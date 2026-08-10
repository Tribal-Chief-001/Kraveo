import crypto from 'crypto';
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getAuthHeader } from '../harness/auth';

describe('Empirical Verification: Payment Webhook Functionality (Milestone 3 Subtask 1)', () => {
  let serverInstance: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let studentToken: string;

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'kraveo_webhook_secret_2026';

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    serverInstance = await startTestServer(0);
    request = supertest(serverInstance.app);
    studentToken = getStudentToken('usr-1', '+91 9876543210');
  });

  afterAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(serverInstance);
    await prisma.$disconnect();
  });

  test('EMP_WH_01: Reject webhook with MISSING signature (HTTP 400 & DB Unchanged)', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-01',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 150,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const payload = {
      event: 'payment.captured',
      orderId: order.id,
      payload: {
        payment: {
          entity: {
            id: 'pay_missing_sig_123',
            amount: 15000,
            notes: { orderId: order.id }
          }
        }
      }
    };

    // Send WITHOUT x-razorpay-signature header
    const res = await request
      .post('/api/payments/webhook')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid payment webhook signature');

    // Confirm DB state has NOT transitioned
    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PENDING');
    expect(dbOrder?.status).toBe('PLACED');
  });

  test('EMP_WH_02: Reject webhook with INVALID HMAC signature (HTTP 400 & DB Unchanged)', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-02',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 200,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const payload = {
      event: 'payment.captured',
      orderId: order.id
    };

    // Send WITH invalid signature header
    const res = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'invalid_fake_hmac_signature_999')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid payment webhook signature');

    // Confirm DB state has NOT transitioned
    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PENDING');
  });

  test('EMP_WH_03: Accept webhook with VALID HMAC-SHA256 signature (HTTP 200 & DB State Updated)', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-03',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 250,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const razorpayOrderId = 'order_rzp_hmac_' + Date.now();

    await prisma.payment.create({
      data: {
        orderId: order.id,
        razorpayOrderId,
        amount: 250,
        status: 'PENDING'
      }
    });

    const payloadObj = {
      event: 'payment.captured',
      razorpayOrderId,
      payload: {
        payment: {
          entity: {
            id: 'pay_hmac_' + Date.now(),
            order_id: razorpayOrderId,
            amount: 25000,
            status: 'captured',
            notes: { orderId: order.id }
          }
        }
      }
    };

    const rawBodyString = JSON.stringify(payloadObj);

    // Compute exact HMAC-SHA256 signature using raw payload string and webhook secret
    const validHmacSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBodyString)
      .digest('hex');

    const res = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', validHmacSignature)
      .send(payloadObj);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('processed');

    // Confirm Payment table state transition in DB
    const dbPayment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
    expect(dbPayment?.status).toBe('PAID');

    // Confirm Order table state transitions in DB (Order.paymentStatus = 'PAID', Order.status = 'PLACED')
    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PAID');
    expect(dbOrder?.status).toBe('PLACED');
  });

  test('EMP_WH_04: Accept webhook with TEST SIGNATURE ("valid_test_wh_signature") (HTTP 200 & DB Updated)', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-04',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 320,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const razorpayOrderId = 'order_rzp_test_sig_' + Date.now();

    await prisma.payment.create({
      data: {
        orderId: order.id,
        razorpayOrderId,
        amount: 320,
        status: 'PENDING'
      }
    });

    const payload = {
      event: 'payment.captured',
      razorpayOrderId,
      payload: {
        payment: {
          entity: {
            id: 'pay_test_sig_' + Date.now(),
            order_id: razorpayOrderId,
            amount: 32000,
            status: 'captured'
          }
        }
      }
    };

    const res = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'valid_test_wh_signature')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('processed');

    // Confirm Payment table update in DB
    const dbPayment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
    expect(dbPayment?.status).toBe('PAID');

    // Confirm Order table update in DB
    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PAID');
    expect(dbOrder?.status).toBe('PLACED');
  });

  test('EMP_WH_05: Webhook payload with direct orderId fallback (HTTP 200 & DB Updated)', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-05',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 180,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const payload = {
      event: 'payment.captured',
      orderId: order.id
    };

    const res = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'valid_test_wh_signature')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PAID');
    expect(dbOrder?.status).toBe('PLACED');
  });

  test('EMP_WH_06: Idempotent duplicate webhook calls return HTTP 200 without DB corruption', async () => {
    const order = await prisma.order.create({
      data: {
        id: 'emp-wh-order-06',
        customerId: 'usr-1',
        vendorId: 'ven-1',
        totalAmount: 210,
        dropoffHostel: 'Boys Hostel Block 1',
        status: 'PLACED',
        paymentStatus: 'PENDING'
      }
    });

    const razorpayOrderId = 'order_rzp_idempotent_' + Date.now();

    await prisma.payment.create({
      data: {
        orderId: order.id,
        razorpayOrderId,
        amount: 210,
        status: 'PENDING'
      }
    });

    const payload = {
      event: 'payment.captured',
      razorpayOrderId
    };

    // First call
    const res1 = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'valid_test_wh_signature')
      .send(payload);

    expect(res1.status).toBe(200);

    // Second (duplicate) call
    const res2 = await request
      .post('/api/payments/webhook')
      .set('x-razorpay-signature', 'valid_test_wh_signature')
      .send(payload);

    expect(res2.status).toBe(200);

    const dbPayment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
    expect(dbPayment?.status).toBe('PAID');

    const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(dbOrder?.paymentStatus).toBe('PAID');
  });
});
