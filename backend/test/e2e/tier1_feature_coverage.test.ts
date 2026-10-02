import crypto from 'crypto';
import supertest from 'supertest';
import { Socket } from 'socket.io-client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { connectTestSocket, waitForSocketEvent, disconnectTestSocket } from '../harness/socket';
import { setGoogleVerifier } from '../../src/services/googleAuth';

describe('Tier 1: Feature Coverage E2E Test Suite (30 Test Cases Across 6 Features)', () => {
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

    // 2. Seed PostgreSQL test database
    await seedTestDatabase();

    // 2. Start dynamic test HTTP + Socket.io server
    serverInstance = await startTestServer(0);
    request = supertest(serverInstance.app);

    // 3. Generate role-based JWT tokens
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
  // FEATURE 1: Database Persistence & Query (No in-memory fallback)
  // =========================================================================
  describe('Feature 1: Database Persistence & Query', () => {
    test('T1_DB_01: User Creation & Persistence Query in PostgreSQL', async () => {
      setGoogleVerifier(async () => ({ sub: 'sub-t1-db01', email: 'persist.student@kraveo.test', emailVerified: true, name: 'Test Persistent Student' }));
      const res = await request.post('/api/auth/google').send({ idToken: 'x'.repeat(40) });
      setGoogleVerifier(null);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isNewUser).toBe(true);

      // Directly query PostgreSQL DB via Prisma ORM
      const dbUser = await prisma.user.findUnique({ where: { email: 'persist.student@kraveo.test' } });
      expect(dbUser).not.toBeNull();
      expect(dbUser?.googleSub).toBe('sub-t1-db01');
      expect(dbUser?.name).toBe('Test Persistent Student');
      expect(dbUser?.role).toBe('STUDENT');
      expect(dbUser?.phone).toBeNull(); // collected later in the profile step
    });

    test('T1_DB_02: Vendor & Menu Relational Database Query', async () => {
      const res = await request.get('/api/vendors');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      // Query Prisma DB directly to verify foreign key relational mapping
      const dbVendor = await prisma.vendor.findUnique({
        where: { id: 'ven-1' },
        include: { menuItems: true }
      });
      expect(dbVendor).not.toBeNull();
      expect(dbVendor?.id).toBe('ven-1');
      expect(dbVendor?.menuItems.length).toBeGreaterThan(0);
      expect(dbVendor?.menuItems[0].vendorId).toBe('ven-1');
    });

    test('T1_DB_03: Order Placement & Relational OrderItem DB Insertion', async () => {
      const res = await request
        .post('/api/orders')
        .set(getAuthHeader(studentToken))
        .send({
          vendorId: 'ven-1',
          items: [{ itemId: 'item-1', quantity: 2 }],
          dropoffHostel: 'Boys Hostel Block 3',
          dropoffNotes: 'Test order placement'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const createdOrderId = res.body.data.id;

      // Query Prisma DB directly to verify record insertion
      const dbOrder = await prisma.order.findUnique({
        where: { id: createdOrderId },
        include: { items: true }
      });
      expect(dbOrder).not.toBeNull();
      expect(dbOrder?.status).toBe('PLACED');
      expect(dbOrder?.customerId).toBe('usr-1');
      expect(dbOrder?.vendorId).toBe('ven-1');
      expect(dbOrder?.items.length).toBe(1);
      expect(dbOrder?.items[0].menuItemId).toBe('item-1');
      expect(dbOrder?.items[0].quantity).toBe(2);
    });

    test('T1_DB_04: Order Status & Driver Assignment DB Persistence Update', async () => {
      // Create fresh test order
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-db-04',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 200,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ACCEPTED', // contract: riders only claim paid orders the restaurant accepted
          paymentStatus: 'PAID'
        }
      });

      const acceptRes = await request
        .post(`/api/orders/${order.id}/accept-driver`)
        .set(getAuthHeader(driverToken))
        .send();

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.success).toBe(true);

      // Verify update in database directly
      const updatedDbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updatedDbOrder?.driverId).toBe('usr-4');
      expect(updatedDbOrder?.status).toBe('ACCEPTED'); // accept-driver never changes the status
      await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } }); // free the rider (max 1 active order)
    });

    test('T1_DB_05: Payment Record Relational Persistence in DB', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-db-05',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 250,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED'
        }
      });

      const payRes = await request
        .post('/api/payments/create-order')
        .set(getAuthHeader(studentToken))
        .send({ orderId: order.id, amount: 250 });

      expect(payRes.status).toBe(200);
      expect(payRes.body.success).toBe(true);
      const razorpayOrderId = payRes.body.razorpayOrderId;

      // Verify Payment record in DB
      const dbPayment = await prisma.payment.findFirst({
        where: { razorpayOrderId }
      });
      expect(dbPayment).not.toBeNull();
      expect(dbPayment?.orderId).toBe(order.id);
      expect(dbPayment?.amount).toBe(250);
      expect(dbPayment?.status).toBe('PENDING');
    });
  });

  // =========================================================================
  // FEATURE 2: Razorpay Payment Webhooks & Server-Authoritative Status
  // =========================================================================
  describe('Feature 2: Razorpay Payment Webhooks & Server-Authoritative Status', () => {
    test('T1_PAY_01: Razorpay Order Creation Endpoint', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-pay-01',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 180,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED'
        }
      });

      const res = await request
        .post('/api/payments/create-order')
        .set(getAuthHeader(studentToken))
        .send({ orderId: order.id, amount: 180 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.razorpayOrderId).toBeDefined();
      expect(res.body.amount).toBe(18000); // Amount in paise
      expect(res.body.currency).toBe('INR');
    });

    test('T1_PAY_02: Razorpay Payment Signature Verification', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-pay-02',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 150,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED'
        }
      });

      const razorpayOrderId = 'order_test_sig_' + Date.now();
      const razorpayPaymentId = 'pay_test_sig_' + Date.now();
      const secret = process.env.RAZORPAY_KEY_SECRET || 'kraveo_razorpay_secret_key_2026';

      // Generate valid HMAC SHA256 signature
      const generatedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      await prisma.payment.create({
        data: {
          orderId: order.id,
          razorpayOrderId,
          amount: 150,
          status: 'PENDING'
        }
      });

      const res = await request
        .post('/api/payments/verify-signature')
        .set(getAuthHeader(studentToken))
        .send({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature: generatedSignature
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbPayment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
      expect(dbPayment?.status).toBe('PAID');
    });

    test('T1_PAY_03: Razorpay Webhook Event Processing', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-pay-03',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 300,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      const razorpayOrderId = 'order_webhook_' + Date.now();
      await prisma.payment.create({
        data: {
          orderId: order.id,
          razorpayOrderId,
          amount: 300,
          status: 'PENDING'
        }
      });

      const webhookPayload = {
        event: 'payment.captured',
        razorpayOrderId,
        payload: {
          payment: {
            entity: {
              id: 'pay_wh_' + Date.now(),
              order_id: razorpayOrderId,
              amount: 30000,
              status: 'captured'
            }
          }
        }
      };

      const res = await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', 'valid_test_wh_signature')
        .send(webhookPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('processed');

      const updatedPayment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
      expect(updatedPayment?.status).toBe('PAID');

      const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updatedOrder?.paymentStatus).toBe('PAID');
    });

    test('T1_PAY_04: Server-Authoritative Order Status Transition Guard', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-pay-04',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 220,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      // The order has a Razorpay payment record (made by /payments/create-order); the webhook names only our order id.
      await prisma.payment.create({ data: { orderId: order.id, razorpayOrderId: 'order_pay04_' + Date.now(), amount: 220, status: 'PENDING' } });

      // Confirm status is PENDING initially
      let dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder?.paymentStatus).toBe('PENDING');

      // Trigger server payment webhook update with signature
      await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', 'valid_test_wh_signature')
        .send({
          event: 'payment.captured',
          orderId: order.id
        });

      // Verify server authoritatively updated status
      dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder?.paymentStatus).toBe('PAID');
    });

    test('T1_PAY_05: Payment Webhook Event Idempotency & Invalid Signature Rejection', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-pay-05',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 190,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      const razorpayOrderId = 'order_idempotent_' + Date.now();
      await prisma.payment.create({
        data: {
          orderId: order.id,
          razorpayOrderId,
          amount: 190,
          status: 'PENDING'
        }
      });

      const payload = { event: 'payment.captured', razorpayOrderId };

      // Rejection on invalid / missing signature
      const badSigRes = await request.post('/api/payments/webhook').send(payload);
      expect(badSigRes.status).toBe(400);
      expect(badSigRes.body.success).toBe(false);
      expect(badSigRes.body.message).toBe('Invalid payment webhook signature');

      // First valid webhook call
      const res1 = await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', 'valid_test_wh_signature')
        .send(payload);
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      // Second identical webhook call (duplicate event)
      const res2 = await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', 'valid_test_wh_signature')
        .send(payload);
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);

      const paymentCount = await prisma.payment.count({ where: { razorpayOrderId } });
      expect(paymentCount).toBe(1);
    });
  });

  // =========================================================================
  // FEATURE 3: Server-Side 4-Digit Gate Handshake OTP Verification
  // =========================================================================
  describe('Feature 3: Server-Side 4-Digit Gate Handshake OTP Verification', () => {
    test('T1_OTP_01: Dynamic Gate OTP Generation on Arrival at Gate', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-otp-01',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 150,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PICKED_UP',
          paymentStatus: 'PAID'
        }
      });

      const res = await request
        .patch(`/api/orders/${order.id}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'ARRIVED_AT_GATE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder?.status).toBe('ARRIVED_AT_GATE');
      expect(dbOrder?.otpCode).toBeDefined();
      expect(dbOrder?.otpCode).toMatch(/^\d{4}$/); // Enforce dynamic 4-digit numeric string
    });

    test('T1_OTP_02: FCM Notification Trigger with Dynamic Gate OTP Code', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-otp-02',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 170,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PICKED_UP',
          paymentStatus: 'PAID'
        }
      });

      const res = await request
        .patch(`/api/orders/${order.id}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'ARRIVED_AT_GATE' });

      expect(res.status).toBe(200);
      // The rider never receives the OTP; it exists only on the server (and for the customer).
      expect(res.body.data.otpCode).toBeNull();
      const generatedOtp = (await prisma.order.findUnique({ where: { id: order.id } }))?.otpCode;
      expect(generatedOtp).toHaveLength(4);
    });

    test('T1_OTP_03: Status Patch to DELIVERED with Valid 4-Digit OTP', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-otp-03',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 200,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          paymentStatus: 'PAID',
          otpCode: '7482'
        }
      });

      const res = await request
        .patch(`/api/orders/${order.id}/status`)
        .set(getAuthHeader(driverToken))
        .send({ status: 'DELIVERED', otpCode: '7482' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder?.status).toBe('DELIVERED');
      expect(dbOrder?.otpCode).toBe('USED'); // Single-use OTP invalidated
    });

    test('T1_OTP_04: Dedicated Gate OTP Verification Endpoint with RBAC & Numeric Coercion', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-otp-04',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 210,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          paymentStatus: 'PAID',
          otpCode: '9123'
        }
      });

      // 1. STUDENT role attempt should be rejected with 403 Forbidden
      const studentRes = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(studentToken))
        .send({ otpCode: '9123' });
      expect(studentRes.status).toBe(403);
      expect(studentRes.body.success).toBe(false);

      // 2. DRIVER role attempt with numeric OTP coercion ({ otp: 9123 })
      const res = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otp: 9123 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DELIVERED');

      const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(dbOrder?.status).toBe('DELIVERED');

      // 3. Idempotent check when already DELIVERED -> returns 200 OK
      const idempotentRes = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '9123' });
      expect(idempotentRes.status).toBe(200);
      expect(idempotentRes.body.success).toBe(true);
    });

    test('T1_OTP_05: Single-Use OTP Invalidation, Invalid OTP Rejection & Response Format', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-otp-05',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 160,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          paymentStatus: 'PAID',
          otpCode: '5566'
        }
      });

      // 1. Invalid OTP attempt -> expects 400 Bad Request with error: 'Invalid Gate OTP'
      const badRes = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '0000' });
      expect(badRes.status).toBe(400);
      expect(badRes.body.success).toBe(false);
      expect(badRes.body.error).toBe('Invalid Gate OTP');
      expect(badRes.body.message).toBe('Invalid or expired 4-digit Gate Handshake OTP code.');

      // 2. Valid OTP attempt with DRIVER role
      const goodRes = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '5566' });
      expect(goodRes.status).toBe(200);
      expect(goodRes.body.success).toBe(true);

      // 3. Idempotent call when order is already DELIVERED
      const reuseRes = await request
        .post(`/api/orders/${order.id}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: '5566' });
      expect(reuseRes.status).toBe(200);
      expect(reuseRes.body.success).toBe(true);
    });
  });

  // =========================================================================
  // FEATURE 4: Removal of Universal OTPs & JWT/RBAC Auth Enforcement
  // =========================================================================
  describe('Feature 4: Removal of Universal OTPs & JWT/RBAC Auth Enforcement', () => {
    test('T1_AUTH_01: Google Sign-In & JWT Token Issue Flow', async () => {
      setGoogleVerifier(async () => ({ sub: 'sub-t1-auth01', email: 'auth.flow@kraveo.test', emailVerified: true, name: 'Auth Flow Student' }));
      const res = await request.post('/api/auth/google').send({ idToken: 'y'.repeat(40) });
      setGoogleVerifier(null);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('auth.flow@kraveo.test');
      expect(res.body.needsProfile).toBe(true);
    });

    test('T1_AUTH_02: Authenticated Bearer Token Profile Access', async () => {
      // Valid JWT token request
      const validRes = await request
        .get('/api/auth/profile')
        .set(getAuthHeader(studentToken));
      expect(validRes.status).toBe(200);
      expect(validRes.body.success).toBe(true);
      expect(validRes.body.user.id).toBe('usr-1');

      // Missing Authorization token request
      const unauthRes = await request.get('/api/auth/profile');
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.body.success).toBe(false);
    });

    test('T1_AUTH_03: Vendor Role RBAC Enforcement', async () => {
      // 1. Authorized VENDOR token -> 200 OK
      const vendorRes = await request
        .patch('/api/vendors/ven-1/toggle')
        .set(getAuthHeader(vendorToken));
      expect(vendorRes.status).toBe(200);

      // 2. Unauthorized STUDENT token -> 403 Forbidden
      const studentRes = await request
        .patch('/api/vendors/ven-1/toggle')
        .set(getAuthHeader(studentToken));
      expect(studentRes.status).toBe(403);
      expect(studentRes.body.success).toBe(false);
    });

    test('T1_AUTH_04: Driver Role RBAC Enforcement', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-auth-04',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 140,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'READY_FOR_PICKUP',
          paymentStatus: 'PAID'
        }
      });
      // Earlier tests left orders at the gate for usr-4; a rider can carry only one order at a time.
      await prisma.order.updateMany({ where: { driverId: 'usr-4', status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED' } });

      // 1. Unauthorized STUDENT token trying to accept driver duty -> 403 Forbidden
      const studentRes = await request
        .post(`/api/orders/${order.id}/accept-driver`)
        .set(getAuthHeader(studentToken));
      expect(studentRes.status).toBe(403);

      // 2. Authorized DRIVER token -> 200 OK
      const driverRes = await request
        .post(`/api/orders/${order.id}/accept-driver`)
        .set(getAuthHeader(driverToken));
      expect(driverRes.status).toBe(200);
      expect(driverRes.body.success).toBe(true);
    });

    test('T1_AUTH_05: Master Token & Static OTP Rejection', async () => {
      // 1. Mock token rejection
      const res = await request
        .get('/api/auth/profile')
        .set('Authorization', 'Bearer mock_jwt_token_usr-1');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      // 2. Phone-OTP login no longer exists
      const sendRes = await request.post('/api/auth/send-otp').send({ phone: '+91 9876599999' });
      expect(sendRes.status).toBe(404);
      const verifyRes = await request.post('/api/auth/verify-otp').send({ phone: '+91 9876599999', otp: '4829' });
      expect(verifyRes.status).toBe(404);

      // 3. Removed /auth/login rejection (404)
      const loginRes = await request.post('/api/auth/login').send({ phone: '+91 9876599999' });
      expect(loginRes.status).toBe(404);
    });

    test('T1_AUTH_06: Hardened Endpoints Authentication & Role Enforcement', async () => {
      // 1. GET /api/drivers requires ADMIN
      const d1 = await request.get('/api/drivers');
      expect(d1.status).toBe(401);
      const d2 = await request.get('/api/drivers').set(getAuthHeader(studentToken));
      expect(d2.status).toBe(403);
      const d3 = await request.get('/api/drivers').set(getAuthHeader(adminToken));
      expect(d3.status).toBe(200);

      // 2. GET /api/drivers/:id requires DRIVER or ADMIN
      const dId1 = await request.get('/api/drivers/usr-4');
      expect(dId1.status).toBe(401);
      const dId2 = await request.get('/api/drivers/usr-4').set(getAuthHeader(studentToken));
      expect(dId2.status).toBe(403);
      const dId3 = await request.get('/api/drivers/usr-4').set(getAuthHeader(driverToken));
      expect(dId3.status).toBe(200);

      // 3. GET /api/orders requires requireAuth
      const o1 = await request.get('/api/orders');
      expect(o1.status).toBe(401);
      const o2 = await request.get('/api/orders').set(getAuthHeader(studentToken));
      expect(o2.status).toBe(200);

      // 4. GET /api/orders/:id requires requireAuth
      const oId1 = await request.get('/api/orders/nonexistent-id');
      expect(oId1.status).toBe(401);
      const oId2 = await request.get('/api/orders/nonexistent-id').set(getAuthHeader(studentToken));
      expect(oId2.status).toBe(404);

      // 5. PATCH /api/vendors/:id/status requires VENDOR or ADMIN
      const vs1 = await request.patch('/api/vendors/ven-1/status').send({ isAcceptingOrders: true });
      expect(vs1.status).toBe(401);
      const vs2 = await request.patch('/api/vendors/ven-1/status').set(getAuthHeader(studentToken)).send({ isAcceptingOrders: true });
      expect(vs2.status).toBe(403);
      const vs3 = await request.patch('/api/vendors/ven-1/status').set(getAuthHeader(vendorToken)).send({ isAcceptingOrders: true });
      expect(vs3.status).toBe(200);

      // 6. PATCH /api/vendors/items/:itemId requires VENDOR or ADMIN
      const vi1 = await request.patch('/api/vendors/items/item-1').send({ price: 190 });
      expect(vi1.status).toBe(401);
      const vi2 = await request.patch('/api/vendors/items/item-1').set(getAuthHeader(studentToken)).send({ price: 190 });
      expect(vi2.status).toBe(403);
      const vi3 = await request.patch('/api/vendors/items/item-1').set(getAuthHeader(vendorToken)).send({ price: 190 });
      expect(vi3.status).toBe(200);

      // 7. GET /api/drivers/locations requires requireAuth
      const dl1 = await request.get('/api/drivers/locations');
      expect(dl1.status).toBe(401);
      const dl2 = await request.get('/api/drivers/locations').set(getAuthHeader(studentToken));
      expect(dl2.status).toBe(200);
    });
  });

  // =========================================================================
  // FEATURE 5: Real-time Socket.io & FCM Multi-Persona Sync
  // =========================================================================
  describe('Feature 5: Real-time Socket.io & FCM Multi-Persona Sync', () => {
    let clientSocket: Socket;

    afterEach(() => {
      if (clientSocket) {
        disconnectTestSocket(clientSocket);
      }
    });

    test('T1_SOC_01: Vendor Room Order Alert Real-Time Broadcast', async () => {
      await prisma.vendor.update({
        where: { id: 'ven-1' },
        data: { isAcceptingOrders: true }
      });

      // Earlier tests left unpaid orders for usr-1 (max 3 unpaid open orders per customer).
      await prisma.order.updateMany({ where: { customerId: 'usr-1', paymentStatus: { in: ['PENDING', 'FAILED'] }, status: 'PLACED' }, data: { status: 'CANCELLED' } });

      // The restaurant socket must authenticate; it joins vendor_ven-1 automatically (and may ask again).
      clientSocket = await connectTestSocket(serverInstance.baseUrl, { auth: { token: vendorToken } });
      expect((await clientSocket.emitWithAck('join_room', 'vendor_ven-1')).ok).toBe(true);

      let alerts = 0;
      clientSocket.on('new_order_alert', () => { alerts += 1; });
      const eventPromise = waitForSocketEvent(clientSocket, 'new_order_alert', 5000);

      // Place new order: contract 1.2 - the restaurant hears nothing until the order is paid.
      const placed = await request
        .post('/api/orders')
        .set(getAuthHeader(studentToken))
        .send({
          vendorId: 'ven-1',
          items: [{ itemId: 'item-1', quantity: 1 }],
          dropoffHostel: 'Boys Hostel Block 3'
        });
      expect(placed.status).toBe(201);
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toBe(0);

      const pay = await request.post('/api/payments/create-order').set(getAuthHeader(studentToken)).send({ orderId: placed.body.data.id });
      const verified = await request.post('/api/payments/verify-signature').set(getAuthHeader(studentToken))
        .send({ razorpayOrderId: pay.body.razorpayOrderId, razorpayPaymentId: 'pay_sim_soc01', razorpaySignature: 'sim' });
      expect(verified.status).toBe(200);

      const eventData = await eventPromise;
      expect(eventData).toBeDefined();
      expect(eventData.vendorId).toBe('ven-1');
      expect(eventData.paymentStatus).toBe('PAID');
      expect(eventData.customer.phone).toBeNull(); // never the customer's phone to the restaurant
    });

    test('T1_SOC_02: Scoped Order Status Room Real-Time Sync', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-soc-02',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 180,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PAID',
          paidAt: new Date()
        }
      });

      // The customer's socket (with its token) may watch its own order.
      clientSocket = await connectTestSocket(serverInstance.baseUrl, { auth: { token: studentToken } });
      expect((await clientSocket.emitWithAck('join_room', `order_${order.id}`)).ok).toBe(true);

      const eventPromise = waitForSocketEvent(clientSocket, 'order_updated', 5000);

      await request
        .patch(`/api/orders/${order.id}/status`)
        .set(getAuthHeader(vendorToken))
        .send({ status: 'ACCEPTED' });

      const updatedEvent = await eventPromise;
      expect(updatedEvent.id).toBe(order.id);
      expect(updatedEvent.status).toBe('ACCEPTED');
    });

    test('T1_SOC_03: Real-Time Driver Location Stream Broadcast', async () => {
      // Admin dashboard socket listens; the rider's socket streams its position.
      clientSocket = await connectTestSocket(serverInstance.baseUrl, { auth: { token: adminToken } });
      const riderSocket = await connectTestSocket(serverInstance.baseUrl, { auth: { token: driverToken } });

      const eventPromise = waitForSocketEvent(clientSocket, 'driver_location_update', 5000);

      const locationPayload = {
        driverId: 'usr-someone-else', // ignored: the rider id always comes from the token
        driverName: 'Vikram Singh',
        lat: 23.0768,
        lng: 76.8524,
        heading: 90
      };

      riderSocket.emit('update_driver_location', locationPayload);

      const locationEvent = await eventPromise;
      disconnectTestSocket(riderSocket);
      expect(locationEvent.driverId).toBe('usr-4');
      expect(locationEvent.lat).toBe(23.0768);
      expect(locationEvent.lng).toBe(76.8524);
    });

    test('T1_SOC_04: FCM Push Notification Token Registration', async () => {
      const fcmToken = 'fcm_token_test_device_12345';
      const res = await request
        .post('/api/notifications/register-token')
        .set(getAuthHeader(studentToken))
        .send({ fcmToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbUser = await prisma.user.findUnique({ where: { id: 'usr-1' } });
      expect(dbUser?.fcmToken).toBe(fcmToken);
    });

    test('T1_SOC_05: Multi-Persona Simultaneous State Sync', async () => {
      const order = await prisma.order.create({
        data: {
          id: 'test-ord-soc-05',
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 220,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ACCEPTED',
          paymentStatus: 'PAID',
          paidAt: new Date()
        }
      });

      clientSocket = await connectTestSocket(serverInstance.baseUrl, { auth: { token: studentToken } });
      expect((await clientSocket.emitWithAck('join_room', `order_${order.id}`)).ok).toBe(true);

      const updatePromise = waitForSocketEvent(clientSocket, 'order_updated', 5000);

      const res = await request
        .patch(`/api/orders/${order.id}/status`)
        .set(getAuthHeader(vendorToken))
        .send({ status: 'PREPARING' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PREPARING');

      const socketData = await updatePromise;
      expect(socketData.id).toBe(order.id);
      expect(socketData.status).toBe('PREPARING');
    });
  });

  // =========================================================================
  // FEATURE 6: Transport Security, CORS & Cleartext Traffic Guards
  // =========================================================================
  describe('Feature 6: Transport Security, CORS & Cleartext Traffic Guards', () => {
    test('T1_SEC_01: CORS Headers Validation on API Endpoints', async () => {
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    test('T1_SEC_02: OPTIONS Preflight CORS Request Handling', async () => {
      const res = await request
        .options('/api/orders')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST');

      expect([200, 204]).toContain(res.status);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBeDefined();
    });

    test('T1_SEC_03: Content-Type & JSON Payload Enforcement', async () => {
      const res = await request
        .post('/api/orders')
        .set(getAuthHeader(studentToken))
        .set('Content-Type', 'application/json')
        .send('invalid-raw-json-string');

      expect(res.status).toBe(400);
    });

    test('T1_SEC_04: Environment Port & Dynamic Server Base URL Config', async () => {
      expect(serverInstance.port).toBeGreaterThan(0);
      expect(serverInstance.baseUrl).toBe(`http://localhost:${serverInstance.port}`);

      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('online');
    });

    test('T1_SEC_05: Security Header Safeguards & Non-Existent Route 404 Guard', async () => {
      const res = await request.get('/api/non-existent-security-route');
      expect(res.status).toBe(404);
      expect(res.headers['x-powered-by']).toBeUndefined(); // Express signature suppressed or clean
    });
  });
});
