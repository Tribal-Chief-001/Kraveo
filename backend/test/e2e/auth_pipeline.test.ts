/**
 * Auth v2: Google Sign-In for students, phone + password for partners, profile, logout, delete account,
 * admin-created partner accounts, order pagination. Runs against a real PostgreSQL.
 */
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getAdminToken, getStudentToken, getAuthHeader } from '../harness/auth';
import { setGoogleVerifier, GoogleAuthError } from '../../src/services/googleAuth';
import { hashPassword, verifyPassword } from '../../src/services/password';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';

const TOKEN = 't'.repeat(40);
const adminHeader = () => getAuthHeader(getAdminToken('usr-5', '+91 9876543214'));

describe('Auth v2 (Google students, password partners)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const asGoogle = (email: string, sub: string, name = 'Aarav Mehta', verified = true) =>
    setGoogleVerifier(async () => ({ sub, email, emailVerified: verified, name }));
  const googleLogin = async (email: string, sub: string, name?: string) => {
    asGoogle(email, sub, name);
    return request.post('/api/auth/google').send({ idToken: TOKEN });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  afterAll(async () => {
    setGoogleVerifier(null);
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    __resetLoginLimiter();
  });
  afterEach(() => setGoogleVerifier(null));

  describe('removed phone-OTP login', () => {
    test('send-otp and verify-otp are gone', async () => {
      expect((await request.post('/api/auth/send-otp').send({ phone: '9000000001' })).status).toBe(404);
      expect((await request.post('/api/auth/verify-otp').send({ phone: '9000000001', otp: '1234' })).status).toBe(404);
    });
  });

  describe('POST /auth/google', () => {
    test('missing token -> 400', async () => {
      expect((await request.post('/api/auth/google').send({})).status).toBe(400);
    });

    test('token that Google rejects -> 401', async () => {
      setGoogleVerifier(async () => { throw new GoogleAuthError(401, 'nope'); });
      const res = await request.post('/api/auth/google').send({ idToken: TOKEN });
      expect(res.status).toBe(401);
    });

    test('server without GOOGLE_WEB_CLIENT_ID -> 503 (not a crash)', async () => {
      const saved = process.env.GOOGLE_WEB_CLIENT_ID;
      delete process.env.GOOGLE_WEB_CLIENT_ID;
      const res = await request.post('/api/auth/google').send({ idToken: TOKEN });
      if (saved) process.env.GOOGLE_WEB_CLIENT_ID = saved;
      expect(res.status).toBe(503);
    });

    test('unverified Google email -> 401', async () => {
      asGoogle('unverified@kraveo.test', 'sub-unv', 'Nobody', false);
      expect((await request.post('/api/auth/google').send({ idToken: TOKEN })).status).toBe(401);
      expect(await prisma.user.findUnique({ where: { email: 'unverified@kraveo.test' } })).toBeNull();
    });

    test('first login creates a STUDENT that still needs a profile; second login is not new', async () => {
      const first = await googleLogin('first@kraveo.test', 'sub-first', 'Riya Kapoor');
      expect(first.status).toBe(200);
      expect(first.body.isNewUser).toBe(true);
      expect(first.body.needsProfile).toBe(true);
      expect(first.body.user).toMatchObject({ role: 'STUDENT', email: 'first@kraveo.test', name: 'Riya Kapoor', phone: null, isStudent: null, avatarId: null });
      expect(Object.keys(first.body.user).sort()).toEqual(['avatarId', 'email', 'hostelBlock', 'id', 'isStudent', 'kraveoCoins', 'name', 'phone', 'role']);

      const second = await googleLogin('first@kraveo.test', 'sub-first', 'Riya Kapoor');
      expect(second.body.isNewUser).toBe(false);
      expect(second.body.user.id).toBe(first.body.user.id);
    });

    test('a Google account that belongs to a partner/admin is refused', async () => {
      await prisma.user.update({ where: { id: 'usr-3' }, data: { email: 'vendor.owner@kraveo.test' } });
      const res = await googleLogin('vendor.owner@kraveo.test', 'sub-vendor');
      expect(res.status).toBe(403);
      await prisma.user.update({ where: { id: 'usr-3' }, data: { email: null } });
    });

    test('an existing account is found by email and linked to the Google id', async () => {
      await prisma.user.create({ data: { name: 'Pre Created', email: 'linked@kraveo.test', role: 'STUDENT' } });
      const res = await googleLogin('linked@kraveo.test', 'sub-linked');
      expect(res.status).toBe(200);
      expect(res.body.isNewUser).toBe(false);
      expect((await prisma.user.findUnique({ where: { email: 'linked@kraveo.test' } }))?.googleSub).toBe('sub-linked');
    });
  });

  describe('profile (name + phone -> student? -> hostel -> avatar)', () => {
    let token: string;
    let userId: string;
    const put = (body: Record<string, unknown>) => request.put('/api/auth/profile').set(getAuthHeader(token)).send(body);

    beforeAll(async () => {
      const res = await googleLogin('profile@kraveo.test', 'sub-profile', 'Kabir Singh');
      token = res.body.token;
      userId = res.body.user.id;
    });

    test.each([
      [{ name: 'A' }, 'name'],
      [{ name: 'VIT Student' }, 'name'],
      [{ name: 'x'.repeat(61) }, 'name'],
      [{ phone: '12345' }, 'phone'],
      [{ phone: '5876543210' }, 'phone'],
      [{ avatarId: 0 }, 'avatarId'],
      [{ avatarId: 16 }, 'avatarId'],
      [{ avatarId: '3' }, 'avatarId'],
      [{ isStudent: 'yes' }, 'isStudent'],
      [{ hostelBlock: 'Block 2' }, 'hostelBlock'], // not a student yet
    ])('rejects %j on field %s', async (body, field) => {
      const res = await put(body as Record<string, unknown>);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
    });

    test('student path: complete profile clears needsProfile', async () => {
      const a = await put({ name: '  Kabir   Singh ', phone: '+91 98765 11111' });
      expect(a.status).toBe(200);
      expect(a.body.needsProfile).toBe(true);
      expect(a.body.user.phone).toBe('+91 9876511111');
      expect(a.body.user.name).toBe('Kabir Singh');

      const b = await put({ isStudent: true });
      expect(b.body.needsProfile).toBe(true); // hostel still missing

      expect((await put({ hostelBlock: 'Roof' })).status).toBe(400);
      const c = await put({ hostelBlock: 'Block 3', avatarId: 7 });
      expect(c.status).toBe(200);
      expect(c.body.needsProfile).toBe(false);
      expect(c.body.user).toMatchObject({ isStudent: true, hostelBlock: 'Block 3', avatarId: 7 });
    });

    test('non-student path: hostel is cleared and not required', async () => {
      const res = await put({ isStudent: false });
      expect(res.status).toBe(200);
      expect(res.body.user.hostelBlock).toBeNull();
      expect(res.body.needsProfile).toBe(false);
      expect((await put({ hostelBlock: 'Block 3' })).status).toBe(400);
    });

    test('phone numbers are unique across accounts', async () => {
      const other = await googleLogin('other@kraveo.test', 'sub-other', 'Other Person');
      const res = await request.put('/api/auth/profile').set(getAuthHeader(other.body.token)).send({ phone: '9876511111' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('phone');
    });

    test('role, coins, email and google id cannot be changed through the profile', async () => {
      await put({ role: 'ADMIN', kraveoCoins: 9999, email: 'evil@kraveo.test', googleSub: 'evil' });
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row).toMatchObject({ role: 'STUDENT', kraveoCoins: 0, email: 'profile@kraveo.test', googleSub: 'sub-profile' });
    });

    test('GET /auth/profile returns the public shape and never leaks secrets', async () => {
      const res = await request.get('/api/auth/profile').set(getAuthHeader(token));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|googleSub|fcmToken/);
    });

    test('logout clears the push token', async () => {
      await put({ fcmToken: 'fcm-abc' });
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.fcmToken).toBe('fcm-abc');
      expect((await request.post('/api/auth/logout').set(getAuthHeader(token))).status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: userId } }))?.fcmToken).toBeNull();
      expect((await request.post('/api/auth/logout')).status).toBe(401);
    });

    test('delete account: blocked while an order is live, then anonymised; the same Google account can sign up again', async () => {
      const vendor = await prisma.vendor.findFirstOrThrow();
      const order = await prisma.order.create({ data: { customerId: userId, vendorId: vendor.id, totalAmount: 100, dropoffHostel: 'Block 3', status: 'PREPARING', paymentStatus: 'PAID' } });
      expect((await request.delete('/api/auth/account').set(getAuthHeader(token))).status).toBe(409);

      await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
      expect((await request.delete('/api/auth/account').set(getAuthHeader(token))).status).toBe(200);
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row).toMatchObject({ name: 'Deleted user', phone: null, email: null, googleSub: null });
      expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();

      const again = await googleLogin('profile@kraveo.test', 'sub-profile', 'Kabir Singh');
      expect(again.body.isNewUser).toBe(true);
      expect(again.body.user.id).not.toBe(userId);
    });
  });

  describe('admin creates partners; partners log in with phone + password', () => {
    const phone = '9000000201';

    test('only ADMIN can create or list partners', async () => {
      const body = { role: 'VENDOR', name: 'Test Owner', phone, password: 'Sup3rSecret!' };
      expect((await request.post('/api/admin/partners').send(body)).status).toBe(401);
      expect((await request.post('/api/admin/partners').set(getAuthHeader(getStudentToken())).send(body)).status).toBe(403);
      expect((await request.get('/api/admin/partners').set(getAuthHeader(getStudentToken()))).status).toBe(403);
    });

    test('validation: bad role / name / phone / short password / duplicate phone', async () => {
      const ok = { role: 'VENDOR', name: 'Test Owner', phone, password: 'Sup3rSecret!' };
      const post = (b: object) => request.post('/api/admin/partners').set(adminHeader()).send(b);
      expect((await post({ ...ok, role: 'ADMIN' })).body.field).toBe('role');
      expect((await post({ ...ok, name: '' })).body.field).toBe('name');
      expect((await post({ ...ok, phone: '123' })).body.field).toBe('phone');
      expect((await post({ ...ok, password: 'short' })).body.field).toBe('password');
      expect((await post({ ...ok, phone: '9876543212' })).status).toBe(409); // seeded vendor already owns it
    });

    test('creating a vendor links it to a restaurant; a second owner for the same restaurant is refused', async () => {
      const vendor = await prisma.vendor.findFirstOrThrow({ where: { userId: null } }).catch(async () =>
        prisma.vendor.create({ data: { name: 'Link Test Dhaba', category: 'Test', bannerImage: '', address: 'x' } }));
      const res = await request.post('/api/admin/partners').set(adminHeader()).send({ role: 'VENDOR', name: 'Test Owner', phone, password: 'Sup3rSecret!', vendorId: vendor.id });
      expect(res.status).toBe(201);
      expect((await prisma.vendor.findUnique({ where: { id: vendor.id } }))?.userId).toBe(res.body.user.id);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Sup3rSecret/);

      const dup = await request.post('/api/admin/partners').set(adminHeader()).send({ role: 'VENDOR', name: 'Second Owner', phone: '9000000202', password: 'Sup3rSecret!', vendorId: vendor.id });
      expect(dup.status).toBe(409);
    });

    test('vendor logs in with the right password and gets its restaurant', async () => {
      const res = await request.post('/api/auth/partner-login').send({ phone: '+91 90000 00201', password: 'Sup3rSecret!', role: 'VENDOR' });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('VENDOR');
      expect(res.body.vendor.id).toBeDefined();
      const profile = await request.get('/api/auth/profile').set(getAuthHeader(res.body.token));
      expect(profile.body.user.id).toBe(res.body.user.id);
    });

    test('wrong password and unknown phone give the identical 401 message', async () => {
      const wrong = await request.post('/api/auth/partner-login').send({ phone, password: 'nope-nope-nope', role: 'VENDOR' });
      const unknown = await request.post('/api/auth/partner-login').send({ phone: '9000000299', password: 'nope-nope-nope', role: 'VENDOR' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    test('right password but the wrong app role -> 403; students have no password login', async () => {
      const wrongRole = await request.post('/api/auth/partner-login').send({ phone, password: 'Sup3rSecret!', role: 'DRIVER' });
      expect(wrongRole.status).toBe(403);
      const student = await request.post('/api/auth/partner-login').send({ phone: '9876543210', password: 'anything-at-all', role: 'VENDOR' });
      expect(student.status).toBe(401);
    });

    test('5 wrong passwords lock the phone for 15 minutes, even for the right password', async () => {
      let last;
      for (let i = 0; i < 5; i++) last = await request.post('/api/auth/partner-login').send({ phone, password: `wrong-pass-${i}`, role: 'VENDOR' });
      expect(last!.status).toBe(429);
      expect(last!.body.retryAfterSeconds).toBeGreaterThan(800);
      const right = await request.post('/api/auth/partner-login').send({ phone, password: 'Sup3rSecret!', role: 'VENDOR' });
      expect(right.status).toBe(429);
    });

    test('driver account gets a DriverPartner profile', async () => {
      const res = await request.post('/api/admin/partners').set(adminHeader()).send({ role: 'DRIVER', name: 'Test Runner', phone: '9000000203', password: 'Sup3rSecret!' });
      expect(res.status).toBe(201);
      const driver = await prisma.driverPartner.findFirst({ where: { userId: res.body.user.id } });
      expect(driver?.runnerCode).toMatch(/^RUN-\d{4}$/);
      __resetLoginLimiter();
      const login = await request.post('/api/auth/partner-login').send({ phone: '9000000203', password: 'Sup3rSecret!', role: 'DRIVER' });
      expect(login.status).toBe(200);
      expect(login.body.driver.runnerCode).toBe(driver?.runnerCode);
    });

    test('GET /admin/partners never exposes password hashes', async () => {
      const res = await request.get('/api/admin/partners').set(adminHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt/);
    });
  });

  describe('password hashing', () => {
    test('unique salt per hash, verifies correct password only, rejects junk formats', async () => {
      const a = await hashPassword('correct horse battery');
      const b = await hashPassword('correct horse battery');
      expect(a).not.toBe(b);
      expect(a.startsWith('scrypt$')).toBe(true);
      expect(await verifyPassword('correct horse battery', a)).toBe(true);
      expect(await verifyPassword('correct horse batterx', a)).toBe(false);
      expect(await verifyPassword('x', null)).toBe(false);
      expect(await verifyPassword('x', 'plaintext')).toBe(false);
    });
  });

  describe('orders pagination', () => {
    test('customer list pages with limit/cursor, no duplicates, nextCursor null at the end', async () => {
      const res = await googleLogin('pager@kraveo.test', 'sub-pager', 'Pager Person');
      const vendor = await prisma.vendor.findFirstOrThrow();
      for (let i = 0; i < 5; i++) {
        await prisma.order.create({ data: { customerId: res.body.user.id, vendorId: vendor.id, totalAmount: 100 + i, dropoffHostel: 'Block 1', createdAt: new Date(Date.now() - i * 60_000) } });
      }
      const header = getAuthHeader(res.body.token);
      const p1 = await request.get('/api/orders?limit=2').set(header);
      expect(p1.body.data).toHaveLength(2);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await request.get(`/api/orders?limit=2&cursor=${p1.body.nextCursor}`).set(header);
      const p3 = await request.get(`/api/orders?limit=2&cursor=${p2.body.nextCursor}`).set(header);
      expect(p3.body.data).toHaveLength(1);
      expect(p3.body.nextCursor).toBeNull();
      const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((o: any) => o.id);
      expect(new Set(ids).size).toBe(5);
      const times = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((o: any) => +new Date(o.createdAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times); // newest first
    });
  });
});
