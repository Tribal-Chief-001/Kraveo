/**
 * Multi-restaurant orders (Docs/22), part 2: the whole life of a combined order after payment.
 * Cancel paths and races, the restaurants' GROUP_WAITING rule, the rider pool (old vs new apps), atomic claim, release, per-stop pickup,
 * the group gate (one OTP, atomic delivery, lock, reset), admin reassign, finance and settlement per child, visibility, live location.
 * Real PostgreSQL, real HTTP and sockets, the payment provider replaced by a ledger.
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { countActiveDeliveries } from '../../src/services/orderFlow';
import { istDateString } from '../../src/utils/time';
import {
  World, Person, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, keysOf, RAW_KEYS, minutesFromNow,
} from '../harness/journey';

jest.setTimeout(180_000);

const paise = (n: number) => Math.round(n * 100);
type GV = { id: string; payOrderId: string; total: number; orders: any[] };

describe('Order groups: lifecycle', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let watchers: Watcher[] = [];

  const watch = async (p: Person, rooms: string[] = [], authExtra: Record<string, unknown> = {}) => {
    const w = await new Watcher(server.baseUrl, p, authExtra).connect();
    for (const r of rooms) expect(await w.join(r)).toBe(true);
    watchers.push(w);
    return w;
  };
  const flushAll = async () => { await __waitForBackgroundWork(); await Promise.all(watchers.map((w) => w.flush())); };
  const setProvider = () => { ledger = createLedger(); setPaymentProvider(ledger.provider); };
  const kids = (gid: string) => prisma.order.findMany({ where: { groupId: gid }, orderBy: { groupIndex: 'asc' }, include: { payments: true } });
  const audit = (targetId: string, action: string) => prisma.adminAuditLog.count({ where: { targetId, action } });
  const dutyOf = async (r: Rider) => (await prisma.driverPartner.findUniqueOrThrow({ where: { id: r.profileId } })).dutyStatus;

  const placeG = async (c: Customer, carts: unknown[], extra: Record<string, unknown> = {}): Promise<GV> => {
    const r = await api.placeGroup(c, carts, extra);
    expect([r.status, r.body.code]).toEqual([201, undefined]);
    return r.body.data;
  };
  const pay = async (c: Customer, primaryId: string, payId = `pay_${randomUUID().slice(0, 12)}`) => {
    const cp = await api.createPayment(c, primaryId);
    expect(cp.status).toBe(200);
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { rzp: cp.body.razorpayOrderId as string, payId, amount: cp.body.amountInPaise as number };
  };
  /** A paid combined order over `vs` (one dish of 180 each). */
  const paidGroup = async (c: Customer, vs: Vendor[]) => {
    const g = await placeG(c, vs.map((v) => cartOf(v)));
    const p = await pay(c, g.payOrderId);
    return { g, ...p, c, vs };
  };
  type PG = Awaited<ReturnType<typeof paidGroup>>;
  const RANK: Record<string, number> = { PLACED: 0, ACCEPTED: 1, PREPARING: 2, READY_FOR_PICKUP: 3 };
  /** Every restaurant moves its part forward to `upTo` (steps it already passed are skipped). */
  const cook = async (pg: PG, upTo: 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP') => {
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] as const) {
      for (let i = 0; i < pg.vs.length; i++) {
        const cur = (await prisma.order.findUniqueOrThrow({ where: { id: pg.g.orders[i].id } })).status;
        if ((RANK[cur] ?? 9) >= RANK[st]) continue;
        expect([st, i, (await api.setStatus(pg.vs[i], pg.g.orders[i].id, st)).status]).toEqual([st, i, 200]);
      }
      if (st === upTo) return;
    }
  };
  const pickupAll = async (pg: PG, rider: Rider) => { for (const o of pg.g.orders) expect((await api.setStatus(rider, o.id, 'PICKED_UP')).status).toBe(200); };
  const driveTo = async (pg: PG, rider: Rider, target: 'PLACED' | 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'ARRIVED_AT_GATE') => {
    if (target === 'PLACED') return;
    await cook(pg, target === 'ACCEPTED' || target === 'PREPARING' ? target : 'READY_FOR_PICKUP');
    if (target === 'ACCEPTED' || target === 'PREPARING' || target === 'READY_FOR_PICKUP') return;
    expect((await api.claim(rider, pg.g.orders[0].id)).status).toBe(200);
    await pickupAll(pg, rider);
    if (target === 'PICKED_UP') return;
    expect((await api.setStatus(rider, pg.g.orders[0].id, 'ARRIVED_AT_GATE')).status).toBe(200);
  };
  const otpOf = async (c: Customer, id: string) => (await api.get(c, id)).body.data.otpCode as string | null;

  /** Settlements made by the finance test reference the world's restaurants (a foreign key): remove them before the world is purged. */
  const cleanSettlements = async () => {
    await prisma.settlementAdjustment.deleteMany({ where: { settlement: { vendorId: { startsWith: 'gl-' } } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { startsWith: 'gl-' } } }); // the orders' settlementId is ON DELETE SET NULL
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanSettlements();
    W = await createWorld('gl', '4', { customers: 3, vendors: 4, riders: 3 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    setProvider();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    for (const w of watchers) w.disconnect();
    watchers = [];
    setPaymentProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]); // the lifecycle never produces a server error, whatever a test does on purpose
  });
  afterAll(async () => {
    await stopTestServer(server);
    await cleanSettlements();
    await purgeWorld('gl');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('cancel: every path cancels the WHOLE group, once, with one refund', () => {
    test('customer cancel (through ANY child) while every restaurant is still PLACED; idempotent; refused once one restaurant accepted', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors;
      const pg = await paidGroup(c, [v1, v2]);
      const r = await api.cancel(c, pg.g.orders[1].id, 'Changed my mind');
      expect([r.status, r.body.message]).toEqual([200, 'Order cancelled.']);
      expect(r.body.data).toMatchObject({ id: pg.g.orders[1].id, status: 'CANCELLED', cancelledBy: 'CUSTOMER', cancelReason: 'Changed my mind', paymentStatus: 'REFUNDED' });
      let k = await kids(pg.g.id);
      expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(k.map((o) => o.cancelledBy)).toEqual(['SYSTEM', 'CUSTOMER']);
      expect(k[0].cancelReason).toBe('Another restaurant in your order could not take it: Changed my mind');
      expect(k.every((o) => o.cancelledAt !== null && o.otpCode === null)).toBe(true);
      expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null]);
      expect(ledger.refundsOf(pg.payId)).toEqual([expect.objectContaining({ amountPaise: paise(pg.g.total) })]);
      // again, through the other child: a no-op success, no second refund, no new audit rows
      const again = await api.cancel(c, pg.g.orders[0].id);
      expect([again.status, again.body.message]).toEqual([200, 'This order was already cancelled.']);
      await flushAll();
      expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      expect(await audit(pg.g.id, 'ORDER_GROUP_CANCELLED')).toBe(1);
      expect(await audit(pg.g.orders[1].id, 'ORDER_CANCELLED')).toBe(0); // the customer's own cancel is not an admin-log event (as for single orders)
      // someone else's group looks like nothing
      expect((await api.cancel(W.customers[1], pg.g.orders[0].id)).status).toBe(404);

      // one restaurant accepted: the customer can no longer cancel in the app, nothing changes
      const pg2 = await paidGroup(c, [v1, v2]);
      expect((await api.setStatus(v1, pg2.g.orders[0].id, 'ACCEPTED')).status).toBe(200);
      const no = await api.cancel(c, pg2.g.orders[1].id);
      expect([no.status, no.body.code]).toEqual([409, 'CANNOT_CANCEL']);
      expect(no.body.message).toBe('The restaurant has already accepted this order, so it can no longer be cancelled in the app. Please contact Kraveo support.');
      k = await kids(pg2.g.id);
      expect(k.map((o) => o.status)).toEqual(['ACCEPTED', 'PLACED']);
      expect(ledger.refundsOf(pg2.payId)).toHaveLength(0);
    });

    test('restaurant reject: only its own PLACED paid child; the cascade tells the others (accepted ones get the normal cancelled update); idempotent', async () => {
      const [c] = W.customers; const [v1, v2, v3] = W.vendors;
      const pg = await paidGroup(c, [v1, v2, v3]);
      const w1 = await watch(v1, [`vendor_${v1.vendorId}`]); const w2 = await watch(v2, [`vendor_${v2.vendorId}`]); const wa = await watch(W.admin);
      expect((await api.setStatus(v1, pg.g.orders[0].id, 'ACCEPTED')).status).toBe(200);
      // the accepted restaurant cannot reject; a restaurant cannot reject another restaurant's part
      expect(await api.reject(v1, pg.g.orders[0].id, 'No gas today').then((r) => [r.status, r.body.code])).toEqual([409, 'CANNOT_REJECT']);
      expect((await api.reject(v2, pg.g.orders[2].id, 'Not mine')).status).toBe(404);
      expect(await api.reject(v3, pg.g.orders[2].id, 'xx').then((r) => r.status)).toBe(400); // reason needs 3 characters
      const r = await api.reject(v3, pg.g.orders[2].id, 'Out of paneer');
      expect([r.status, r.body.message]).toEqual([200, 'Order rejected. The customer will be refunded.']);
      await flushAll();
      const k = await kids(pg.g.id);
      expect(k.map((o) => [o.status, o.cancelledBy])).toEqual([['CANCELLED', 'SYSTEM'], ['CANCELLED', 'SYSTEM'], ['CANCELLED', 'VENDOR']]);
      expect(k[2].cancelReason).toBe('Out of paneer');
      expect(k[0].cancelReason).toBe('Another restaurant in your order could not take it: Out of paneer');
      // the accepted restaurant and the waiting one both hear (their own child only), the admin hears about all three
      expect(w1.last('order_updated', pg.g.orders[0].id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
      expect(w2.last('order_updated', pg.g.orders[1].id)).toMatchObject({ status: 'CANCELLED' });
      expect(w1.of('order_updated').every((e: any) => e.id === pg.g.orders[0].id)).toBe(true);
      expect(wa.last('order_updated', pg.g.orders[2].id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'VENDOR' });
      expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      // vendor history keeps its (cancelled-after-paid) parts; a repeat reject is an idempotent success
      expect((await api.list(v1, '?scope=history')).body.data.map((o: any) => o.id)).toEqual([pg.g.orders[0].id]);
      const again = await api.reject(v3, pg.g.orders[2].id, 'Out of paneer');
      expect([again.status, again.body.message]).toEqual([200, 'This order was already cancelled.']);
      expect(await api.reject(v1, pg.g.orders[0].id, 'late').then((r) => r.status)).toBe(200); // already cancelled by the cascade: idempotent too
      expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      expect(await audit(pg.g.id, 'ORDER_GROUP_CANCELLED')).toBe(1);
      expect(await audit(pg.g.orders[2].id, 'ORDER_CANCELLED')).toBe(1);
      expect(await audit(pg.g.orders[0].id, 'ORDER_CANCELLED')).toBe(1);
    });

    test('admin cancel in every state except DELIVERED cancels the whole group, says how many orders, refunds once, frees the rider', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      for (const state of ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] as const) {
        await resetWorldState(W);
        const pg = await paidGroup(c, [v1, v2]);
        await driveTo(pg, r1, state);
        const res = await api.adminCancel(W.admin, pg.g.orders[1].id, `Admin decision in ${state}`);
        expect([state, res.status]).toEqual([state, 200]);
        expect(res.body).toMatchObject({ success: true, groupId: pg.g.id, cancelledOrders: 2 });
        await flushAll();
        const k = await kids(pg.g.id);
        expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
        expect(k.map((o) => o.cancelledBy)).toEqual(['SYSTEM', 'ADMIN']);
        expect(k.every((o) => o.otpCode === null)).toBe(true);
        expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null]);
        expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
        expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
        expect(await dutyOf(r1)).toBe('ONLINE'); // the cancelled delivery no longer holds the rider
        const repeat = await api.adminCancel(W.admin, pg.g.orders[0].id);
        expect(repeat.body).toMatchObject({ message: 'This order was already cancelled.', groupId: pg.g.id, cancelledOrders: 0 });
        expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      }
      // a delivered group cannot be cancelled
      await resetWorldState(W);
      const pg = await paidGroup(c, [v1, v2]);
      await driveTo(pg, r1, 'ARRIVED_AT_GATE');
      expect((await api.otp(r1, pg.g.orders[0].id, await otpOf(c, pg.g.orders[0].id))).status).toBe(200);
      const closed = await api.adminCancel(W.admin, pg.g.orders[1].id);
      expect([closed.status, closed.body.code]).toEqual([409, 'ORDER_CLOSED']);
    });

    test('system expiry: an unpaid group after 15 minutes (no refund); a paid group whose restaurant never answers after 10 minutes (one refund, even when a SIBLING timed out)', async () => {
      const [c, c2] = W.customers; const [v1, v2, v3] = W.vendors;
      // unpaid
      const unpaid = await placeG(c, [cartOf(v1), cartOf(v2)]);
      const t1 = await runOrderMaintenance(minutesFromNow(16));
      expect(t1.expired.some((id) => unpaid.orders.some((o) => o.id === id))).toBe(true);
      let k = await kids(unpaid.id);
      expect(k.map((o) => [o.status, o.cancelledBy, o.paymentStatus, o.refundStatus])).toEqual([['CANCELLED', 'SYSTEM', 'PENDING', null], ['CANCELLED', 'SYSTEM', 'PENDING', null]]);
      expect(k.map((o) => o.cancelReason).sort()).toEqual(['Another restaurant in your order could not take it: Payment not completed', 'Payment not completed']);
      expect(ledger.calls.refundPayment).toBe(0);
      expect((await runOrderMaintenance(minutesFromNow(17))).expired).toEqual([]);
      // paid, restaurant 1 accepted, restaurant 2 (a SIBLING, not the primary) never answers
      await resetWorldState(W);
      const pg = await paidGroup(c, [v1, v2, v3]);
      expect((await api.setStatus(v1, pg.g.orders[0].id, 'ACCEPTED')).status).toBe(200);
      expect((await api.setStatus(v3, pg.g.orders[2].id, 'ACCEPTED')).status).toBe(200);
      const w1 = await watch(v1, [`vendor_${v1.vendorId}`]);
      const t2 = await runOrderMaintenance(minutesFromNow(11));
      await flushAll();
      expect(t2.autoCancelled).toEqual([pg.g.orders[1].id]); // the one PLACED child is the trigger
      expect(t2.refundsDone).toContain(pg.g.orders[0].id); // the refund of the PRIMARY ran in the same tick
      k = await kids(pg.g.id);
      expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
      expect(k[1]).toMatchObject({ cancelledBy: 'SYSTEM', cancelReason: 'Restaurant did not respond' });
      expect(k[0].cancelReason).toBe('Another restaurant in your order could not take it: Restaurant did not respond');
      expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null, null]);
      expect(k.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED']);
      expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      expect(w1.last('order_updated', pg.g.orders[0].id)).toMatchObject({ status: 'CANCELLED' });
      // the primary itself timing out, and two jobs running at once: still one refund
      await resetWorldState(W);
      const pg2 = await paidGroup(c2, [v1, v2]);
      expect((await api.setStatus(v2, pg2.g.orders[1].id, 'ACCEPTED')).status).toBe(200);
      const both = await Promise.all([runOrderMaintenance(minutesFromNow(11)), runOrderMaintenance(minutesFromNow(11))]);
      await flushAll();
      expect(both.flatMap((t) => t.autoCancelled)).toEqual([pg2.g.orders[0].id]);
      expect(ledger.refundsOf(pg2.payId)).toHaveLength(1);
      expect((await kids(pg2.g.id)).map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
    });

    test('RACE: restaurant reject x2, customer cancel, admin cancel and the expiry job at the same moment: one cancelled group, ONE refund, no 5xx, no deadlock', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors;
      for (let round = 0; round < 3; round++) {
        await resetWorldState(W);
        const pg = await paidGroup(c, [v1, v2]);
        const rs = await Promise.all([
          api.reject(v1, pg.g.orders[0].id, 'Closing early'),
          api.reject(v2, pg.g.orders[1].id, 'Out of stock'),
          api.cancel(c, pg.g.orders[1].id, 'Changed my mind'),
          api.adminCancel(W.admin, pg.g.orders[0].id, 'Admin decision'),
          runOrderMaintenance(minutesFromNow(11)),
          api.cancel(c, pg.g.orders[0].id),
        ]);
        await flushAll();
        const statuses = rs.filter((r: any) => typeof r.status === 'number').map((r: any) => r.status);
        expect(statuses.every((s: number) => s === 200)).toBe(true);
        const k = await kids(pg.g.id);
        expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
        expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null]);
        expect(k.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
        expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
        expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
        expect(await audit(pg.g.id, 'ORDER_GROUP_CANCELLED')).toBe(1); // exactly one winner wrote the cancel
      }
    });

    test('RACE: the payment arrives (verify + webhook) while the customer cancels and the expiry job runs: always cancelled, captured == refunded exactly once', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors;
      for (let round = 0; round < 4; round++) {
        await resetWorldState(W);
        const g = await placeG(c, [cartOf(v1), cartOf(v2)]);
        const cp = await api.createPayment(c, g.payOrderId);
        const payId = `pay_race_${round}`;
        ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        await Promise.all([
          api.verify(c, cp.body.razorpayOrderId, payId),
          api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise),
          api.cancel(c, g.orders[1].id, 'Changed my mind'),
          runOrderMaintenance(minutesFromNow(16)),
        ]);
        await flushAll();
        await runOrderMaintenance(minutesFromNow(17)); // retries whatever a racing refund left behind
        await flushAll();
        const k = await kids(g.id);
        expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
        expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null]);
        expect(k.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
        expect(ledger.refundsOf(payId)).toHaveLength(1);
        expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      }
    });
  });

  // =========================================================================================
  describe('restaurants: GROUP_WAITING and what they may see', () => {
    test('nobody starts cooking until every restaurant accepted; the rule is idempotent-safe and the restaurants are told when the last one accepts', async () => {
      const [c] = W.customers; const [v1, v2, v3] = W.vendors;
      const pg = await paidGroup(c, [v1, v2, v3]);
      const w1 = await watch(v1, [`vendor_${v1.vendorId}`]); const w2 = await watch(v2, [`vendor_${v2.vendorId}`]);
      const [a, b, d] = pg.g.orders.map((o: any) => o.id);
      expect((await api.get(v1, a)).body.data.group).toEqual({ size: 3, allAccepted: false });
      expect((await api.setStatus(v1, a, 'ACCEPTED')).status).toBe(200);
      const wait = await api.setStatus(v1, a, 'PREPARING');
      expect([wait.status, wait.body.code, wait.body.message]).toEqual([409, 'GROUP_WAITING', 'Waiting for the other restaurant(s) in this combined order to accept.']);
      expect((await api.setStatus(v2, b, 'ACCEPTED')).status).toBe(200);
      expect((await api.setStatus(v1, a, 'PREPARING')).body.code).toBe('GROUP_WAITING'); // restaurant 3 has not accepted yet
      expect((await api.setStatus(W.admin, a, 'PREPARING')).body.code).toBe('GROUP_WAITING'); // the admin is bound by the same rule
      expect((await api.get(v2, b)).body.data.group).toEqual({ size: 3, allAccepted: false });
      const m = w1.mark();
      expect((await api.setStatus(v3, d, 'ACCEPTED')).status).toBe(200);
      await flushAll();
      // every restaurant gets an update with allAccepted true although only restaurant 3 moved
      expect(w1.since(m, 'order_updated', a).pop()?.group).toEqual({ size: 3, allAccepted: true });
      expect(w2.since(0, 'order_updated', b).pop()?.group).toEqual({ size: 3, allAccepted: true });
      for (const [v, id] of [[v1, a], [v2, b], [v3, d]] as const) expect((await api.get(v, id)).body.data.group).toEqual({ size: 3, allAccepted: true });
      expect((await api.setStatus(v1, a, 'PREPARING')).status).toBe(200);
      expect((await api.setStatus(v1, a, 'PREPARING')).status).toBe(200); // repeat = idempotent success, never GROUP_WAITING
      expect((await api.setStatus(v1, a, 'READY_FOR_PICKUP')).status).toBe(200); // everything after PREPARING is unchanged
      // a single order is not affected at all
      const s = await api.place(W.customers[1], v2);
      await pay(W.customers[1], s.body.data.id);
      expect((await api.setStatus(v2, s.body.data.id, 'ACCEPTED')).status).toBe(200);
      expect((await api.setStatus(v2, s.body.data.id, 'PREPARING')).status).toBe(200);
      expect(Object.keys((await api.get(v2, s.body.data.id)).body.data)).not.toContain('group');
    });

    test('a restaurant never sees another restaurant, the group money, the customer price or the customer phone (REST and sockets), only { size, allAccepted }', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const w1 = await watch(v1, [`vendor_${v1.vendorId}`]);
      const pg = await paidGroup(c, [v1, v2]);
      await cook(pg, 'READY_FOR_PICKUP');
      expect((await api.claim(r1, pg.g.orders[0].id)).status).toBe(200);
      await pickupAll(pg, r1);
      await api.setStatus(r1, pg.g.orders[0].id, 'ARRIVED_AT_GATE');
      await flushAll();
      const seen = [
        ...w1.events.map((e) => e.data),
        (await api.get(v1, pg.g.orders[0].id)).body.data,
        ...(await api.list(v1)).body.data,
        ...(await api.list(v1, '?scope=history')).body.data,
      ];
      expect(seen.length).toBeGreaterThan(4);
      const text = JSON.stringify(seen);
      expect(text).not.toContain('Kitchen 2');
      expect(text).not.toContain(pg.g.orders[1].id);
      expect(text).not.toContain(pg.g.id);
      expect(text).not.toContain('Gate 2');
      for (const d of seen) {
        expect([...keysOf(d)].filter((k) => RAW_KEYS.includes(k) || ['deliveryFee', 'discount', 'taxAndPackaging', 'feeBreakdown', 'couponCode', 'stops', 'feeTotal', 'payOrderId'].includes(k))).toEqual([]);
        expect(d.otpCode ?? null).toBeNull();
        expect(d.customer?.phone ?? null).toBeNull();
        expect(Object.keys(d.group).sort()).toEqual(['allAccepted', 'size']);
        expect(d.group.size).toBe(2);
        expect(d.totalAmount).toBe(180); // what it earns for ITS part: no fee, no share of the group total
        expect(d.subtotal).toBe(180);
      }
      expect((await api.get(v1, pg.g.orders[1].id)).status).toBe(404); // the other restaurant's part
      expect((await api.getGroup(v1, pg.g.id)).status).toBe(404);
      expect((await api.getGroup(r1, pg.g.id)).status).toBe(404);
    });
  });

  // =========================================================================================
  describe('rider pool, claim, release', () => {
    test('POOL: grouped children are invisible to old apps; a new app (?groups=1) gets ONE entry per group, only when EVERY restaurant accepted; pool entry hides the customer', async () => {
      const [c, c2] = W.customers; const [v1, v2, v3, v4] = W.vendors; const [r1] = W.riders;
      const single = await api.place(c2, v4);
      await pay(c2, single.body.data.id);
      await api.setStatus(v4, single.body.data.id, 'ACCEPTED');
      const pg = await paidGroup(c, [v1, v2, v3]);
      const ids = pg.g.orders.map((o: any) => o.id);
      const oldApp = async () => (await api.available(r1)).body.data.map((o: any) => o.id);
      const newApp = async () => (await api.availableGroups(r1)).body.data;
      const oldApp2 = async () => (await api.raw('r', 'get', '/api/orders/available?groups=0', r1.token)).body.data.map((o: any) => o.id);
      expect(await oldApp()).toEqual([single.body.data.id]);
      expect((await newApp()).map((o: any) => o.id)).toEqual([single.body.data.id]);
      // not claimable until all three accepted
      await api.setStatus(v1, ids[0], 'ACCEPTED');
      await api.setStatus(v2, ids[1], 'ACCEPTED');
      expect((await newApp()).map((o: any) => o.id)).toEqual([single.body.data.id]);
      await api.setStatus(v3, ids[2], 'ACCEPTED');
      const pool = await newApp();
      expect(pool.map((o: any) => o.id).sort()).toEqual([single.body.data.id, ids[0]].sort()); // one entry for the group: its primary child
      const entry = pool.find((o: any) => o.id === ids[0]);
      expect(entry.group).toEqual({
        id: pg.g.id, index: 0, size: 3, primary: true,
        stops: ids.map((id: string, i: number) => ({ orderId: id, index: i, status: 'ACCEPTED', vendor: { name: `Kitchen ${i + 1}`, address: `Gate ${i + 1}`, lat: 23.0768, lng: 76.8524 }, itemCount: 1 })),
      });
      expect(entry).toMatchObject({ customer: null, dropoffNotes: null, driver: null, otpCode: null, status: 'ACCEPTED', paymentStatus: 'PAID' });
      expect(JSON.stringify(entry)).not.toContain('Cust1');
      expect(await oldApp()).toEqual([single.body.data.id]); // old apps still never see a group
      expect(await oldApp2()).toEqual([single.body.data.id]);
      expect((await api.get(r1, ids[0])).body.data).toMatchObject({ id: ids[0], customer: null, group: { id: pg.g.id } }); // the pool entry (the primary) can be opened like any pool order
      expect((await api.get(r1, ids[1])).status).toBe(404); // the other children are not offered, so they cannot be opened by a pool rider
      expect((await api.getGroup(r1, pg.g.id)).status).toBe(404);
      // a cancelled child takes the group out of the pool
      await api.adminCancel(W.admin, ids[2]);
      expect((await newApp()).map((o: any) => o.id)).toEqual([single.body.data.id]);
    });

    test('POOL SOCKETS: order_available once per group (only to riders that sent groups:1), order_unavailable for the primary when claimed', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1, r2, r3] = W.riders;
      const wNew = await watch(r1, [], { groups: 1 });
      const wOld = await watch(r2);
      const wNew2 = await watch(r3, [], { groups: 1 });
      const pg = await paidGroup(c, [v1, v2]);
      const [a, b] = pg.g.orders.map((o: any) => o.id);
      await api.setStatus(v1, a, 'ACCEPTED');
      await flushAll();
      expect(wNew.count('order_available')).toBe(0); // restaurant 2 has not accepted
      await api.setStatus(v2, b, 'ACCEPTED');
      await api.setStatus(v1, a, 'PREPARING');
      await api.setStatus(v2, b, 'PREPARING');
      await api.setStatus(v1, a, 'READY_FOR_PICKUP');
      await flushAll();
      expect(wNew.count('order_available')).toBe(1);
      expect(wNew.last('order_available').id).toBe(a);
      expect(wNew.last('order_available').group.size).toBe(2);
      expect(wNew2.count('order_available')).toBe(1);
      expect(wOld.count('order_available')).toBe(0);
      // claimed through the SECOND child
      expect((await api.claim(r1, b)).status).toBe(200);
      await flushAll();
      expect(wNew.of('order_unavailable')).toEqual([{ id: a }]);
      expect(wNew2.of('order_unavailable')).toEqual([{ id: a }]);
      expect(wOld.count('order_unavailable')).toBe(0);
      // released: offered again, once
      expect((await api.release(r1, a)).status).toBe(200);
      await flushAll();
      expect(wNew2.count('order_available')).toBe(2);
      expect(wOld.count('order_available')).toBe(0);
    });

    test('CLAIM: atomic for the whole group, two riders at once give one winner; every child gets the rider; the group counts as ONE active delivery', async () => {
      const [c, c2] = W.customers; const [v1, v2, v3] = W.vendors; const [r1, r2, r3] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      // not claimable while a restaurant has not accepted (a clear answer, nothing assigned)
      await api.setStatus(v1, pg.g.orders[0].id, 'ACCEPTED');
      expect(await api.claim(r1, pg.g.orders[0].id).then((r) => [r.status, r.body.code])).toEqual([409, 'ORDER_NOT_AVAILABLE']);
      expect((await kids(pg.g.id)).every((o) => o.driverId === null)).toBe(true);
      await api.setStatus(v2, pg.g.orders[1].id, 'ACCEPTED');
      const rs = await Promise.all([api.claim(r1, pg.g.orders[0].id), api.claim(r2, pg.g.orders[1].id), api.claim(r3, pg.g.orders[0].id)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const winner = [r1, r2, r3][rs.findIndex((r) => r.status === 200)];
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'ALREADY_TAKEN')).toBe(true);
      const k = await kids(pg.g.id);
      expect(k.map((o) => o.driverId)).toEqual([winner.id, winner.id]);
      expect(k.map((o) => o.status)).toEqual(['ACCEPTED', 'ACCEPTED']); // a claim never changes the status
      expect(await dutyOf(winner)).toBe('IN_TRANSIT');
      // the winner repeating it: idempotent; a loser: ALREADY_TAKEN
      const repeat = await api.claim(winner, pg.g.orders[1].id);
      expect([repeat.status, repeat.body.message]).toEqual([200, 'You already have this order.']);
      // two children = ONE active delivery
      expect(await countActiveDeliveries(prisma as any, winner.id)).toBe(1);
      // the winner is busy: another group or single order is refused
      const pg2 = await paidGroup(c2, [v3, v1]);
      await cook(pg2, 'ACCEPTED');
      expect(await api.claim(winner, pg2.g.orders[0].id).then((r) => [r.status, r.body.code])).toEqual([409, 'RIDER_BUSY']);
      // other rider states
      const free = [r1, r2, r3].filter((r) => r.id !== winner.id);
      await prisma.driverPartner.update({ where: { id: free[0].profileId }, data: { dutyStatus: 'OFFLINE' } });
      expect(await api.claim(free[0], pg2.g.orders[0].id).then((r) => [r.status, r.body.code])).toEqual([409, 'RIDER_OFFLINE']);
      await prisma.driverPartner.update({ where: { id: free[0].profileId }, data: { dutyStatus: 'ONLINE', approvalStatus: 'SUSPENDED' } });
      expect(await api.claim(free[0], pg2.g.orders[0].id).then((r) => r.status)).toBe(403);
      await prisma.driverPartner.update({ where: { id: free[0].profileId }, data: { approvalStatus: 'APPROVED' } });
      expect(await api.claim(free[0], pg2.g.orders[1].id).then((r) => r.status)).toBe(200); // a free rider takes the second group
      // an unpaid group is not available
      const unpaid = await placeG(W.customers[2], [cartOf(v2), cartOf(v3)]);
      expect(await api.claim(free[1], unpaid.orders[0].id).then((r) => [r.status, r.body.code])).toEqual([409, 'ORDER_NOT_AVAILABLE']);
    });

    test('RELEASE: the whole group goes back to the pool (through any child) and only while NO child is picked up', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1, r2] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      await cook(pg, 'PREPARING');
      expect((await api.claim(r1, pg.g.orders[0].id)).status).toBe(200);
      expect((await api.release(r2, pg.g.orders[0].id)).status).toBe(404); // not the carrier
      const rel = await api.release(r1, pg.g.orders[1].id);
      expect([rel.status, rel.body.message]).toEqual([200, 'The order is back in the pool.']);
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([null, null]);
      expect(await dutyOf(r1)).toBe('ONLINE');
      expect((await api.availableGroups(r2)).body.data.map((o: any) => o.id)).toEqual([pg.g.orders[0].id]);
      expect(await audit(pg.g.orders[0].id, 'ORDER_RELEASED')).toBe(1);
      // another rider takes it; the first can do nothing with it any more
      expect((await api.claim(r2, pg.g.orders[1].id)).status).toBe(200);
      expect((await api.release(r1, pg.g.orders[0].id)).status).toBe(404);
      // once ANY child is picked up, release is refused for the whole group
      await cook(pg, 'READY_FOR_PICKUP');
      expect((await api.setStatus(r2, pg.g.orders[1].id, 'PICKED_UP')).status).toBe(200);
      const no = await api.release(r2, pg.g.orders[0].id);
      expect([no.status, no.body.code]).toEqual([409, 'CANNOT_RELEASE']);
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([r2.id, r2.id]);
    });
  });

  // =========================================================================================
  describe('delivery: per-stop pickup, group arrival, one OTP, atomic delivery', () => {
    test('JOURNEY: pickup per restaurant in any order, arrival only after all, one code on every child, wrong codes counted for the group, delivery of all children at once, idempotent retries', async () => {
      const [c] = W.customers; const [v1, v2, v3] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c); const wr = await watch(r1);
      const pg = await paidGroup(c, [v1, v2, v3]);
      const ids: string[] = pg.g.orders.map((o: any) => o.id);
      for (const id of ids) expect(await wc.join(`order_${id}`)).toBe(true);
      await cook(pg, 'READY_FOR_PICKUP');
      expect((await api.claim(r1, ids[2])).status).toBe(200);
      // the rider sees every child with the group and its stops; customer name and phone once assigned
      const active = (await api.list(r1, '?scope=active')).body.data;
      expect(active.map((o: any) => o.id).sort()).toEqual([...ids].sort());
      for (const o of active) {
        expect(o.group).toMatchObject({ id: pg.g.id, size: 3, primary: o.id === ids[0] });
        expect(o.group.stops.map((s: any) => s.vendor.name)).toEqual(['Kitchen 1', 'Kitchen 2', 'Kitchen 3']);
        expect(o.customer).toMatchObject({ name: 'Cust1 Tester', phone: c.phone });
        expect(o.otpCode).toBeNull();
      }
      // per-stop pickup: only a child that is READY; arrival needs EVERY child picked up
      expect((await api.setStatus(r1, ids[1], 'ARRIVED_AT_GATE')).body.code).toBe('INVALID_TRANSITION'); // still READY
      expect((await api.setStatus(r1, ids[1], 'PICKED_UP')).status).toBe(200);
      const early = await api.setStatus(r1, ids[1], 'ARRIVED_AT_GATE'); // picked up, but the others are not
      expect([early.status, early.body.code]).toEqual([409, 'GROUP_NOT_PICKED_UP']);
      expect((await kids(pg.g.id)).map((o) => o.status)).toEqual(['READY_FOR_PICKUP', 'PICKED_UP', 'READY_FOR_PICKUP']);
      expect((await api.getGroup(c, pg.g.id)).body.data.status).toBe('READY_FOR_PICKUP'); // least advanced child
      expect((await api.setStatus(r1, ids[2], 'PICKED_UP')).status).toBe(200);
      expect((await api.setStatus(r1, ids[0], 'PICKED_UP')).status).toBe(200);
      expect((await api.getGroup(c, pg.g.id)).body.data.status).toBe('PICKED_UP');
      // nobody else may move it
      expect((await api.setStatus(c, ids[0], 'ARRIVED_AT_GATE')).status).toBe(403);
      expect((await api.setStatus(v1, ids[0], 'ARRIVED_AT_GATE')).status).toBe(403);
      expect((await api.setStatus(W.riders[1], ids[0], 'ARRIVED_AT_GATE')).status).toBe(404);
      // arrival through ANY child moves all of them and writes ONE code
      const m = wc.mark();
      const arrived = await api.setStatus(r1, ids[1], 'ARRIVED_AT_GATE');
      expect(arrived.status).toBe(200);
      let k = await kids(pg.g.id);
      expect(k.map((o) => o.status)).toEqual(['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE', 'ARRIVED_AT_GATE']);
      const code = k[0].otpCode!;
      expect(code).toMatch(/^\d{4}$/);
      expect(k.map((o) => o.otpCode)).toEqual([code, code, code]);
      expect(k.every((o) => o.otpAttempts === 0 && !o.otpLocked)).toBe(true);
      await flushAll();
      for (const id of ids) expect(await otpOf(c, id)).toBe(code); // the customer sees it on every part, only now
      expect((await api.get(r1, ids[0])).body.data.otpCode).toBeNull();
      expect((await api.get(v1, ids[0])).body.data.otpCode ?? null).toBeNull();
      expect(wc.since(m, 'order_updated').every((e: any) => e.otpCode === code && e.status === 'ARRIVED_AT_GATE')).toBe(true);
      expect(wr.of('order_updated').every((e: any) => e.otpCode === null)).toBe(true);
      const repeat = await api.setStatus(r1, ids[0], 'ARRIVED_AT_GATE');
      expect([repeat.status, repeat.body.message]).toEqual([200, 'Order is already ARRIVED_AT_GATE.']);
      expect((await kids(pg.g.id)).map((o) => o.otpCode)).toEqual([code, code, code]); // the code is not rewritten
      // delivery needs the code; DELIVERED cannot be set without it by anyone
      expect((await api.setStatus(r1, ids[0], 'DELIVERED')).body.code).toBe('OTP_INVALID');
      expect((await api.otp(v1, ids[0], code)).status).toBe(403);
      expect((await api.otp(c, ids[0], code)).status).toBe(403);
      expect((await api.otp(W.riders[1], ids[0], code)).status).toBe(404);
      // wrong codes count for the GROUP, whichever child is named
      const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
      expect((await api.otp(r1, ids[0], wrong)).body).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: 4 });
      expect((await api.otp(r1, ids[2], wrong)).body).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: 3 });
      expect((await kids(pg.g.id)).map((o) => o.otpAttempts)).toEqual([2, 2, 2]);
      // the right code through the THIRD child delivers EVERY child at once
      const done = await api.otp(r1, ids[2], code);
      expect([done.status, done.body.message]).toEqual([200, 'Gate Handshake OTP verified successfully. Order DELIVERED!']);
      k = await kids(pg.g.id);
      expect(k.map((o) => o.status)).toEqual(['DELIVERED', 'DELIVERED', 'DELIVERED']);
      expect(new Set(k.map((o) => o.deliveredAt!.getTime())).size).toBe(1);
      expect(k.map((o) => o.otpCode)).toEqual(['USED', 'USED', 'USED']);
      expect(new Set(k.map((o) => o.otpProof)).size).toBe(3); // each child has its own proof
      expect(await dutyOf(r1)).toBe('ONLINE');
      expect((await api.getGroup(c, pg.g.id)).body.data.status).toBe('DELIVERED');
      // retries: the same code on any child is an idempotent success, another code is refused and not counted
      for (const id of ids) {
        const again = await api.otp(r1, id, code);
        expect([again.status, again.body.message]).toEqual([200, 'Order is already DELIVERED.']);
      }
      expect((await api.otp(r1, ids[0], wrong)).body.code).toBe('ALREADY_DELIVERED');
      expect((await kids(pg.g.id)).map((o) => o.otpAttempts)).toEqual([2, 2, 2]);
      expect((await api.setStatus(r1, ids[0], 'DELIVERED', { otpCode: code })).status).toBe(200); // the PATCH path goes through the same checks
    });

    test('OTP LOCK: 5 wrong codes lock the whole group (every child answers 423), one needs-attention row, the admin unlocks through any child, a new code is the same on all', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      await driveTo(pg, r1, 'ARRIVED_AT_GATE');
      const [a, b] = pg.g.orders.map((o: any) => o.id);
      const code = (await kids(pg.g.id))[0].otpCode!;
      const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
      for (let i = 0; i < 4; i++) expect((await api.otp(r1, i % 2 ? a : b, wrong)).body.code).toBe('OTP_INVALID');
      const fifth = await api.otp(r1, a, wrong);
      expect([fifth.status, fifth.body.code]).toEqual([423, 'OTP_LOCKED']);
      expect((await kids(pg.g.id)).every((o) => o.otpLocked && o.otpAttempts === 5)).toBe(true);
      for (const id of [a, b]) expect(await api.otp(r1, id, code).then((r) => [r.status, r.body.code])).toEqual([423, 'OTP_LOCKED']); // even the right code
      const na = (await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === pg.g.id);
      expect(na.map((x: any) => [x.problem, x.order.id])).toEqual([['OTP_LOCKED', a]]); // one row for the group (through the primary)
      expect(await audit(a, 'OTP_LOCKED') + await audit(b, 'OTP_LOCKED')).toBe(1);
      // the admin resets through the SECOND child
      const reset = await api.resetOtp(W.admin, b);
      expect(reset.status).toBe(200);
      const k = await kids(pg.g.id);
      expect(k.every((o) => !o.otpLocked && o.otpAttempts === 0)).toBe(true);
      expect(k[0].otpCode).toMatch(/^\d{4}$/);
      expect(k[1].otpCode).toBe(k[0].otpCode);
      expect(await otpOf(c, a)).toBe(k[0].otpCode);
      expect((await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === pg.g.id)).toEqual([]);
      expect((await api.otp(r1, b, k[0].otpCode)).status).toBe(200);
      expect((await kids(pg.g.id)).map((o) => o.status)).toEqual(['DELIVERED', 'DELIVERED']);
      expect((await api.resetOtp(W.admin, a)).body.code).toBe('NOT_AT_GATE'); // nothing to unlock any more
    });

    test('a delivered group never counts twice: finance counts ONE delivery per group, restaurants are settled per child, refunds count once', async () => {
      const [c, c2] = W.customers; const [v1, v2, v3] = W.vendors; const [r1] = W.riders;
      const g = await paidGroup(c, [v1, v2]);
      await driveTo(g, r1, 'ARRIVED_AT_GATE');
      expect((await api.otp(r1, g.g.orders[1].id, await otpOf(c, g.g.orders[0].id))).status).toBe(200);
      const s = await api.place(c2, v3);
      await pay(c2, s.body.data.id);
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) await api.setStatus(v3, s.body.data.id, st);
      await api.claim(r1, s.body.data.id);
      await api.setStatus(r1, s.body.data.id, 'PICKED_UP');
      await api.setStatus(r1, s.body.data.id, 'ARRIVED_AT_GATE');
      expect((await api.otp(r1, s.body.data.id, await otpOf(c2, s.body.data.id))).status).toBe(200);
      const today = istDateString(new Date());
      const q = `from=${today}&to=${today}`;
      const adm = (url: string) => api.raw('admin', 'get', url, W.admin.token);
      const riders = (await adm(`/api/admin/finance/riders?${q}`)).body.data.find((x: any) => x.driverUserId === r1.id);
      expect(riders.deliveries).toBe(2); // the group (2 orders) + the single order
      expect(riders.byDay).toEqual([{ date: today, deliveries: 2 }]);
      const byRest = (await adm(`/api/admin/finance/by-restaurant?${q}&limit=200`)).body.data.filter((x: any) => x.vendorId.startsWith('gl-'));
      const row = (v: Vendor) => byRest.find((x: any) => x.vendorId === v.vendorId);
      expect(row(v1)).toMatchObject({ orders: 1, foodGross: 180, vendorAmount: 180, feesCollected: 25, discounts: 0 });
      expect(row(v2)).toMatchObject({ orders: 1, foodGross: 180, vendorAmount: 180, feesCollected: 15 }); // the extra-restaurant fee sits on the second child
      expect(row(v3)).toMatchObject({ orders: 1, feesCollected: 25 });
      expect(row(v1).feesCollected + row(v2).feesCollected).toBe(40); // feesCollected of the group = the group fee
      // settlement: one per restaurant, each its own child's vendorSubtotal
      for (const v of [v1, v2]) {
        const run = await api.raw('admin', 'post', '/api/admin/settlements/run', W.admin.token, { vendorId: v.vendorId });
        expect(run.status).toBe(200);
        expect(run.body.data.created).toHaveLength(1);
        expect(run.body.data.created[0]).toMatchObject({ vendorId: v.vendorId, orderCount: 1, vendorAmount: 180, foodGross: 180 });
      }
      // refunds: a cancelled paid group is ONE refund whose amount is the group total, split by restaurant
      const rg = await paidGroup(c, [v1, v2]);
      await api.adminCancel(W.admin, rg.g.orders[0].id);
      await flushAll();
      const after = (await adm(`/api/admin/finance/by-restaurant?${q}&limit=200`)).body.data.filter((x: any) => x.vendorId.startsWith('gl-'));
      const refunds = [v1, v2].map((v) => after.find((x: any) => x.vendorId === v.vendorId)?.refunds);
      expect(refunds[0].amount + refunds[1].amount).toBeCloseTo(rg.g.total, 2);
      expect(refunds.map((r) => r.count)).toEqual([1, 1]);
    });
  });

  // =========================================================================================
  describe('admin: reassign, needs-attention, live location', () => {
    test('REASSIGN moves the whole group; the target rider must have no other delivery; unassign only before pickup', async () => {
      const [c, c2] = W.customers; const [v1, v2, v3] = W.vendors; const [r1, r2, r3] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      await cook(pg, 'PREPARING');
      const idA = pg.g.orders[0].id; const idB = pg.g.orders[1].id;
      expect((await api.reassign(W.admin, idB, r1.profileId)).status).toBe(200); // through the SECOND child
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([r1.id, r1.id]);
      expect(await dutyOf(r1)).toBe('IN_TRANSIT');
      expect((await api.reassign(W.admin, idA, r1.profileId)).status).toBe(200); // same rider: no-op
      // r2 already carries something: refused; the group being moved is not counted against the target
      const other = await paidGroup(c2, [v3, v1]);
      await cook(other, 'ACCEPTED');
      expect((await api.claim(r2, other.g.orders[0].id)).status).toBe(200);
      expect(await api.reassign(W.admin, idA, r2.profileId).then((r) => [r.status, r.body.code])).toEqual([409, 'RIDER_BUSY']);
      expect((await api.reassign(W.admin, idA, r3.profileId)).status).toBe(200);
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([r3.id, r3.id]);
      expect(await dutyOf(r1)).toBe('ONLINE');
      expect(await dutyOf(r3)).toBe('IN_TRANSIT');
      // offline rider: refused unless forced
      await prisma.driverPartner.update({ where: { id: r1.profileId }, data: { dutyStatus: 'OFFLINE' } });
      expect(await api.reassign(W.admin, idA, r1.profileId).then((r) => [r.status, r.body.code])).toEqual([409, 'RIDER_OFFLINE']);
      expect((await api.reassign(W.admin, idA, r1.profileId, true)).status).toBe(200);
      // unassign before pickup: the whole group; after ANY pickup: refused
      expect((await api.reassign(W.admin, idB, null)).status).toBe(200);
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([null, null]);
      await cook(pg, 'READY_FOR_PICKUP');
      expect((await api.claim(r3, idA)).status).toBe(200);
      expect((await api.setStatus(r3, idB, 'PICKED_UP')).status).toBe(200);
      expect(await api.reassign(W.admin, idA, null).then((r) => [r.status, r.body.code])).toEqual([409, 'CANNOT_UNASSIGN']);
      expect((await api.reassign(W.admin, idA, r1.profileId, true)).status).toBe(200); // handing the picked-up group to another rider is allowed
      expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([r1.id, r1.id]);
      // unpaid and finished groups cannot be assigned
      const unpaid = await placeG(W.customers[2], [cartOf(v2), cartOf(v3)]);
      expect(await api.reassign(W.admin, unpaid.orders[0].id, r2.profileId).then((r) => [r.status, r.body.code])).toEqual([409, 'PAYMENT_NOT_CONFIRMED']);
      await api.adminCancel(W.admin, idA);
      expect(await api.reassign(W.admin, idB, r2.profileId).then((r) => [r.status, r.body.code])).toEqual([409, 'ORDER_CLOSED']);
    });

    test('needs-attention rows of a group child carry groupId; ready food without a rider is reported per child', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors;
      const pg = await paidGroup(c, [v1, v2]);
      await cook(pg, 'READY_FOR_PICKUP');
      await prisma.order.updateMany({ where: { groupId: pg.g.id }, data: { updatedAt: minutesFromNow(-30) } });
      const rows = (await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === pg.g.id);
      expect(rows.map((x: any) => x.problem)).toEqual(['NO_RIDER', 'NO_RIDER']);
      expect(rows.every((x: any) => x.order.group.id === pg.g.id && x.order.groupId === pg.g.id)).toBe(true);
      // single orders carry no groupId
      const s = await api.place(W.customers[1], v1);
      expect(Object.keys((await api.get(W.admin, s.body.data.id)).body.data)).not.toContain('groupId');
    });

    test('the rider\'s live position reaches the order room of EVERY child (customer and admin only); the restaurants get nothing', async () => {
      const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const pg = await paidGroup(c, [v1, v2]);
      const ids: string[] = pg.g.orders.map((o: any) => o.id);
      const wc = await watch(c); const wa = await watch(W.admin); const wv = await watch(v1, [`vendor_${v1.vendorId}`]); const wo = await watch(W.customers[1]);
      for (const id of ids) { expect(await wc.join(`order_${id}`)).toBe(true); expect(await wa.join(`order_${id}`)).toBe(true); }
      expect(await wo.join(`order_${ids[0]}`)).toBe(false); // someone else's order room
      await cook(pg, 'READY_FOR_PICKUP');
      expect((await api.claim(r1, ids[1])).status).toBe(200);
      expect((await api.location(r1, 23.0735, 76.8599)).status).toBe(200);
      await flushAll();
      expect(wc.of('rider_location').map((e: any) => e.orderId).sort()).toEqual([...ids].sort());
      expect(wa.of('rider_location').map((e: any) => e.orderId).sort()).toEqual([...ids].sort());
      expect(wv.count('rider_location') + wo.count('rider_location')).toBe(0);
    });
  });
});
