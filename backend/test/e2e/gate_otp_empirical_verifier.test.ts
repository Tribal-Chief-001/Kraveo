import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';

describe('Empirical Verification: Gate OTP & Delivery Security (Milestone 3 Subtask 2)', () => {
  let serverInstance: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let studentToken: string;
  let vendorToken: string;
  let driverToken: string;
  let adminToken: string;

  beforeAll(async () => {
    // 1. Clean previous test artifacts from database
    await cleanTestOrders();
    await cleanTestUsers();

    // 2. Seed test database
    await seedTestDatabase();

    // 3. Start dynamic test HTTP server
    serverInstance = await startTestServer(0);
    request = supertest(serverInstance.app);

    // 4. Generate role-based JWT tokens
    studentToken = getStudentToken('usr-1', '+91 9876543210');
    vendorToken = getVendorToken('usr-3', '+91 9876543212');
    driverToken = getDriverToken('usr-4', '+91 9876543213');
    adminToken = getAdminToken('usr-5', '+91 9876543214');
  });

  afterAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(serverInstance);
    await prisma.$disconnect();
  });

  // =========================================================================
  // REQUIREMENT 1: ARRIVED_AT_GATE generates random 4-digit OTP in Order record
  // =========================================================================
  describe('Requirement 1: ARRIVED_AT_GATE OTP Generation', () => {
    test('EMP_OTP_01: Transition to ARRIVED_AT_GATE generates random 4-digit numeric OTP in DB', async () => {
      const orderId = 'gate-otp-test-ord-01';
      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 250,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PICKED_UP'
        }
      });

      const res = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'ARRIVED_AT_GATE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ARRIVED_AT_GATE');
      expect(res.body.data.otpCode).toBeDefined();

      const generatedOtp = res.body.data.otpCode;
      expect(typeof generatedOtp).toBe('string');
      expect(generatedOtp).toHaveLength(4);
      expect(generatedOtp).toMatch(/^\d{4}$/);

      // Verify Prisma DB record directly
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder).not.toBeNull();
      expect(dbOrder?.status).toBe('ARRIVED_AT_GATE');
      expect(dbOrder?.otpCode).toBe(generatedOtp);
    });

    test('EMP_OTP_02: Transitioning to ARRIVED_AT_GATE generates dynamic distinct 4-digit OTPs', async () => {
      const orderId1 = 'gate-otp-test-ord-02a';
      const orderId2 = 'gate-otp-test-ord-02b';

      await prisma.order.createMany({
        data: [
          { id: orderId1, customerId: 'usr-1', vendorId: 'ven-1', driverId: 'usr-4', totalAmount: 100, dropoffHostel: 'Block 1', status: 'PICKED_UP' },
          { id: orderId2, customerId: 'usr-1', vendorId: 'ven-1', driverId: 'usr-4', totalAmount: 100, dropoffHostel: 'Block 1', status: 'PICKED_UP' }
        ]
      });

      const res1 = await request.patch(`/api/orders/${orderId1}/status`).set(getAuthHeader(driverToken)).send({ status: 'ARRIVED_AT_GATE' });
      const res2 = await request.patch(`/api/orders/${orderId2}/status`).set(getAuthHeader(driverToken)).send({ status: 'ARRIVED_AT_GATE' });

      expect(res1.body.data.otpCode).toMatch(/^\d{4}$/);
      expect(res2.body.data.otpCode).toMatch(/^\d{4}$/);
    });
  });

  // =========================================================================
  // REQUIREMENT 2: DELIVERED transition requires matching OTP (otpCode / otp, string / int)
  // =========================================================================
  describe('Requirement 2: DELIVERED Transition with Matching OTP Variants', () => {
    test('EMP_OTP_03: PATCH status to DELIVERED with matching string otpCode succeeds', async () => {
      const orderId = 'gate-otp-test-ord-03';
      const expectedOtp = '4321';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 150,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: expectedOtp
        }
      });

      const res = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otpCode: expectedOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('DELIVERED');
      expect(dbOrder?.otpCode).toBe('USED');
    });

    test('EMP_OTP_04: POST verify-gate-otp with integer key `otp` ({ otp: 8765 }) succeeds', async () => {
      const orderId = 'gate-otp-test-ord-04';
      const expectedOtpNum = 8765;

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 180,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '8765'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otp: expectedOtpNum });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('DELIVERED');
      expect(dbOrder?.otpCode).toBe('USED');
    });

    test('EMP_OTP_05: PATCH status to DELIVERED with integer key `otp` ({ status: "DELIVERED", otp: 5432 }) succeeds', async () => {
      const orderId = 'gate-otp-test-ord-05';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 210,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '5432'
        }
      });

      const res = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otp: 5432 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');
    });

    test('EMP_OTP_06: POST verify-gate-otp with string key `otpCode` ({ otpCode: "9988" }) succeeds', async () => {
      const orderId = 'gate-otp-test-ord-06';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 220,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '9988'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '9988' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');
    });
  });

  // =========================================================================
  // REQUIREMENT 3: Transition to DELIVERED with invalid OTP returns HTTP 400 with { success: false, error: "Invalid Gate OTP" }
  // =========================================================================
  describe('Requirement 3: Invalid Gate OTP Rejection Payload & HTTP 400', () => {
    test('EMP_OTP_07: PATCH status to DELIVERED with invalid OTP returns HTTP 400 with { success: false, error: "Invalid Gate OTP" }', async () => {
      const orderId = 'gate-otp-test-ord-07';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 200,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '1122'
        }
      });

      const res = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otpCode: '9999' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid Gate OTP');

      // Verify order status remains ARRIVED_AT_GATE in DB
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('ARRIVED_AT_GATE');
      expect(dbOrder?.otpCode).toBe('1122');
    });

    test('EMP_OTP_08: POST verify-gate-otp with invalid OTP returns HTTP 400 with { success: false, error: "Invalid Gate OTP" }', async () => {
      const orderId = 'gate-otp-test-ord-08';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 230,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '3344'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otp: '0000' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid Gate OTP');
    });

    test('EMP_OTP_09: Missing OTP body in DELIVERED transition returns HTTP 400 with { success: false, error: "Invalid Gate OTP" }', async () => {
      const orderId = 'gate-otp-test-ord-09';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 190,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '5566'
        }
      });

      const res = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid Gate OTP');
    });
  });

  // =========================================================================
  // REQUIREMENT 4: Repeated delivery transition returns HTTP 200 OK (idempotency)
  // =========================================================================
  describe('Requirement 4: Delivery Transition Idempotency', () => {
    test('EMP_OTP_10: Repeated PATCH status to DELIVERED on already DELIVERED order returns HTTP 200 OK', async () => {
      const orderId = 'gate-otp-test-ord-10';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 300,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '6677'
        }
      });

      // First call transition to DELIVERED
      const firstRes = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otpCode: '6677' });

      expect(firstRes.status).toBe(200);
      expect(firstRes.body.success).toBe(true);

      // Second repeated call transition to DELIVERED (idempotency check)
      const secondRes = await request
        .patch(`/api/orders/${orderId}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otpCode: '6677' });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.success).toBe(true);
      expect(secondRes.body.message).toContain('already DELIVERED');

      // Verify DB record status is still DELIVERED
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('DELIVERED');
    });

    test('EMP_OTP_11: Repeated POST verify-gate-otp on already DELIVERED order returns HTTP 200 OK', async () => {
      const orderId = 'gate-otp-test-ord-11';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 270,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '7788'
        }
      });

      // Verify OTP first time
      const firstRes = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '7788' });

      expect(firstRes.status).toBe(200);
      expect(firstRes.body.success).toBe(true);

      // Verify OTP second time (idempotency)
      const secondRes = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '7788' });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.success).toBe(true);
      expect(secondRes.body.message).toContain('already DELIVERED');
    });
  });

  // =========================================================================
  // REQUIREMENT 5: POST /api/orders/:id/verify-gate-otp enforces DRIVER/ADMIN authorization
  // =========================================================================
  describe('Requirement 5: Authorization Enforcement on Dedicated Gate OTP Endpoint', () => {
    test('EMP_OTP_12: Unauthenticated request to verify-gate-otp returns HTTP 401 Unauthorized', async () => {
      const orderId = 'gate-otp-test-ord-12';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 140,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '1212'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .send({ otpCode: '1212' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test('EMP_OTP_13: STUDENT role request to verify-gate-otp returns HTTP 403 Forbidden', async () => {
      const orderId = 'gate-otp-test-ord-13';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 160,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '3434'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(studentToken))
        .send({ otpCode: '3434' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test('EMP_OTP_14: VENDOR role request to verify-gate-otp returns HTTP 403 Forbidden', async () => {
      const orderId = 'gate-otp-test-ord-14';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 170,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '5656'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(vendorToken))
        .send({ otpCode: '5656' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    test('EMP_OTP_15: DRIVER role request to verify-gate-otp succeeds (HTTP 200)', async () => {
      const orderId = 'gate-otp-test-ord-15';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 190,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '7878'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '7878' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');
    });

    test('EMP_OTP_16: ADMIN role request to verify-gate-otp succeeds (HTTP 200)', async () => {
      const orderId = 'gate-otp-test-ord-16';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 220,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: '9090'
        }
      });

      const res = await request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(adminToken))
        .send({ otpCode: '9090' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');
    });
  });
});
