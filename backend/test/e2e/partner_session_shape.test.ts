/**
 * Bug-hunt round 2 (VE-01/VE-02/VE-03, DR-02/DR-07/DR-09/DR-10): the partner apps parse several answers as a "session", so the
 * real HTTP shapes matter. Re-apply (PUT /partner/application) must carry `user`; partner-login must carry the caller's own
 * profile details; riders get `dutyStatus`; a suspended partner's old token says why it ended, an unrelated token does not.
 */
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { __resetSignupLimiter } from '../../src/routes/partners';

const adminHeader = () => getAuthHeader(getAdminToken('usr-5', '+91 9876543214'));
const PW = 'Sup3rSecret!';
const NAME_PREFIX = 'ZZ Test';

describe('Partner session shapes (bug-hunt round 2)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;

  const vPhone = '9000000381';
  const dPhone = '9000000382';
  const signup = (body: object) => request.post('/api/auth/partner-signup').send(body);
  const login = (phone: string, role: string) => request.post('/api/auth/partner-login').send({ phone, password: PW, role });
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
  beforeEach(() => { __resetLoginLimiter(); __resetSignupLimiter(); });

  describe('restaurant', () => {
    let token = '';
    let vendorId = '';
    let userId = '';

    test('re-apply after a rejection answers with the same user/profile shape as /partner/me', async () => {
      const s = await signup({ role: 'VENDOR', name: 'Ramesh Kumar', phone: vPhone, password: PW, restaurantName: `${NAME_PREFIX} Shape Dhaba`, category: 'North Indian', address: 'Ashta road, near gate 2', fssaiNumber: '12345678901234' });
      expect(s.status).toBe(201);
      token = s.body.token; vendorId = s.body.vendor.id; userId = s.body.user.id;
      expect((await setStatus('vendor', vendorId, 'REJECTED', 'FSSAI number does not match')).status).toBe(200);

      const h = getAuthHeader(token);
      const put = await request.put('/api/partner/application').set(h).send({ name: 'Ramesh K Sharma', address: 'Gate 2 food court' });
      expect(put.status).toBe(200);
      const me = await request.get('/api/partner/me').set(h);
      expect(put.body.user).toEqual({ id: userId, name: 'Ramesh K Sharma', phone: expect.any(String), role: 'VENDOR', avatarId: null });
      expect(put.body.user).toEqual(me.body.user);
      // unchanged keys
      expect(put.body.success).toBe(true);
      expect(put.body.approvalStatus).toBe('PENDING');
      expect(put.body.rejectionReason).toBeNull();
      expect(put.body.vendor).toEqual(me.body.vendor);
      expect(put.body.vendor).toMatchObject({ id: vendorId, address: 'Gate 2 food court', category: 'North Indian', fssaiNumber: '12345678901234' });
      expect(put.body.driver).toBeUndefined();
      expect(Object.keys(put.body).sort()).toEqual(['approvalStatus', 'rejectionReason', 'success', 'user', 'vendor']);
    });

    test('partner-login returns the restaurant details of the caller (address, category, FSSAI), and no secrets', async () => {
      const res = await login(vPhone, 'VENDOR');
      expect(res.status).toBe(200);
      expect(res.body.vendor).toMatchObject({ id: vendorId, category: 'North Indian', address: 'Gate 2 food court', fssaiNumber: '12345678901234', approvalStatus: 'PENDING' });
      // the keys the login answer always had are still there
      expect(res.body.vendor).toHaveProperty('isAcceptingOrders');
      expect(res.body.vendor).toHaveProperty('rejectionReason');
      expect(res.body.user.id).toBe(userId);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion|scrypt/i);
      // same details /partner/me gives
      const me = await request.get('/api/partner/me').set(getAuthHeader(res.body.token));
      for (const k of ['category', 'address', 'fssaiNumber']) expect(res.body.vendor[k]).toEqual(me.body.vendor[k]);
    });

    test('a suspended restaurant\'s old token says the account is paused; a forged or unknown token learns nothing', async () => {
      expect((await setStatus('vendor', vendorId, 'APPROVED')).status).toBe(200);
      const live = (await login(vPhone, 'VENDOR')).body.token;
      expect((await request.get('/api/partner/me').set(getAuthHeader(live))).status).toBe(200);
      expect((await setStatus('vendor', vendorId, 'SUSPENDED', 'Customer complaints')).status).toBe(200);

      const res = await request.get('/api/partner/me').set(getAuthHeader(live));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_REVOKED');
      expect(res.body.reason).toBe('ACCOUNT_SUSPENDED');
      expect(res.body.message).toMatch(/paused/i);

      // Token signed with a wrong secret for this very user id: generic answer, no account state.
      const forged = jwt.sign({ id: userId, phone: vPhone, role: 'VENDOR', tv: 0 }, 'not-the-real-secret');
      const f = await request.get('/api/partner/me').set(getAuthHeader(forged));
      expect(f.status).toBe(401);
      expect(f.body.reason).toBeUndefined();
      expect(JSON.stringify(f.body)).not.toMatch(/paus|suspend/i);
      // No token at all: also nothing.
      const none = await request.get('/api/partner/me');
      expect(none.status).toBe(401);
      expect(JSON.stringify(none.body)).not.toMatch(/paus|suspend/i);
    });

    test('a revoked session of a partner who is NOT suspended (password reset) gets the plain answer', async () => {
      expect((await setStatus('vendor', vendorId, 'APPROVED')).status).toBe(200);
      __resetLoginLimiter();
      const live = (await login(vPhone, 'VENDOR')).body.token;
      await request.post(`/api/admin/partners/${userId}/reset-password`).set(adminHeader()).send({ password: 'Brand-New-Pass1' });
      const res = await request.get('/api/partner/me').set(getAuthHeader(live));
      expect([res.status, res.body.code, res.body.reason]).toEqual([401, 'TOKEN_REVOKED', undefined]);
    });
  });

  describe('rider', () => {
    let token = '';
    let driverId = '';
    let userId = '';

    test('re-apply after a rejection answers with the same user/profile shape as /partner/me', async () => {
      const s = await signup({ role: 'DRIVER', name: 'Sunil Verma', phone: dPhone, password: PW, vehicleType: 'Scooter', vehicleRegNo: 'MP04 AB 1234', emergencyPhone: '9000000999', upiId: 'sunil@okaxis' });
      expect(s.status).toBe(201);
      token = s.body.token; driverId = s.body.driver.id; userId = s.body.user.id;
      expect((await setStatus('driver', driverId, 'REJECTED', 'Plate unreadable')).status).toBe(200);

      const h = getAuthHeader(token);
      const put = await request.put('/api/partner/application').set(h).send({ vehicleRegNo: 'mp04 cd 5678' });
      expect(put.status).toBe(200);
      const me = await request.get('/api/partner/me').set(h);
      expect(put.body.user).toEqual({ id: userId, name: 'Sunil Verma', phone: expect.any(String), role: 'DRIVER', avatarId: null });
      expect(put.body.user).toEqual(me.body.user);
      expect(put.body.success).toBe(true);
      expect(put.body.approvalStatus).toBe('PENDING');
      expect(put.body.rejectionReason).toBeNull();
      expect(put.body.driver).toEqual(me.body.driver);
      expect(put.body.driver).toMatchObject({ id: driverId, vehicleType: 'Scooter', vehicleRegNo: 'MP04 CD 5678', approvalStatus: 'PENDING' });
      expect(put.body.vendor).toBeUndefined();
      expect(Object.keys(put.body).sort()).toEqual(['approvalStatus', 'driver', 'rejectionReason', 'success', 'user']);
    });

    test('partner-login returns the rider\'s own vehicle, plate, UPI, emergency contact and duty state, and no secrets', async () => {
      const res = await login(dPhone, 'DRIVER');
      expect(res.status).toBe(200);
      expect(res.body.driver).toMatchObject({ id: driverId, vehicleType: 'Scooter', vehicleRegNo: 'MP04 CD 5678', upiId: 'sunil@okaxis', approvalStatus: 'PENDING', dutyStatus: 'OFFLINE' });
      expect(res.body.driver.emergencyPhone).toEqual(expect.stringContaining('9000000999'));
      expect(res.body.driver).toHaveProperty('runnerCode');
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion|scrypt/i);
      const me = await request.get('/api/partner/me').set(getAuthHeader(res.body.token));
      expect(res.body.driver).toEqual(me.body.driver);
    });

    test('/partner/me and partner-login report the server\'s duty state', async () => {
      expect((await setStatus('driver', driverId, 'APPROVED')).status).toBe(200);
      __resetLoginLimiter();
      const t = (await login(dPhone, 'DRIVER')).body.token;
      expect((await request.get('/api/partner/me').set(getAuthHeader(t))).body.driver.dutyStatus).toBe('OFFLINE');
      expect((await request.post('/api/drivers/duty-status').set(getAuthHeader(t)).send({ isOnline: true })).body.dutyStatus).toBe('ONLINE');
      expect((await request.get('/api/partner/me').set(getAuthHeader(t))).body.driver.dutyStatus).toBe('ONLINE');
      __resetLoginLimiter();
      expect((await login(dPhone, 'DRIVER')).body.driver.dutyStatus).toBe('ONLINE');
      await request.post('/api/drivers/duty-status').set(getAuthHeader(t)).send({ isOnline: false });
      expect((await request.get('/api/partner/me').set(getAuthHeader(t))).body.driver.dutyStatus).toBe('OFFLINE');
    });

    test('a suspended rider\'s old token says the account is paused', async () => {
      __resetLoginLimiter();
      const live = (await login(dPhone, 'DRIVER')).body.token;
      expect((await setStatus('driver', driverId, 'SUSPENDED', 'No-show')).status).toBe(200);
      const res = await request.get('/api/partner/me').set(getAuthHeader(live));
      expect([res.status, res.body.code, res.body.reason]).toEqual([401, 'TOKEN_REVOKED', 'ACCOUNT_SUSPENDED']);
    });
  });
});
