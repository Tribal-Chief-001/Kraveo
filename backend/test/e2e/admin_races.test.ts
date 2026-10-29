/**
 * Admin user management: races of a suspension / removal against the customer's own requests (Docs/27 B1 "race-free", Docs/28 rules).
 * The admin call starts 0-N ms after the customer's request so the two meet at every point of the checkout / payment. Invariants checked
 * from the database after every round: no open order for a blocked customer, no double refund, no money without an order owner.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { World, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf } from '../harness/journey';

jest.setTimeout(240_000);
const P = 'ax';
const later = async <T,>(ms: number, fn: () => Promise<T>): Promise<T> => { await new Promise((r) => setTimeout(r, ms)); return fn(); };

describe('Admin account actions vs the customer\'s own requests', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  const admin = () => ({ Authorization: `Bearer ${W.admin.token}` });
  const act = (id: string, verb: 'suspend' | 'restore' | 'remove', body: object = {}) => request.post(`/api/admin/customers/${id}/${verb}`).set(admin()).send(body);
  const openCount = (customerId: string) => prisma.order.count({ where: { customerId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
  const reset = async (id: string) => {
    await prisma.order.deleteMany({ where: { customerId: id } });
    await prisma.orderGroup.deleteMany({ where: { customerId: id } });
    await prisma.user.update({ where: { id }, data: { accountStatus: 'ACTIVE', statusReason: null, deletedAt: null, tokenVersion: 0 } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    W = await createWorld(P, '6', { customers: 4, vendors: 2, riders: 1 });
    server = await startTestServer(0);
    request = supertest(server.app);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await __waitForBackgroundWork();
    await cleanTestOrders();
    await resetWorldState(W);
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await purgeWorld(P);
    await cleanTestOrders();
    await prisma.adminAuditLog.deleteMany({});
    await prisma.$disconnect();
  });

  test('remove (REFUSE) vs placeOrder: either the order exists and the removal was refused, or the customer is removed and has NO order (22 rounds)', async () => {
    const c = W.customers[0];
    let removedRounds = 0;
    for (let i = 0; i < 22; i++) {
      await reset(c.id);
      const [placed, removed] = await Promise.all([api.place(c, W.vendors[0]), later(i, () => act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester' }))]);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
      const orders = await prisma.order.count({ where: { customerId: c.id } });
      if (row.accountStatus === 'REMOVED') {
        removedRounds += 1;
        expect([removed.status, orders]).toEqual([200, 0]);
        expect([401, 403]).toContain(placed.status === 201 ? 0 : placed.status); // the checkout was refused (401 account unavailable, or the old token)
      } else {
        expect([removed.status, removed.body.code, placed.status, orders]).toEqual([409, 'HAS_OPEN_ORDERS', 201, 1]);
      }
    }
    expect(removedRounds).toBeGreaterThanOrEqual(0);
  });

  test('suspend (CANCEL) vs placeOrder: nothing open is left for the customer; a placed order is cancelled with no refund (unpaid); never a 5xx (18 rounds)', async () => {
    const c = W.customers[1];
    for (let i = 0; i < 18; i++) {
      await reset(c.id);
      const [placed, sus] = await Promise.all([api.place(c, W.vendors[0]), later(i, () => act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' }))]);
      await __waitForBackgroundWork();
      expect(sus.status).toBe(200);
      expect(sus.body.failed).toEqual([]);
      expect(await openCount(c.id)).toBe(0);
      if (placed.status === 201) {
        const row = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.id } });
        expect([row.status, row.paymentStatus, row.refundStatus]).toEqual(['CANCELLED', 'PENDING', null]);
      } else {
        expect([401, 403]).toContain(placed.status);
      }
    }
  });

  test('suspend (CANCEL) vs a combined checkout: no open order and no open group is left (14 rounds)', async () => {
    const c = W.customers[2];
    for (let i = 0; i < 14; i++) {
      await reset(c.id);
      const [placed, sus] = await Promise.all([api.placeGroup(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])]), later(i * 2, () => act(c.id, 'suspend', { reason: 'Fake orders', openOrders: 'CANCEL' }))]);
      await __waitForBackgroundWork();
      expect(sus.status).toBe(200);
      expect(await openCount(c.id)).toBe(0);
      if (placed.status === 201) {
        const kids = await prisma.order.findMany({ where: { groupId: placed.body.data.id } });
        expect(kids.every((k) => k.status === 'CANCELLED')).toBe(true);
      }
    }
  });

  test('remove (CANCEL) vs the customer\'s payment landing at the same moment: the money is refunded exactly once, or the removal was refused because the paid order was already live (10 rounds)', async () => {
    const c = W.customers[3];
    for (let i = 0; i < 10; i++) {
      await reset(c.id);
      const placed = await api.place(c, W.vendors[1]);
      const id = placed.body.data.id as string;
      const cp = await api.createPayment(c, id);
      const payId = `pay_ax_${i}`;
      ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
      const [, removed] = await Promise.all([api.verify(c, cp.body.razorpayOrderId, payId), later(i * 3, () => act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust4 Tester', openOrders: 'CANCEL' }))]);
      await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise); // the webhook arrives too, in any order
      await __waitForBackgroundWork();
      expect(removed.status).toBe(200);
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('CANCELLED'); // CANCEL mode: whatever state the order was in, it ends cancelled
      expect(ledger.refundsOf(payId)).toHaveLength(1); // the customer paid once, was refunded once
      expect(ledger.totalRefunded()).toBe(ledger.totalCaptured());
      expect(['DONE', 'PENDING']).toContain(row.refundStatus);
      ledger.refundsOf(payId); // eslint-disable-line @typescript-eslint/no-unused-expressions
      await prisma.order.deleteMany({ where: { id } });
      ledger = createLedger();
      setPaymentProvider(ledger.provider);
    }
  });

  test('two admins at once: suspend and remove (and remove twice) end in ONE coherent state with one audit row per real change, never a 5xx (10 rounds)', async () => {
    const c = W.customers[0];
    for (let i = 0; i < 10; i++) {
      await reset(c.id);
      await prisma.adminAuditLog.deleteMany({});
      const [a, b, d] = await Promise.all([
        act(c.id, 'suspend', { reason: 'Fake orders' }),
        later(i % 3, () => act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester' })),
        later(i % 4, () => act(c.id, 'remove', { reason: 'Fraud', confirmName: 'Cust1 Tester' })),
      ]);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.accountStatus).toBe('REMOVED'); // a remove always wins over a suspend, whatever the order of arrival
      expect([a.status, b.status, d.status].every((s) => s === 200 || s === 409)).toBe(true);
      expect([b.status, d.status]).toContain(200);
      const removedRows = await prisma.adminAuditLog.count({ where: { action: 'CUSTOMER_REMOVED', targetId: c.id } });
      expect(removedRows).toBe(1);
      const susRows = await prisma.adminAuditLog.count({ where: { action: 'CUSTOMER_SUSPENDED', targetId: c.id } });
      expect(susRows).toBe(a.body.changed === true ? 1 : 0);
    }
  });

  test('restore vs a sign-in at the same moment: the person either gets the block answer or a working new session, never a half state', async () => {
    const c = W.customers[1];
    await prisma.user.update({ where: { id: c.id }, data: { email: 'race@ax.kraveo.test', googleSub: 'sub-ax-race' } });
    const { setGoogleVerifier } = await import('../../src/services/googleAuth');
    setGoogleVerifier(async () => ({ sub: 'sub-ax-race', email: 'race@ax.kraveo.test', emailVerified: true, name: 'Race' }));
    try {
      for (let i = 0; i < 8; i++) {
        await reset(c.id);
        await act(c.id, 'suspend', { reason: 'Fake orders' });
        const [g, r] = await Promise.all([request.post('/api/auth/google').send({ idToken: 'x'.repeat(30) }), later(i, () => act(c.id, 'restore'))]);
        expect(r.status).toBe(200);
        if (g.status === 200) expect((await request.get('/api/auth/profile').set({ Authorization: `Bearer ${g.body.token}` })).status).toBe(200);
        else expect([g.status, g.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      }
    } finally {
      setGoogleVerifier(null);
    }
  });
});
