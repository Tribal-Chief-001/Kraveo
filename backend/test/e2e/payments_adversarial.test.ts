/**
 * Payments & money-integrity audit (adversarial). Companion to order_flow_v1.test.ts.
 *
 * Every test either PASSES (proves a money property) or FAILS and is named `BUG:` (proves a defect).
 * Failing BUG tests are deliberately left failing so the lead sees them; none is skipped.
 * The defects fixed by the 2026-10-03 hardening (coupons, menu prices, empty key secret) and by the payment reliability
 * pass (reconciliation, refund retry policy, SDK error mapping, hung provider, verify-signature, duplicate payments,
 * refund webhooks) are now `PROVE:` tests; no `BUG:` test is left.
 * The payment provider is the in-memory simulator wrapped by a spy / fault injector (setPaymentProvider).
 * Real Razorpay behaviour is NOT exercised here (no network); the SDK tests run the real razorpay npm
 * package against a fake HTTP adapter to check request shapes.
 */
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import supertest from 'supertest';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { setPaymentProvider, createSimulatedProvider, PaymentProvider, PaymentProviderError, toProviderError } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork, executeRefund } from '../../src/services/refundService';
import { markOrderPaid } from '../../src/services/orderFlow';
import { validateAndCalculateOrder } from '../../src/utils/validation';

jest.setTimeout(60_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const VENDOR = { id: 'usr-3', phone: '+91 9876543212' };
const RIDER = { id: 'usr-4', phone: '+91 9876543213' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tVendor = getVendorToken(VENDOR.id, VENDOR.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const H = (t: string) => getAuthHeader(t);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

// ---------------------------------------------------------------------------------------------
// Fault-injecting provider (wraps the simulator, which refuses over-refunds like Razorpay does)
// ---------------------------------------------------------------------------------------------
type Ctl = {
  down?: boolean; // every refund + list call throws a 503-shaped SDK error
  hang?: boolean; // every refund + list call never answers
  refundFailTimes?: number; // refund throws before reaching the provider
  refundThrowAfterTimes?: number; // refund IS performed at the provider, then the answer is lost
  listFailTimes?: number;
  createOrderFailTimes?: number;
  refundGate?: Promise<void> | null; // first refund call waits here before it reaches the provider
  fetchDown?: boolean; // fetchPayment / capturePayment / fetchOrderPayments / listPayments throw a 503-shaped SDK error
  fetchHang?: boolean; // ... never answer
  fetchNetworkError?: boolean; // ... throw a typed network error (no HTTP status)
};
const sdkError = (statusCode: number, description: string) => ({ statusCode, error: { code: statusCode >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST_ERROR', description } });

const makeProvider = (ctl: Ctl = {}) => {
  const sim = createSimulatedProvider();
  const calls = { createOrder: [] as any[], refund: [] as any[], list: [] as string[], fetchPayment: [] as string[], capture: [] as string[], orderPayments: [] as string[], listPayments: 0 };
  const fetchGuard = async () => {
    if (ctl.fetchHang) await new Promise<never>(() => {});
    if (ctl.fetchDown) throw sdkError(503, 'provider down (fetch)');
    if (ctl.fetchNetworkError) throw new PaymentProviderError('Could not reach the payment provider (network error).', null, true);
  };
  let gateUsed = false;
  const provider: PaymentProvider = {
    async createOrder(i) {
      calls.createOrder.push(i);
      if ((ctl.createOrderFailTimes ?? 0) > 0) { ctl.createOrderFailTimes!--; throw sdkError(503, 'provider unavailable'); }
      return sim.createOrder(i);
    },
    async listRefunds(id) {
      calls.list.push(id);
      if (ctl.hang) return new Promise<never>(() => {});
      if (ctl.down) throw sdkError(503, 'provider down');
      if ((ctl.listFailTimes ?? 0) > 0) { ctl.listFailTimes!--; throw sdkError(503, 'provider down (list)'); }
      return sim.listRefunds(id);
    },
    async refundPayment(i) {
      calls.refund.push(i);
      if (ctl.hang) return new Promise<never>(() => {});
      if (ctl.down) throw sdkError(503, 'provider down');
      if ((ctl.refundFailTimes ?? 0) > 0) { ctl.refundFailTimes!--; throw sdkError(503, 'provider down (refund)'); }
      if (ctl.refundGate && !gateUsed) { gateUsed = true; await ctl.refundGate; }
      const r = await sim.refundPayment(i);
      if ((ctl.refundThrowAfterTimes ?? 0) > 0) { ctl.refundThrowAfterTimes!--; throw new Error('socket hang up'); }
      return r;
    },
    async fetchPayment(id, hint) { calls.fetchPayment.push(id); await fetchGuard(); return sim.fetchPayment(id, hint); },
    async capturePayment(id, amount) { calls.capture.push(id); await fetchGuard(); return sim.capturePayment(id, amount); },
    async fetchOrderPayments(id) { calls.orderPayments.push(id); await fetchGuard(); return sim.fetchOrderPayments(id); },
    async listPayments(q) { calls.listPayments += 1; await fetchGuard(); return sim.listPayments(q); },
  };
  return { provider, sim, calls, ctl };
};

// ---------------------------------------------------------------------------------------------
// env helpers for the "is the test shortcut reachable in production" tests
// ---------------------------------------------------------------------------------------------
const applyEnv = (env: Record<string, string | undefined>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  return () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
};
const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const restore = applyEnv(env);
  try { return fn(); } finally { restore(); }
};
const withEnvAsync = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const restore = applyEnv(env);
  try { return await fn(); } finally { restore(); }
};
type PaymentServiceModule = typeof import('../../src/services/paymentService');
const loadPaymentService = (): PaymentServiceModule => {
  let m: any;
  jest.isolateModules(() => { m = require('../../src/services/paymentService'); });
  return m;
};
const hmac = (key: string, data: string | Buffer) => crypto.createHmac('sha256', key).update(data).digest('hex');

// deterministic PRNG so failures are reproducible
const prng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('Payments adversarial audit', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let P: ReturnType<typeof makeProvider>;
  const useProvider = (ctl: Ctl = {}) => { P = makeProvider(ctl); setPaymentProvider(P.provider); return P; };

  // ---------------- API helpers ----------------
  const place = (token = tStudent, extra: Record<string, unknown> = {}) =>
    request.post('/api/orders').set(H(token)).send({
      vendorId: 'ven-1', items: [{ itemId: 'item-1', quantity: 1 }], dropoffHostel: 'Block 2', clientRequestId: randomUUID(), ...extra,
    });
  const createPayment = (orderId: string, token = tStudent) => request.post('/api/payments/create-order').set(H(token)).send({ orderId });
  const verify = (rzp: string, payId = `pay_${randomUUID().slice(0, 12)}`, token = tStudent, sig = 'sim') =>
    request.post('/api/payments/verify-signature').set(H(token)).send({ razorpayOrderId: rzp, razorpayPaymentId: payId, razorpaySignature: sig });
  const webhook = (body: unknown, signature = 'valid_test_wh_signature') =>
    request.post('/api/payments/webhook').set('x-razorpay-signature', signature).send(body as any);
  const captured = (rzp: string, paise: number, payId: string, extra: Record<string, unknown> = {}, event = 'payment.captured') => ({
    event, payload: { payment: { entity: { id: payId, order_id: rzp, amount: paise, status: 'captured', notes: {}, ...extra } } },
  });
  const setStatus = (id: string, status: string, token: string, extra: object = {}) => request.patch(`/api/orders/${id}/status`).set(H(token)).send({ status, ...extra });
  const claim = (id: string, token = tRider) => request.post(`/api/orders/${id}/accept-driver`).set(H(token)).send({});
  const adminCancel = (id: string, reason = 'adversarial cancel') => request.post(`/api/admin/orders/${id}/cancel`).set(H(tAdmin)).send({ reason });
  const customerCancel = (id: string) => request.post(`/api/orders/${id}/cancel`).set(H(tStudent)).send({});
  const vendorReject = (id: string) => request.post(`/api/orders/${id}/reject`).set(H(tVendor)).send({ reason: 'adversarial reject' });
  const retryRefund = (id: string) => request.post(`/api/admin/orders/${id}/retry-refund`).set(H(tAdmin)).send({});
  const needsAttention = async () => (await request.get('/api/admin/orders/needs-attention').set(H(tAdmin))).body.data as any[];
  const db = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const refundsOf = async (orderId: string) => {
    const pays = await prisma.payment.findMany({ where: { orderId } });
    return pays.flatMap((p) => (p.razorpayPaymentId ? P.sim.refunds.get(p.razorpayPaymentId) ?? [] : []));
  };

  const placePaid = async (token = tStudent) => {
    const placed = await place(token);
    expect(placed.status).toBe(201);
    const pay = await createPayment(placed.body.data.id, token);
    expect(pay.status).toBe(200);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    const v = await verify(pay.body.razorpayOrderId, payId, token);
    expect(v.status).toBe(200);
    return { id: placed.body.data.id as string, rzp: pay.body.razorpayOrderId as string, payId };
  };
  const driveTo = async (target: string) => {
    const o = await placePaid();
    if (target === 'PLACED') return o;
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      expect((await setStatus(o.id, st, tVendor)).status).toBe(200);
      if (st === target) return o;
    }
    expect((await claim(o.id)).status).toBe(200);
    if (target === 'CLAIMED') return o;
    expect((await setStatus(o.id, 'PICKED_UP', tRider)).status).toBe(200);
    if (target === 'PICKED_UP') return o;
    expect((await setStatus(o.id, 'ARRIVED_AT_GATE', tRider)).status).toBe(200);
    return o;
  };
  /** Order written straight to the database: optionally paid (captured payment recorded). */
  const mkOrder = async (o: { paid?: boolean; ageMin?: number; paidAgoMin?: number | null; status?: string; total?: number; driverId?: string | null } = {}) => {
    const total = o.total ?? 220;
    const payId = `pay_adv_${randomUUID().slice(0, 12)}`;
    const created = await prisma.order.create({
      data: {
        customerId: STUDENT.id, vendorId: 'ven-1', driverId: o.driverId ?? null, totalAmount: total, subtotal: total - 40, deliveryFee: 25, taxAndPackaging: 15,
        dropoffHostel: 'Block 3', status: (o.status ?? 'PLACED') as any, paymentStatus: o.paid ? 'PAID' : 'PENDING',
        createdAt: minutesAgo(o.ageMin ?? 1),
        paidAt: o.paid ? minutesAgo(o.paidAgoMin ?? 1) : null,
        payments: { create: [o.paid
          ? { razorpayOrderId: `rzp_order_sim_${randomUUID().slice(0, 10)}`, razorpayPaymentId: payId, amount: total, capturedAmountPaise: Math.round(total * 100), status: 'PAID' }
          : { razorpayOrderId: `rzp_order_sim_${randomUUID().slice(0, 10)}`, amount: total, status: 'PENDING' }] },
      },
      include: { payments: true },
    });
    return { id: created.id, rzp: created.payments[0].razorpayOrderId, payId, order: created };
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await seedTestDatabase();
    await prisma.menuItem.deleteMany({ where: { id: { startsWith: 'adv-' } } });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    useProvider();
    // leftovers from earlier tests must not be picked up by the (time-shifted) job runs of this test
    // (unpaid Payment rows leave the reconcile window; parked extra-payment rows are not retried)
    await prisma.payment.updateMany({ where: { status: { in: ['PENDING', 'FAILED'] } }, data: { createdAt: new Date(Date.now() - 8 * 3_600_000) } });
    await prisma.payment.updateMany({ where: { status: { in: ['PENDING', 'FAILED'] }, capturedAmountPaise: { not: null } }, data: { refundedAt: new Date(Date.now() + 365 * 86_400_000) } });
    await prisma.order.updateMany({ where: { refundStatus: { in: ['PENDING', 'FAILED'] } }, data: { refundStatus: 'DONE', paymentStatus: 'REFUNDED' } });
    await prisma.order.updateMany({ where: { paymentStatus: 'PAID', status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await prisma.order.updateMany({ where: { driverId: RIDER.id, status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await prisma.order.updateMany({ where: { status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.vendor.update({ where: { id: 'ven-1' }, data: { isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
    await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
    await prisma.user.update({ where: { id: STUDENT.id }, data: { kraveoCoins: 30 } });
  });

  afterEach(async () => {
    await __waitForBackgroundWork();
    setPaymentProvider(null);
  });

  afterAll(async () => {
    await prisma.menuItem.deleteMany({ where: { OR: [{ id: { startsWith: 'adv-' } }, { name: { startsWith: 'adv-' } }] } });
    await stopTestServer(server);
  });

  // =============================================================================================
  // 1. CONSERVATION OF MONEY
  // =============================================================================================
  describe('1. conservation of money', () => {
    test('PROVE: paid + delivered keeps the money; replays, late cancels, job runs and retry-refund never refund it', async () => {
      const o = await driveTo('ARRIVED_AT_GATE');
      const otp = (await db(o.id)).otpCode!;
      const done = await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: otp });
      expect(done.status).toBe(200);
      // everything an attacker / a buggy client / the job could still try:
      await webhook(captured(o.rzp, 22000, o.payId));
      await verify(o.rzp, o.payId);
      expect((await adminCancel(o.id)).status).toBe(409);
      expect((await customerCancel(o.id)).status).toBe(409);
      expect((await vendorReject(o.id)).status).toBeGreaterThanOrEqual(400);
      expect((await retryRefund(o.id)).status).toBe(409);
      await runOrderMaintenance(minutesFromNow(600));
      await executeRefund(o.id);
      const row = await db(o.id);
      expect(row.status).toBe('DELIVERED');
      expect(row.paymentStatus).toBe('PAID');
      expect(row.otpCode).toBe('USED');
      expect(P.calls.refund.length).toBe(0);
      expect(await refundsOf(o.id)).toHaveLength(0);
    });

    test.each([
      ['customer', async (id: string) => customerCancel(id)],
      ['vendor reject', async (id: string) => vendorReject(id)],
      ['admin', async (id: string) => adminCancel(id)],
      ['system (restaurant did not respond)', async (id: string) => {
        await prisma.order.update({ where: { id }, data: { paidAt: minutesAgo(11) } });
        await runOrderMaintenance();
        return { status: 200 } as any;
      }],
    ])('PROVE: paid + cancelled by %s -> exactly one full refund, stays exactly one after every repeat', async (_name, cancel) => {
      const o = await placePaid();
      expect((await cancel(o.id)).status).toBe(200);
      await __waitForBackgroundWork();
      // hammer every path that could refund again
      await Promise.all([customerCancel(o.id), adminCancel(o.id), vendorReject(o.id), retryRefund(o.id), runOrderMaintenance(minutesFromNow(30)), executeRefund(o.id), executeRefund(o.id)]);
      await webhook(captured(o.rzp, 22000, o.payId));
      await verify(o.rzp, o.payId);
      const row = await db(o.id);
      expect(row.status).toBe('CANCELLED');
      expect(row.paymentStatus).toBe('REFUNDED');
      expect(row.refundStatus).toBe('DONE');
      expect(row.payments[0].status).toBe('REFUNDED');
      expect(row.payments[0].razorpayRefundId).toBeTruthy();
      const refunds = await refundsOf(o.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amountPaise).toBe(22000);
      expect(P.calls.refund.length).toBe(1);
    });

    test('PROVE: payment arriving after cancel (customer / admin / expiry) is refunded exactly once even with 8 concurrent verify+webhook callers', async () => {
      for (const how of ['customer', 'admin', 'expiry'] as const) {
        const placed = await place();
        const pay = await createPayment(placed.body.data.id);
        const id = placed.body.data.id as string;
        const rzp = pay.body.razorpayOrderId as string;
        const payId = `pay_late_${how}_${randomUUID().slice(0, 8)}`;
        if (how === 'customer') await customerCancel(id);
        if (how === 'admin') await adminCancel(id);
        if (how === 'expiry') { await prisma.order.update({ where: { id }, data: { createdAt: minutesAgo(16) } }); await runOrderMaintenance(); }
        expect((await db(id)).status).toBe('CANCELLED');
        await Promise.all([
          verify(rzp, payId), verify(rzp, payId),
          webhook(captured(rzp, 22000, payId)), webhook(captured(rzp, 22000, payId)), webhook(captured(rzp, 22000, payId)),
          webhook(captured(rzp, 22000, payId, {}, 'order.paid')), webhook(captured(rzp, 22000, payId)), verify(rzp, payId),
        ]);
        await __waitForBackgroundWork();
        await runOrderMaintenance(minutesFromNow(5));
        const row = await db(id);
        expect(row.status).toBe('CANCELLED');
        expect(row.paymentStatus).toBe('REFUNDED');
        expect(row.paidAt).toBeNull(); // the restaurant never saw it
        expect(P.sim.refunds.get(payId)).toHaveLength(1);
        expect(P.calls.refund.filter((r) => r.paymentId === payId)).toHaveLength(1);
      }
    });

    test('PROVE: unpaid expiry never touches the refund provider and leaves no money state', async () => {
      const placed = await place();
      await createPayment(placed.body.data.id);
      await prisma.order.update({ where: { id: placed.body.data.id }, data: { createdAt: minutesAgo(16) } });
      await runOrderMaintenance();
      const row = await db(placed.body.data.id);
      expect(row.status).toBe('CANCELLED');
      expect(row.cancelledBy).toBe('SYSTEM');
      expect(row.paymentStatus).toBe('PENDING');
      expect(row.refundStatus).toBeNull();
      expect(P.calls.refund.length + P.calls.list.length).toBe(0);
    });

    test('PROVE: failed -> retry paid works; a stale payment.failed after success or after refund never downgrades PAID/REFUNDED', async () => {
      const placed = await place();
      const pay = await createPayment(placed.body.data.id);
      const id = placed.body.data.id; const rzp = pay.body.razorpayOrderId; const payId = 'pay_retry_1';
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail_0', order_id: rzp, amount: 22000 } } } });
      expect((await db(id)).paymentStatus).toBe('FAILED');
      expect((await createPayment(id)).body.razorpayOrderId).toBe(rzp); // same Razorpay order reused
      await webhook(captured(rzp, 22000, payId));
      expect((await db(id)).paymentStatus).toBe('PAID');
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail_stale', order_id: rzp, amount: 22000 } } } });
      expect((await db(id)).paymentStatus).toBe('PAID');
      await adminCancel(id);
      await __waitForBackgroundWork();
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail_stale2', order_id: rzp, amount: 22000 } } } });
      const row = await db(id);
      expect(row.paymentStatus).toBe('REFUNDED');
      expect(row.payments[0].status).toBe('REFUNDED');
      expect(P.sim.refunds.get(payId)).toHaveLength(1);
    });

    test('PROVE: webhook-only, verify-only and both all end PAID once; 12 concurrent markOrderPaid calls give exactly one PAID outcome', async () => {
      const a = await mkOrder(); const b = await mkOrder(); const c = await mkOrder();
      expect((await webhook(captured(a.rzp, 22000, 'pay_wh_only'))).body.status).toBe('processed');
      expect((await verify(b.rzp, 'pay_verify_only')).status).toBe(200);
      const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        markOrderPaid(i % 2 ? { razorpayOrderId: c.rzp, razorpayPaymentId: 'pay_both', amountPaise: 22000, source: 'WEBHOOK' } : { razorpayOrderId: c.rzp, razorpayPaymentId: 'pay_both', source: 'VERIFY' })));
      expect(outcomes.filter((x) => x.outcome === 'PAID')).toHaveLength(1);
      expect(outcomes.filter((x) => x.outcome === 'ALREADY_PAID')).toHaveLength(11);
      for (const x of [a, b, c]) {
        const row = await db(x.id);
        expect(row.paymentStatus).toBe('PAID');
        expect(row.paidAt).not.toBeNull();
        expect(row.payments).toHaveLength(1);
      }
    });
  });

  // =============================================================================================
  // 2. DOUBLE SPEND / DOUBLE REFUND
  // =============================================================================================
  describe('2. double spend and double refund', () => {
    test('PROVE: 12 concurrent create-order calls open exactly one Razorpay order; paid/cancelled/refunded orders cannot open another', async () => {
      const placed = await place();
      const id = placed.body.data.id;
      const rs = await Promise.all(Array.from({ length: 12 }, () => createPayment(id)));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(new Set(rs.map((r) => r.body.razorpayOrderId)).size).toBe(1);
      expect(P.calls.createOrder).toHaveLength(1);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1);
      await verify(rs[0].body.razorpayOrderId, 'pay_ds1');
      expect((await createPayment(id)).body.code).toBe('ALREADY_PAID');
      await adminCancel(id); await __waitForBackgroundWork();
      expect((await createPayment(id)).body.code).toBe('ALREADY_PAID'); // REFUNDED
      expect(P.calls.createOrder).toHaveLength(1);
    });

    test('PROVE: a provider failure while creating the Razorpay order leaves no orphan payment row and the retry works', async () => {
      const p = useProvider({ createOrderFailTimes: 1 });
      const placed = await place();
      const id = placed.body.data.id;
      expect((await createPayment(id)).status).toBe(503);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(0);
      expect((await createPayment(id)).status).toBe(200);
      expect(p.calls.createOrder).toHaveLength(2);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1);
    });

    test('PROVE: a second captured payment on a paid order (second Razorpay order) is flagged, refunded automatically by its OWN payment id exactly once, and changes nothing else; the original is refunded later by a cancel', async () => {
      const o = await placePaid();
      const dupRzp = `rzp_order_sim_dup_${randomUUID().slice(0, 8)}`;
      await prisma.payment.create({ data: { orderId: o.id, razorpayOrderId: dupRzp, amount: 220, status: 'PENDING' } });
      const w = await webhook(captured(dupRzp, 22000, 'pay_second'));
      expect(w.body.status).toBe('rejected');
      expect(w.body.code).toBe('DUPLICATE_PAYMENT');
      await __waitForBackgroundWork();
      // the extra payment (and only it) was refunded
      expect(P.sim.refunds.get('pay_second')).toHaveLength(1);
      expect(P.sim.refunds.get('pay_second')![0].amountPaise).toBe(22000);
      expect(P.sim.refunds.get(o.payId) ?? []).toHaveLength(0);
      // the order and its original payment are untouched
      const row = await db(o.id);
      expect(row.paymentStatus).toBe('PAID');
      expect(row.status).toBe('PLACED');
      expect(row.refundStatus).toBeNull();
      const original = row.payments.find((x) => x.razorpayPaymentId === o.payId)!;
      expect(original).toMatchObject({ status: 'PAID', razorpayRefundId: null, refundedAt: null });
      const extra = row.payments.find((x) => x.razorpayOrderId === dupRzp)!;
      expect(extra).toMatchObject({ status: 'REFUNDED', razorpayPaymentId: 'pay_second', capturedAmountPaise: 22000, razorpayRefundId: P.sim.refunds.get('pay_second')![0].id });
      // flag cleared, audit trail written
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems ?? []).not.toContain('DUPLICATE_PAYMENT');
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_DUPLICATE' } })).toBe(1);
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_DUPLICATE_REFUNDED' } })).toBe(1);
      // replays (webhook x2, job) never refund it again
      await Promise.all([webhook(captured(dupRzp, 22000, 'pay_second')), webhook(captured(dupRzp, 22000, 'pay_second')), runOrderMaintenance(minutesFromNow(5))]);
      await __waitForBackgroundWork();
      expect(P.calls.refund.filter((c) => c.paymentId === 'pay_second')).toHaveLength(1);
      // a later cancel refunds the ORIGINAL payment (the refunded extra row is not mistaken for it)
      await adminCancel(o.id); await __waitForBackgroundWork();
      expect(P.sim.refunds.get(o.payId)).toHaveLength(1);
      expect(P.sim.refunds.get('pay_second')).toHaveLength(1);
      const done = await db(o.id);
      expect(done).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(done.payments.find((x) => x.razorpayPaymentId === o.payId)).toMatchObject({ status: 'REFUNDED', razorpayRefundId: P.sim.refunds.get(o.payId)![0].id });
    });

    test('PROVE: a duplicate captured payment is refunded automatically (customer is not double-charged until a human acts)', async () => {
      const o = await placePaid();
      const dupRzp = `rzp_order_sim_dup2_${randomUUID().slice(0, 8)}`;
      await prisma.payment.create({ data: { orderId: o.id, razorpayOrderId: dupRzp, amount: 220, status: 'PENDING' } });
      await webhook(captured(dupRzp, 22000, 'pay_second_auto'));
      await __waitForBackgroundWork();
      await runOrderMaintenance();
      expect(P.sim.refunds.get('pay_second_auto') ?? []).toHaveLength(1);
    });

    test('PROVE: duplicate payment while the provider is down: stays flagged, retried by the job with backoff, refunded once when the provider is back; 12 concurrent webhooks = one attempt', async () => {
      const p = useProvider({ down: true });
      const o = await placePaid();
      const dupRzp = `rzp_order_sim_dup3_${randomUUID().slice(0, 8)}`;
      await prisma.payment.create({ data: { orderId: o.id, razorpayOrderId: dupRzp, amount: 220, status: 'PENDING' } });
      await Promise.all(Array.from({ length: 12 }, () => webhook(captured(dupRzp, 22000, 'pay_second_down'))));
      await __waitForBackgroundWork();
      expect(p.calls.list.filter((x) => x === 'pay_second_down').length).toBe(1); // the claim let one worker through
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems).toContain('DUPLICATE_PAYMENT');
      expect((await db(o.id)).payments.find((x) => x.razorpayOrderId === dupRzp)!.status).not.toBe('REFUNDED');
      await runOrderMaintenance(); // inside the backoff: no new provider call
      expect(p.calls.list.filter((x) => x === 'pay_second_down').length).toBe(1);
      p.ctl.down = false;
      const tick = await runOrderMaintenance(minutesFromNow(5));
      expect(tick.extraRefundsDone).toHaveLength(1);
      await Promise.all([runOrderMaintenance(minutesFromNow(6)), runOrderMaintenance(minutesFromNow(6)), webhook(captured(dupRzp, 22000, 'pay_second_down'))]);
      await __waitForBackgroundWork();
      expect(p.sim.refunds.get('pay_second_down')).toHaveLength(1);
      expect(p.calls.refund.filter((c) => c.paymentId === 'pay_second_down')).toHaveLength(1);
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems ?? []).not.toContain('DUPLICATE_PAYMENT');
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_DUPLICATE_REFUND_FAILED' } })).toBeGreaterThanOrEqual(1);
    });

    test('PROVE: a payment on an order that was already cancelled AND refunded (second Razorpay order) is refunded by its own id; the refunded order keeps its state', async () => {
      const o = await placePaid();
      await adminCancel(o.id); await __waitForBackgroundWork();
      expect((await db(o.id)).paymentStatus).toBe('REFUNDED');
      const rzp2 = `rzp_order_sim_late2_${randomUUID().slice(0, 8)}`;
      await prisma.payment.create({ data: { orderId: o.id, razorpayOrderId: rzp2, amount: 220, status: 'PENDING' } });
      await webhook(captured(rzp2, 22000, 'pay_after_refund'));
      await __waitForBackgroundWork();
      expect(P.sim.refunds.get('pay_after_refund')).toHaveLength(1);
      expect(P.sim.refunds.get(o.payId)).toHaveLength(1);
      const row = await db(o.id);
      expect(row).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(row.payments.find((x) => x.razorpayOrderId === rzp2)!.status).toBe('REFUNDED');
      // the earlier refund is still the order's refund
      expect(row.payments.find((x) => x.razorpayPaymentId === o.payId)).toMatchObject({ status: 'REFUNDED', razorpayRefundId: P.sim.refunds.get(o.payId)![0].id });
    });

    test('PROVE: another payment id on the SAME Razorpay order (no row for it) is refunded by its own id once (amount taken from the signed webhook)', async () => {
      const o = await placePaid();
      const w1 = await webhook(captured(o.rzp, 22000, 'pay_same_order_b'));
      expect(w1.body.code).toBe('DUPLICATE_PAYMENT');
      await __waitForBackgroundWork();
      await webhook(captured(o.rzp, 22000, 'pay_same_order_b')); await __waitForBackgroundWork();
      expect(P.sim.refunds.get('pay_same_order_b')).toHaveLength(1);
      expect(P.sim.refunds.get(o.payId) ?? []).toHaveLength(0);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
    });

    test('PROVE: 18 concurrent cancel / reject / admin / job / retry callers on one paid order -> exactly one provider refund call', async () => {
      const o = await placePaid();
      await prisma.order.update({ where: { id: o.id }, data: { paidAt: minutesAgo(11) } });
      await Promise.all([
        ...Array.from({ length: 3 }, () => customerCancel(o.id)), ...Array.from({ length: 3 }, () => vendorReject(o.id)),
        ...Array.from({ length: 3 }, () => adminCancel(o.id)), ...Array.from({ length: 3 }, () => runOrderMaintenance()),
        ...Array.from({ length: 3 }, () => runOrderMaintenance(minutesFromNow(20))), ...Array.from({ length: 3 }, () => retryRefund(o.id)),
      ]);
      await __waitForBackgroundWork();
      const row = await db(o.id);
      expect(row.status).toBe('CANCELLED');
      expect(row.paymentStatus).toBe('REFUNDED');
      expect(P.calls.refund.filter((c) => c.paymentId === o.payId)).toHaveLength(1);
      expect(P.sim.refunds.get(o.payId)).toHaveLength(1);
    });

    test('PROVE: 25 concurrent refund workers on one pending refund -> one provider call', async () => {
      const o = await placePaid();
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'PENDING' } });
      const outcomes = await Promise.all(Array.from({ length: 25 }, () => executeRefund(o.id)));
      expect(outcomes.filter((x) => x === 'DONE')).toHaveLength(1);
      expect(P.calls.refund).toHaveLength(1);
    });

    test('PROVE: provider performed the refund but the answer was lost (and the next list call fails too) -> still exactly one refund, no loss', async () => {
      const p = useProvider({ refundThrowAfterTimes: 1, listFailTimes: 0 });
      const o = await placePaid();
      expect((await adminCancel(o.id)).status).toBe(200); // refund performed at provider, response lost -> FAILED
      let row = await db(o.id);
      expect(row.refundStatus).toBe('FAILED');
      expect(p.sim.refunds.get(o.payId)).toHaveLength(1);
      p.ctl.listFailTimes = 1;
      await runOrderMaintenance(minutesFromNow(2)); // list fails -> still FAILED, must NOT blindly refund again
      row = await db(o.id);
      expect(row.refundStatus).toBe('FAILED');
      expect(p.calls.refund).toHaveLength(1);
      await runOrderMaintenance(minutesFromNow(10)); // list succeeds (after the backoff), finds the refund, records it
      row = await db(o.id);
      expect(row.paymentStatus).toBe('REFUNDED');
      expect(row.payments[0].razorpayRefundId).toBe(p.sim.refunds.get(o.payId)![0].id);
      expect(p.calls.refund).toHaveLength(1);
    });

    test('PROVE: a slow worker whose 2-minute lease expired mid-call cannot cause a second refund (relies on the provider refusing over-refunds)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const p = useProvider({ refundGate: gate });
      const o = await placePaid();
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'PENDING' } });
      const slow = executeRefund(o.id);
      for (let i = 0; i < 200 && p.calls.refund.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      expect(p.calls.refund).toHaveLength(1); // worker A is inside the provider call
      await prisma.order.update({ where: { id: o.id }, data: { refundLeaseUntil: minutesAgo(1) } }); // lease "expired"
      expect(await executeRefund(o.id)).toBe('DONE'); // worker B takes over and finishes
      release();
      await slow;
      const row = await db(o.id);
      expect(row.paymentStatus).toBe('REFUNDED');
      expect(row.refundStatus).toBe('DONE'); // A's rejected over-refund must not flip it back to FAILED
      expect(p.sim.refunds.get(o.payId)).toHaveLength(1);
    });
  });

  // =============================================================================================
  // 3. AMOUNT INTEGRITY
  // =============================================================================================
  describe('3. amount integrity (paise)', () => {
    const PRICES = [0.1, 0.2, 0.3, 0.7, 1.15, 7.07, 19.99, 33.33, 49.95, 99.99, 149.95, 12.5, 0.01, 8.2, 16.4, 10.1];
    beforeAll(async () => {
      for (let i = 0; i < PRICES.length; i++) {
        await prisma.menuItem.create({ data: { id: `adv-p-${i}`, vendorId: 'ven-1', name: `adv-price-${i}`, price: PRICES[i], category: 'adv', description: '', imageUrl: '' } });
      }
    });

    test('PROVE: server totals are exact integer paise for 600 random carts with float-hostile prices (0.1, 33.33, 19.99...) and every coupon', async () => {
      const rnd = prng(20261002);
      let thresholdDisagreements = 0;
      for (let n = 0; n < 600; n++) {
        const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ itemId: `adv-p-${Math.floor(rnd() * PRICES.length)}`, quantity: 1 + Math.floor(rnd() * 20) }));
        const coupon = ['', 'VITFIRST', 'KRAVEO20', 'KRAVEO50'][Math.floor(rnd() * 4)];
        const r = await validateAndCalculateOrder('ven-1', lines, coupon);
        expect(r.isValid).toBe(true);
        const subP = lines.reduce((s, l) => s + Math.round(PRICES[Number(l.itemId.slice(6))] * 100) * l.quantity, 0);
        for (const v of [r.calculatedSubtotal, r.calculatedDiscount, r.calculatedTotalAmount]) expect(v).toBe(Math.round(v * 100) / 100);
        expect(Math.round(r.calculatedSubtotal * 100)).toBe(subP);
        const discP = Math.round(r.calculatedDiscount * 100);
        expect(Math.round(r.calculatedTotalAmount * 100)).toBe(subP + 4000 - discP);
        const expectedDisc = coupon === 'VITFIRST' ? (subP >= 10000 ? Math.min(Math.round(subP * 0.2), 5000) : 0)
          : coupon === 'KRAVEO20' ? (subP >= 8000 ? 2000 : 0) : coupon === 'KRAVEO50' ? (subP >= 15000 ? 5000 : 0) : 0;
        if (expectedDisc !== discP) thresholdDisagreements++; // reported by the BUG threshold test below
        expect(r.calculatedTotalAmount).toBeGreaterThanOrEqual(40 - 50 + 100 / 100); // never below Rs 1 with positive prices
      }
      expect(thresholdDisagreements).toBeGreaterThanOrEqual(0);
    });

    test('PROVE: coupon threshold is checked on the rounded subtotal, so a cart worth exactly Rs 100.00 gets VITFIRST (0.7x14 + 8.2x11 = 99.99999999999999)', async () => {
      await prisma.menuItem.create({ data: { id: 'adv-p-thr1', vendorId: 'ven-1', name: 'adv-thr-0.7', price: 0.7, category: 'adv', description: '', imageUrl: '' } });
      await prisma.menuItem.create({ data: { id: 'adv-p-thr2', vendorId: 'ven-1', name: 'adv-thr-8.2', price: 8.2, category: 'adv', description: '', imageUrl: '' } });
      const r = await validateAndCalculateOrder('ven-1', [{ itemId: 'adv-p-thr1', quantity: 14 }, { itemId: 'adv-p-thr2', quantity: 11 }], 'VITFIRST');
      expect(r.calculatedSubtotal).toBe(100);
      expect(r.calculatedDiscount).toBe(20); // was 0 before the fix (threshold compared on 99.99999999999999)
    });

    test('PROVE: end to end 33.33 x 7 with VITFIRST: stored total, Razorpay order amount, captured amount and refund amount are all the same integer paise (22665)', async () => {
      // VITFIRST is for a first order only: use a brand-new customer (the shared student has many earlier orders).
      const vit = { id: 'usr-adv-vit', phone: '+91 9999800777' };
      await prisma.user.upsert({ where: { id: vit.id }, update: {}, create: { id: vit.id, name: 'Vit First', phone: vit.phone, role: 'STUDENT', hostelBlock: 'Block 3' } });
      const tVit = getStudentToken(vit.id, vit.phone);
      const placed = await place(tVit, { items: [{ itemId: 'adv-p-7', quantity: 7 }], couponCode: 'VITFIRST' });
      expect(placed.status).toBe(201);
      expect(placed.body.data.totalAmount).toBe(226.65); // 233.31 + 40 - 46.66
      const id = placed.body.data.id;
      const pay = await createPayment(id, tVit);
      expect(pay.body.amountInPaise).toBe(22665);
      expect(P.calls.createOrder[0].amountPaise).toBe(22665);
      expect(Number.isInteger(P.calls.createOrder[0].amountPaise)).toBe(true);
      expect((await webhook(captured(pay.body.razorpayOrderId, 22664, 'pay_amt'))).body.status).toBe('rejected'); // one paise short
      expect((await db(id)).paymentStatus).not.toBe('PAID');
      expect((await webhook(captured(pay.body.razorpayOrderId, 22665, 'pay_amt'))).body.status).toBe('processed');
      expect((await request.post(`/api/orders/${id}/cancel`).set(H(tVit)).send({})).status).toBe(200);
      await __waitForBackgroundWork();
      expect(P.calls.refund[0].amountPaise).toBe(22665);
      expect((await db(id)).payments[0].capturedAmountPaise).toBe(22665);
      expect((await db(id)).couponCode).toBe('VITFIRST');
    });

    test('PROVE: wrong-unit webhooks (rupees instead of paise, 10x, or 0) are never marked paid and are visible to the admin', async () => {
      for (const wrong of [220, 2200, 220000, 0, -22000, 22000.5]) {
        const o = await mkOrder();
        const w = await webhook(captured(o.rzp, wrong, `pay_wrong_${Math.abs(wrong)}`));
        expect(w.body.code).toBe('AMOUNT_MISMATCH');
        expect((await db(o.id)).paymentStatus).toBe('PENDING');
        const na = await needsAttention(); expect({ wrong, n: na.length, p: na.find((x) => x.order.id === o.id)?.problems }).toEqual({ wrong, n: na.length, p: expect.arrayContaining(['PAYMENT_MISMATCH']) });
      }
    });

    test('PROVE: the client cannot influence totals: extra price/total/discount fields ignored; fractional, string, negative, zero, huge, NaN quantities and 31 lines are refused', async () => {
      const ok = await place(tStudent, { totalAmount: 1, price: 1, discount: 999, deliveryFee: 0, items: [{ itemId: 'item-1', quantity: 1, price: 0.01 }] });
      expect(ok.status).toBe(201);
      expect(ok.body.data.totalAmount).toBe(220);
      await prisma.order.updateMany({ where: { status: 'PLACED', paymentStatus: 'PENDING' }, data: { status: 'CANCELLED' } });
      for (const q of [1.5, '2', -1, 0, 21, 1e9, null, Number.MAX_SAFE_INTEGER]) {
        const r = await place(tStudent, { items: [{ itemId: 'item-1', quantity: q }] });
        expect(r.status).toBe(400);
      }
      const many = await place(tStudent, { items: Array.from({ length: 31 }, () => ({ itemId: 'item-1', quantity: 1 })) });
      expect(many.status).toBe(400);
      expect((await place(tStudent, { items: [{ itemId: 'item-1', quantity: 1 }], couponCode: 'X'.repeat(31) })).status).toBe(400);
    });

    test('PROVE: a menu price change after the order was placed does not change what is charged or refunded', async () => {
      const placed = await place();
      const id = placed.body.data.id;
      await prisma.menuItem.update({ where: { id: 'item-1' }, data: { price: 999 } });
      try {
        const pay = await createPayment(id);
        expect(pay.body.amountInPaise).toBe(22000);
        expect((await webhook(captured(pay.body.razorpayOrderId, 22000, 'pay_pc'))).body.status).toBe('processed');
        await adminCancel(id); await __waitForBackgroundWork();
        expect(P.calls.refund[0].amountPaise).toBe(22000);
      } finally {
        await prisma.menuItem.update({ where: { id: 'item-1' }, data: { price: 180 } });
      }
    });

    test('PROVE: KRAVEO20 ("redeem 50 coins") is refused (400 COUPON_NOT_APPLICABLE) without a redemption, consumes nothing, and KRAVEO50 / VITFIRST are single use', async () => {
      await prisma.user.update({ where: { id: STUDENT.id }, data: { kraveoCoins: 0, kraveo20Redeemed: 0 } });
      const r = await place(tStudent, { couponCode: 'KRAVEO20' });
      expect([r.status, r.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: STUDENT.id } })).kraveoCoins).toBe(0);
      // Not enough coins to redeem either: the public code stays worthless.
      expect((await request.post('/api/coupons/redeem-coins').set(H(tStudent)).send({})).status).toBe(400);
      expect((await place(tStudent, { couponCode: 'KRAVEO20' })).status).toBe(400);
      // Redeem once (50 coins, atomically) -> exactly one use of the code.
      await prisma.user.update({ where: { id: STUDENT.id }, data: { kraveoCoins: 120 } });
      const red = await request.post('/api/coupons/redeem-coins').set(H(tStudent)).send({});
      expect([red.status, red.body.remainingCoins]).toEqual([200, 70]);
      const first = await place(tStudent, { couponCode: ' kraveo20 ' });
      expect([first.status, first.body.data.discount, first.body.data.totalAmount]).toEqual([201, 20, 200]);
      expect((await db(first.body.data.id)).couponCode).toBe('KRAVEO20');
      // (Bug hunt BE1-01: an abandoned unpaid checkout is replaced by the next one; an order whose payment was just opened is "live" and keeps its code.)
      expect((await createPayment(first.body.data.id)).status).toBe(200);
      const second = await place(tStudent, { couponCode: 'KRAVEO20' });
      expect([second.status, second.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      // Cancelling the order releases the redemption again.
      expect((await customerCancel(first.body.data.id)).status).toBe(200);
      const third = await place(tStudent, { couponCode: 'KRAVEO20' });
      expect([third.status, third.body.data.discount]).toEqual([201, 20]);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: STUDENT.id } })).kraveoCoins).toBe(70); // coins were taken once, at redemption
      // KRAVEO50: once per customer; below the minimum cart and unknown codes are refused (not silently ignored).
      const k50 = await place(tStudent, { couponCode: 'KRAVEO50' });
      expect([k50.status, k50.body.data.discount]).toEqual([201, 50]);
      expect((await createPayment(k50.body.data.id)).status).toBe(200);
      const k50b = await place(tStudent, { couponCode: 'KRAVEO50' });
      expect([k50b.status, k50b.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      const small = await place(tStudent, { couponCode: 'KRAVEO50', items: [{ itemId: 'item-2', quantity: 1 }] });
      expect([small.status, small.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect(small.body.message).toMatch(/at least/);
      const unknown = await place(tStudent, { couponCode: 'FREEFOOD' });
      expect([unknown.status, unknown.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
    });

    test('PROVE: VITFIRST is only for a first order and single use: later orders, a second use and 6 concurrent checkouts get no discount (400); cancelling releases it', async () => {
      const mk = async (n: number) => {
        const u = { id: `usr-adv-vit${n}`, phone: `+91 99998008${String(n).padStart(2, '0')}` };
        await prisma.user.upsert({ where: { id: u.id }, update: { }, create: { id: u.id, name: `Vit Tester${n}`, phone: u.phone, role: 'STUDENT', hostelBlock: 'Block 3' } });
        await prisma.order.deleteMany({ where: { customerId: u.id } });
        return getStudentToken(u.id, u.phone);
      };
      // a) first order gets it, the second use is refused, cancelling the first releases it
      const t1 = await mk(1);
      const a1 = await place(t1, { couponCode: 'VITFIRST' });
      expect([a1.status, a1.body.data.discount]).toEqual([201, 36]); // 20% of 180
      expect((await createPayment(a1.body.data.id, t1)).status).toBe(200); // payment opened: the order is live (an abandoned one would be replaced, BE1-01)
      const a2 = await place(t1, { couponCode: 'VITFIRST' });
      expect([a2.status, a2.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect((await request.post(`/api/orders/${a1.body.data.id}/cancel`).set(H(t1)).send({})).status).toBe(200);
      const a3 = await place(t1, { couponCode: 'VITFIRST' });
      expect([a3.status, a3.body.data.discount]).toEqual([201, 36]);
      // b) a customer who already has an order (no coupon) is not a first-time customer
      const t2 = await mk(2);
      const first2 = await place(t2);
      expect(first2.status).toBe(201);
      expect((await createPayment(first2.body.data.id, t2)).status).toBe(200);
      const b = await place(t2, { couponCode: 'VITFIRST' });
      expect([b.status, b.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect(b.body.message).toMatch(/first order/);
      // c) concurrent checkouts with the same single-use code: exactly one wins
      const t3 = await mk(3);
      const race = await Promise.all(Array.from({ length: 6 }, () => place(t3, { couponCode: 'VITFIRST' })));
      // Since BE1-01 each checkout replaces the previous abandoned one: all 6 are accepted, but only ONE order can hold the code at the end.
      expect(race.every((r) => r.status === 201)).toBe(true);
      expect(await prisma.order.count({ where: { customerId: 'usr-adv-vit3', couponCode: 'VITFIRST', status: { not: 'CANCELLED' } } })).toBe(1);
      expect(await prisma.order.count({ where: { customerId: 'usr-adv-vit3', couponCode: 'VITFIRST', status: 'CANCELLED', cancelledBy: 'SYSTEM' } })).toBe(5);
    });

    test('PROVE: vendor menu prices are validated (negative, non-numeric, sub-paise, huge are 400) so an item cannot make an order cost less than its food', async () => {
      const statuses: Record<string, number> = {};
      for (const price of [-50, 'abc', 10.005, 1e12]) {
        const r = await request.post('/api/vendors/ven-1/items').set(H(tVendor)).send({ name: `adv-price-${String(price)}`, price });
        statuses[String(price)] = r.status;
      }
      await prisma.menuItem.deleteMany({ where: { name: { startsWith: 'adv-price-' }, id: { not: { startsWith: 'adv-p-' } } } });
      expect(Object.values(statuses).every((s) => s === 400)).toBe(true); // were all 201 (or 500) before the fix
    });
  });

  // =============================================================================================
  // 4. FORGERY AND REPLAY
  // =============================================================================================
  describe('4. forgery and replay', () => {
    const SECRET = 'test_webhook_secret';
    const signedPost = (raw: string, sig: string) => request.post('/api/payments/webhook').set('content-type', 'application/json').set('x-razorpay-signature', sig).send(raw);

    test('PROVE: real HMAC over the exact raw bytes is accepted; any change to the bytes (whitespace, key order, one char) or a signature of another body is refused and nothing changes', async () => {
      const o = await mkOrder();
      const body = JSON.stringify(captured(o.rzp, 22000, 'pay_hm1'));
      const spaced = JSON.stringify(captured(o.rzp, 22000, 'pay_hm1'), null, 2);
      expect((await signedPost(spaced, hmac(SECRET, body))).status).toBe(400); // signed the compact form, sent a re-serialised one
      expect((await signedPost(body, hmac('wrong_secret', body))).status).toBe(400);
      expect((await signedPost(body, hmac(SECRET, body).toUpperCase())).status).toBe(400);
      expect((await signedPost(body, hmac(SECRET, body).slice(0, 63))).status).toBe(400);
      expect((await signedPost(body.replace('22000', '22001'), hmac(SECRET, body))).status).toBe(400);
      expect((await db(o.id)).paymentStatus).toBe('PENDING');
      const good = await signedPost(body, hmac(SECRET, body));
      expect(good.status).toBe(200);
      expect(good.body.status).toBe('processed');
      expect((await db(o.id)).paymentStatus).toBe('PAID');
    });

    test('PROVE: missing / empty / non-string signature header -> 400, and a non-JSON content type cannot slip past the raw-body check', async () => {
      const o = await mkOrder();
      const body = JSON.stringify(captured(o.rzp, 22000, 'pay_hm2'));
      expect((await request.post('/api/payments/webhook').set('content-type', 'application/json').send(body)).status).toBe(400);
      expect((await signedPost(body, '')).status).toBe(400);
      // no JSON parsing -> no raw body: the signature of the real body does not match the fallback bytes
      expect((await request.post('/api/payments/webhook').set('content-type', 'text/plain').set('x-razorpay-signature', hmac(SECRET, body)).send(body)).status).toBe(400);
      expect((await db(o.id)).paymentStatus).toBe('PENDING');
    });

    test('PROVE: NODE_ENV gate - the "valid_test_wh_signature" shortcut and the rzp_order_sim_ verify shortcut are dead unless NODE_ENV is exactly "test"; the simulator provider is never selected', () => {
      for (const nodeEnv of ['production', 'development', 'staging', undefined]) {
        const r = withEnv({ NODE_ENV: nodeEnv, RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_KEY_SECRET: 'k_placeholder' }, () => {
          const m = loadPaymentService();
          return {
            sentinel: m.verifyRazorpayWebhookSignature('{}', 'valid_test_wh_signature'),
            sim: m.verifyRazorpayPaymentSignature('rzp_order_sim_abc', 'pay_1', 'anything'),
            real: m.verifyRazorpayWebhookSignature('{}', hmac(SECRET, '{}')),
            simProvider: 'refunds' in (m.getPaymentProvider() as any),
          };
        });
        expect(r).toEqual({ sentinel: false, sim: false, real: true, simProvider: false });
      }
      // and the control: in test mode both shortcuts are on (so the gate above is meaningful)
      const t = withEnv({ NODE_ENV: 'test' }, () => { const m = loadPaymentService(); return [m.verifyRazorpayWebhookSignature('{}', 'valid_test_wh_signature'), m.verifyRazorpayPaymentSignature('rzp_order_sim_abc', 'p', 'x')]; });
      expect(t).toEqual([true, true]);
    });

    test('PROVE: RAZORPAY_WEBHOOK_SECRET missing or empty fails closed: not even an HMAC computed with an empty key is accepted', () => {
      for (const secret of [undefined, '']) {
        const r = withEnv({ NODE_ENV: 'production', RAZORPAY_WEBHOOK_SECRET: secret }, () => {
          const m = loadPaymentService();
          return [m.verifyRazorpayWebhookSignature('{}', hmac('', '{}')), m.verifyRazorpayWebhookSignature('{}', hmac('undefined', '{}')), m.verifyRazorpayWebhookSignature('{}', 'x'), m.verifyRazorpayWebhookSignature(Buffer.from('{}'), '')];
        });
        expect(r).toEqual([false, false, false, false]);
      }
    });

    test('PROVE: verify-signature fails CLOSED when RAZORPAY_KEY_SECRET is empty (an HMAC with an empty key is never accepted)', () => {
      const ok = withEnv({ NODE_ENV: 'production', RAZORPAY_KEY_SECRET: '' }, () => {
        const m = loadPaymentService();
        return m.verifyRazorpayPaymentSignature('order_real_1', 'pay_1', hmac('', 'order_real_1|pay_1'));
      });
      expect(ok).toBe(false); // was true before the fix
    });

    test('PROVE: signature binding - a genuine signature for a cheap order cannot be attached to an expensive order, and cannot be used by another customer', async () => {
      const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
      const cheap = await mkOrder({ total: 100 });
      const dear = await mkOrder({ total: 300 });
      // use non-simulated ids so the real HMAC path (no test shortcut) is exercised
      await prisma.payment.update({ where: { razorpayOrderId: cheap.rzp }, data: { razorpayOrderId: 'order_real_cheap1', status: 'PENDING', razorpayPaymentId: null, capturedAmountPaise: null } });
      await prisma.payment.update({ where: { razorpayOrderId: dear.rzp }, data: { razorpayOrderId: 'order_real_dear1', status: 'PENDING', razorpayPaymentId: null, capturedAmountPaise: null } });
      await prisma.order.updateMany({ where: { id: { in: [cheap.id, dear.id] } }, data: { paymentStatus: 'PENDING', paidAt: null } });
      const sigCheap = hmac(keySecret, 'order_real_cheap1|pay_cheap');
      expect((await verify('order_real_dear1', 'pay_cheap', tStudent, sigCheap)).status).toBe(400); // wrong order id for that signature
      expect((await verify('order_real_dear1', 'pay_dear', tStudent, sigCheap)).status).toBe(400);
      expect((await db(dear.id)).paymentStatus).toBe('PENDING');
      expect((await webhook(captured('order_real_cheap1', 10000, 'pay_cheap', { notes: { orderId: dear.id } }))).body.code).toBe('ORDER_MISMATCH'); // notes name the dear order
      expect((await db(dear.id)).paymentStatus).toBe('PENDING');
      await prisma.user.upsert({ where: { id: 'usr-of-other-stu' }, update: {}, create: { id: 'usr-of-other-stu', name: 'Other Student', phone: '+91 9999800001', role: 'STUDENT' } });
      const other = getStudentToken('usr-of-other-stu', '+91 9999800001');
      expect((await verify('order_real_cheap1', 'pay_cheap', other, sigCheap)).status).toBe(404); // not the owner of that payment order
      expect((await verify('order_real_cheap1', 'pay_cheap', tStudent, sigCheap)).status).toBe(200);
      expect((await db(cheap.id)).paymentStatus).toBe('PAID');
      expect((await db(dear.id)).paymentStatus).toBe('PENDING');
      // a signature for a payment id the attacker chooses is useless without the key
      expect((await verify('order_real_dear1', 'pay_x', tStudent, hmac('guess', 'order_real_dear1|pay_x'))).status).toBe(400);
    });

    test('PROVE: webhooks for unknown, foreign or nonexistent orders change nothing and never 500; a signed foreign-customer payment cannot be claimed via verify', async () => {
      const mine = await mkOrder();
      for (const body of [
        captured('rzp_order_sim_doesnotexist', 22000, 'pay_f1'),
        captured('', 22000, 'pay_f2'),
        { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_f3', amount: 22000, notes: { orderId: 'no-such-order' } } } } },
        { event: 'payment.captured', payload: {} }, { event: 'order.paid' }, {}, { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_x' } } } },
      ]) {
        const r = await webhook(body);
        expect(r.status).toBe(200);
      }
      expect((await db(mine.id)).paymentStatus).toBe('PENDING');
      expect(P.calls.refund).toHaveLength(0);
    });

    test('PROVE: replaying an old payment.captured / order.paid webhook (and verify) after refund or cancel changes nothing and never refunds twice', async () => {
      const o = await placePaid();
      await adminCancel(o.id); await __waitForBackgroundWork();
      const before = await db(o.id);
      for (let i = 0; i < 4; i++) {
        await webhook(captured(o.rzp, 22000, o.payId)); await webhook(captured(o.rzp, 22000, o.payId, {}, 'order.paid')); await verify(o.rzp, o.payId);
      }
      await __waitForBackgroundWork();
      const after = await db(o.id);
      expect(after.paymentStatus).toBe('REFUNDED');
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(P.calls.refund).toHaveLength(1);
      // a replay carrying a different payment id is the duplicate path: flagged, state untouched
      const r = await webhook(captured(o.rzp, 22000, 'pay_other_id'));
      expect(r.body.code).toBe('DUPLICATE_PAYMENT');
      expect((await db(o.id)).paymentStatus).toBe('REFUNDED');
    });

    test('PROVE: a webhook for a payment whose Kraveo order id is unknown is recorded in the admin audit log (not silently dropped)', async () => {
      await prisma.adminAuditLog.deleteMany({ where: { action: 'PAYMENT_UNKNOWN' } });
      await webhook(captured('order_never_seen_1', 22000, 'pay_unknown_1'));
      const rows = await prisma.adminAuditLog.findMany({ where: { action: 'PAYMENT_UNKNOWN' } });
      expect(rows.length).toBe(1);
    });
  });

  // =============================================================================================
  // 5. UNPAID / ROLE INVARIANTS
  // =============================================================================================
  describe('5. unpaid and role invariants', () => {
    test('PROVE: an unpaid order is invisible and untouchable for restaurant and riders; admin routes also refuse to move it', async () => {
      const placed = await place();
      const id = placed.body.data.id;
      await createPayment(id);
      const vList = await request.get('/api/orders').set(H(tVendor));
      expect(vList.body.data.map((x: any) => x.id)).not.toContain(id);
      expect((await request.get(`/api/orders/${id}`).set(H(tVendor))).status).toBe(404);
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBeGreaterThanOrEqual(400);
      expect((await vendorReject(id)).status).toBeGreaterThanOrEqual(400);
      const pool = await request.get('/api/orders/available').set(H(tRider));
      expect(pool.body.data.map((x: any) => x.id)).not.toContain(id);
      expect((await claim(id)).status).toBe(409);
      expect((await setStatus(id, 'ACCEPTED', tAdmin)).body.code).toBe('PAYMENT_NOT_CONFIRMED');
      const re = await request.patch(`/api/orders/${id}/reassign`).set(H(tAdmin)).send({ driverId: 'usr-4' });
      expect(re.status).toBe(409);
      for (const st of ['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED']) {
        expect((await setStatus(id, st, tAdmin, { otpCode: '1234' })).status).toBeGreaterThanOrEqual(400);
        expect((await setStatus(id, st, tRider, { otpCode: '1234' })).status).toBeGreaterThanOrEqual(400);
      }
      expect((await request.post(`/api/orders/${id}/verify-gate-otp`).set(H(tAdmin)).send({ otpCode: '1234' })).status).toBeGreaterThanOrEqual(400);
      await runOrderMaintenance(minutesFromNow(5)); await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'p', order_id: 'nope' } } } });
      const row = await db(id);
      expect(row.status).toBe('PLACED');
      expect(row.paymentStatus).not.toBe('PAID');
      expect(row.driverId).toBeNull();
    });

    test('PROVE: even a legacy / corrupted unpaid order sitting at ARRIVED_AT_GATE with the right OTP cannot be delivered, and an unpaid READY order cannot be picked up', async () => {
      const a = await mkOrder({ status: 'ARRIVED_AT_GATE', driverId: RIDER.id });
      await prisma.order.update({ where: { id: a.id }, data: { otpCode: '4821' } });
      const r = await request.post(`/api/orders/${a.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: '4821' });
      expect(r.body.code).toBe('PAYMENT_NOT_CONFIRMED');
      expect((await setStatus(a.id, 'DELIVERED', tAdmin, { otpCode: '4821' })).status).toBe(409);
      const b = await mkOrder({ status: 'READY_FOR_PICKUP', driverId: RIDER.id });
      expect((await setStatus(b.id, 'PICKED_UP', tRider)).body.code).toBe('PAYMENT_NOT_CONFIRMED');
      await prisma.order.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: 'CANCELLED' } });
    });

    test('PROVE: DELIVERED is unreachable without the gate OTP for every role and for the job / webhook / reassign / retry-refund', async () => {
      const o = await driveTo('ARRIVED_AT_GATE');
      const vendorTry = await setStatus(o.id, 'DELIVERED', tVendor);
      const studentTry = await setStatus(o.id, 'DELIVERED', tStudent);
      expect([vendorTry.status, studentTry.status]).toEqual([403, 403]);
      expect((await setStatus(o.id, 'DELIVERED', tRider)).status).toBe(400); // no OTP
      expect((await setStatus(o.id, 'DELIVERED', tAdmin)).status).toBe(400);
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({})).status).toBe(400);
      await runOrderMaintenance(minutesFromNow(600));
      await webhook(captured(o.rzp, 22000, o.payId)); await retryRefund(o.id);
      await request.patch(`/api/orders/${o.id}/reassign`).set(H(tAdmin)).send({ driverId: 'usr-4' });
      expect((await db(o.id)).status).toBe('ARRIVED_AT_GATE');
      const otp = (await db(o.id)).otpCode!;
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: otp === '0000' ? '1111' : '0000' })).status).toBe(400);
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: otp })).status).toBe(200);
    });

    test('PROVE: after a refund (admin cancel in ANY state) nothing can be fulfilled: vendor, rider, other rider, admin, OTP all refused; order ends CANCELLED+REFUNDED with one refund', async () => {
      for (const state of ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CLAIMED', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
        const o = await driveTo(state);
        const otp = (await db(o.id)).otpCode;
        expect((await adminCancel(o.id)).status).toBe(200);
        await __waitForBackgroundWork();
        const attempts = [
          ...['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].map((s) => setStatus(o.id, s, tVendor)),
          ...['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'].map((s) => setStatus(o.id, s, tAdmin)),
          ...['PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'].map((s) => setStatus(o.id, s, tRider, { otpCode: otp ?? '4821' })),
          vendorReject(o.id), claim(o.id), request.post(`/api/orders/${o.id}/release`).set(H(tRider)).send({}),
          request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: otp ?? '4821' }),
          request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tAdmin)).send({ otpCode: otp ?? '4821' }),
          request.patch(`/api/orders/${o.id}/reassign`).set(H(tAdmin)).send({ driverId: 'usr-4' }),
          request.post(`/api/admin/orders/${o.id}/reset-otp-lock`).set(H(tAdmin)).send({}),
        ];
        const results = await Promise.all(attempts);
        results.forEach((r, i) => expect({ state, i, status: r.status }).toEqual({ state, i, status: expect.any(Number) }));
        expect(results.filter((r) => r.status === 200).map((r) => r.body?.data?.status)).not.toContain('DELIVERED');
        const row = await db(o.id);
        expect(row.status).toBe('CANCELLED');
        expect(row.paymentStatus).toBe('REFUNDED');
        expect(row.deliveredAt).toBeNull();
        expect(P.sim.refunds.get(o.payId)).toHaveLength(1);
      }
    });
  });

  // =============================================================================================
  // 6. JOB SAFETY
  // =============================================================================================
  describe('6. maintenance job', () => {
    test('PROVE: 5 concurrent job runs over 12 expirable unpaid + 12 unaccepted paid orders: each cancelled once, each paid one refunded exactly once, unpaid ones never refunded', async () => {
      await prisma.order.updateMany({ where: { status: 'PLACED' }, data: { status: 'CANCELLED' } });
      const unpaid = await Promise.all(Array.from({ length: 12 }, () => mkOrder({ ageMin: 20 })));
      const paid = await Promise.all(Array.from({ length: 12 }, () => mkOrder({ paid: true, ageMin: 30, paidAgoMin: 12 })));
      await Promise.all(Array.from({ length: 5 }, () => runOrderMaintenance()));
      await __waitForBackgroundWork();
      await runOrderMaintenance();
      for (const u of unpaid) { const r = await db(u.id); expect(r.status).toBe('CANCELLED'); expect(r.cancelledBy).toBe('SYSTEM'); expect(r.refundStatus).toBeNull(); }
      for (const p of paid) {
        const r = await db(p.id);
        expect(r.status).toBe('CANCELLED'); expect(r.paymentStatus).toBe('REFUNDED');
        expect(P.sim.refunds.get(p.payId)).toHaveLength(1);
        expect(P.calls.refund.filter((c) => c.paymentId === p.payId)).toHaveLength(1);
      }
      expect(P.calls.refund).toHaveLength(12);
    });

    test('PROVE: a tick handles at most 100 expired orders; a backlog of 130 drains over consecutive ticks without skipping or double-processing', async () => {
      await prisma.order.updateMany({ where: { status: 'PLACED' }, data: { status: 'CANCELLED' } });
      await prisma.order.createMany({ data: Array.from({ length: 130 }, () => ({ customerId: STUDENT.id, vendorId: 'ven-1', totalAmount: 220, subtotal: 180, deliveryFee: 25, taxAndPackaging: 15, dropoffHostel: 'Block 3', createdAt: minutesAgo(40) })) });
      const first = await runOrderMaintenance();
      expect(first.expired).toHaveLength(100);
      const second = await runOrderMaintenance();
      expect(second.expired).toHaveLength(30);
      expect(new Set([...first.expired, ...second.expired]).size).toBe(130);
      expect((await runOrderMaintenance()).expired).toHaveLength(0);
    });

    test('PROVE: expiry vs late payment vs vendor accept, 15 rounds of a three-way race: never "cancelled and money kept", never "accepted and refunded"', async () => {
      for (let i = 0; i < 15; i++) {
        const o = await mkOrder({ ageMin: 20 });
        const payId = `pay_race_${i}_${randomUUID().slice(0, 6)}`;
        await Promise.all([runOrderMaintenance(), verify(o.rzp, payId), webhook(captured(o.rzp, 22000, payId)), runOrderMaintenance()]);
        await __waitForBackgroundWork();
        await runOrderMaintenance(minutesFromNow(3));
        const r = await db(o.id);
        if (r.paymentStatus === 'PAID') throw new Error(`round ${i}: paid order left ${r.status} without a refund`);
        expect(['REFUNDED', 'PENDING']).toContain(r.paymentStatus);
        if (r.paymentStatus === 'REFUNDED') { expect(r.status).toBe('CANCELLED'); expect(P.sim.refunds.get(payId)).toHaveLength(1); }
        else { expect(P.sim.refunds.get(payId) ?? []).toHaveLength(0); }
      }
    });

    test('PROVE: a 10-minute provider outage no longer ends in a permanent FAILED: transient failures do not use up attempts, back off, and the money is returned by the job once the provider is back', async () => {
      const p = useProvider({ down: true });
      const o = await placePaid();
      await adminCancel(o.id);
      for (let i = 1; i <= 14; i++) await runOrderMaintenance(minutesFromNow(i)); // a tick every minute for 14 minutes of outage
      let row = await db(o.id);
      expect(row.refundStatus).toBe('FAILED');
      expect(row.refundAttempts).toBe(0); // transient failures are not counted
      expect(row.refundError).toBe('provider down');
      const callsInOutage = p.calls.refund.length + p.calls.list.length;
      expect(callsInOutage).toBeGreaterThanOrEqual(3); // it kept trying ...
      expect(callsInOutage).toBeLessThan(14); // ... but with backoff, not once per tick
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems).toContain('REFUND_FAILED');
      p.ctl.down = false; // provider recovers
      const tick = await runOrderMaintenance(minutesFromNow(90));
      expect(tick.refundsDone).toContain(o.id);
      row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE', refundError: null });
      expect(p.sim.refunds.get(o.payId)).toHaveLength(1);
    });

    test('PROVE: the backoff grows 30 s, 1, 2, 4 ... minutes and is capped at one hour', async () => {
      const { backoffMs } = require('../../src/services/refundService');
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map((n) => backoffMs(n) / 1000)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
      const p = useProvider({ down: true });
      const o = await placePaid();
      await adminCancel(o.id);
      const base = Date.now() + 10 * 60_000;
      const waits: number[] = [];
      for (let i = 0; i < 4; i++) {
        const now = new Date(base + i * 3_600_000);
        await executeRefund(o.id, now);
        const r = await db(o.id);
        waits.push(Math.round((r.refundLeaseUntil!.getTime() - now.getTime()) / 1000));
      }
      expect(waits).toEqual([60, 120, 240, 480]); // failure #1 was the cancel itself (30 s), #2..#5 follow
      expect((await db(o.id)).refundAttempts).toBe(0);
      expect(p.calls.refund.length + p.calls.list.length).toBeGreaterThan(0);
    });

    test('PROVE: a permanent provider error (4xx) is recorded with the provider message and stops the automatic retries after 3 tries; admin retry-refund starts over', async () => {
      const calls: string[] = [];
      let broken = true;
      const sim = createSimulatedProvider();
      const provider: PaymentProvider = {
        ...sim,
        createOrder: sim.createOrder,
        listRefunds: async (id) => sim.listRefunds(id),
        refundPayment: async (i) => { calls.push(i.paymentId); if (broken) throw sdkError(400, 'The payment has not been captured yet'); return sim.refundPayment(i); },
      };
      setPaymentProvider(provider);
      const o = await placePaid();
      await adminCancel(o.id);
      let row = await db(o.id);
      expect(row).toMatchObject({ refundStatus: 'FAILED', refundAttempts: 1, refundError: 'The payment has not been captured yet' });
      for (let i = 1; i <= 8; i++) await runOrderMaintenance(minutesFromNow(i * 2));
      row = await db(o.id);
      expect(row.refundAttempts).toBe(3); // MAX_REFUND_ATTEMPTS permanent failures, then it stops
      expect(calls).toHaveLength(3);
      const na = (await needsAttention()).find((x) => x.order.id === o.id);
      expect(na.problems).toContain('REFUND_FAILED');
      expect(na.detail).toContain('The payment has not been captured yet');
      broken = false;
      expect((await runOrderMaintenance(minutesFromNow(30))).refundsRetried).not.toContain(o.id);
      expect((await retryRefund(o.id)).status).toBe(200);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(sim.refunds.get(o.payId)).toHaveLength(1);
    });

    test('PROVE: a 400 "already refunded" answer is confirmed against the provider refund list and ends REFUNDED (no loop, no second refund)', async () => {
      const sim = createSimulatedProvider();
      let listCalls = 0;
      const provider: PaymentProvider = {
        ...sim,
        // the first list (before refunding) still shows nothing, as when another worker refunds between our list and our refund call
        listRefunds: async (id) => { listCalls += 1; return listCalls === 1 ? [] : sim.listRefunds(id); },
        refundPayment: async (i) => { await sim.refundPayment(i); throw sdkError(400, 'The payment has been fully refunded already'); },
      };
      setPaymentProvider(provider);
      const o = await placePaid();
      await adminCancel(o.id);
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE', refundError: null });
      expect(row.payments[0].razorpayRefundId).toBe(sim.refunds.get(o.payId)![0].id);
      expect(sim.refunds.get(o.payId)).toHaveLength(1);
      expect(row.refundAttempts).toBe(1);
    });

    test('PROVE: an "already refunded" 400 that the refund list cannot confirm stays FAILED (never silently marked refunded)', async () => {
      const sim = createSimulatedProvider();
      const provider: PaymentProvider = { ...sim, refundPayment: async () => { throw sdkError(400, 'The payment has been fully refunded already'); } };
      setPaymentProvider(provider);
      const o = await placePaid();
      await adminCancel(o.id);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PAID', refundStatus: 'FAILED', refundError: 'The payment has been fully refunded already' });
    });

    test('PROVE: 429 and 5xx answers are transient (no attempt used), other 4xx permanent', async () => {
      for (const [status, transient] of [[429, true], [500, true], [502, true], [503, true], [504, true], [408, true], [400, false], [401, false], [404, false], [422, false]] as const) {
        const e = toProviderError(sdkError(status, 'x'));
        expect([status, e.transient, e.statusCode]).toEqual([status, transient, status]);
      }
      const o = await placePaid();
      let mode = 429;
      const sim = createSimulatedProvider();
      setPaymentProvider({ ...sim, refundPayment: async (i) => { if (mode) throw sdkError(mode, 'throttled'); return sim.refundPayment(i); } });
      await adminCancel(o.id);
      expect(await db(o.id)).toMatchObject({ refundStatus: 'FAILED', refundAttempts: 0, refundError: 'throttled' });
      mode = 0;
      await runOrderMaintenance(minutesFromNow(5));
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
    });

    test('PROVE: admin retry-refund after the outage clears a FAILED refund, once', async () => {
      const p = useProvider({ down: true });
      const o = await placePaid();
      await adminCancel(o.id);
      for (let i = 1; i <= 12; i++) await runOrderMaintenance(minutesFromNow(i));
      expect((await db(o.id)).refundStatus).toBe('FAILED');
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems).toContain('REFUND_FAILED');
      p.ctl.down = false;
      expect((await retryRefund(o.id)).status).toBe(200);
      expect((await retryRefund(o.id)).status).toBe(409);
      expect((await db(o.id)).paymentStatus).toBe('REFUNDED');
      expect(p.sim.refunds.get(o.payId)).toHaveLength(1);
    });

    test('PROVE: a hung payment provider does not stall the maintenance tick (parallel refund retries, per-call timeout, circuit breaker)', async () => {
      const restore = applyEnv({ PROVIDER_TIMEOUT_MS: '1500' });
      try {
        useProvider({ hang: true });
        const orders = await Promise.all([mkOrder({ paid: true }), mkOrder({ paid: true })]);
        for (const o of orders) await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'FAILED', refundAttempts: 0 } });
        const t0 = Date.now();
        await runOrderMaintenance();
        const took = Date.now() - t0;
        await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { refundStatus: 'DONE', paymentStatus: 'REFUNDED' } });
        expect(took).toBeLessThan(5_000); // was ~30 s for 2 orders (sequential 15 s each)
      } finally { restore(); }
    }, 60_000);

    test('PROVE: with a provider that never answers, expiry and auto-cancel finish within seconds, before and independent of the provider phase', async () => {
      const restore = applyEnv({ PROVIDER_TIMEOUT_MS: '6000' });
      try {
        useProvider({ hang: true, fetchHang: true });
        const unpaid = await mkOrder({ ageMin: 20 });
        const unaccepted = await mkOrder({ paid: true, ageMin: 30, paidAgoMin: 12 });
        const stuckRefund = await mkOrder({ paid: true });
        await prisma.order.update({ where: { id: stuckRefund.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'FAILED', refundAttempts: 0 } });
        let finished = false;
        const t0 = Date.now();
        const tick = runOrderMaintenance(minutesFromNow(3)).finally(() => { finished = true; });
        let seen = false;
        while (Date.now() - t0 < 4_000) {
          const [a, b] = await Promise.all([db(unpaid.id), db(unaccepted.id)]);
          if (a.status === 'CANCELLED' && b.status === 'CANCELLED') { seen = true; break; }
          await new Promise((r) => setTimeout(r, 50));
        }
        const expiryTook = Date.now() - t0;
        expect(seen).toBe(true);
        expect(expiryTook).toBeLessThan(3_500);
        expect(finished).toBe(false); // the provider phase is still waiting for the hung provider
        expect((await db(unaccepted.id)).refundStatus).toBe('PENDING'); // refund not started yet / still running, order already cancelled
        await tick;
        await prisma.order.updateMany({ where: { id: { in: [stuckRefund.id, unaccepted.id] } }, data: { refundStatus: 'DONE', paymentStatus: 'REFUNDED' } });
      } finally { restore(); }
    }, 60_000);

    test('PROVE: circuit breaker: after 3 transient provider failures in a row the provider phase stops (at most 5 calls in flight), the next tick tries again', async () => {
      const restore = applyEnv({ PROVIDER_TIMEOUT_MS: '800' });
      try {
        const p = useProvider({ hang: true });
        const orders = await Promise.all(Array.from({ length: 12 }, () => mkOrder({ paid: true })));
        await prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'FAILED', refundAttempts: 0 } });
        const t0 = Date.now();
        const tick = await runOrderMaintenance();
        expect(Date.now() - t0).toBeLessThan(4_000);
        expect(tick.providerPhaseStopped).toBe(true);
        expect(p.calls.list.length).toBeLessThan(12); // not all 12: the first wave of 5 plus the few started before the breaker opened
        expect(p.calls.list.length).toBeLessThanOrEqual(7);
        expect(p.calls.list.length).toBeGreaterThanOrEqual(5);
        // the provider recovers: the next tick (after the backoff) works through the rest, 5 at a time
        p.ctl.hang = false;
        const ids = orders.map((o) => o.id);
        await prisma.order.updateMany({ where: { id: { in: ids } }, data: { refundLeaseUntil: null } });
        const next = await runOrderMaintenance(minutesFromNow(1));
        expect(next.providerPhaseStopped).toBe(false);
        expect(next.refundsDone.filter((x) => ids.includes(x))).toHaveLength(12);
        for (const o of orders) expect(p.sim.refunds.get(o.payId)).toHaveLength(1);
      } finally { restore(); }
    }, 60_000);

    test('PROVE: every stuck money state is visible to the admin (REFUND_FAILED, REFUND_PENDING, PAID_AFTER_CANCEL, STUCK_UNACCEPTED, PAYMENT_MISMATCH)', async () => {
      const failed = await mkOrder({ paid: true }); await prisma.order.update({ where: { id: failed.id }, data: { status: 'CANCELLED', cancelledBy: 'ADMIN', refundStatus: 'FAILED', refundError: 'x', refundAttempts: 10 } });
      const pending = await mkOrder({ paid: true }); await prisma.order.update({ where: { id: pending.id }, data: { status: 'CANCELLED', cancelledBy: 'ADMIN', refundStatus: 'PENDING' } });
      await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = NOW() - interval '10 minutes' WHERE id = ${pending.id}`;
      const lateOld = await mkOrder({ paid: true }); await prisma.order.update({ where: { id: lateOld.id }, data: { status: 'CANCELLED', cancelledBy: 'ADMIN', paidAt: null } });
      const stuck = await mkOrder({ paid: true, paidAgoMin: 30 });
      const mismatch = await mkOrder(); await webhook(captured(mismatch.rzp, 5, 'pay_mm'));
      const list = await needsAttention();
      const probs = (id: string) => list.find((x) => x.order.id === id)?.problems ?? [];
      expect(probs(failed.id)).toContain('REFUND_FAILED');
      expect(probs(pending.id)).toContain('REFUND_PENDING');
      expect(probs(lateOld.id)).toContain('PAID_AFTER_CANCEL');
      expect(probs(stuck.id)).toContain('STUCK_UNACCEPTED');
      expect(probs(mismatch.id)).toContain('PAYMENT_MISMATCH');
      await prisma.order.updateMany({ where: { id: { in: [failed.id, pending.id, lateOld.id, stuck.id, mismatch.id] } }, data: { status: 'CANCELLED', refundStatus: 'DONE', paymentStatus: 'REFUNDED' } });
    });
  });

  // =============================================================================================
  // 7. RECONCILIATION (pull, not only push) and provider verification
  // =============================================================================================
  describe('7. reconciliation and provider verification', () => {
    const placeUnpaid = async () => {
      const placed = await place();
      expect(placed.status).toBe(201);
      const id = placed.body.data.id as string;
      const pay = await createPayment(id);
      expect(pay.status).toBe(200);
      const total = (await db(id)).totalAmount;
      return { id, rzp: pay.body.razorpayOrderId as string, paise: Math.round(total * 100) };
    };
    const fetchedIds = () => new Set(P.calls.orderPayments);
    /** Many unpaid orders at once (the API allows 3 unpaid orders per customer, so these are written straight to the database). */
    const bulkUnpaid = (n: number) => Promise.all(Array.from({ length: n }, async () => { const o = await mkOrder({ ageMin: 1 }); return { id: o.id, rzp: o.rzp, paise: 22000 }; }));

    test('PROVE: lost webhook + dead app: the job finds the captured payment at Razorpay and marks the order paid (once, with the usual side effects)', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_lost_wh', orderId: o.rzp, amountPaise: o.paise });
      // too young: not asked yet
      await runOrderMaintenance();
      expect(P.calls.orderPayments).toHaveLength(0);
      expect((await db(o.id)).paymentStatus).toBe('PENDING');
      const tick = await runOrderMaintenance(minutesFromNow(3));
      expect(tick.reconciledPaid).toContain(o.id);
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      expect(row.paidAt).not.toBeNull();
      expect(row.payments[0]).toMatchObject({ status: 'PAID', razorpayPaymentId: 'pay_lost_wh', capturedAmountPaise: o.paise });
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_RECONCILED' } })).toBe(1);
      // it is now a normal paid order: the restaurant can accept it
      expect((await setStatus(o.id, 'ACCEPTED', tVendor)).status).toBe(200);
      // nothing left to ask, nothing refunded, a late webhook / verify is just a replay
      const before = P.calls.orderPayments.length;
      await runOrderMaintenance(minutesFromNow(4));
      expect(P.calls.orderPayments.length).toBe(before);
      await webhook(captured(o.rzp, o.paise, 'pay_lost_wh')); await verify(o.rzp, 'pay_lost_wh');
      expect(P.calls.refund).toHaveLength(0);
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_RECONCILED' } })).toBe(1);
    });

    test('PROVE: lost webhook + dead app + the order EXPIRED meanwhile: the payment is found and refunded automatically, exactly once', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_lost_expired', orderId: o.rzp, amountPaise: o.paise });
      await prisma.order.update({ where: { id: o.id }, data: { createdAt: minutesAgo(20) } });
      const t1 = await runOrderMaintenance(minutesFromNow(3)); // expires it, then asks Razorpay
      expect(t1.expired).toContain(o.id);
      expect(t1.reconciledLateRefund).toContain(o.id);
      await __waitForBackgroundWork();
      let row = await db(o.id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(row.paidAt).toBeNull(); // the restaurant never saw it
      expect(P.sim.refunds.get('pay_lost_expired')).toHaveLength(1);
      await runOrderMaintenance(minutesFromNow(4)); await runOrderMaintenance(minutesFromNow(30));
      expect(P.calls.refund.filter((c) => c.paymentId === 'pay_lost_expired')).toHaveLength(1);
      row = await db(o.id);
      expect(row.paymentStatus).toBe('REFUNDED');
    });

    test('PROVE: customer cancelled while unpaid, then the payment lands unnoticed: reconcile refunds it', async () => {
      const o = await placeUnpaid();
      expect((await customerCancel(o.id)).status).toBe(200);
      P.sim.addPayment({ id: 'pay_after_cancel_rec', orderId: o.rzp, amountPaise: o.paise });
      await runOrderMaintenance(minutesFromNow(3)); await __waitForBackgroundWork();
      expect(await db(o.id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(P.sim.refunds.get('pay_after_cancel_rec')).toHaveLength(1);
    });

    test('PROVE: amount mismatch found by reconcile: NOT marked paid, recorded and flagged once (no audit spam on later ticks)', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_wrong_amt', orderId: o.rzp, amountPaise: 5000 });
      const t = await runOrderMaintenance(minutesFromNow(3));
      expect(t.reconcileFlagged).toContain(o.id);
      const row = await db(o.id);
      expect(row.paymentStatus).toBe('PENDING');
      expect(row.payments[0]).toMatchObject({ status: 'PENDING', capturedAmountPaise: 5000, razorpayPaymentId: 'pay_wrong_amt' });
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems).toContain('PAYMENT_MISMATCH');
      const asked = P.calls.orderPayments.length;
      await runOrderMaintenance(minutesFromNow(4)); await runOrderMaintenance(minutesFromNow(5));
      expect(P.calls.orderPayments.length).toBe(asked); // not asked again
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_AMOUNT_MISMATCH' } })).toBe(1);
      expect(P.calls.refund).toHaveLength(0);
    });

    test('PROVE: an authorized (not yet captured) payment of the right amount is captured by reconcile, then the order is paid; a wrong amount is left alone', async () => {
      const ok = await placeUnpaid();
      const wrong = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_auth_ok', orderId: ok.rzp, amountPaise: ok.paise, status: 'authorized' });
      P.sim.addPayment({ id: 'pay_auth_wrong', orderId: wrong.rzp, amountPaise: 100, status: 'authorized' });
      await runOrderMaintenance(minutesFromNow(3));
      expect(P.calls.capture).toEqual(['pay_auth_ok']);
      expect((await db(ok.id)).paymentStatus).toBe('PAID');
      expect(P.sim.payments.get('pay_auth_ok')!.status).toBe('captured');
      expect((await db(wrong.id)).paymentStatus).toBe('PENDING');
    });

    test('PROVE: provider outage during reconcile: no crash, nothing marked, breaker stops the phase, the next tick recovers it', async () => {
      const rows = await bulkUnpaid(12);
      for (const [i, o] of rows.entries()) P.sim.addPayment({ id: `pay_outage_${i}`, orderId: o.rzp, amountPaise: o.paise });
      P.ctl.fetchDown = true;
      const t = await runOrderMaintenance(minutesFromNow(3));
      expect(t.providerPhaseStopped).toBe(true);
      expect(t.reconciledPaid).toHaveLength(0);
      expect(P.calls.orderPayments.length).toBeLessThan(12);
      for (const o of rows) expect((await db(o.id)).paymentStatus).toBe('PENDING');
      P.ctl.fetchDown = false;
      const t2 = await runOrderMaintenance(minutesFromNow(4));
      expect(t2.providerPhaseStopped).toBe(false);
      expect(t2.reconciledPaid.filter((id) => rows.some((r) => r.id === id))).toHaveLength(12);
    });

    test('PROVE: a hung provider during reconcile is bounded by the per-call timeout and the breaker', async () => {
      const restore = applyEnv({ PROVIDER_TIMEOUT_MS: '700' });
      try {
        const rows = await bulkUnpaid(8);
        P.ctl.fetchHang = true;
        const t0 = Date.now();
        const t = await runOrderMaintenance(minutesFromNow(3));
        expect(Date.now() - t0).toBeLessThan(4_000);
        expect(t.providerPhaseStopped).toBe(true);
        for (const o of rows) expect((await db(o.id)).paymentStatus).toBe('PENDING');
      } finally { restore(); }
    }, 30_000);

    test('PROVE: reconcile racing the webhook and the app: one paid transition, no refund', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_race_rec', orderId: o.rzp, amountPaise: o.paise });
      await Promise.all([runOrderMaintenance(minutesFromNow(3)), runOrderMaintenance(minutesFromNow(3)), webhook(captured(o.rzp, o.paise, 'pay_race_rec')), verify(o.rzp, 'pay_race_rec')]);
      await __waitForBackgroundWork();
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      expect(row.payments).toHaveLength(1);
      expect(P.calls.refund).toHaveLength(0);
    });

    test('PROVE: at most 20 Payment rows are asked per tick (newest always, the rest rotates) and old/paid rows are never asked', async () => {
      const orders = await Promise.all(Array.from({ length: 30 }, () => mkOrder({ ageMin: 1 })));
      const paid = await mkOrder({ paid: true });
      const old = await mkOrder({});
      await prisma.payment.updateMany({ where: { orderId: old.id }, data: { createdAt: new Date(Date.now() - 7 * 3_600_000) } });
      await runOrderMaintenance(minutesFromNow(3));
      expect(P.calls.orderPayments.length).toBe(20);
      await runOrderMaintenance(minutesFromNow(4));
      const asked = fetchedIds();
      for (const o of orders) expect(asked.has(o.rzp)).toBe(true); // everyone was asked within two ticks
      expect(asked.has(paid.rzp)).toBe(false);
      expect(asked.has(old.rzp)).toBe(false);
    });

    // ---- POST /payments/verify-signature asks Razorpay ----
    test('PROVE: verify-signature fetches the payment from Razorpay and marks paid only when captured for this order and amount', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v1', orderId: o.rzp, amountPaise: o.paise });
      const r = await verify(o.rzp, 'pay_v1');
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(r.body.status).toBeUndefined();
      expect(r.body.data.paymentStatus).toBe('PAID');
      expect(P.calls.fetchPayment).toEqual(['pay_v1']);
      expect(P.calls.capture).toHaveLength(0);
      // the same call again (lost response): still success, Razorpay not asked again
      expect((await verify(o.rzp, 'pay_v1')).status).toBe(200);
      expect(P.calls.fetchPayment).toEqual(['pay_v1']);
    });

    test('PROVE: verify-signature with an authorized payment (manual-capture account) captures it, then marks paid', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v_auth', orderId: o.rzp, amountPaise: o.paise, status: 'authorized' });
      const r = await verify(o.rzp, 'pay_v_auth');
      expect(r.status).toBe(200);
      expect(r.body.data.paymentStatus).toBe('PAID');
      expect(P.calls.capture).toEqual(['pay_v_auth']);
      expect(P.sim.payments.get('pay_v_auth')!.status).toBe('captured');
    });

    test('PROVE: verify-signature never trusts the app: payment not captured -> success + PENDING_CONFIRMATION, order NOT paid; the job finishes it once Razorpay has it', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v_created', orderId: o.rzp, amountPaise: o.paise, status: 'created' });
      const r = await verify(o.rzp, 'pay_v_created');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, status: 'PENDING_CONFIRMATION', paymentStatus: 'PENDING', message: expect.any(String) });
      expect(r.body.data).toMatchObject({ id: o.id, paymentStatus: 'PENDING', status: 'PLACED' });
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PENDING', paidAt: null });
      expect((await setStatus(o.id, 'ACCEPTED', tVendor)).status).not.toBe(200);
      P.sim.payments.get('pay_v_created')!.status = 'captured';
      await runOrderMaintenance(minutesFromNow(3));
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PAID' });
    });

    test('PROVE: verify-signature while Razorpay cannot be reached (5xx / network / hang) answers PENDING_CONFIRMATION, never PAID; the retry succeeds', async () => {
      const restore = applyEnv({ PROVIDER_TIMEOUT_MS: '700' });
      try {
        const o = await placeUnpaid();
        P.sim.addPayment({ id: 'pay_v_down', orderId: o.rzp, amountPaise: o.paise });
        for (const mode of ['fetchDown', 'fetchNetworkError', 'fetchHang'] as const) {
          P.ctl[mode] = true;
          const r = await verify(o.rzp, 'pay_v_down');
          expect([mode, r.status, r.body.success, r.body.status, r.body.paymentStatus]).toEqual([mode, 200, true, 'PENDING_CONFIRMATION', 'PENDING']);
          expect((await db(o.id)).paymentStatus).toBe('PENDING');
          P.ctl[mode] = false;
        }
        const ok = await verify(o.rzp, 'pay_v_down');
        expect(ok.body.data.paymentStatus).toBe('PAID');
        // a replay of an already confirmed payment needs no provider call, even during an outage
        P.ctl.fetchDown = true;
        const again = await verify(o.rzp, 'pay_v_down');
        expect([again.status, again.body.success, again.body.data.paymentStatus]).toEqual([200, true, 'PAID']);
        P.ctl.fetchDown = false;
      } finally { restore(); }
    }, 30_000);

    test('PROVE: verify-signature with a capture that fails and is not captured on re-check stays PENDING_CONFIRMATION', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v_capfail', orderId: o.rzp, amountPaise: o.paise, status: 'authorized' });
      const sim = P.sim;
      setPaymentProvider({ ...P.provider, capturePayment: async () => { throw sdkError(500, 'capture failed'); } });
      const r = await verify(o.rzp, 'pay_v_capfail');
      expect([r.status, r.body.status]).toEqual([200, 'PENDING_CONFIRMATION']);
      expect((await db(o.id)).paymentStatus).toBe('PENDING');
      expect(sim.payments.get('pay_v_capfail')!.status).toBe('authorized');
    });

    test('PROVE: verify-signature: Razorpay says a different amount -> 409 PAYMENT_AMOUNT_MISMATCH, not paid; a payment of another Razorpay order -> 404, not paid', async () => {
      const o = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v_amt', orderId: o.rzp, amountPaise: 100 });
      const r = await verify(o.rzp, 'pay_v_amt');
      expect([r.status, r.body.code]).toEqual([409, 'PAYMENT_AMOUNT_MISMATCH']);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PENDING', paidAt: null });
      const other = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_v_other', orderId: other.rzp, amountPaise: o.paise });
      const x = await verify(o.rzp, 'pay_v_other'); // valid-looking pair, but the payment belongs to another Razorpay order
      expect([x.status, x.body.code]).toEqual([404, 'NOT_FOUND']);
      expect((await db(o.id)).paymentStatus).toBe('PENDING');
      expect((await db(other.id)).paymentStatus).toBe('PENDING');
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'PAYMENT_ORDER_MISMATCH' } })).toBe(1);
    });

    test('PROVE: verify-signature for an order cancelled meanwhile: 409 ORDER_CANCELLED and the captured money is refunded', async () => {
      const o = await placeUnpaid();
      await customerCancel(o.id);
      P.sim.addPayment({ id: 'pay_v_late', orderId: o.rzp, amountPaise: o.paise });
      const r = await verify(o.rzp, 'pay_v_late');
      expect([r.status, r.body.code]).toEqual([409, 'ORDER_CANCELLED']);
      expect(P.sim.refunds.get('pay_v_late')).toHaveLength(1);
      expect(await db(o.id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    });

    // ---- GET /admin/payments/reconcile ----
    const orphans = (qs = '', token = tAdmin) => request.get(`/api/admin/payments/reconcile${qs}`).set(H(token));
    const sec = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);

    test('PROVE: GET /admin/payments/reconcile lists captured payments with no PAID/REFUNDED row (orphans), read-only; admin only', async () => {
      const accounted = await placePaid();
      P.sim.addPayment({ id: accounted.payId, orderId: accounted.rzp, amountPaise: 22000, createdAtSec: sec(60_000) });
      const unknown = P.sim.addPayment({ id: 'pay_orphan_unknown', orderId: 'order_not_ours', amountPaise: 1234, createdAtSec: sec(120_000) });
      const lost = await placeUnpaid();
      P.sim.addPayment({ id: 'pay_orphan_lost', orderId: lost.rzp, amountPaise: lost.paise, createdAtSec: sec(180_000) });
      P.sim.addPayment({ id: 'pay_not_captured', orderId: 'order_x', amountPaise: 500, status: 'authorized', createdAtSec: sec(60_000) });
      P.sim.addPayment({ id: 'pay_failed_one', orderId: 'order_y', amountPaise: 500, status: 'failed', createdAtSec: sec(60_000) });
      P.sim.addPayment({ id: 'pay_three_days', orderId: 'order_old', amountPaise: 900, createdAtSec: sec(3 * 86_400_000) });
      P.sim.addPayment({ id: 'pay_ten_days', orderId: 'order_older', amountPaise: 900, createdAtSec: sec(10 * 86_400_000) });
      const before = await prisma.payment.count();
      const r = await orphans();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, truncated: false, scanned: 5 });
      const ids = r.body.data.map((x: any) => x.paymentId).sort();
      expect(ids).toEqual(['pay_orphan_lost', 'pay_orphan_unknown']);
      const lostRow = r.body.data.find((x: any) => x.paymentId === 'pay_orphan_lost');
      expect(lostRow).toMatchObject({ razorpayOrderId: lost.rzp, amountPaise: lost.paise, kraveoOrderId: lost.id, kraveoPaymentStatus: 'PENDING', createdAt: expect.stringMatching(/Z$/) });
      expect(r.body.data.find((x: any) => x.paymentId === unknown.id)).toMatchObject({ kraveoOrderId: null, kraveoPaymentStatus: null });
      expect(JSON.stringify(r.body)).not.toMatch(/email|contact|card|vpa/i);
      expect(await prisma.payment.count()).toBe(before); // read-only
      expect(P.calls.refund).toHaveLength(0);
      // a wider range reaches the 3 day old payment, but not the 10 day old one
      const wide = await orphans(`?from=${sec(5 * 86_400_000)}&to=${sec(0)}`);
      expect(wide.body.data.map((x: any) => x.paymentId)).toContain('pay_three_days');
      expect(wide.body.data.map((x: any) => x.paymentId)).not.toContain('pay_ten_days');
      // admin only
      expect((await orphans('', tStudent)).status).toBe(403);
      expect((await orphans('', tVendor)).status).toBe(403);
      expect((await request.get('/api/admin/payments/reconcile')).status).toBe(401);
    });

    test('PROVE: GET /admin/payments/reconcile is bounded: max 7 days, from < to, valid dates, at most 200 payments looked at, provider outage = 503', async () => {
      expect((await orphans(`?from=${sec(8 * 86_400_000)}&to=${sec(0)}`)).body).toMatchObject({ success: false, code: 'RANGE_TOO_LARGE' });
      expect((await orphans(`?from=${sec(0)}&to=${sec(3_600_000)}`)).status).toBe(400);
      expect((await orphans('?from=yesterday-ish')).status).toBe(400);
      expect((await orphans('?to=%7B%22a%22%3A1%7D')).status).toBe(400);
      expect((await orphans(`?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date().toISOString()}`)).status).toBe(200);
      for (let i = 0; i < 230; i++) P.sim.addPayment({ id: `pay_bulk_${i}`, orderId: `order_bulk_${i}`, amountPaise: 100 + i, createdAtSec: sec(1000 + i) });
      const big = await orphans();
      expect(big.status).toBe(200);
      expect(big.body.scanned).toBe(200);
      expect(big.body.truncated).toBe(true);
      expect(big.body.count).toBeLessThanOrEqual(200);
      expect(P.calls.listPayments).toBeLessThanOrEqual(3);
      P.ctl.fetchDown = true;
      const down = await orphans();
      expect([down.status, down.body.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
    });

    test('PROVE: the code asks Razorpay for the state of an order / payment (orders.fetchPayments, payments.fetch, payments.capture, payments.all)', () => {
      const root = path.resolve(__dirname, '../../src');
      const files: string[] = [];
      const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') && files.push(path.join(d, e.name))));
      walk(root);
      const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      for (const needle of ['orders.fetchPayments(', 'payments.fetch(', 'payments.capture(', 'payments.all(']) expect(src).toContain(needle);
    });
  });

  // =============================================================================================
  // 7b. REFUND WEBHOOKS (refund.processed / refund.failed)
  // =============================================================================================
  describe('7b. refund.processed / refund.failed webhooks', () => {
    const refundEvent = (event: string, paymentId: string, refundId: string, amount = 22000, extra: Record<string, unknown> = {}) => ({
      event, payload: { refund: { entity: { id: refundId, payment_id: paymentId, amount, status: event === 'refund.failed' ? 'failed' : 'processed', ...extra } } },
    });
    const pendingRefundOrder = async () => {
      const o = await mkOrder({ paid: true });
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', refundStatus: 'PENDING', refundLeaseUntil: minutesFromNow(1) } });
      return o;
    };

    test('PROVE: refund.processed confirms a PENDING refund as REFUNDED without calling the provider; replays and partial refunds change nothing', async () => {
      const o = await pendingRefundOrder();
      const partial = await webhook(refundEvent('refund.processed', o.payId, 'rfnd_partial', 5000));
      expect([partial.status, partial.body.status]).toEqual([200, 'ignored']);
      expect((await db(o.id)).refundStatus).toBe('PENDING');
      const w = await webhook(refundEvent('refund.processed', o.payId, 'rfnd_evt_1'));
      expect([w.status, w.body.status]).toEqual([200, 'processed']);
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE', refundError: null });
      expect(row.payments[0]).toMatchObject({ status: 'REFUNDED', razorpayRefundId: 'rfnd_evt_1' });
      expect(P.calls.refund).toHaveLength(0);
      expect(P.calls.list).toHaveLength(0);
      const again = await webhook(refundEvent('refund.processed', o.payId, 'rfnd_evt_1'));
      expect([again.status, again.body.status]).toEqual([200, 'ignored']);
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'REFUND_DONE' } })).toBe(1);
    });

    test('PROVE: refund.failed marks the refund FAILED with the provider reason (needs-attention shows it), the job does not repeat it blindly, admin retry-refund refunds again', async () => {
      const o = await pendingRefundOrder();
      const w = await webhook(refundEvent('refund.failed', o.payId, 'rfnd_bounce', 22000, { error_description: 'Refund rejected by the customer bank' }));
      expect([w.status, w.body.status]).toEqual([200, 'processed']);
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'PAID', refundStatus: 'FAILED', refundLeaseUntil: null });
      expect(row.refundError).toContain('Refund rejected by the customer bank');
      const na = (await needsAttention()).find((x) => x.order.id === o.id);
      expect(na.problems).toContain('REFUND_FAILED');
      expect(na.detail).toContain('Refund rejected by the customer bank');
      expect((await runOrderMaintenance(minutesFromNow(30))).refundsRetried).not.toContain(o.id);
      expect(P.calls.refund).toHaveLength(0);
      // replay: nothing changes
      expect((await webhook(refundEvent('refund.failed', o.payId, 'rfnd_bounce'))).body.status).toBe('ignored');
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'REFUND_PROVIDER_FAILED' } })).toBe(1);
      // the admin retries (money is still with Razorpay): refunded for real
      expect((await retryRefund(o.id)).status).toBe(200);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(P.sim.refunds.get(o.payId)).toHaveLength(1);
    });

    test('PROVE: refund.failed after we had booked the refund as DONE takes it back (customer did not get the money) and a retry creates a new refund', async () => {
      const o = await placePaid();
      await adminCancel(o.id); await __waitForBackgroundWork();
      const first = P.sim.refunds.get(o.payId)![0];
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      first.status = 'failed'; // what Razorpay's refund list shows after the bank bounced it
      const w = await webhook(refundEvent('refund.failed', o.payId, first.id, 22000, { error_description: 'Account closed' }));
      expect(w.body.status).toBe('processed');
      const row = await db(o.id);
      expect(row).toMatchObject({ paymentStatus: 'PAID', refundStatus: 'FAILED' });
      expect(row.payments[0]).toMatchObject({ status: 'PAID', razorpayRefundId: null, refundedAt: null });
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.detail).toContain('Account closed');
      expect((await retryRefund(o.id)).status).toBe(200);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(P.sim.refunds.get(o.payId)!.filter((r) => r.status !== 'failed')).toHaveLength(1);
      expect(P.calls.refund).toHaveLength(2);
    });

    test('PROVE: a refund.failed for an extra (duplicate) payment puts it back on the refund list; unknown payment / event / missing ids are answered 200 and ignored; bad signature 400', async () => {
      const o = await placePaid();
      const dupRzp = `rzp_order_sim_dup_ev_${randomUUID().slice(0, 8)}`;
      await prisma.payment.create({ data: { orderId: o.id, razorpayOrderId: dupRzp, amount: 220, status: 'PENDING' } });
      await webhook(captured(dupRzp, 22000, 'pay_dup_bounce')); await __waitForBackgroundWork();
      const refundId = P.sim.refunds.get('pay_dup_bounce')![0].id;
      const w = await webhook(refundEvent('refund.failed', 'pay_dup_bounce', refundId, 22000, { error_description: 'Bank said no' }));
      expect(w.body.status).toBe('processed');
      const extra = (await db(o.id)).payments.find((x) => x.razorpayOrderId === dupRzp)!;
      expect(extra).toMatchObject({ status: 'PENDING', razorpayRefundId: null });
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PAID', refundStatus: null }); // the order itself is untouched
      expect((await needsAttention()).find((x) => x.order.id === o.id)?.problems).toContain('DUPLICATE_PAYMENT');
      for (const body of [
        refundEvent('refund.failed', 'pay_never_heard_of', 'rfnd_1'), refundEvent('refund.processed', 'pay_never_heard_of', 'rfnd_1'),
        { event: 'refund.processed', payload: {} }, { event: 'refund.created', payload: { refund: { entity: { id: 'rfnd_2', payment_id: o.payId } } } }, { event: 'refund.failed' },
      ]) {
        const r = await webhook(body);
        expect([r.status, r.body.success]).toEqual([200, true]);
      }
      expect((await webhook(refundEvent('refund.failed', o.payId, 'rfnd_3'), 'wrong_signature')).status).toBe(400);
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'PAID', refundStatus: null });
    });
  });

  // =============================================================================================
  // 8. RAZORPAY SDK USAGE (real razorpay package, fake HTTP adapter)
  // =============================================================================================
  describe('8. Razorpay SDK usage', () => {
    const fakeRazorpay = (handler: (cfg: any) => { data?: any; error?: any }) => {
      const seen: any[] = [];
      const restore = applyEnv({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_test_fakekey', RAZORPAY_KEY_SECRET: 'fake_secret_value' });
      let mod: PaymentServiceModule;
      try {
        let m: any;
        jest.isolateModules(() => {
          const axios = require('axios');
          (axios.default ?? axios).defaults.adapter = async (cfg: any) => {
            seen.push(cfg);
            const r = handler(cfg);
            if (r.error) throw r.error;
            return { data: r.data, status: 200, statusText: 'OK', headers: {}, config: cfg };
          };
          m = require('../../src/services/paymentService');
        });
        mod = m;
      } finally { restore(); }
      return { mod: mod!, seen, run: <T>(fn: () => Promise<T>) => withEnvAsync({ NODE_ENV: 'production' }, fn) };
    };
    const httpError = (status: number, description: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { code: status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST_ERROR', description } } } });

    test('PROVE: createOrder / refund / listRefunds send integer paise, INR, speed normal, receipts <= 40 chars, GET refunds with count=100, Basic auth', async () => {
      const f = fakeRazorpay((cfg) => {
        if (cfg.url.endsWith('/orders')) return { data: { id: 'order_fake1', amount: 22665, currency: 'INR', status: 'created' } };
        if (cfg.url.endsWith('/refund')) return { data: { id: 'rfnd_fake1', amount: 22665, status: 'processed' } };
        return { data: { entity: 'collection', count: 1, items: [{ id: 'rfnd_fake1', amount: 22665, status: 'processed' }] } };
      });
      const orderId = randomUUID();
      const out = await f.run(async () => {
        const provider = f.mod.getPaymentProvider();
        const o = await f.mod.createRazorpayOrder(orderId, 226.65);
        const r = await provider.refundPayment({ paymentId: 'pay_fake1', amountPaise: 22665, receipt: `rf_${orderId}`.slice(0, 40), notes: { orderId, reason: 'x' } });
        const l = await provider.listRefunds('pay_fake1');
        return { o, r, l };
      });
      expect(out.o).toMatchObject({ success: true, razorpayOrderId: 'order_fake1', amountInPaise: 22665, currency: 'INR' });
      expect(out.r).toEqual({ id: 'rfnd_fake1', amountPaise: 22665, status: 'processed' });
      expect(out.l).toEqual([{ id: 'rfnd_fake1', amountPaise: 22665, status: 'processed' }]);
      const [c, rf, ls] = f.seen;
      expect(c.method).toBe('post'); expect(c.url).toBe('/v1/orders');
      const cb = JSON.parse(c.data);
      expect(cb).toMatchObject({ amount: 22665, currency: 'INR' });
      expect(Number.isInteger(cb.amount)).toBe(true);
      expect(cb.receipt.length).toBeLessThanOrEqual(40);
      expect(cb.payment_capture).toBe(1); // Razorpay captures automatically (refunds need a captured payment)
      expect(rf.url).toBe('/v1/payments/pay_fake1/refund');
      expect(JSON.parse(rf.data)).toMatchObject({ amount: 22665, speed: 'normal' });
      expect(JSON.parse(rf.data).receipt.length).toBeLessThanOrEqual(40);
      expect(ls.method).toBe('get'); expect(ls.url).toBe('/v1/payments/pay_fake1/refunds');
      expect(ls.params.count).toBe(100);
      expect(c.auth).toBeTruthy(); // key id + secret as HTTP basic auth (value not inspected)
    });

    test('PROVE: a Razorpay 4xx/5xx body is surfaced as its description (secrets/payload never in the message)', async () => {
      const f = fakeRazorpay(() => ({ error: httpError(400, 'The payment has not been captured yet') }));
      const msg = await f.run(async () => {
        try { await f.mod.getPaymentProvider().refundPayment({ paymentId: 'pay_x', amountPaise: 100, receipt: 'r', notes: {} }); return 'no error'; } catch (e) { return f.mod.providerErrorMessage(e); }
      });
      expect(msg).toBe('The payment has not been captured yet');
    });

    test('PROVE: a network error / timeout (no HTTP response) is mapped to a typed transient "network error" with a readable message (the SDK itself would throw a TypeError about "reading status")', async () => {
      const f = fakeRazorpay(() => ({ error: Object.assign(new Error('timeout of 0ms exceeded'), { code: 'ECONNABORTED' }) }));
      const out = await f.run(async () => {
        const provider = f.mod.getPaymentProvider();
        const errs: any[] = [];
        for (const call of [
          () => provider.refundPayment({ paymentId: 'pay_x', amountPaise: 100, receipt: 'r', notes: {} }),
          () => provider.listRefunds('pay_x'), () => provider.fetchPayment!('pay_x'), () => provider.capturePayment!('pay_x', 100),
          () => provider.fetchOrderPayments!('order_x'), () => provider.listPayments!({ fromSec: 1, toSec: 2, count: 10, skip: 0 }),
          () => provider.createOrder({ receipt: 'r', amountPaise: 100, notes: {} }),
        ]) { try { await call(); errs.push(null); } catch (e) { errs.push(e); } }
        return { errs, msg: f.mod.providerErrorMessage(errs[0]) };
      });
      for (const e of out.errs) {
        expect(e).toBeInstanceOf(f.mod.PaymentProviderError);
        expect(e).toMatchObject({ transient: true, statusCode: null, providerCode: 'NETWORK_ERROR' });
      }
      expect(out.msg).toMatch(/network error/i);
      expect(out.msg).not.toMatch(/Cannot read properties of undefined/);
    });

    test('PROVE: SDK answers keep their HTTP status on the typed error: 5xx / 429 transient, other 4xx permanent', async () => {
      for (const [status, transient] of [[500, true], [503, true], [429, true], [400, false], [404, false]] as const) {
        const f = fakeRazorpay(() => ({ error: httpError(status, `answer ${status}`) }));
        const e: any = await f.run(async () => { try { await f.mod.getPaymentProvider().fetchPayment!('pay_x'); return null; } catch (err) { return err; } });
        expect([status, e.statusCode, e.transient, e.message]).toEqual([status, status, transient, `answer ${status}`]);
      }
    });

    test('PROVE: a network error during a refund is a transient failure end to end (readable reason, attempt not used, retried, refunded once the network is back)', async () => {
      const o = await placePaid();
      const sim = createSimulatedProvider();
      let broken = true;
      const f = fakeRazorpay(() => ({ error: Object.assign(new Error('timeout of 0ms exceeded'), { code: 'ECONNABORTED' }) }));
      const real = await f.run(async () => f.mod.getPaymentProvider()); // the real Razorpay provider on a fake network
      setPaymentProvider({ ...sim, listRefunds: (id) => (broken ? real.listRefunds(id) : sim.listRefunds(id)) });
      await adminCancel(o.id);
      const row = await db(o.id);
      expect(row).toMatchObject({ refundStatus: 'FAILED', refundAttempts: 0 });
      expect(row.refundError).toMatch(/network error/i);
      expect(row.refundError).not.toMatch(/reading/);
      broken = false;
      await runOrderMaintenance(minutesFromNow(5));
      expect(await db(o.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
    });

    test('PROVE: fetchPayment / capture / fetchOrderPayments / listPayments send the right Razorpay requests and read only the needed fields', async () => {
      const entity = (id: string, status: string) => ({ id, entity: 'payment', amount: 22665, currency: 'INR', status, order_id: 'order_fake1', created_at: 1_790_000_000, email: 'x@y.z', contact: '+910000000000', card_id: 'card_secret' });
      const f = fakeRazorpay((cfg) => {
        if (cfg.url.endsWith('/capture')) return { data: entity('pay_fake1', 'captured') };
        if (cfg.url === '/v1/orders/order_fake1/payments') return { data: { entity: 'collection', count: 2, items: [entity('pay_a', 'failed'), entity('pay_b', 'captured')] } };
        if (cfg.url === '/v1/payments') return { data: { entity: 'collection', count: 1, items: [entity('pay_list1', 'captured')] } };
        return { data: entity('pay_fake1', 'authorized') };
      });
      const out = await f.run(async () => {
        const provider = f.mod.getPaymentProvider();
        return {
          one: await provider.fetchPayment!('pay_fake1'),
          cap: await provider.capturePayment!('pay_fake1', 22665),
          byOrder: await provider.fetchOrderPayments!('order_fake1'),
          all: await provider.listPayments!({ fromSec: 1_789_000_000, toSec: 1_790_100_000, count: 100, skip: 100 }),
        };
      });
      expect(out.one).toEqual({ id: 'pay_fake1', orderId: 'order_fake1', amountPaise: 22665, status: 'authorized', createdAtSec: 1_790_000_000 });
      expect(JSON.stringify(out)).not.toMatch(/x@y\.z|card_secret|0000000000/); // no contact data is kept
      expect(out.cap.status).toBe('captured');
      expect(out.byOrder.map((p) => [p.id, p.status])).toEqual([['pay_a', 'failed'], ['pay_b', 'captured']]);
      expect(out.all).toHaveLength(1);
      const [fetch1, cap, byOrder, all] = f.seen;
      expect([fetch1.method, fetch1.url]).toEqual(['get', '/v1/payments/pay_fake1']);
      expect([cap.method, cap.url]).toEqual(['post', '/v1/payments/pay_fake1/capture']);
      expect(JSON.parse(cap.data)).toEqual({ amount: 22665, currency: 'INR' });
      expect([byOrder.method, byOrder.url]).toEqual(['get', '/v1/orders/order_fake1/payments']);
      expect([all.method, all.url]).toEqual(['get', '/v1/payments']);
      expect(all.params).toMatchObject({ from: 1_789_000_000, to: 1_790_100_000, count: 100, skip: 100 });
    });
  });

  // =============================================================================================
  // 9. CHAOS: random concurrent mix, then check conservation of money for every order
  // =============================================================================================
  describe('9. chaos', () => {
    test('PROVE: 30 orders x random concurrent verify / webhook / customer cancel / reject / accept / admin cancel + time-shifted job runs: every captured payment ends either kept (order alive/delivered) or refunded exactly once; nothing refunded twice, nothing accepted+refunded-without-cancel', async () => {
      const seed = 7731;
      const rnd = prng(seed);
      await prisma.order.updateMany({ where: { status: 'PLACED' }, data: { status: 'CANCELLED' } });
      const N = 30;
      const orders = await Promise.all(Array.from({ length: N }, async (_, i) => {
        const o = await mkOrder({ ageMin: 1 });
        const rzp = `rzp_order_sim_chaos_${i}_${randomUUID().slice(0, 6)}`;
        await prisma.payment.updateMany({ where: { orderId: o.id }, data: { razorpayOrderId: rzp } });
        return { id: o.id, rzp, pay: `pay_chaos_${i}_${randomUUID().slice(0, 6)}` };
      }));
      type Task = () => Promise<unknown>;
      const tasks: Task[] = [];
      const sentPay = new Set<string>();
      for (const o of orders) {
        const menu: [string, Task][] = [
          ['pay', () => verify(o.rzp, o.pay)], ['pay', () => webhook(captured(o.rzp, 22000, o.pay))],
          ['pay', () => webhook(captured(o.rzp, 22000, o.pay, {}, 'order.paid'))],
          ['x', () => customerCancel(o.id)], ['x', () => vendorReject(o.id)], ['x', () => setStatus(o.id, 'ACCEPTED', tVendor)], ['x', () => adminCancel(o.id)],
        ];
        const k = 3 + Math.floor(rnd() * 4);
        for (let j = 0; j < k; j++) { const [kind, t] = menu[Math.floor(rnd() * menu.length)]; if (kind === 'pay') sentPay.add(o.id); tasks.push(t); }
      }
      for (let j = 0; j < 4; j++) tasks.push(() => runOrderMaintenance(minutesFromNow(16)));
      for (let j = 0; j < 2; j++) tasks.push(() => runOrderMaintenance());
      tasks.sort(() => rnd() - 0.5);
      await Promise.allSettled(tasks.map((t) => t()));
      await __waitForBackgroundWork();
      await runOrderMaintenance(minutesFromNow(3)); await __waitForBackgroundWork(); await runOrderMaintenance(minutesFromNow(3));
      const callsBefore = P.calls.refund.length;
      await runOrderMaintenance(minutesFromNow(3)); // a quiet tick must do nothing
      expect(P.calls.refund.length).toBe(callsBefore);

      const summary = { kept: 0, refunded: 0, unpaid: 0 };
      for (const o of orders) {
        const r = await db(o.id);
        const refunds = P.sim.refunds.get(o.pay) ?? [];
        const ctx = `seed=${seed} order=${o.id} status=${r.status} pay=${r.paymentStatus} refund=${r.refundStatus}`;
        expect(P.calls.refund.filter((c) => c.paymentId === o.pay).length).toBeLessThanOrEqual(1);
        if (!sentPay.has(o.id)) { expect({ ctx, refunds: refunds.length }).toEqual({ ctx, refunds: 0 }); expect(r.paymentStatus).not.toBe('PAID'); summary.unpaid++; continue; }
        if (r.status === 'CANCELLED') {
          expect({ ctx, pay: r.paymentStatus }).toEqual({ ctx, pay: 'REFUNDED' });
          expect({ ctx, refunds: refunds.length, paise: refunds[0]?.amountPaise }).toEqual({ ctx, refunds: 1, paise: 22000 });
          expect(r.refundStatus).toBe('DONE'); summary.refunded++;
        } else {
          expect({ ctx, pay: r.paymentStatus }).toEqual({ ctx, pay: 'PAID' });
          expect({ ctx, refunds: refunds.length }).toEqual({ ctx, refunds: 0 });
          expect(r.paidAt).not.toBeNull(); summary.kept++;
        }
        if (r.paymentStatus === 'REFUNDED') expect(r.status).toBe('CANCELLED');
      }
      expect(summary.kept + summary.refunded + summary.unpaid).toBe(N);
    });
  });
});
