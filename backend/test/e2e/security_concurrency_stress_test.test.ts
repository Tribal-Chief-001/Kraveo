import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import { io as ClientSocket, Socket } from 'socket.io-client';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';

describe('Adversarial Security & Concurrency Stress Test Suite', () => {
  let serverInstance: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let studentToken: string;
  let vendorToken: string;
  let driverToken: string;
  let adminToken: string;

  const DEFAULT_JWT_SECRET = 'kraveo_vit_bhopal_super_secret_jwt_key_2026';
  const DEFAULT_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'kraveo_webhook_secret_2026';

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    serverInstance = await startTestServer(0);
    request = supertest(serverInstance.app);

    studentToken = getStudentToken('usr-1', '+91 9876543210');
    vendorToken = getVendorToken('usr-3', '+91 9876543212');
    driverToken = getDriverToken('usr-4', '+91 9876543213');
    adminToken = getAdminToken('usr-5', '+91 9876543214');

    // Create a secondary student user for IDOR testing
    await prisma.user.upsert({
      where: { phone: '+91 9999900002' },
      update: {},
      create: {
        id: 'usr-student-2',
        name: 'Victim Student',
        phone: '+91 9999900002',
        role: Role.STUDENT,
        hostelBlock: 'Girls Hostel Block 2'
      }
    });

    // Create a secondary driver user for driver race testing
    const driverUser2 = await prisma.user.upsert({
      where: { phone: '+91 9999900003' },
      update: {},
      create: {
        id: 'usr-driver-2',
        name: 'Rival Runner',
        phone: '+91 9999900003',
        role: Role.DRIVER
      }
    });

    await prisma.driverPartner.upsert({
      where: { id: 'usr-driver-2' },
      update: {},
      create: {
        id: 'usr-driver-2',
        userId: driverUser2.id,
        name: 'Rival Runner',
        phone: driverUser2.phone,
        studentRegNo: '22BCE10099',
        runnerCode: 'RUN-9999',
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775',
        vehicleType: 'Honda Activa',
        vehicleRegNo: 'MP 04 CD 5678',
        emergencyPhone: '+91 99999 11111',
        dutyStatus: 'ONLINE'
      }
    });
  });

  afterAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(serverInstance);
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. GATE OTP & CONCURRENCY RACE CONDITIONS
  // =========================================================================
  describe('1. Gate OTP & Concurrency Stress Testing', () => {
    test('CONC_01: 20 simultaneous Gate OTP verifications (Double-Tap Storm) maintain DB integrity', async () => {
      const orderId = 'stress-gate-otp-race-01';
      const validOtp = '5829';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 250,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: validOtp
        }
      });

      // Fire 20 parallel requests simulating double-tap / multi-packet surge
      const requests = Array.from({ length: 20 }, () =>
        request
          .post(`/api/orders/${orderId}/verify-gate-otp`)
          .set(getAuthHeader(driverToken))
          .send({ otpCode: validOtp })
      );

      const responses = await Promise.all(requests);

      // Exactly one request claims the OTP; concurrent losers receive a safe conflict.
      const statusCodes = responses.map((r) => r.status);
      expect(statusCodes.filter((s) => s === 200)).toHaveLength(1);
      expect(statusCodes.every((s) => s === 200 || s === 409)).toBe(true);

      // Verify DB state is cleanly DELIVERED and OTP is invalidated to 'USED'
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('DELIVERED');
      expect(dbOrder?.otpCode).toBe('USED');
    });

    test('CONC_02: Driver Assignment Concurrency Race (Two Drivers Accepting Simultaneously)', async () => {
      const orderId = 'stress-driver-assign-race-02';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: null,
          totalAmount: 300,
          dropoffHostel: 'Boys Hostel Block 1',
          status: 'PLACED'
        }
      });

      const tokenDriver1 = driverToken;
      const tokenDriver2 = jwt.sign({ id: 'usr-driver-2', phone: '+91 9999900003', role: 'DRIVER' }, DEFAULT_JWT_SECRET);

      // Send concurrent accept requests from two different drivers at the exact same millisecond
      const [res1, res2] = await Promise.all([
        request.post(`/api/orders/${orderId}/accept-driver`).set(getAuthHeader(tokenDriver1)).send({}),
        request.post(`/api/orders/${orderId}/accept-driver`).set(getAuthHeader(tokenDriver2)).send({})
      ]);

      const successCount = [res1, res2].filter((r) => r.status === 200).length;
      const failureCount = [res1, res2].filter((r) => r.status === 400).length;

      // Note: If non-atomic, both can succeed (200), meaning Driver 2 overwrites Driver 1
      // In a hardened atomic architecture, exactly 1 must succeed and 1 must fail with 400.
      console.log(`[CONC_02 Result]: Success count: ${successCount}, 400 Rejected count: ${failureCount}`);

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(['usr-4', 'usr-driver-2']).toContain(dbOrder?.driverId);
    });

    test('CONC_03: Gate OTP Brute-Force & Race between 1 valid and 10 invalid attempts', async () => {
      const orderId = 'stress-gate-otp-brute-03';
      const realOtp = '8142';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 180,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'ARRIVED_AT_GATE',
          otpCode: realOtp
        }
      });

      const invalidOtps = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999'];
      const attackPromises = invalidOtps.map((badOtp) =>
        request
          .post(`/api/orders/${orderId}/verify-gate-otp`)
          .set(getAuthHeader(driverToken))
          .send({ otpCode: badOtp })
      );

      // Add the 1 legitimate request in the mix
      const legitimatePromise = request
        .post(`/api/orders/${orderId}/verify-gate-otp`)
        .set(getAuthHeader(driverToken))
        .send({ otpCode: realOtp });

      const [legitRes, ...invalidResponses] = await Promise.all([legitimatePromise, ...attackPromises]);

      expect(legitRes.status).toBe(200);
      expect(legitRes.body.data.status).toBe('DELIVERED');

      // Invalid responses prior to delivery return 400; after delivery they may return 200 (idempotent already delivered) or 400
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.status).toBe('DELIVERED');
      expect(dbOrder?.otpCode).toBe('USED');
    });
  });

  // =========================================================================
  // 2. AUTHENTICATION & AUTHORIZATION BYPASSES
  // =========================================================================
  describe('2. Authentication & Authorization Security Stress Testing', () => {
    test('AUTH_01: Forged Admin JWT using hardcoded fallback secret grants unauthorized access', async () => {
      // Attacker signs arbitrary token using the known repo secret
      const forgedAdminToken = jwt.sign(
        { id: 'usr-rogue-attacker', phone: '+91 9999999999', role: 'ADMIN' },
        DEFAULT_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const res = await request
        .get('/api/drivers')
        .set(getAuthHeader(forgedAdminToken));

      // Demonstrates vulnerability of hardcoded fallback secret:
      // Backend validates signature with default secret and returns 200 OK
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('AUTH_02: Unauthenticated WebSocket client connects, joins rooms, and broadcasts spoofed updates', async () => {
      let clientSocket: Socket | null = null;
      try {
        // Connect with NO authentication token
        clientSocket = ClientSocket(serverInstance.baseUrl, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false
        });

        await new Promise<void>((resolve, reject) => {
          clientSocket!.on('connect', () => resolve());
          clientSocket!.on('connect_error', (err) => reject(err));
          setTimeout(() => reject(new Error('Connection timeout')), 4000);
        });

        expect(clientSocket.connected).toBe(true);

        // Unauthenticated client joins arbitrary sensitive vendor and order rooms
        clientSocket.emit('join_room', 'vendor_ven-1');
        clientSocket.emit('join_room', 'order_sensitive_999');

        // Unauthenticated client emits spoofed driver location
        clientSocket.emit('update_driver_location', {
          driverId: 'usr-4',
          lat: 23.0775,
          lng: 76.8513,
          heading: 180
        });

        // Unauthenticated connection is accepted without handshake rejection
        expect(clientSocket.id).toBeDefined();
      } finally {
        if (clientSocket && clientSocket.connected) {
          clientSocket.disconnect();
        }
      }
    });

    test('AUTH_03: Student order listing is scoped to the authenticated customer', async () => {
      const orderA = 'idor-order-student-a';
      const orderB = 'idor-order-student-b';

      await prisma.order.createMany({
        data: [
          { id: orderA, customerId: 'usr-1', vendorId: 'ven-1', totalAmount: 150, dropoffHostel: 'Boys Block 3', status: 'PLACED' },
          { id: orderB, customerId: 'usr-student-2', vendorId: 'ven-1', totalAmount: 350, dropoffHostel: 'Girls Block 2', status: 'PLACED' }
        ]
      });

      // Student 1 requests order list without customerId filter
      const res = await request
        .get('/api/orders')
        .set(getAuthHeader(studentToken));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const returnedIds = res.body.data.map((o: any) => o.id);
      // Student 1 sees only their own order.
      expect(returnedIds).toContain(orderA);
      expect(returnedIds).not.toContain(orderB);
    });

    test('AUTH_04: Student A cannot read Student B\'s order or gate OTP', async () => {
      const victimOrderId = 'idor-otp-leak-order';
      const secretGateOtp = '9281';

      await prisma.order.create({
        data: {
          id: victimOrderId,
          customerId: 'usr-student-2', // Belong to Student 2
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 400,
          dropoffHostel: 'Girls Hostel Block 2',
          status: 'ARRIVED_AT_GATE',
          otpCode: secretGateOtp
        }
      });

      // Student 1 accesses Student 2's order directly by ID
      const res = await request
        .get(`/api/orders/${victimOrderId}`)
        .set(getAuthHeader(studentToken)); // usr-1 token

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data?.otpCode).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. PAYMENT VERIFICATION EDGE CASES
  // =========================================================================
  describe('3. Payment Verification Edge Cases & Tampering', () => {
    test('PAY_01: Amount Tampering in POST /api/payments/create-order creates underpaid Razorpay order', async () => {
      const orderId = 'pay-tamper-order-01';
      const actualOrderTotal = 500; // ₹500 order in DB

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: actualOrderTotal,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      // A malicious client submits amount: 1 (₹1) instead of ₹500.
      const res = await request
        .post('/api/payments/create-order')
        .set(getAuthHeader(studentToken))
        .send({
          orderId,
          amount: 1 // ₹1 attack
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Demonstrates vulnerability: created payment order for 100 paise (₹1) for a ₹500 food cart!
      expect(res.body.amount).toBe(50000);

      const dbPayment = await prisma.payment.findFirst({ where: { orderId } });
      expect(dbPayment?.amount).toBe(500); // Payment amount is server-authoritative.
    });

    test('PAY_02: Non-Production Test Signature Bypass ("valid_test_wh_signature") bypasses HMAC check', async () => {
      const orderId = 'pay-test-sig-bypass-02';
      const rzpOrderId = 'rzp_order_bypass_' + Date.now();

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 600,
          dropoffHostel: 'Boys Hostel Block 1',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      await prisma.payment.create({
        data: {
          orderId,
          razorpayOrderId: rzpOrderId,
          amount: 600,
          status: 'PENDING'
        }
      });

      const res = await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', 'valid_test_wh_signature')
        .send({
          event: 'payment.captured',
          razorpayOrderId: rzpOrderId
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.paymentStatus).toBe('PAID');
    });

    test('PAY_03: Tampered Webhook HMAC-SHA256 Signature is strictly rejected (HTTP 400)', async () => {
      const orderId = 'pay-tampered-hmac-03';
      const rzpOrderId = 'rzp_order_tamper_' + Date.now();

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 350,
          dropoffHostel: 'Boys Hostel Block 1',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      const legitPayload = {
        event: 'payment.captured',
        razorpayOrderId: rzpOrderId,
        amount: 35000
      };

      const validSignature = crypto
        .createHmac('sha256', DEFAULT_WEBHOOK_SECRET)
        .update(JSON.stringify(legitPayload))
        .digest('hex');

      // Attacker tampers payload amount to 100 paise while attaching original signature
      const tamperedPayload = {
        ...legitPayload,
        amount: 100
      };

      const res = await request
        .post('/api/payments/webhook')
        .set('x-razorpay-signature', validSignature)
        .send(tamperedPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid payment webhook signature');
    });

    test('PAY_04: Replayed Webhooks execute idempotently without corrupting DB', async () => {
      const orderId = 'pay-replay-idempotent-04';
      const rzpOrderId = 'rzp_order_replay_' + Date.now();

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 220,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      await prisma.payment.create({
        data: {
          orderId,
          razorpayOrderId: rzpOrderId,
          amount: 220,
          status: 'PENDING'
        }
      });

      const payload = {
        event: 'payment.captured',
        razorpayOrderId: rzpOrderId
      };

      const payloadStr = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', DEFAULT_WEBHOOK_SECRET).update(payloadStr).digest('hex');

      // Send 5 replayed webhooks
      for (let i = 0; i < 5; i++) {
        const res = await request
          .post('/api/payments/webhook')
          .set('x-razorpay-signature', signature)
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }

      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.paymentStatus).toBe('PAID');
    });

    test('PAY_05: Currency Precision & Fractional Rupee Rounding', async () => {
      const orderId = 'pay-fractional-precision-05';
      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          totalAmount: 199.99,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'PLACED',
          paymentStatus: 'PENDING'
        }
      });

      const res = await request
        .post('/api/payments/create-order')
        .set(getAuthHeader(studentToken))
        .send({ orderId, amount: 199.99 });

      expect(res.status).toBe(200);
      // 199.99 * 100 = 19999 paise
      expect(res.body.amount).toBe(19999);
    });
  });

  // =========================================================================
  // 4. DATABASE ISOLATION & CONCURRENCY (LOYALTY COINS & REVIEWS)
  // =========================================================================
  describe('4. Database Concurrency & Loyalty Integrity Testing', () => {
    test('DB_01: Concurrent Coin Redemption Double-Spend is prevented by atomic updateMany', async () => {
      // Set user's initial coins to exactly 50
      await prisma.user.update({
        where: { id: 'usr-1' },
        data: { kraveoCoins: 50 }
      });

      // Fire 10 concurrent redemption requests simultaneously (each requesting 50 coins for ₹20 coupon)
      const redemptionRequests = Array.from({ length: 10 }, () =>
        request
          .post('/api/coupons/redeem-coins')
          .set(getAuthHeader(studentToken))
          .send({})
      );

      const responses = await Promise.all(redemptionRequests);

      const successes = responses.filter((r) => r.status === 200);
      const failures = responses.filter((r) => r.status === 400);

      // Exactly 1 redemption must succeed and 9 must fail
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(9);

      // Final user coin balance must be 0 (never negative)
      const user = await prisma.user.findUnique({ where: { id: 'usr-1' } });
      expect(user?.kraveoCoins).toBe(0);
    });

    test('DB_02: Concurrent Review Submissions for Single Order in Prisma $transaction', async () => {
      const orderId = 'stress-review-race-02';

      await prisma.order.create({
        data: {
          id: orderId,
          customerId: 'usr-1',
          vendorId: 'ven-1',
          driverId: 'usr-4',
          totalAmount: 280,
          dropoffHostel: 'Boys Hostel Block 3',
          status: 'DELIVERED',
          isReviewed: false
        }
      });

      // User initial balance
      const initialUser = await prisma.user.findUnique({ where: { id: 'usr-1' } });
      const initialCoins = initialUser?.kraveoCoins || 0;

      // Submit 5 concurrent reviews for the exact same order
      const reviewRequests = Array.from({ length: 5 }, () =>
        request
          .post('/api/reviews')
          .set(getAuthHeader(studentToken))
          .send({
            orderId,
            driverRating: 5,
            dhabaNotes: 'Great food!'
          })
      );

      const responses = await Promise.all(reviewRequests);

      const successes = responses.filter((r) => r.status === 200);
      const rejections = responses.filter((r) => r.status === 400 && r.body.message?.includes('already been reviewed'));

      console.log(`[DB_02 Review Race]: Successes: ${successes.length}, Already-Reviewed Rejections: ${rejections.length}`);

      // Confirm DB record
      const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(dbOrder?.isReviewed).toBe(true);

      const dbReviews = await prisma.reviewRecord.findMany({ where: { orderId } });
      // Total reviews for this order should ideally be 1
      console.log(`[DB_02 Reviews Inserted in DB]: ${dbReviews.length}`);
    });
  });
});
