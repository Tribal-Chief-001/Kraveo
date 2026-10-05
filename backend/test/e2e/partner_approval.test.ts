/**
 * Partner self sign-up with admin approval: create account (PENDING) -> admin approves / rejects ->
 * only APPROVED partners can work. Also admin-created partners, password reset, audit log and the
 * admin customer views. Runs against a real PostgreSQL.
 */
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getAdminToken, getStudentToken, getAuthHeader } from '../harness/auth';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { __resetSignupLimiter } from '../../src/routes/partners';

const adminHeader = () => getAuthHeader(getAdminToken('usr-5', '+91 9876543214'));
const PW = 'Sup3rSecret!';
const NAME_PREFIX = 'ZZ Test';

describe('Partner approval pipeline', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const vendorBody = (phone: string, extra: object = {}) => ({
    role: 'VENDOR', name: 'Ramesh Kumar', phone, password: PW,
    restaurantName: `${NAME_PREFIX} Dhaba ${phone}`, category: 'North Indian', address: 'Ashta road, near gate 2', ...extra,
  });
  const driverBody = (phone: string, extra: object = {}) => ({
    role: 'DRIVER', name: 'Sunil Verma', phone, password: PW, vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234', emergencyPhone: '9000000999', ...extra,
  });
  const signup = (body: object) => request.post('/api/auth/partner-signup').send(body);
  const setStatus = (kind: string, id: string, status: string, reason?: string) =>
    request.post(`/api/admin/partners/${kind}/${id}/status`).set(adminHeader()).send({ status, reason });

  const cleanup = async () => {
    await prisma.vendor.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
    await prisma.driverPartner.deleteMany({ where: { user: { phone: { startsWith: '+91 9000' } } } });
    await prisma.driverPartner.deleteMany({ where: { phone: { startsWith: '+91 9000' } } });
    await prisma.adminAuditLog.deleteMany({});
    await cleanTestUsers();
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanup();
    await seedTestDatabase();
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  afterAll(async () => {
    await cleanTestOrders();
    await cleanup();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    __resetLoginLimiter();
    __resetSignupLimiter();
  });

  describe('sign-up validation', () => {
    test('rejects a bad role, name, phone, password', async () => {
      expect((await signup({ ...vendorBody('9000000301'), role: 'ADMIN' })).body.field).toBe('role');
      expect((await signup({ ...vendorBody('9000000301'), name: '1' })).body.field).toBe('name');
      expect((await signup({ ...vendorBody('9000000301'), phone: '12345' })).body.field).toBe('phone');
      expect((await signup({ ...vendorBody('9000000301'), password: 'short' })).body.field).toBe('password');
    });

    test('vendor needs a restaurant name and an address; FSSAI must be 14 digits if given', async () => {
      expect((await signup(vendorBody('9000000301', { restaurantName: '' }))).body.field).toBe('restaurantName');
      expect((await signup(vendorBody('9000000301', { address: '' }))).body.field).toBe('address');
      expect((await signup(vendorBody('9000000301', { fssaiNumber: '123' }))).body.field).toBe('fssaiNumber');
    });

    test('rider needs a vehicle type; a plate unless on a cycle or foot; a different emergency contact', async () => {
      expect((await signup(driverBody('9000000302', { vehicleType: 'Rocket' }))).body.field).toBe('vehicleType');
      expect((await signup(driverBody('9000000302', { vehicleRegNo: '' }))).body.field).toBe('vehicleRegNo');
      expect((await signup(driverBody('9000000302', { emergencyPhone: '9000000302' }))).body.field).toBe('emergencyPhone');
      expect((await signup(driverBody('9000000302', { upiId: 'not-a-upi' }))).body.field).toBe('upiId');
      expect((await prisma.user.findFirst({ where: { phone: '+91 9000000302' } }))).toBeNull();
    });

    test('a rider on a cycle needs no number plate and no student registration number', async () => {
      const res = await signup(driverBody('9000000303', { vehicleType: 'cycle', vehicleRegNo: '' }));
      expect(res.status).toBe(201);
      const d = await prisma.driverPartner.findFirstOrThrow({ where: { userId: res.body.user.id } });
      expect(d.vehicleType).toBe('Cycle');
      expect(d.studentRegNo).toBeNull();
    });

    test('same phone twice -> 409, and 409 answers never use up the allowance (bug hunt BE2-04: only real sign-ups are throttled)', async () => {
      expect((await signup(vendorBody('9000000304'))).status).toBe(201);
      for (let i = 0; i < 5; i++) expect((await signup(vendorBody('9000000304'))).status).toBe(409);
    });
  });

  describe('a pending restaurant', () => {
    const phone = '9000000311';
    let token = '';
    let vendorId = '';
    let userId = '';

    beforeAll(async () => {
      __resetSignupLimiter();
      const res = await signup(vendorBody(phone, { fssaiNumber: '12345678901234' }));
      expect(res.status).toBe(201);
      token = res.body.token;
      vendorId = res.body.vendor.id;
      userId = res.body.user.id;
      expect(res.body.approvalStatus).toBe('PENDING');
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt|Sup3rSecret/);
    });

    test('the account is a VENDOR, closed, with the restaurant details saved', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.role).toBe('VENDOR');
      expect(user.passwordHash).toMatch(/^scrypt\$/);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
      expect(v.approvalStatus).toBe('PENDING');
      expect(v.isAcceptingOrders).toBe(false);
      expect(v.fssaiNumber).toBe('12345678901234');
      expect(v.appliedAt).not.toBeNull();
    });

    test('can log in and sees PENDING; /partner/me agrees', async () => {
      const login = await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'VENDOR' });
      expect(login.status).toBe(200);
      expect(login.body.approvalStatus).toBe('PENDING');
      const me = await request.get('/api/partner/me').set(getAuthHeader(token));
      expect(me.status).toBe(200);
      expect(me.body.approvalStatus).toBe('PENDING');
      expect(me.body.vendor.name).toContain(NAME_PREFIX);
      expect((await request.get('/api/partner/me').set(getAuthHeader(getStudentToken()))).status).toBe(403);
    });

    test('cannot open the store, add menu items or touch orders (403 PARTNER_NOT_APPROVED)', async () => {
      const h = getAuthHeader(token);
      const toggle = await request.patch(`/api/vendors/${vendorId}/toggle`).set(h);
      expect(toggle.status).toBe(403);
      expect(toggle.body.code).toBe('PARTNER_NOT_APPROVED');
      expect(toggle.body.approvalStatus).toBe('PENDING');
      expect((await request.patch(`/api/vendors/${vendorId}/status`).set(h).send({ isAcceptingOrders: true })).status).toBe(403);
      expect((await request.post(`/api/vendors/${vendorId}/items`).set(h).send({ name: 'Roll', price: 50 })).status).toBe(403);
      expect((await request.patch('/api/orders/does-not-matter/status').set(h).send({ status: 'ACCEPTED' })).status).toBe(403);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).isAcceptingOrders).toBe(false);
    });

    test('customers cannot see it or order from it, but the owner and the admin can', async () => {
      const item = await prisma.menuItem.create({ data: { vendorId, name: 'Test roll', price: 60, category: 'Rolls', description: '', imageUrl: '' } });
      const anon = await request.get('/api/vendors');
      expect(anon.body.data.some((v: any) => v.id === vendorId)).toBe(false);
      expect((await request.get(`/api/vendors/${vendorId}`)).status).toBe(404);
      expect((await request.get(`/api/menus/${vendorId}`)).body.count).toBe(0);
      const student = await request.get('/api/vendors').set(getAuthHeader(getStudentToken()));
      expect(student.body.data.some((v: any) => v.id === vendorId)).toBe(false);

      const owner = await request.get('/api/vendors').set(getAuthHeader(token));
      expect(owner.body.data.some((v: any) => v.id === vendorId)).toBe(true);
      const admin = await request.get('/api/vendors').set(adminHeader());
      expect(admin.body.data.some((v: any) => v.id === vendorId)).toBe(true);
      expect((await request.get(`/api/menus/${vendorId}`).set(adminHeader())).body.count).toBe(1);

      const order = await request.post('/api/orders').set(getAuthHeader(getStudentToken())).send({ vendorId, items: [{ itemId: item.id, quantity: 1 }], dropoffHostel: 'Block 1' });
      expect(order.status).toBe(400);
      expect(order.body.message).toMatch(/not available/i);
    });

    test('the admin sees it under applications with every detail and a phone number', async () => {
      const res = await request.get('/api/admin/applications').set(adminHeader());
      expect(res.status).toBe(200);
      expect(res.body.counts.PENDING).toBeGreaterThanOrEqual(1);
      const row = res.body.data.find((a: any) => a.id === vendorId);
      expect(row).toMatchObject({ kind: 'VENDOR', status: 'PENDING', selfSignup: true, phone: `+91 ${phone}` });
      expect(row.vendor).toMatchObject({ category: 'North Indian', fssaiNumber: '12345678901234' });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt/);
      expect((await request.get('/api/admin/applications')).status).toBe(401);
      expect((await request.get('/api/admin/applications').set(getAuthHeader(token))).status).toBe(403);
    });

    test('a rejection needs a reason; it can only reject a pending application', async () => {
      expect((await setStatus('vendor', vendorId, 'REJECTED')).status).toBe(400);
      const rej = await setStatus('vendor', vendorId, 'REJECTED', 'FSSAI number does not match');
      expect(rej.status).toBe(200);
      expect(rej.body.data.status).toBe('REJECTED');
      expect((await setStatus('vendor', vendorId, 'REJECTED', 'again please')).status).toBe(409);
      expect((await setStatus('vendor', vendorId, 'SUSPENDED', 'not active yet')).status).toBe(409);
    });

    test('the partner sees the reason, fixes the details and is pending again', async () => {
      const h = getAuthHeader(token);
      const me = await request.get('/api/partner/me').set(h);
      expect(me.body.approvalStatus).toBe('REJECTED');
      expect(me.body.rejectionReason).toBe('FSSAI number does not match');
      const login = await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'VENDOR' });
      expect(login.body.approvalStatus).toBe('REJECTED');

      const bad = await request.put('/api/partner/application').set(h).send({ fssaiNumber: '99' });
      expect(bad.status).toBe(400);
      const fixed = await request.put('/api/partner/application').set(h).send({ fssaiNumber: '98765432109876', address: 'Gate 2 food court' });
      expect(fixed.status).toBe(200);
      expect(fixed.body.approvalStatus).toBe('PENDING');
      expect(fixed.body.rejectionReason).toBeNull();
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).fssaiNumber).toBe('98765432109876');
    });

    test('approval unlocks everything: store toggle works and customers can see it', async () => {
      const ok = await setStatus('vendor', vendorId, 'APPROVED');
      expect(ok.status).toBe(200);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).rejectionReason).toBeNull();
      expect((await request.get('/api/partner/me').set(getAuthHeader(token))).body.approvalStatus).toBe('APPROVED');

      const open = await request.patch(`/api/vendors/${vendorId}/status`).set(getAuthHeader(token)).send({ isAcceptingOrders: true });
      expect(open.status).toBe(200);
      expect(open.body.isAcceptingOrders).toBe(true);
      const anon = await request.get('/api/vendors');
      expect(anon.body.data.some((v: any) => v.id === vendorId)).toBe(true);
      expect((await request.get(`/api/vendors/${vendorId}`)).status).toBe(200);
      expect((await request.put('/api/partner/application').set(getAuthHeader(token)).send({ address: 'x y z' })).status).toBe(409);
    });

    test('suspending closes the restaurant, hides it and blocks the owner; reactivating restores it', async () => {
      const sus = await setStatus('vendor', vendorId, 'SUSPENDED', 'Customer complaints');
      expect(sus.status).toBe(200);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).isAcceptingOrders).toBe(false);
      expect((await request.get('/api/vendors')).body.data.some((v: any) => v.id === vendorId)).toBe(false);
      // Suspension ends the owner's sessions (tokenVersion bump); signing in again says why they are blocked.
      const revoked = await request.patch(`/api/vendors/${vendorId}/toggle`).set(getAuthHeader(token));
      expect([revoked.status, revoked.body.code]).toEqual([401, 'TOKEN_REVOKED']);
      __resetLoginLimiter();
      const relogin = await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'VENDOR' });
      expect(relogin.body.approvalStatus).toBe('SUSPENDED');
      const blocked = await request.patch(`/api/vendors/${vendorId}/toggle`).set(getAuthHeader(relogin.body.token));
      expect(blocked.status).toBe(403);
      expect(blocked.body.approvalStatus).toBe('SUSPENDED');
      expect((await setStatus('vendor', vendorId, 'APPROVED')).status).toBe(200);
      token = relogin.body.token;
      expect((await request.patch(`/api/vendors/${vendorId}/toggle`).set(getAuthHeader(token))).status).toBe(200);
    });

    test('admin resets the password: the old one stops working, the new one works', async () => {
      expect((await request.post(`/api/admin/partners/${userId}/reset-password`).set(adminHeader()).send({ password: 'short' })).status).toBe(400);
      expect((await request.post(`/api/admin/partners/${userId}/reset-password`).set(adminHeader()).send({ password: 'Brand-New-Pass1' })).status).toBe(200);
      expect((await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'VENDOR' })).status).toBe(401);
      const fresh = await request.post('/api/auth/partner-login').send({ phone, password: 'Brand-New-Pass1', role: 'VENDOR' });
      expect(fresh.status).toBe(200);
      // The old session (issued with the old password) is dead, the new login works.
      expect((await request.get('/api/partner/me').set(getAuthHeader(token))).status).toBe(401);
      expect((await request.get('/api/partner/me').set(getAuthHeader(fresh.body.token))).status).toBe(200);
      token = fresh.body.token;
      expect((await request.post(`/api/admin/partners/${userId}/reset-password`).set(getAuthHeader(getStudentToken())).send({ password: 'Brand-New-Pass1' })).status).toBe(403);
      expect((await request.post('/api/admin/partners/usr-1/reset-password').set(adminHeader()).send({ password: 'Brand-New-Pass1' })).status).toBe(404);
    });
  });

  describe('a rider application', () => {
    const phone = '9000000321';
    let token = '';
    let driverId = '';

    test('sign-up creates a pending rider with a runner code', async () => {
      const res = await signup(driverBody(phone, { upiId: 'sunil@okaxis' }));
      expect(res.status).toBe(201);
      token = res.body.token;
      driverId = res.body.driver.id;
      expect(res.body.approvalStatus).toBe('PENDING');
      expect(res.body.driver.runnerCode).toMatch(/^RUN-\d{4,}$/);
      const d = await prisma.driverPartner.findUniqueOrThrow({ where: { id: driverId } });
      expect(d).toMatchObject({ approvalStatus: 'PENDING', vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234', upiId: 'sunil@okaxis' });
    });

    test('a pending rider cannot share a location, accept an order or be assigned by the admin', async () => {
      const h = getAuthHeader(token);
      const loc = await request.post('/api/drivers/location').set(h).send({ lat: 23.07, lng: 76.85 });
      expect(loc.status).toBe(403);
      expect(loc.body.code).toBe('PARTNER_NOT_APPROVED');
      expect((await request.post('/api/orders/nothing/accept-driver').set(h)).status).toBe(403);
      expect((await request.post('/api/orders/nothing/verify-gate-otp').set(h).send({ otp: '1234' })).status).toBe(403);

      const vendor = await prisma.vendor.findFirstOrThrow({ where: { id: 'ven-1' } });
      const order = await prisma.order.create({ data: { customerId: 'usr-1', vendorId: vendor.id, totalAmount: 100, dropoffHostel: 'Block 1', status: 'READY_FOR_PICKUP', paymentStatus: 'PAID' } });
      const reassign = await request.patch(`/api/orders/${order.id}/reassign`).set(adminHeader()).send({ driverId });
      expect(reassign.status).toBe(400);
      expect(reassign.body.message).toMatch(/approved rider/i);
    });

    test('approve it and the rider can work; the applications list reflects the new counts', async () => {
      const before = (await request.get('/api/admin/applications').set(adminHeader())).body.counts;
      expect((await setStatus('driver', driverId, 'APPROVED')).status).toBe(200);
      const after = (await request.get('/api/admin/applications').set(adminHeader())).body.counts;
      expect(after.PENDING).toBe(before.PENDING - 1);
      expect(after.APPROVED).toBe(before.APPROVED + 1);
      const loc = await request.post('/api/drivers/location').set(getAuthHeader(token)).send({ lat: 23.07, lng: 76.85 });
      expect(loc.status).toBe(200);
      const list = await request.get('/api/admin/applications?status=APPROVED&kind=DRIVER').set(adminHeader());
      expect(list.body.data.every((a: any) => a.kind === 'DRIVER' && a.status === 'APPROVED')).toBe(true);
      expect(list.body.data.some((a: any) => a.id === driverId)).toBe(true);
    });

    test('suspending a rider puts them offline and blocks the work endpoints', async () => {
      expect((await setStatus('driver', driverId, 'SUSPENDED', 'No-show on three orders')).status).toBe(200);
      expect((await prisma.driverPartner.findUniqueOrThrow({ where: { id: driverId } })).dutyStatus).toBe('OFFLINE');
      expect((await request.post('/api/drivers/location').set(getAuthHeader(token)).send({ lat: 23.07, lng: 76.85 })).status).toBe(401); // old session revoked
      __resetLoginLimiter();
      const again = (await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'DRIVER' })).body.token;
      expect((await request.post('/api/drivers/location').set(getAuthHeader(again)).send({ lat: 23.07, lng: 76.85 })).status).toBe(403);
      expect((await request.get('/api/partner/me').set(getAuthHeader(again))).body.rejectionReason).toBe('No-show on three orders');
    });
  });

  describe('rider duty status', () => {
    const phone = '9000000341';
    let token = '';
    let driverId = '';

    beforeAll(async () => {
      __resetSignupLimiter();
      const res = await request.post('/api/admin/partners').set(adminHeader()).send(driverBody(phone));
      driverId = res.body.profileId;
      __resetLoginLimiter();
      const login = await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'DRIVER' });
      token = login.body.token;
    });

    const duty = (isOnline: unknown, t = token) => request.post('/api/drivers/duty-status').set(getAuthHeader(t)).send({ isOnline });
    const dbDuty = async () => (await prisma.driverPartner.findUniqueOrThrow({ where: { id: driverId } })).dutyStatus;

    test('going on and off duty is saved on the server', async () => {
      expect((await duty(true)).body.dutyStatus).toBe('ONLINE');
      expect(await dbDuty()).toBe('ONLINE');
      expect((await duty(false)).body.dutyStatus).toBe('OFFLINE');
      expect(await dbDuty()).toBe('OFFLINE');
    });

    test('a rider who is mid-delivery shows as IN_TRANSIT, not plain ONLINE', async () => {
      const userId = (await prisma.driverPartner.findUniqueOrThrow({ where: { id: driverId } })).userId!;
      const order = await prisma.order.create({ data: { customerId: 'usr-1', vendorId: 'ven-1', driverId: userId, totalAmount: 100, dropoffHostel: 'Block 1', status: 'PICKED_UP', paymentStatus: 'PAID' } });
      expect((await duty(true)).body.dutyStatus).toBe('IN_TRANSIT');
      await prisma.order.delete({ where: { id: order.id } });
      expect((await duty(true)).body.dutyStatus).toBe('ONLINE');
    });

    test('needs a boolean, a rider login, and an approved account', async () => {
      expect((await duty('yes')).status).toBe(400);
      expect((await request.post('/api/drivers/duty-status').send({ isOnline: true })).status).toBe(401);
      expect((await duty(true, getStudentToken())).status).toBe(403);
      await setStatus('driver', driverId, 'SUSPENDED', 'Testing a pause');
      expect((await duty(true)).status).toBe(401); // the suspended session is revoked
      __resetLoginLimiter();
      token = (await request.post('/api/auth/partner-login').send({ phone, password: PW, role: 'DRIVER' })).body.token;
      const blocked = await duty(true);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('PARTNER_NOT_APPROVED');
      expect(await dbDuty()).toBe('OFFLINE'); // suspension already took them offline
      await setStatus('driver', driverId, 'APPROVED');
    });

    test('logging out puts the rider off duty', async () => {
      await duty(true);
      expect(await dbDuty()).toBe('ONLINE');
      expect((await request.post('/api/auth/logout').set(getAuthHeader(token))).status).toBe(200);
      expect(await dbDuty()).toBe('OFFLINE');
    });

    test('the dashboard list shows the saved duty status', async () => {
      await duty(true);
      const list = await request.get('/api/drivers').set(adminHeader());
      expect(list.body.data.find((d: any) => d.id === driverId).dutyStatus).toBe('ONLINE');
    });
  });

  describe('what a suspended or approved partner can do (end to end)', () => {
    test('suspending a restaurant: it vanishes for customers, its open orders stay readable, new orders are refused', async () => {
      __resetSignupLimiter();
      const created = await request.post('/api/admin/partners').set(adminHeader()).send(vendorBody('9000000351'));
      const vendorId = created.body.profileId;
      __resetLoginLimiter();
      const token = (await request.post('/api/auth/partner-login').send({ phone: '9000000351', password: PW, role: 'VENDOR' })).body.token;
      const item = await prisma.menuItem.create({ data: { vendorId, name: 'Roll', price: 60, category: 'Rolls', description: '', imageUrl: '' } });
      const live = await prisma.order.create({ data: { customerId: 'usr-1', vendorId, totalAmount: 80, dropoffHostel: 'Block 1', status: 'PLACED', paymentStatus: 'PAID', items: { create: [{ menuItemId: item.id, name: 'Roll', quantity: 1, price: 60 }] } } });

      // Before: customers see it and can order.
      expect((await request.get('/api/vendors')).body.data.some((v: any) => v.id === vendorId)).toBe(true);
      const ok = await request.post('/api/orders').set(getAuthHeader(getStudentToken())).send({ vendorId, items: [{ itemId: item.id, quantity: 1 }], dropoffHostel: 'Block 1' });
      expect(ok.status).toBe(201);

      await setStatus('vendor', vendorId, 'SUSPENDED', 'Hygiene complaint');

      // After: hidden, closed, new orders refused, the owner cannot work, the admin still sees everything.
      expect((await request.get('/api/vendors')).body.data.some((v: any) => v.id === vendorId)).toBe(false);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).isAcceptingOrders).toBe(false);
      const refused = await request.post('/api/orders').set(getAuthHeader(getStudentToken())).send({ vendorId, items: [{ itemId: item.id, quantity: 1 }], dropoffHostel: 'Block 1' });
      expect(refused.status).toBe(400);
      expect((await request.patch(`/api/orders/${live.id}/status`).set(getAuthHeader(token)).send({ status: 'ACCEPTED' })).status).toBe(401); // session revoked
      __resetLoginLimiter();
      const token2 = (await request.post('/api/auth/partner-login').send({ phone: '9000000351', password: PW, role: 'VENDOR' })).body.token;
      const accept = await request.patch(`/api/orders/${live.id}/status`).set(getAuthHeader(token2)).send({ status: 'ACCEPTED' });
      expect(accept.status).toBe(403);
      expect(accept.body.code).toBe('PARTNER_NOT_APPROVED');
      expect((await request.get(`/api/orders/${live.id}`).set(adminHeader())).status).toBe(200);
      // The order that was already placed is NOT cancelled or moved by a suspension: the admin decides what to do with it.
      expect((await prisma.order.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('PLACED');
      await prisma.order.deleteMany({ where: { vendorId } });
    });

    test('approving a restaurant does not open it: the owner opens the store himself when the menu is ready', async () => {
      __resetSignupLimiter();
      const res = await signup(vendorBody('9000000352'));
      const vendorId = res.body.vendor.id;
      await setStatus('vendor', vendorId, 'APPROVED');
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).isAcceptingOrders).toBe(false);
      const open = await request.patch(`/api/vendors/${vendorId}/status`).set(getAuthHeader(res.body.token)).send({ isAcceptingOrders: true });
      expect(open.status).toBe(200);
    });
  });

  describe('admin creates partners directly', () => {
    test('a vendor is created together with its restaurant, already approved and open', async () => {
      const res = await request.post('/api/admin/partners').set(adminHeader()).send(vendorBody('9000000331', { fssaiNumber: '' }));
      expect(res.status).toBe(201);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: res.body.profileId } });
      expect(v).toMatchObject({ approvalStatus: 'APPROVED', isAcceptingOrders: true, userId: res.body.user.id });
      expect((await request.get('/api/vendors')).body.data.some((x: any) => x.id === v.id)).toBe(true);
      const login = await request.post('/api/auth/partner-login').send({ phone: '9000000331', password: PW, role: 'VENDOR' });
      expect(login.body.approvalStatus).toBe('APPROVED');
      expect(login.body.vendor.id).toBe(v.id);
    });

    test('a vendor without a restaurant name or an existing vendorId is refused', async () => {
      const res = await request.post('/api/admin/partners').set(adminHeader()).send({ role: 'VENDOR', name: 'No Shop', phone: '9000000332', password: PW });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('restaurantName');
    });

    test('a rider is created approved with the vehicle details', async () => {
      const res = await request.post('/api/admin/partners').set(adminHeader()).send(driverBody('9000000333', { vehicleType: 'Scooter' }));
      expect(res.status).toBe(201);
      const d = await prisma.driverPartner.findUniqueOrThrow({ where: { id: res.body.profileId } });
      expect(d).toMatchObject({ approvalStatus: 'APPROVED', vehicleType: 'Scooter', vehicleRegNo: 'MP04 AB 1234' });
      expect(d.appliedAt).toBeNull();
    });

    test('approvals, suspensions, resets and creations are all in the activity log', async () => {
      const res = await request.get('/api/admin/audit-log').set(adminHeader());
      expect(res.status).toBe(200);
      const actions = new Set(res.body.data.map((a: any) => a.action));
      for (const a of ['PARTNER_APPROVED', 'PARTNER_REJECTED', 'PARTNER_SUSPENDED', 'PASSWORD_RESET', 'PARTNER_CREATED']) expect(actions.has(a)).toBe(true);
      expect((await request.get('/api/admin/audit-log').set(getAuthHeader(getStudentToken()))).status).toBe(403);
    });
  });

  describe('admin customer views', () => {
    let customerId = '';

    beforeAll(async () => {
      const customer = await prisma.user.create({
        data: { name: 'Aarav Mehta', email: 'aarav@kraveo.test', googleSub: 'g-aarav-detail', phone: '+91 9999000451', role: 'STUDENT', isStudent: true, hostelBlock: 'Block 2', avatarId: 7, kraveoCoins: 40 },
      });
      customerId = customer.id;
      const paid = await prisma.order.create({
        data: {
          customerId, vendorId: 'ven-1', totalAmount: 230, deliveryFee: 20, dropoffHostel: 'Block 2', status: 'DELIVERED', paymentStatus: 'PAID',
          items: { create: [{ name: 'Paneer roll', quantity: 2, price: 90 }, { name: 'Masala chai', quantity: 1, price: 30 }] },
          payments: { create: [{ razorpayOrderId: 'order_detail_1', razorpayPaymentId: 'pay_detail_1', amount: 230, status: 'PAID' }] },
        },
      });
      await prisma.order.create({ data: { customerId, vendorId: 'ven-1', totalAmount: 100, dropoffHostel: 'Block 2', status: 'CANCELLED', paymentStatus: 'FAILED' } });
      await prisma.order.create({ data: { customerId, vendorId: 'ven-1', totalAmount: 120, dropoffHostel: 'Block 2', status: 'PREPARING', paymentStatus: 'PAID' } });
      expect(paid.id).toBeDefined();
    });

    afterAll(async () => {
      await prisma.order.deleteMany({ where: { customerId } });
    });

    test('only an admin can list customers', async () => {
      expect((await request.get('/api/admin/customers')).status).toBe(401);
      expect((await request.get('/api/admin/customers').set(getAuthHeader(getStudentToken()))).status).toBe(403);
    });

    test('the list has profile fields, order counts and money spent; search finds by name, email, phone and hostel', async () => {
      const res = await request.get('/api/admin/customers?search=aarav').set(adminHeader());
      expect(res.status).toBe(200);
      const row = res.body.data.find((c: any) => c.id === customerId);
      expect(row).toMatchObject({ name: 'Aarav Mehta', email: 'aarav@kraveo.test', phone: '+91 9999000451', isStudent: true, hostelBlock: 'Block 2', avatarId: 7, kraveoCoins: 40, ordersCount: 3, totalSpent: 350 });
      expect(row.lastOrderAt).toBeTruthy();
      for (const q of ['kraveo.test', '9999000451', 'Block 2']) {
        const r = await request.get(`/api/admin/customers?search=${encodeURIComponent(q)}`).set(adminHeader());
        expect(r.body.data.some((c: any) => c.id === customerId)).toBe(true);
      }
      expect((await request.get('/api/admin/customers?search=zzz-nobody-zzz').set(adminHeader())).body.total).toBe(0);
      expect(JSON.stringify(res.body)).not.toMatch(/googleSub|g-aarav-detail|fcmToken|passwordHash/);
    });

    test('pagination returns a cursor', async () => {
      const first = await request.get('/api/admin/customers?limit=1').set(adminHeader());
      expect(first.body.data.length).toBe(1);
      if (first.body.total > 1) {
        expect(first.body.nextCursor).toBeTruthy();
        const second = await request.get(`/api/admin/customers?limit=1&cursor=${first.body.nextCursor}`).set(adminHeader());
        expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
      }
    });

    test('the detail view has the stats, every order with items and payment ids', async () => {
      const res = await request.get(`/api/admin/customers/${customerId}`).set(adminHeader());
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.stats).toMatchObject({ ordersCount: 3, deliveredCount: 1, cancelledCount: 1, activeCount: 1, paidOrdersCount: 2, totalSpent: 350 });
      expect(d.orders.length).toBe(3);
      const delivered = d.orders.find((o: any) => o.status === 'DELIVERED');
      expect(delivered.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Paneer roll', quantity: 2, price: 90 })]));
      expect(delivered.payments[0]).toMatchObject({ razorpayPaymentId: 'pay_detail_1', amount: 230, status: 'PAID' });
      expect(delivered.vendor.name).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toMatch(/googleSub|g-aarav-detail|fcmToken|passwordHash/);
      expect((await request.get('/api/admin/customers/usr-3').set(adminHeader())).status).toBe(404); // a vendor is not a customer
      expect((await request.get('/api/admin/customers/missing-id').set(adminHeader())).status).toBe(404);
    });
  });
});
