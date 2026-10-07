/**
 * Multi-restaurant orders (Docs/22), part 3: push notifications without duplicates, and the deadlock / consistency stress test.
 *  - Push: restaurants hear about THEIR part; the customer and the riders hear about the combined order ONCE (addressed to the primary child).
 *  - Stress: random mixed parallel operations (pay replays, accept, cook, claim, release, pickup, arrive, OTP, cancel, reject, reassign, expiry job)
 *    on one group must finish (no hang, no 5xx) and leave consistent state: all-or-nothing cancel, one rider, one OTP, one refund.
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { setPushProvider } from '../../src/services/push/provider';
import { __waitForPushWork, sweepMissedPushes, runPushMaintenance } from '../../src/services/push/pushService';
import { PushMessage, PushProvider } from '../../src/services/push/types';
import {
  World, Person, Customer, Vendor, Rider, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, minutesFromNow,
} from '../harness/journey';

jest.setTimeout(240_000);

class FakeProvider implements PushProvider {
  readonly enabled = true;
  sent: PushMessage[] = [];
  async send(m: PushMessage) { this.sent.push(m); }
  of(event: string) { return this.sent.filter((m) => m.data.event === event); }
}

describe('Order groups: push and stress', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let fake: FakeProvider;
  const owner = new Map<string, string>(); // token -> who
  const flush = async () => { await __waitForPushWork(); await __waitForBackgroundWork(); await __waitForPushWork(); };
  const tok = (p: Person) => `tok_${p.id}_AAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const register = async () => {
    await prisma.deviceToken.deleteMany({});
    owner.clear();
    for (const p of [...W.customers, ...W.vendors, ...W.riders]) {
      const app = p.role === 'STUDENT' ? 'CUSTOMER' : p.role === 'VENDOR' ? 'VENDOR' : 'DRIVER';
      await prisma.deviceToken.create({ data: { userId: p.id, token: tok(p), app } });
      owner.set(tok(p), p.id);
    }
  };
  /** "event>who" lines of every message about `orderId` (who = the person's id without the world prefix). */
  const lines = (orderId?: string) => fake.sent.filter((m) => !orderId || m.data.orderId === orderId).map((m) => `${m.data.event}>${owner.get(m.token)!.replace('gs-', '')}`);
  const count = (event: string, orderId?: string) => fake.sent.filter((m) => m.data.event === event && (!orderId || m.data.orderId === orderId)).length;
  const kids = (gid: string) => prisma.order.findMany({ where: { groupId: gid }, orderBy: { groupIndex: 'asc' }, include: { payments: true } });
  const placeG = async (c: Customer, vs: Vendor[]) => {
    const r = await api.placeGroup(c, vs.map((v) => cartOf(v)));
    expect([r.status, r.body.code]).toEqual([201, undefined]);
    return r.body.data as { id: string; payOrderId: string; total: number; orders: any[] };
  };
  const pay = async (c: Customer, primaryId: string, payId = `pay_${randomUUID().slice(0, 12)}`) => {
    const cp = await api.createPayment(c, primaryId);
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { rzp: cp.body.razorpayOrderId as string, payId, amount: cp.body.amountInPaise as number };
  };
  const paidGroup = async (c: Customer, vs: Vendor[]) => { const g = await placeG(c, vs); const p = await pay(c, g.payOrderId); await flush(); return { g, ...p, c, vs }; };
  type PG = Awaited<ReturnType<typeof paidGroup>>;
  const stepAll = async (pg: PG, st: string) => { for (let i = 0; i < pg.vs.length; i++) expect([st, (await api.setStatus(pg.vs[i], pg.g.orders[i].id, st)).status]).toEqual([st, 200]); await flush(); };

  beforeAll(async () => {
    await cleanTestOrders();
    W = await createWorld('gs', '5', { customers: 3, vendors: 3, riders: 3 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    // only this world's riders are on duty: leftovers of other suites must not become push recipients
    await prisma.driverPartner.updateMany({ where: { id: { not: { startsWith: 'gs-' } } }, data: { dutyStatus: 'OFFLINE' } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    fake = new FakeProvider();
    setPushProvider(fake);
    await prisma.pushLog.deleteMany({});
    await register();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await flush();
    setPaymentProvider(null);
    setPushProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await prisma.pushLog.deleteMany({});
    await prisma.deviceToken.deleteMany({});
    await stopTestServer(server);
    await purgeWorld('gs');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('push: no duplicates', () => {
    test('the whole journey: restaurants once each for their part, customer once per group for picked up / at the gate / delivered, riders once per group, never the OTP', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      const [a, b] = pg.g.orders.map((o: any) => o.id);
      // paid: each restaurant is told about ITS child only; its text says what it earns, never the customer's total
      expect(lines().sort()).toEqual([`NEW_ORDER>vown-1`, `NEW_ORDER>vown-2`]);
      expect(fake.sent.find((m) => m.data.orderId === a)!.body).toBe('1 item - You earn Rs 180. Tap to accept.');
      expect(count('NEW_ORDER', a)).toBe(1);
      expect(count('NEW_ORDER', b)).toBe(1);
      // accepted: the customer hears from each restaurant, by name
      await stepAll({ ...pg, vs: [v1] } as PG, 'ACCEPTED'); // v1 only (first child)
      expect(fake.of('ORDER_ACCEPTED').map((m) => [m.data.orderId, m.body])).toEqual([[a, 'Kitchen 1 is preparing your food.']]);
      expect((await api.setStatus(v2, b, 'ACCEPTED')).status).toBe(200);
      await flush();
      expect(fake.of('ORDER_ACCEPTED').map((m) => [m.data.orderId, m.body])).toEqual([[a, 'Kitchen 1 is preparing your food.'], [b, 'Kitchen 2 is preparing your food.']]);
      // cooking and ready: the customer is not told per kitchen; riders hear about the GROUP once (the primary id), one push per idle rider
      await stepAll(pg, 'PREPARING');
      await stepAll(pg, 'READY_FOR_PICKUP');
      expect(count('ORDER_READY')).toBe(0);
      const nd = fake.of('NEW_DELIVERY');
      expect(nd.map((m) => owner.get(m.token)!.replace('gs-', '')).sort()).toEqual(['rider-1', 'rider-2', 'rider-3']);
      expect(nd.every((m) => m.data.orderId === a)).toBe(true);
      expect(nd[0].body).toBe('2 restaurants to BH2. Tap to accept.');
      expect(await prisma.pushLog.count({ where: { event: 'NEW_DELIVERY', orderId: b } })).toBe(0);
      // claim, pickup stop by stop: ONE "picked up" when the last stop is done
      expect((await api.claim(r1, b)).status).toBe(200);
      expect((await api.setStatus(r1, b, 'PICKED_UP')).status).toBe(200);
      await flush();
      expect(count('ORDER_PICKED_UP')).toBe(0);
      expect((await api.setStatus(r1, a, 'PICKED_UP')).status).toBe(200);
      await flush();
      expect(fake.of('ORDER_PICKED_UP').map((m) => [m.data.orderId, owner.get(m.token), m.body])).toEqual([[a, c.id, 'Rider1 picked up your order.']]);
      // the gate: once
      expect((await api.setStatus(r1, b, 'ARRIVED_AT_GATE')).status).toBe(200);
      await api.setStatus(r1, a, 'ARRIVED_AT_GATE'); // idempotent repeat: no second push
      await flush();
      expect(fake.of('RIDER_AT_GATE').map((m) => [m.data.orderId, m.body])).toEqual([[a, 'Open Kraveo to see your code.']]);
      const code = (await prisma.order.findUniqueOrThrow({ where: { id: a } })).otpCode!;
      expect((await api.otp(r1, b, code)).status).toBe(200);
      await api.otp(r1, a, code); // idempotent retry
      await flush();
      expect(fake.of('ORDER_DELIVERED').map((m) => [m.data.orderId, owner.get(m.token)])).toEqual([[a, c.id]]);
      // the totals of the whole journey
      const byEvent = fake.sent.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.data.event]: (acc[m.data.event] ?? 0) + 1 }), {});
      expect(byEvent).toEqual({ NEW_ORDER: 2, ORDER_ACCEPTED: 2, GROUP_READY_TO_COOK: 1, NEW_DELIVERY: 3, ORDER_PICKED_UP: 1, RIDER_AT_GATE: 1, ORDER_DELIVERED: 1 });
      // no push ever carries the code (title, body or data)
      for (const m of fake.sent) expect(`${m.title} ${m.body} ${m.data.event}`).not.toContain(code);
      expect(await prisma.pushLog.count({ where: { orderId: b, event: { in: ['ORDER_PICKED_UP', 'RIDER_AT_GATE', 'ORDER_DELIVERED'] } } })).toBe(0);
      // replays and the safety-net sweeps add nothing
      const before = fake.sent.length;
      await api.webhookCaptured(pg.rzp, pg.payId, pg.amount);
      await sweepMissedPushes(new Date());
      await sweepMissedPushes(new Date());
      await runPushMaintenance(new Date());
      await flush();
      expect(fake.sent.length).toBe(before);
    });

    test('cancel by a restaurant: the customer hears once (and the refund once), the OTHER restaurants hear, the rejecting one does not, no rider push without a rider', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors;
      const pg = await paidGroup(c, [v1, v2]);
      const [a, b] = pg.g.orders.map((o: any) => o.id);
      expect((await api.setStatus(v1, a, 'ACCEPTED')).status).toBe(200);
      await flush();
      fake.sent.length = 0;
      expect((await api.reject(v2, b, 'Out of paneer')).status).toBe(200);
      await flush();
      expect(lines().sort()).toEqual(['ORDER_CANCELLED>cust-1', 'ORDER_CANCELLED_VENDOR>vown-1', 'REFUND_PROCESSED>cust-1']);
      expect(fake.of('ORDER_CANCELLED')[0]).toMatchObject({ data: { orderId: a }, body: expect.stringContaining('Out of paneer') });
      expect(fake.of('ORDER_CANCELLED')[0].body).toContain('Your refund is on its way.');
      expect(fake.of('ORDER_CANCELLED_VENDOR')[0]).toMatchObject({ data: { orderId: a }, body: expect.stringContaining('another restaurant could not take this combined order') });
      expect(fake.of('REFUND_PROCESSED')[0]).toMatchObject({ data: { orderId: a }, body: 'Rs 400 is on its way to your account (5-7 working days).' });
      expect(count('DELIVERY_CANCELLED')).toBe(0);
      // repeating the cancel and replaying the money change nothing
      await api.reject(v2, b, 'Out of paneer');
      await api.adminCancel(W.admin, a);
      await api.webhookCaptured(pg.rzp, pg.payId, pg.amount);
      await runOrderMaintenance(minutesFromNow(15));
      await flush();
      expect(fake.sent).toHaveLength(3);
    });

    test('cancel by the customer: both restaurants are told, the customer only gets the refund; cancel by the admin with a rider: the rider is told ONCE', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      fake.sent.length = 0;
      expect((await api.cancel(c, pg.g.orders[1].id)).status).toBe(200);
      await flush();
      expect(lines().sort()).toEqual(['ORDER_CANCELLED_VENDOR>vown-1', 'ORDER_CANCELLED_VENDOR>vown-2', 'REFUND_PROCESSED>cust-1']);
      expect(count('ORDER_CANCELLED')).toBe(0); // the customer pressed Cancel: they know
      // admin cancel while a rider carries it
      await resetWorldState(W);
      await prisma.pushLog.deleteMany({});
      const pg2 = await paidGroup(c, [v1, v2]);
      await stepAll(pg2, 'ACCEPTED'); await stepAll(pg2, 'PREPARING'); await stepAll(pg2, 'READY_FOR_PICKUP');
      expect((await api.claim(r1, pg2.g.orders[1].id)).status).toBe(200);
      fake.sent.length = 0;
      expect((await api.adminCancel(W.admin, pg2.g.orders[1].id, 'Admin decision')).status).toBe(200);
      await flush();
      expect(fake.of('DELIVERY_CANCELLED').map((m) => [m.data.orderId, owner.get(m.token)])).toEqual([[pg2.g.orders[0].id, r1.id]]); // once, to the carrier, for the group
      expect(count('ORDER_CANCELLED')).toBe(1);
      expect(count('ORDER_CANCELLED_VENDOR')).toBe(2);
      expect(count('REFUND_PROCESSED')).toBe(1);
    });

    test('admin assignment: the rider is told once for the group; the new-delivery sweep announces a group once (primary id), never a child', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1, r2] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      await stepAll(pg, 'ACCEPTED'); await stepAll(pg, 'PREPARING'); await stepAll(pg, 'READY_FOR_PICKUP');
      const [a, b] = pg.g.orders.map((o: any) => o.id);
      // the sweep is the safety net for a lost push: forget what was sent and let it run twice
      await prisma.pushLog.deleteMany({ where: { event: 'NEW_DELIVERY' } });
      fake.sent.length = 0;
      await sweepMissedPushes(new Date());
      await sweepMissedPushes(new Date());
      await flush();
      expect(fake.of('NEW_DELIVERY').map((m) => m.data.orderId)).toEqual([a, a, a]); // one per idle rider, all about the primary
      expect(await prisma.pushLog.count({ where: { orderId: b } })).toBe(await prisma.pushLog.count({ where: { orderId: b, event: { in: ['NEW_ORDER', 'ORDER_ACCEPTED'] } } }));
      fake.sent.length = 0;
      expect((await api.reassign(W.admin, b, r2.profileId)).status).toBe(200);
      await api.reassign(W.admin, a, r2.profileId); // same rider again: nothing new
      await flush();
      expect(fake.of('DELIVERY_ASSIGNED').map((m) => [m.data.orderId, owner.get(m.token), m.body])).toEqual([[a, r2.id, '2 restaurants to BH2.']]);
      expect(count('NEW_DELIVERY')).toBe(0);
      // a rider that is busy is not announced a delivery any more
      fake.sent.length = 0;
      await prisma.pushLog.deleteMany({ where: { event: 'NEW_DELIVERY' } });
      await prisma.order.updateMany({ where: { groupId: pg.g.id }, data: { driverId: null } });
      await prisma.order.updateMany({ where: { groupId: pg.g.id, groupIndex: 0 }, data: { driverId: r1.id } }); // a half-assigned group is not claimable
      await sweepMissedPushes(new Date());
      await flush();
      expect(count('NEW_DELIVERY')).toBe(0);
    });
  });

  // =========================================================================================
  describe('stress: mixed parallel operations on one group', () => {
    const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
      Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`HANG: ${what} did not finish within ${ms} ms`)), ms))]);

    /** The invariants of a combined order that must hold after ANY interleaving of operations. */
    const checkConsistent = async (gid: string, label: string) => {
      const k = await kids(gid);
      const st = k.map((o) => o.status as string);
      const tag = `${label} ${st.join('/')}`;
      const some = (s: string[]) => k.some((o) => s.includes(o.status));
      const all = (s: string[]) => k.every((o) => s.includes(o.status));
      // cancel and delivery are all-or-nothing
      expect([tag, all(['CANCELLED']) || !some(['CANCELLED'])]).toEqual([tag, true]);
      expect([tag, all(['DELIVERED']) || !some(['DELIVERED'])]).toEqual([tag, true]);
      // the gate is a group step: once any child is at the gate (or delivered) all of them are
      if (some(['ARRIVED_AT_GATE', 'DELIVERED'])) expect([tag, all(['ARRIVED_AT_GATE', 'DELIVERED'])]).toEqual([tag, true]);
      // nobody cooks before every restaurant accepted
      if (some(['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'])) expect([tag, k.every((o) => o.status !== 'PLACED')]).toEqual([tag, true]);
      // one rider for the group
      expect([tag, new Set(k.map((o) => o.driverId)).size]).toEqual([tag, 1]);
      if (!all(['CANCELLED']) && some(['PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'])) expect([tag, k[0].driverId !== null]).toEqual([tag, true]);
      // one OTP, mirrored counters, once delivered it is consumed
      const gate = k.filter((o) => o.status === 'ARRIVED_AT_GATE');
      if (gate.length) {
        expect([tag, new Set(gate.map((o) => o.otpCode)).size]).toEqual([tag, 1]);
        expect([tag, new Set(gate.map((o) => `${o.otpAttempts}/${o.otpLocked}`)).size]).toEqual([tag, 1]);
      }
      if (all(['DELIVERED'])) expect([tag, k.every((o) => o.otpCode === 'USED' && o.deliveredAt !== null)]).toEqual([tag, true]);
      // money: one payment status for the group, refund status only on the primary
      expect([tag, new Set(k.map((o) => o.paymentStatus)).size]).toEqual([tag, 1]);
      expect([tag, k.slice(1).every((o) => o.refundStatus === null && o.payments.length === 0)]).toEqual([tag, true]);
      if (!some(['CANCELLED'])) expect([tag, k.every((o) => o.refundStatus === null)]).toEqual([tag, true]);
      return k;
    };

    test('12 groups x 5 waves of 10 random parallel operations: nothing hangs, no 5xx, the invariants hold after every wave, one refund per cancelled group', async () => {
      let seed = 4242;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const [c] = W.customers;
      let cancelledGroups = 0; let deliveredGroups = 0;
      for (let round = 0; round < 12; round++) {
        await resetWorldState(W);
        ledger = createLedger();
        setPaymentProvider(ledger.provider);
        const pg = await paidGroup(c, W.vendors);
        const ids: string[] = pg.g.orders.map((o: any) => o.id);
        const gid = pg.g.id;
        const otpOf = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).otpCode ?? '0000';
        const ops: [string, () => Promise<unknown>][] = [
          ...W.vendors.flatMap((v, i): [string, () => Promise<unknown>][] => ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].map((s) => [`${s}:${i}`, () => api.setStatus(v, ids[i], s)])),
          ...W.vendors.map((v, i): [string, () => Promise<unknown>] => [`reject:${i}`, () => api.reject(v, ids[i], 'Cannot make it today')]),
          ...W.riders.flatMap((r): [string, () => Promise<unknown>][] => [
            [`claim:${r.id}`, () => api.claim(r, pick(ids))],
            [`release:${r.id}`, () => api.release(r, pick(ids))],
            [`pickup:${r.id}`, () => api.setStatus(r, pick(ids), 'PICKED_UP')],
            [`arrive:${r.id}`, () => api.setStatus(r, pick(ids), 'ARRIVED_AT_GATE')],
            [`otp:${r.id}`, async () => { const id = pick(ids); return api.otp(r, id, await otpOf(id)); }],
            [`wrongotp:${r.id}`, () => api.otp(r, pick(ids), '0000')],
          ]),
          ['customer-cancel', () => api.cancel(c, pick(ids))],
          ['admin-cancel', () => api.adminCancel(W.admin, pick(ids))],
          ['reassign', () => api.reassign(W.admin, pick(ids), pick(W.riders).profileId, true)],
          ['unassign', () => api.reassign(W.admin, pick(ids), null)],
          ['reset-otp', () => api.resetOtp(W.admin, pick(ids))],
          ['verify-replay', () => api.verify(c, pg.rzp, pg.payId)],
          ['webhook-replay', () => api.webhookCaptured(pg.rzp, pg.payId, pg.amount)],
          ['webhook-duplicate-payment', () => { ledger.capture(pg.rzp, `${pg.payId}_dup`, pg.amount); return api.webhookCaptured(pg.rzp, `${pg.payId}_dup`, pg.amount); }],
          ['expiry-job', () => runOrderMaintenance(minutesFromNow(11))],
        ];
        // the happy-path operations are listed twice so that groups usually make real progress before something cancels them
        const progress = ops.filter(([n]) => /^(ACCEPTED|PREPARING|READY_FOR_PICKUP|claim|pickup|arrive|otp:)/.test(n));
        for (let wave = 0; wave < 5; wave++) {
          const batch = Array.from({ length: 10 }, () => pick(rnd() < 0.7 ? progress : ops));
          const results = await withTimeout(Promise.all(batch.map(async ([n, fn]) => ({ n, r: (await fn()) as any }))), 60_000, `round ${round} wave ${wave} [${batch.map(([n]) => n).join(', ')}]`);
          const fiveXX = results.filter((x) => typeof x.r?.status === 'number' && x.r.status >= 500).map((x) => `${x.n}:${x.r.status} ${JSON.stringify(x.r.body)}`);
          expect(fiveXX).toEqual([]);
          await flush();
          await checkConsistent(gid, `round ${round} wave ${wave}`);
        }
        // settle: retries of refunds that raced, then the final state is fully consistent
        await runOrderMaintenance(minutesFromNow(5));
        await flush();
        const k = await checkConsistent(gid, `round ${round} final`);
        if (k.every((o) => o.status === 'CANCELLED')) {
          cancelledGroups += 1;
          expect(k.map((o) => o.paymentStatus)).toEqual(Array(3).fill('REFUNDED'));
          expect(k[0].refundStatus).toBe('DONE');
          expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
          expect(ledger.refundsOf(`${pg.payId}_dup`).length).toBeLessThanOrEqual(1);
          expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0); // every captured paisa is back, once (a duplicate payment included)
        } else {
          if (k.every((o) => o.status === 'DELIVERED')) deliveredGroups += 1;
          expect(k.every((o) => o.paymentStatus === 'PAID')).toBe(true);
          expect(ledger.refundsOf(pg.payId)).toHaveLength(0);
          expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(pg.amount); // only a duplicate payment may have been refunded
        }
      }
      // the random walk really exercised both kinds of endings
      expect(cancelledGroups + deliveredGroups).toBeGreaterThan(0);
      expect(cancelledGroups).toBeGreaterThan(0);
    });

    test('the lock order is group -> children ascending: parallel claims, cancels, rejects, reassigns and the expiry job on ONE group never deadlock, 40 times', async () => {
      const [c] = W.customers;
      // three restaurants are enough for crossing lock orders (ids are random uuids, so the primary is not always the smallest id)
      for (let round = 0; round < 40; round++) {
        await resetWorldState(W);
        const pg = await paidGroup(c, W.vendors);
        const ids: string[] = pg.g.orders.map((o: any) => o.id);
        for (let i = 0; i < 3; i++) await api.setStatus(W.vendors[i], ids[i], 'ACCEPTED');
        const batch = [
          () => api.claim(W.riders[0], ids[2]), () => api.claim(W.riders[1], ids[1]), () => api.claim(W.riders[2], ids[0]),
          () => api.reject(W.vendors[2], ids[2], 'Closing early'), () => api.setStatus(W.vendors[0], ids[0], 'PREPARING'),
          () => api.cancel(c, ids[1]), () => api.adminCancel(W.admin, ids[0]), () => api.reassign(W.admin, ids[1], W.riders[0].profileId, true),
          () => api.release(W.riders[0], ids[0]), () => runOrderMaintenance(minutesFromNow(11)),
        ];
        const t0 = Date.now();
        const results: any[] = await withTimeout(Promise.all(batch.map((fn) => fn())), 30_000, `lock round ${round}`);
        expect(results.filter((r) => typeof r?.status === 'number' && r.status >= 500)).toEqual([]);
        expect(Date.now() - t0).toBeLessThan(25_000);
        await flush();
        await checkConsistent(pg.g.id, `lock round ${round}`);
      }
    });
  });
});

