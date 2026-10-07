/**
 * Multi-restaurant orders (Docs/22): fixes from the independent review (Docs/bughunt/GROUPS_review.md), each with its test.
 *  #2 push when the last restaurant accepts, #4 coins and rider rating once per delivery, #5 fixed cascade text, #7 authorisation before
 *  any lock, #8 review locks rider -> group -> children, #9 socket room cap, #10 partial group repaired by a cancel, #11 overdue from the
 *  last pickup, #1 reassign warning; plus the review's cheap test gaps (settlement run in parallel, replace-checkout racing a payment).
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { lockGroupRows } from '../../src/services/groupLock';
import { invalidateSettingsCache } from '../../src/services/settings';
import { DEFAULT_SETTINGS } from '../../src/services/pricing';
import { MAX_ORDER_ROOMS_PER_SOCKET } from '../../src/realtime';
import { setPushProvider } from '../../src/services/push/provider';
import { __waitForPushWork } from '../../src/services/push/pushService';
import { PushMessage, PushProvider } from '../../src/services/push/types';
import {
  World, Person, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, minutesFromNow, sleep,
} from '../harness/journey';

jest.setTimeout(180_000);

class FakeProvider implements PushProvider {
  readonly enabled = true;
  sent: PushMessage[] = [];
  async send(m: PushMessage) { this.sent.push(m); }
  of(event: string) { return this.sent.filter((m) => m.data.event === event); }
}

describe('Order groups: review fixes', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let watchers: Watcher[] = [];
  let fake: FakeProvider;

  const flush = async () => { await __waitForPushWork(); await __waitForBackgroundWork(); await __waitForPushWork(); await Promise.all(watchers.map((w) => w.flush())); };
  const kids = (gid: string) => prisma.order.findMany({ where: { groupId: gid }, orderBy: { groupIndex: 'asc' }, include: { payments: true } });
  const placeG = async (c: Customer, vs: Vendor[]) => {
    const r = await api.placeGroup(c, vs.map((v) => cartOf(v)));
    expect([r.status, r.body.code]).toEqual([201, undefined]);
    return r.body.data as { id: string; payOrderId: string; total: number; orders: any[] };
  };
  const pay = async (c: Customer, primaryId: string, payId = `pay_${randomUUID().slice(0, 12)}`) => {
    const cp = await api.createPayment(c, primaryId);
    expect(cp.status).toBe(200);
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
    return { rzp: cp.body.razorpayOrderId as string, payId, amount: cp.body.amountInPaise as number };
  };
  const paidGroup = async (c: Customer, vs: Vendor[]) => { const g = await placeG(c, vs); const p = await pay(c, g.payOrderId); return { g, ...p, c, vs }; };
  type PG = Awaited<ReturnType<typeof paidGroup>>;
  const RANK: Record<string, number> = { PLACED: 0, ACCEPTED: 1, PREPARING: 2, READY_FOR_PICKUP: 3 };
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
  const deliver = async (pg: PG, rider: Rider) => {
    await cook(pg, 'READY_FOR_PICKUP');
    expect((await api.claim(rider, pg.g.orders[0].id)).status).toBe(200);
    for (const o of pg.g.orders) expect((await api.setStatus(rider, o.id, 'PICKED_UP')).status).toBe(200);
    expect((await api.setStatus(rider, pg.g.orders[0].id, 'ARRIVED_AT_GATE')).status).toBe(200);
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: pg.g.orders[0].id } })).otpCode!;
    expect((await api.otp(rider, pg.g.orders[1].id, code)).status).toBe(200);
    return code;
  };
  const review = (c: Person, orderId: string, extra: Record<string, unknown> = {}) => api.raw('c', 'post', '/api/reviews', c.token, { orderId, driverRating: 5, ...extra });
  const setFees = async (patch: Record<string, unknown>) => {
    const value = { ...DEFAULT_SETTINGS.fees, ...patch };
    await prisma.appSetting.upsert({ where: { key: 'fees' }, update: { value: value as any }, create: { key: 'fees', value: value as any } });
    invalidateSettingsCache();
  };
  const cleanSettlements = async () => {
    await prisma.settlementAdjustment.deleteMany({ where: { settlement: { vendorId: { startsWith: 'gr-' } } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { startsWith: 'gr-' } } });
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanSettlements();
    W = await createWorld('gr', '7', { customers: 3, vendors: 6, riders: 3 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    await prisma.appSetting.deleteMany({ where: { key: 'fees' } });
    invalidateSettingsCache();
    await prisma.user.updateMany({ where: { id: { startsWith: 'gr-' } }, data: { kraveoCoins: 0 } });
    await prisma.driverPartner.updateMany({ where: { id: { startsWith: 'gr-' } }, data: { rating: 4.5 } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    fake = new FakeProvider();
    setPushProvider(fake);
    api.calls.length = 0;
  });
  afterEach(async () => {
    await flush();
    for (const w of watchers) w.disconnect();
    watchers = [];
    setPaymentProvider(null);
    setPushProvider(null);
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]);
  });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'fees' } });
    invalidateSettingsCache();
    await prisma.deviceToken.deleteMany({ where: { userId: { startsWith: 'gr-' } } });
    await prisma.pushLog.deleteMany({ where: { userId: { startsWith: 'gr-' } } });
    await stopTestServer(server);
    await cleanSettlements();
    await purgeWorld('gr');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  test('#2 the last restaurant accepting pushes "you can start cooking" to the restaurants that accepted earlier (once per order, no customer data)', async () => {
    const [c] = W.customers; const [v1, v2, v3] = W.vendors;
    await prisma.deviceToken.deleteMany({});
    for (const v of [v1, v2, v3]) await prisma.deviceToken.create({ data: { userId: v.id, token: `tok_${v.id}_AAAAAAAAAAAAAAAAAAAAAAAA`, app: 'VENDOR' } });
    const pg = await paidGroup(c, [v1, v2, v3]);
    const ids: string[] = pg.g.orders.map((o: any) => o.id);
    await flush();
    const w1 = new Watcher(server.baseUrl, v1); await w1.connect(); watchers.push(w1);
    expect((await api.setStatus(v1, ids[0], 'ACCEPTED')).status).toBe(200);
    expect((await api.setStatus(v2, ids[1], 'ACCEPTED')).status).toBe(200);
    await flush();
    expect(fake.of('GROUP_READY_TO_COOK')).toHaveLength(0); // restaurant 3 is still missing
    const m = w1.mark();
    expect((await api.setStatus(v3, ids[2], 'ACCEPTED')).status).toBe(200);
    await flush();
    const pushes = fake.of('GROUP_READY_TO_COOK');
    expect(pushes.map((p) => p.data.orderId).sort()).toEqual([ids[0], ids[1]].sort()); // the two that accepted earlier, not the one that just accepted
    expect(pushes.map((p) => p.token).sort()).toEqual([v1, v2].map((v) => `tok_${v.id}_AAAAAAAAAAAAAAAAAAAAAAAA`).sort()); // to their restaurants only
    for (const p of pushes) {
      expect(p).toMatchObject({ title: 'Start cooking', body: 'All restaurants accepted - you can start cooking.', channelId: 'order_updates', priority: 'high' });
      expect(Object.keys(p.data).sort()).toEqual(['event', 'orderId', 'v']);
      expect(`${p.title} ${p.body}`).not.toMatch(/Cust|\d{4}|Kitchen|BH2|Room/);
    }
    // the socket update stays
    expect(w1.since(m, 'order_updated', ids[0]).pop()?.group).toEqual({ size: 3, allAccepted: true });
    // idempotent per order + event: repeats and the cooking steps send nothing more
    await api.setStatus(v3, ids[2], 'ACCEPTED');
    await api.setStatus(v1, ids[0], 'PREPARING');
    await flush();
    expect(fake.of('GROUP_READY_TO_COOK')).toHaveLength(2);
    expect(await prisma.pushLog.count({ where: { event: 'GROUP_READY_TO_COOK' } })).toBe(2);
    // a group where the last acceptance is the only one pushes to nobody extra (single order: never)
    const s = await api.place(W.customers[1], v1);
    await pay(W.customers[1], s.body.data.id);
    await api.setStatus(v1, s.body.data.id, 'ACCEPTED');
    await flush();
    expect(fake.of('GROUP_READY_TO_COOK')).toHaveLength(2);
  });

  // =========================================================================================
  test('#4 and #8 reviews: coins and the rider rating move ONCE per delivery (3 restaurants), in any order and even in parallel; the other children can still be reviewed', async () => {
    const [c] = W.customers; const [v1, v2, v3] = W.vendors; const [r1] = W.riders;
    const pg = await paidGroup(c, [v1, v2, v3]);
    await deliver(pg, r1);
    const ids: string[] = pg.g.orders.map((o: any) => o.id);
    const coins = async () => (await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).kraveoCoins;
    const rating = async () => (await prisma.driverPartner.findUniqueOrThrow({ where: { id: r1.profileId } })).rating;
    expect(await coins()).toBe(0);
    // the LAST child first: it is the first review of the delivery
    const first = await review(c, ids[2], { driverRating: 5 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ coinsEarned: 10, totalCoins: 10 });
    expect(first.body.review.coinsEarned).toBe(10);
    const afterFirst = await rating();
    expect(afterFirst).toBe(parseFloat(((4.5 * 20 + 5) / 21).toFixed(2)));
    // the other two, one after the other: reviewed, no more coins, rating untouched
    for (const [i, id] of [[1, ids[1]], [0, ids[0]]] as const) {
      const r = await review(c, id, { driverRating: 1, dishReviews: [{ dishId: pg.vs[i].items[0].id, rating: 4 }] });
      expect([r.status, r.body.coinsEarned, r.body.totalCoins, r.body.review.coinsEarned]).toEqual([200, 0, 10, 0]);
      expect(r.body.message).toContain('already given');
    }
    expect(await coins()).toBe(10);
    expect(await rating()).toBe(afterFirst);
    expect((await prisma.order.findMany({ where: { groupId: pg.g.id } })).every((o) => o.isReviewed)).toBe(true);
    expect((await prisma.reviewRecord.findMany({ where: { orderId: { in: ids } } })).map((r) => r.coinsEarned).sort()).toEqual([0, 0, 10]);
    // a second review of the same child is refused as before
    expect((await review(c, ids[0])).status).toBe(400);
    // all three at the same moment (a fresh delivery): exactly one wins the coins
    await resetWorldState(W);
    await prisma.user.update({ where: { id: c.id }, data: { kraveoCoins: 0 } });
    const pg2 = await paidGroup(c, [v1, v2, v3]);
    await deliver(pg2, r1);
    const rs = await Promise.all(pg2.g.orders.map((o: any) => review(c, o.id)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.map((r) => r.body.coinsEarned).sort()).toEqual([0, 0, 10]);
    expect(await coins()).toBe(10);
    // authorisation is answered on a plain read (403 for somebody else's order, 404 for none), the single-order review is unchanged
    expect((await review(W.customers[1], pg2.g.orders[0].id)).status).toBe(403);
    expect((await review(c, 'no-such-order')).status).toBe(404);
    const single = await api.place(c, v1);
    await pay(c, single.body.data.id);
    expect((await review(c, single.body.data.id)).status).toBe(403); // not delivered yet
    await prisma.user.update({ where: { id: c.id }, data: { kraveoCoins: 0 } });
    await prisma.order.update({ where: { id: single.body.data.id }, data: { status: 'DELIVERED', deliveredAt: new Date(), driverId: r1.id } });
    expect((await review(c, single.body.data.id)).body).toMatchObject({ coinsEarned: 10, totalCoins: 10 });
  });

  test('#8 a review and a claim of the same delivered group at the same moment never deadlock (rider -> group -> children)', async () => {
    const [c] = W.customers; const [v1, v2] = W.vendors; const [r1, r2] = W.riders;
    for (let round = 0; round < 6; round++) {
      await resetWorldState(W);
      const pg = await paidGroup(c, [v1, v2]);
      await deliver(pg, r1);
      const rs: any[] = await Promise.all([review(c, pg.g.orders[0].id), api.claim(r1, pg.g.orders[1].id), review(c, pg.g.orders[1].id), api.claim(r2, pg.g.orders[0].id), api.release(r1, pg.g.orders[0].id)]);
      expect(rs.filter((r) => r.status >= 500)).toEqual([]);
      expect([rs[0].status, rs[2].status]).toEqual([200, 200]);
    }
  });

  // =========================================================================================
  test('#5 a cascaded sibling carries a FIXED reason: restaurants never read another restaurant\'s or the admin\'s text; the customer reads the real reason on the triggering child and in the group view', async () => {
    const [c] = W.customers; const [v1, v2, v3] = W.vendors;
    const secret = 'Out of paneer, call 9876501234 (internal note)';
    const pg = await paidGroup(c, [v1, v2, v3]);
    expect((await api.reject(v2, pg.g.orders[1].id, secret)).status).toBe(200);
    await flush();
    const k = await kids(pg.g.id);
    expect(k.map((o) => o.cancelReason)).toEqual(['Another restaurant in your order could not take it', secret, 'Another restaurant in your order could not take it']);
    expect(k.map((o) => o.cancelledBy)).toEqual(['SYSTEM', 'VENDOR', 'SYSTEM']);
    for (const [v, i] of [[v1, 0], [v3, 2]] as const) {
      const seen = JSON.stringify([(await api.get(v, pg.g.orders[i].id)).body.data, (await api.list(v, '?scope=history')).body.data]);
      expect(seen).not.toContain('paneer');
      expect(seen).not.toContain('9876501234');
      expect((await api.get(v, pg.g.orders[i].id)).body.data.cancelReason).toBe('Another restaurant in your order could not take it');
    }
    const view = (await api.getGroup(c, pg.g.id)).body.data;
    expect(view.cancelReason).toBe(secret); // the real reason, once, at group level
    expect(view.orders.map((o: any) => o.cancelReason)).toEqual(['Another restaurant in your order could not take it', secret, 'Another restaurant in your order could not take it']);
    // the admin's note stays on the triggering child too
    const pg2 = await paidGroup(c, [v1, v2]);
    await api.adminCancel(W.admin, pg2.g.orders[0].id, 'Internal: kitchen on fire, call 9000000000');
    const vend = JSON.stringify((await api.get(v2, pg2.g.orders[1].id)).body.data);
    expect(vend).not.toContain('kitchen on fire');
    expect((await api.getGroup(c, pg2.g.id)).body.data.cancelReason).toBe('Internal: kitchen on fire, call 9000000000');
    expect((await api.getGroup(c, 'nope')).status).toBe(404);
    // an uncancelled group has no group-level reason
    const live = await placeG(c, [v1, v3]);
    expect((await api.getGroup(c, live.id)).body.data.cancelReason).toBeNull();
  });

  // =========================================================================================
  test('#7 a user who only guesses an order id never touches the locks of a group: create-order, cancel, reject, status, release, verify-otp, review answer at once while the group is locked', async () => {
    const [c, c2] = W.customers; const [v1, v2, v3] = W.vendors; const [r1, r2] = W.riders;
    const pg = await paidGroup(c, [v1, v2]);
    await cook(pg, 'READY_FOR_PICKUP');
    expect((await api.claim(r1, pg.g.orders[0].id)).status).toBe(200);
    const [a, b] = pg.g.orders.map((o: any) => o.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = prisma.$transaction(async (tx) => { await lockGroupRows(tx, pg.g.id); acquired(); await held; }, { maxWait: 10_000, timeout: 30_000 });
    await gotLock;
    const t0 = Date.now();
    const answers = await Promise.all([
      api.createPayment(c2, a), // not the owner
      api.createPayment(c2, b),
      api.cancel(c2, b),
      api.reject(v3, b, 'Not mine at all'),
      api.setStatus(v3, b, 'ACCEPTED'),
      api.setStatus(r2, a, 'PICKED_UP'), // a rider that is not the carrier
      api.release(r2, a),
      api.otp(r2, a, '1234'),
      api.raw('c2', 'post', '/api/reviews', c2.token, { orderId: a }),
    ]);
    const took = Date.now() - t0;
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 403]);
    expect(took).toBeLessThan(2500); // all refused without waiting for the 3+ seconds the group stays locked
    // the real owner's call does wait for the lock and then works
    const owner = api.setStatus(r1, a, 'PICKED_UP');
    await sleep(300);
    release();
    await holder;
    expect((await owner).status).toBe(200);
    expect((await api.setStatus(r1, b, 'PICKED_UP')).status).toBe(200);
  });

  // =========================================================================================
  test('#10 a cancel finishes a PARTIAL group (some children cancelled, some live): through either child, customer or admin, one refund', async () => {
    const [c] = W.customers; const [v1, v2, v3] = W.vendors;
    const partial = async (cancelledIndex: number) => {
      const pg = await paidGroup(c, [v1, v2, v3]);
      await prisma.order.update({ where: { id: pg.g.orders[cancelledIndex].id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'VENDOR', cancelReason: 'Manual edit' } });
      return pg;
    };
    const expectDone = async (pg: PG) => {
      await flush();
      const k = await kids(pg.g.id);
      expect(k.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
      expect(k.map((o) => o.refundStatus)).toEqual(['DONE', null, null]);
      expect(k.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED']);
      expect(ledger.refundsOf(pg.payId)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
    };
    // customer, through the CANCELLED child (used to answer "already cancelled" and do nothing)
    let pg = await partial(1);
    let r = await api.cancel(c, pg.g.orders[1].id);
    expect([r.status, r.body.message]).toEqual([200, 'Order cancelled.']);
    await expectDone(pg);
    // customer, through a live child
    await resetWorldState(W);
    pg = await partial(2);
    expect((await api.cancel(c, pg.g.orders[0].id)).status).toBe(200);
    await expectDone(pg);
    // the PRIMARY is the cancelled one (paid, no refund booked): the cancel starts it
    await resetWorldState(W);
    pg = await partial(0);
    expect((await kids(pg.g.id))[0].refundStatus).toBeNull();
    expect((await api.cancel(c, pg.g.orders[0].id)).status).toBe(200);
    await expectDone(pg);
    // admin, through either child; the second call is the normal no-op
    await resetWorldState(W);
    pg = await partial(0);
    const adm = await api.adminCancel(W.admin, pg.g.orders[2].id, 'Repair');
    expect(adm.body).toMatchObject({ groupId: pg.g.id, cancelledOrders: 3 });
    await expectDone(pg);
    const again = await api.adminCancel(W.admin, pg.g.orders[0].id);
    expect(again.body).toMatchObject({ message: 'This order was already cancelled.', cancelledOrders: 0 });
    // vendor reject through the cancelled own child repairs too
    await resetWorldState(W);
    pg = await partial(1);
    expect((await api.reject(v2, pg.g.orders[1].id, 'Repair it')).status).toBe(200);
    await expectDone(pg);
    // a customer still cannot cancel a partial group in which a restaurant already accepted
    await resetWorldState(W);
    pg = await paidGroup(c, [v1, v2, v3]);
    await api.setStatus(v1, pg.g.orders[0].id, 'ACCEPTED');
    await prisma.order.update({ where: { id: pg.g.orders[1].id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'VENDOR', cancelReason: 'Manual edit' } });
    expect((await api.cancel(c, pg.g.orders[2].id)).body.code).toBe('CANNOT_CANCEL');
  });

  // =========================================================================================
  test('#11 DELIVERY_OVERDUE of a group counts from the LAST pickup and only once every stop is picked up', async () => {
    const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
    const pg = await paidGroup(c, [v1, v2]);
    await cook(pg, 'READY_FOR_PICKUP');
    await api.claim(r1, pg.g.orders[0].id);
    const [a, b] = pg.g.orders.map((o: any) => o.id);
    const rows = async () => (await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === pg.g.id && x.problems.includes('DELIVERY_OVERDUE'));
    const longAgo = minutesFromNow(-70);
    expect((await api.setStatus(r1, a, 'PICKED_UP')).status).toBe(200);
    await prisma.order.update({ where: { id: a }, data: { pickedUpAt: longAgo, updatedAt: longAgo } });
    expect(await rows()).toEqual([]); // waiting at the second kitchen is not "overdue"
    expect((await api.setStatus(r1, b, 'PICKED_UP')).status).toBe(200); // picked up just now
    expect(await rows()).toEqual([]);
    await prisma.order.update({ where: { id: b }, data: { pickedUpAt: longAgo, updatedAt: longAgo } });
    const late = await rows();
    expect(late.map((x: any) => x.order.id)).toEqual([a]); // reported once, through the primary
    expect(late[0].problem).toBe('DELIVERY_OVERDUE');
    // a single order is unchanged
    const s = await api.place(W.customers[1], v1);
    await pay(W.customers[1], s.body.data.id);
    await prisma.order.update({ where: { id: s.body.data.id }, data: { status: 'PICKED_UP', pickedUpAt: longAgo, updatedAt: longAgo, driverId: W.riders[1].id } });
    expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === s.body.data.id)?.problems).toContain('DELIVERY_OVERDUE');
  });

  // =========================================================================================
  test('#9 one socket keeps all order rooms of three combined orders (13 rooms); the cap is a sane maximum, not 10', async () => {
    expect(MAX_ORDER_ROOMS_PER_SOCKET).toBe(30);
    const [c] = W.customers;
    await setFees({ maxRestaurantsPerOrder: 5 });
    const wc = new Watcher(server.baseUrl, c); await wc.connect(); watchers.push(wc);
    const ids: string[] = [];
    for (const vs of [W.vendors.slice(0, 5), W.vendors.slice(1, 6), W.vendors.slice(0, 3)]) {
      const pg = await paidGroup(c, vs); // paid, so the next group does not replace it
      ids.push(...pg.g.orders.map((o: any) => o.id));
    }
    expect(ids).toHaveLength(13);
    for (const id of ids) expect(await wc.join(`order_${id}`)).toBe(true);
    for (const id of ids) expect((await server.io.in(`order_${id}`).fetchSockets()).length).toBe(1); // none was dropped
    // and a join beyond the cap still drops the OLDEST, not a random one
    const extra = await api.place(c, W.vendors[5]);
    expect(extra.status).toBe(201);
  });

  // =========================================================================================
  test('#1 admin reassign of a combined order works and answers with a warning (also in the audit row); single orders get none', async () => {
    const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
    const pg = await paidGroup(c, [v1, v2]);
    await cook(pg, 'PREPARING');
    const res = await api.reassign(W.admin, pg.g.orders[1].id, r1.profileId);
    expect(res.status).toBe(200);
    expect(res.body.warning).toBe('Combined order: the rider needs the latest app.');
    expect(res.body.data.id).toBe(pg.g.orders[1].id);
    expect((await kids(pg.g.id)).map((o) => o.driverId)).toEqual([r1.id, r1.id]);
    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ORDER_REASSIGNED', targetId: pg.g.orders[1].id } });
    expect(log.summary).toContain('Whole combined order (2 restaurants) moved. Warning: the rider needs the latest app.');
    // unassigning carries no warning; a no-op carries none
    const un = await api.reassign(W.admin, pg.g.orders[0].id, null);
    expect(un.status).toBe(200);
    expect(un.body.warning).toBeUndefined();
    // a single order: no warning
    const s = await api.place(W.customers[1], v1);
    await pay(W.customers[1], s.body.data.id);
    await api.setStatus(v1, s.body.data.id, 'ACCEPTED');
    const one = await api.reassign(W.admin, s.body.data.id, r1.profileId);
    expect(one.status).toBe(200);
    expect(one.body.warning).toBeUndefined();
  });

  test('#6 the group new-delivery push goes only to riders that are ONLINE and idle (offline and busy riders are skipped)', async () => {
    const [c] = W.customers; const [v1, v2, v3] = W.vendors; const [r1, r2, r3] = W.riders;
    await prisma.deviceToken.deleteMany({});
    await prisma.driverPartner.updateMany({ where: { id: { not: { startsWith: 'gr-' } } }, data: { dutyStatus: 'OFFLINE' } });
    for (const r of W.riders) await prisma.deviceToken.create({ data: { userId: r.id, token: `tok_${r.id}_AAAAAAAAAAAAAAAAAAAAAAAA`, app: 'DRIVER' } });
    await prisma.driverPartner.update({ where: { id: r3.profileId }, data: { dutyStatus: 'OFFLINE' } });
    const busy = await paidGroup(W.customers[1], [v3, v1]);
    await cook(busy, 'ACCEPTED');
    expect((await api.claim(r2, busy.g.orders[0].id)).status).toBe(200); // r2 is busy now
    fake.sent.length = 0;
    const pg = await paidGroup(c, [v1, v2]);
    await cook(pg, 'READY_FOR_PICKUP');
    await flush();
    expect(fake.of('NEW_DELIVERY').filter((m) => m.data.orderId === pg.g.orders[0].id).map((m) => m.token)).toEqual([`tok_${r1.id}_AAAAAAAAAAAAAAAAAAAAAAAA`]);
  });

  // =========================================================================================
  test('GAP settlement run, OTP retries and reviews in parallel on a delivered group: no 5xx, one settlement per restaurant, each child settled once', async () => {
    const [c] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
    const pg = await paidGroup(c, [v1, v2]);
    const code = await deliver(pg, r1);
    const run = (v: Vendor) => api.raw('admin', 'post', '/api/admin/settlements/run', W.admin.token, { vendorId: v.vendorId });
    const rs: any[] = await Promise.all([run(v1), run(v2), run(v1), run(v2), api.otp(r1, pg.g.orders[0].id, code), api.otp(r1, pg.g.orders[1].id, code), review(c, pg.g.orders[0].id), api.otp(r1, pg.g.orders[1].id, code), run(v1)]);
    expect(rs.filter((r) => r.status >= 500)).toEqual([]);
    expect(rs.filter((r) => r.status !== 200)).toEqual([]);
    const settlements = await prisma.settlement.findMany({ where: { vendorId: { in: [v1.vendorId, v2.vendorId] } } });
    expect(settlements.map((s) => [s.vendorId, s.orderCount, s.vendorAmount]).sort()).toEqual([[v1.vendorId, 1, 180], [v2.vendorId, 1, 180]]);
    const k = await kids(pg.g.id);
    expect(new Set(k.map((o) => o.settlementId)).size).toBe(2);
    expect(k.every((o) => o.settlementId !== null && o.status === 'DELIVERED')).toBe(true);
  });

  test('GAP a new checkout replacing an unpaid group while that group\'s payment is being captured (verify + webhook + replace + expiry): consistent, never paid-and-cancelled without a refund', async () => {
    const [c] = W.customers; const [v1, v2] = W.vendors;
    for (let round = 0; round < 5; round++) {
      await resetWorldState(W);
      ledger = createLedger();
      setPaymentProvider(ledger.provider);
      const g = await placeG(c, [v1, v2]);
      const cp = await api.createPayment(c, g.payOrderId);
      await prisma.payment.updateMany({ where: { orderId: g.payOrderId }, data: { createdAt: minutesFromNow(-5) } }); // the checkout is no longer "in flight": replaceable
      const payId = `pay_replace_${round}`;
      ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
      const rs: any[] = await Promise.all([
        api.verify(c, cp.body.razorpayOrderId, payId),
        api.placeGroup(c, [cartOf(v1), cartOf(v2)]),
        api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise),
        runOrderMaintenance(minutesFromNow(1)),
      ]);
      await flush();
      expect(rs.filter((r) => r.status >= 500)).toEqual([]);
      expect(rs[1].status).toBe(201);
      await runOrderMaintenance(minutesFromNow(5));
      await flush();
      const k = await kids(g.id);
      const cancelled = k.map((o) => o.status === 'CANCELLED');
      expect(new Set(cancelled).size).toBe(1); // all or nothing
      expect(new Set(k.map((o) => o.paymentStatus)).size).toBe(1);
      expect(k.slice(1).every((o) => o.refundStatus === null)).toBe(true);
      if (cancelled[0]) {
        if (k[0].paymentStatus === 'PENDING') expect(ledger.refundsOf(payId)).toHaveLength(0); // replaced before the money arrived and nothing arrived: never happens here, the capture is in the ledger
        else { expect(k[0].refundStatus).toBe('DONE'); expect(ledger.refundsOf(payId)).toHaveLength(1); }
      } else {
        expect(k.every((o) => o.paymentStatus === 'PAID')).toBe(true);
      }
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(cancelled[0] ? 0 : cp.body.amountInPaise);
    }
  });
});
