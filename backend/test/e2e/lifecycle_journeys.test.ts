/**
 * Whole-lifecycle journeys (QA end-to-end): multi-actor, real sockets, real PostgreSQL, the payment provider
 * replaced by a ledger around the in-memory simulator. Every step asserts what each actor sees over REST and
 * over their socket, and the database. Tests named `PROVE:` were `BUG:` tests (kept failing on purpose) until the
 * 2026-10-03 hardening fixed the defect they exposed.
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import {
  World, Person, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, keysOf, RAW_KEYS,
  sleep, until, minutesFromNow, reissue,
} from '../harness/journey';

jest.setTimeout(60_000);

describe('Lifecycle journeys', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let watchers: Watcher[] = [];

  const watch = async (p: Person, rooms: string[] = []) => {
    const w = await new Watcher(server.baseUrl, p).connect();
    for (const r of rooms) expect(await w.join(r)).toBe(true);
    watchers.push(w);
    return w;
  };
  const flushAll = async () => { await __waitForBackgroundWork(); await Promise.all(watchers.map((w) => w.flush())); };
  const row = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const dutyOf = async (r: Rider) => (await prisma.driverPartner.findUniqueOrThrow({ where: { id: r.profileId } })).dutyStatus;
  const refundsOf = async (orderId: string) => {
    const pays = await prisma.payment.findMany({ where: { orderId } });
    return pays.flatMap((p) => (p.razorpayPaymentId ? ledger.refundsOf(p.razorpayPaymentId) : []));
  };
  const audit = (orderId: string, action: string) => prisma.adminAuditLog.count({ where: { targetId: orderId, action } });

  /** Place (and pay) through the real endpoints. `via` = how the money notification reaches the server. */
  const place = async (c: Customer, v: Vendor, extra: Record<string, unknown> = {}, itemIdx = 0) => {
    const r = await api.place(c, v, extra, itemIdx);
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };
  const pay = async (c: Customer, orderId: string, via: 'verify' | 'webhook' | 'both' | 'none' = 'verify', payId = `pay_${randomUUID().slice(0, 12)}`) => {
    const cp = await api.createPayment(c, orderId);
    expect(cp.status).toBe(200);
    const rzp = cp.body.razorpayOrderId as string;
    const amount = cp.body.amountInPaise as number;
    if (via === 'none') return { rzp, payId, amount };
    ledger.capture(rzp, payId, amount);
    if (via === 'verify' || via === 'both') expect((await api.verify(c, rzp, payId)).status).toBe(200);
    if (via === 'webhook' || via === 'both') expect((await api.webhookCaptured(rzp, payId, amount)).status).toBe(200);
    return { rzp, payId, amount };
  };
  const placePaid = async (c: Customer, v: Vendor, via: 'verify' | 'webhook' | 'both' = 'verify', itemIdx = 0) => {
    const id = await place(c, v, {}, itemIdx);
    return { id, ...(await pay(c, id, via)) };
  };
  /** Drive a paid order forward through the real endpoints. */
  const STEPS = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CLAIMED', 'PICKED_UP', 'ARRIVED_AT_GATE'];
  const driveTo = async (id: string, target: string, v: Vendor, r: Rider) => {
    for (const st of STEPS) {
      if (st === 'CLAIMED') expect((await api.claim(r, id)).status).toBe(200);
      else if (['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(st)) expect((await api.setStatus(v, id, st)).status).toBe(200);
      else expect((await api.setStatus(r, id, st)).status).toBe(200);
      if (st === target) return;
    }
    throw new Error(`unknown target ${target}`);
  };
  const setProvider = () => { ledger = createLedger(); setPaymentProvider(ledger.provider); };

  /** Restaurants and riders must never get an OTP, a raw column, payment internals, or an event type that is not theirs. */
  const expectHygiene = (vendorWatchers: Watcher[], riderWatchers: Watcher[], customerWatchers: Watcher[]) => {
    const orderEvents = new Set(['order_updated', 'new_order_alert', 'order_available', 'order_unavailable', 'rider_location', 'driver_location_update']);
    const pairs: [Watcher, string[]][] = [...vendorWatchers.map((x): [Watcher, string[]] => [x, ['new_order_alert', 'order_updated']]), ...riderWatchers.map((x): [Watcher, string[]] => [x, ['order_available', 'order_unavailable', 'order_updated']])];
    for (const [w, allowed] of pairs) {
      for (const ev of w.events) {
        if (!orderEvents.has(ev.event)) continue;
        expect([w.who.role, ev.event, allowed.includes(ev.event)]).toEqual([w.who.role, ev.event, true]);
        expect([w.who.role, ev.event, [...keysOf(ev.data)].filter((k) => RAW_KEYS.includes(k))]).toEqual([w.who.role, ev.event, []]);
        expect([w.who.role, ev.event, ev.data?.otpCode ?? null]).toEqual([w.who.role, ev.event, null]);
        if (w.who.role === 'VENDOR') expect(ev.data.customer?.phone ?? null).toBeNull();
      }
    }
    for (const w of customerWatchers) {
      for (const ev of w.events) {
        const bad = ['payments', 'razorpayOrderId', 'razorpayPaymentId', 'capturedAmountPaise', 'refundError', 'refundAttempts', 'otpAttempts', 'otpLocked', 'customerId', 'passwordHash', 'fcmToken'];
        expect([ev.event, [...keysOf(ev.data)].filter((k) => bad.includes(k))]).toEqual([ev.event, []]);
        expect(ev.event).not.toBe('driver_location_update');
      }
    }
  };

  beforeAll(async () => {
    await cleanTestOrders();
    W = await createWorld('jy', '1', { customers: 3, vendors: 2, riders: 3 });
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
    // The lifecycle must never produce a server error, whatever a journey does on purpose.
    expect(api.calls.filter((c) => c.status >= 500 && !(c.status === 503 && (c.body as any)?.code === 'PROVIDER_UNAVAILABLE'))).toEqual([]);
  });
  afterAll(async () => {
    await stopTestServer(server);
    await purgeWorld('jy');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  // 1. Happy path
  // =========================================================================================
  describe('J1 happy path', () => {
    test('place -> pay -> accept -> prepare -> ready -> claim -> pickup -> gate -> OTP -> delivered; every actor sees the right thing at every step', async () => {
      const [c1, c2] = W.customers; const [v1, v2] = W.vendors; const [r1, r2] = W.riders;
      const wc = await watch(c1); const wc2 = await watch(c2); const wv = await watch(v1); const wv2 = await watch(v2);
      const wr1 = await watch(r1); const wr2 = await watch(r2); const wa = await watch(W.admin);

      // --- 1. place (idempotent) -------------------------------------------------------------
      const key = randomUUID();
      const placed = await api.place(c1, v1, { clientRequestId: key });
      expect(placed.status).toBe(201);
      const id = placed.body.data.id as string;
      expect(placed.body.data).toMatchObject({ status: 'PLACED', paymentStatus: 'PENDING', subtotal: 180, deliveryFee: 25, taxAndPackaging: 0, discount: 0, totalAmount: 205, otpCode: null, driver: null, paidAt: null });
      const replay = await api.place(c1, v1, { clientRequestId: key });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ idempotentReplay: true, data: { id } });
      expect(await wc.join(`order_${id}`)).toBe(true);
      expect(await wc2.join(`order_${id}`)).toBe(false);
      expect(await wv.join(`order_${id}`)).toBe(false); // unpaid: the restaurant may not watch it
      expect(await wr1.join(`order_${id}`)).toBe(false);
      await flushAll();
      expect((await api.get(v1, id)).status).toBe(404);
      expect((await api.list(v1, '?scope=active')).body.data.map((o: any) => o.id)).not.toContain(id);
      expect((await api.available(r1)).body.data.map((o: any) => o.id)).not.toContain(id);
      for (const w of [wv, wv2, wr1, wr2, wc2]) expect(w.of('order_updated', id).concat(w.of('new_order_alert', id), w.of('order_available', id))).toEqual([]);
      expect(wa.count('order_updated', id)).toBeGreaterThanOrEqual(1);

      // --- 2. pay (verify) -------------------------------------------------------------------
      const { rzp, payId } = await pay(c1, id, 'verify');
      await flushAll();
      const paidRow = await row(id);
      expect(paidRow).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
      expect(paidRow.paidAt).not.toBeNull();
      expect(paidRow.payments).toHaveLength(1);
      expect(paidRow.payments[0]).toMatchObject({ razorpayOrderId: rzp, razorpayPaymentId: payId, status: 'PAID', capturedAmountPaise: 20500 });
      expect(wv.count('new_order_alert', id)).toBe(1);
      expect(wa.count('new_order_alert', id)).toBe(1);
      expect(wc.count('new_order_alert', id)).toBe(0);
      expect(wv.last('new_order_alert', id)).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED', customer: { name: 'Cust1', phone: null, hostelBlock: null }, otpCode: null });
      expect(wv.last('new_order_alert', id).acceptBy).toBeTruthy();
      expect(wc.last('order_updated', id)).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      expect(wv2.count('new_order_alert')).toBe(0);
      expect(wr1.count('order_available', id) + wr2.count('order_available', id)).toBe(0); // not in the pool before the restaurant accepts
      const vv = (await api.get(v1, id)).body.data;
      expect(vv.customer).toEqual({ id: c1.id, name: 'Cust1', phone: null, hostelBlock: null });
      expect((await api.list(v1, '?scope=active')).body.data.map((o: any) => o.id)).toContain(id);
      expect((await api.get(v2, id)).status).toBe(404);
      expect((await api.get(c2, id)).status).toBe(404);
      expect(await wv.join(`order_${id}`)).toBe(true);

      // --- 3. accept -> pool -------------------------------------------------------------------
      expect((await api.setStatus(v1, id, 'ACCEPTED')).status).toBe(200);
      await until(() => wr1.count('order_available', id) === 1 && wr2.count('order_available', id) === 1, 3000, 'order_available');
      const offer = wr1.last('order_available', id);
      expect(offer).toMatchObject({ customer: null, dropoffNotes: null, driver: null, otpCode: null, paymentStatus: 'PAID', status: 'ACCEPTED' });
      expect(wc.last('order_updated', id).status).toBe('ACCEPTED');
      expect(wv.last('order_updated', id).status).toBe('ACCEPTED');
      expect((await row(id)).acceptedAt).not.toBeNull();
      expect((await api.available(r1)).body.data.find((o: any) => o.id === id)).toMatchObject({ customer: null, dropoffNotes: null });
      expect(await wr1.join(`order_${id}`)).toBe(false); // pool riders cannot watch the order room

      // --- 4. claim: one winner, the loser is told, everyone sees the assignment ---------------
      const [a, b] = await Promise.all([api.claim(r1, id), api.claim(r2, id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? r1 : r2; const loser = winner === r1 ? r2 : r1;
      const ww = winner === r1 ? wr1 : wr2; const wl = winner === r1 ? wr2 : wr1;
      expect((a.status === 409 ? a : b).body.code).toBe('ALREADY_TAKEN');
      await flushAll();
      expect(wl.count('order_unavailable', id)).toBe(1);
      expect(wl.last('order_unavailable', id)).toEqual({ id });
      expect((await row(id))).toMatchObject({ driverId: winner.id, status: 'ACCEPTED' });
      expect(await ww.join(`order_${id}`)).toBe(true);
      expect(await wl.join(`order_${id}`)).toBe(false);
      expect((await api.get(loser, id)).status).toBe(404);
      expect((await api.available(loser)).body.data.map((o: any) => o.id)).not.toContain(id);
      expect((await api.get(winner, id)).body.data.customer).toEqual({ id: c1.id, name: c1.name, phone: c1.phone, hostelBlock: 'Block 3' });
      expect((await api.get(winner, id)).body.data.dropoffNotes).toBe('Room 214');
      const custDriver = (await api.get(c1, id)).body.data.driver;
      expect(custDriver).toEqual({ id: winner.id, name: winner.name, phone: winner.phone });
      expect(wc.last('order_updated', id).driver).toEqual(custDriver);
      expect(wv.last('order_updated', id).driver).toEqual(custDriver);
      expect(wv.last('order_updated', id).customer.phone).toBeNull();
      expect(await dutyOf(winner)).toBe('IN_TRANSIT');

      // --- 5. kitchen ----------------------------------------------------------------------------
      for (const st of ['PREPARING', 'READY_FOR_PICKUP']) {
        const m = { c: wc.mark(), w: ww.mark() };
        expect((await api.setStatus(v1, id, st)).status).toBe(200);
        await flushAll();
        expect(wc.since(m.c, 'order_updated', id).map((o) => o.status)).toEqual([st]);
        expect(ww.since(m.w, 'order_updated', id).map((o) => o.status)).toEqual([st]);
        expect(ww.since(m.w, 'order_updated', id)[0].customer.phone).toBe(c1.phone); // the assigned rider sees the phone
      }
      // The rider cannot move restaurant statuses, the restaurant cannot move rider statuses.
      expect((await api.setStatus(winner, id, 'PREPARING')).status).toBe(403);
      expect((await api.setStatus(v1, id, 'PICKED_UP')).status).toBe(403);

      // --- 6. pickup + live position ---------------------------------------------------------------
      expect((await api.setStatus(winner, id, 'PICKED_UP')).status).toBe(200);
      expect(await wa.join(`order_${id}`)).toBe(true);
      const locMarks = [wc, wv, wv2, wr1, wr2, wc2].map((w) => w.mark());
      expect((await api.location(winner, 23.0771, 76.8519)).status).toBe(200);
      await flushAll();
      expect(wc.count('rider_location', id)).toBe(1);
      expect(wc.last('rider_location', id)).toMatchObject({ orderId: id, driverId: winner.id, lat: 23.0771, lng: 76.8519 });
      expect(wa.count('rider_location', id)).toBe(1);
      expect(wa.count('driver_location_update')).toBeGreaterThanOrEqual(1);
      [wc, wv, wv2, wr1, wr2, wc2].forEach((w, i) => {
        if (w !== wc) expect(w.since(locMarks[i]).filter((e) => e.lat !== undefined)).toEqual([]);
      });
      expect((await api.get(c1, id)).body.data.pickedUpAt).toBeTruthy();

      // --- 7. gate: OTP only for the customer -----------------------------------------------------
      const m = { c: wc.mark(), v: wv.mark(), r: ww.mark(), a: wa.mark() };
      const arrived = await api.setStatus(winner, id, 'ARRIVED_AT_GATE');
      expect(arrived.status).toBe(200);
      expect(arrived.body.data.otpCode).toBeNull();
      await flushAll();
      const otp = (await row(id)).otpCode!;
      expect(otp).toMatch(/^\d{4}$/);
      expect(wc.since(m.c, 'order_updated', id).map((o) => o.otpCode)).toEqual([otp]);
      expect(wv.since(m.v, 'order_updated', id).map((o) => o.otpCode)).toEqual([null]);
      expect(ww.since(m.r, 'order_updated', id).map((o) => o.otpCode)).toEqual([null]);
      expect(wa.since(m.a, 'order_updated', id).map((o) => o.otpCode)).toEqual([otp]);
      expect((await api.get(c1, id)).body.data.otpCode).toBe(otp);
      expect((await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id).otpCode).toBe(otp);
      expect((await api.get(winner, id)).body.data.otpCode).toBeNull();
      expect((await api.list(winner, '?scope=active')).body.data.find((o: any) => o.id === id).otpCode).toBeNull();
      expect((await api.get(v1, id)).body.data.otpCode).toBeNull();
      expect((await api.list(v1)).body.data.find((o: any) => o.id === id).otpCode).toBeNull();
      expect((await api.get(W.admin, id)).body.data.otpCode).toBe(otp);
      expect(JSON.stringify((await api.get(winner, id)).body)).not.toContain(otp === '0000' ? 'zzzz' : `"otpCode":"${otp}"`);

      // --- 8. deliver ----------------------------------------------------------------------------
      const wrong = otp === '1234' ? '4321' : '1234';
      const bad = await api.otp(winner, id, wrong);
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: 4 });
      expect((await api.otp(loser, id, otp)).status).toBe(404);
      expect((await api.otp(c1, id, otp)).status).toBe(403);
      expect((await api.otp(v1, id, otp)).status).toBe(403);
      const done = await api.otp(winner, id, otp);
      expect(done.status).toBe(200);
      expect(done.body.data).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID', otpCode: null });
      await flushAll();
      for (const w of [wc, wv, ww, wa]) expect(w.last('order_updated', id).status).toBe('DELIVERED');
      expect(wc.last('order_updated', id).otpCode).toBeNull();
      const fin = await row(id);
      expect(fin).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID', otpCode: 'USED', driverId: winner.id, otpAttempts: 1 });
      const t = (d: Date | null) => d!.getTime();
      expect(t(fin.createdAt) <= t(fin.paidAt) && t(fin.paidAt) <= t(fin.acceptedAt) && t(fin.acceptedAt) <= t(fin.pickedUpAt) && t(fin.pickedUpAt) <= t(fin.deliveredAt)).toBe(true);
      expect(fin.cancelledAt).toBeNull();
      for (const k of ['createdAt', 'paidAt', 'acceptedAt', 'pickedUpAt', 'deliveredAt']) expect(done.body.data[k]).toMatch(/Z$/);
      expect(await dutyOf(winner)).toBe('ONLINE');
      expect(await refundsOf(id)).toHaveLength(0);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(20500);
      // Nothing more is forwarded once the order is over; a replay of the OTP changes nothing.
      const before = wc.count('rider_location');
      await api.location(winner, 23.08, 76.85);
      await flushAll();
      expect(wc.count('rider_location')).toBe(before);
      expect((await api.otp(winner, id, otp)).body.message).toMatch(/already DELIVERED/);
      expect((await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id)).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(String) });
      // Customer 2 and restaurant 2 heard nothing about any of it.
      expect(wc2.events.filter((e) => e.data?.id === id || e.data?.orderId === id)).toEqual([]);
      expect(wv2.events.filter((e) => e.data?.id === id)).toEqual([]);
      expectHygiene([wv, wv2], [wr1, wr2], [wc, wc2]);
    });
  });

  // =========================================================================================
  // 2. Payment arrival paths
  // =========================================================================================
  describe('J2 payment paths', () => {
    test('paid by WEBHOOK only (app killed): restaurant alerted once, customer sees PAID from REST, then the whole order completes', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wv = await watch(v1); const wr = await watch(r1);
      const id = await place(c1, v1);
      const cp = await api.createPayment(c1, id);
      ledger.capture(cp.body.razorpayOrderId, 'pay_wh_only', 20500);
      // The customer app is killed here. Razorpay calls the webhook.
      const w1 = await api.webhookCaptured(cp.body.razorpayOrderId, 'pay_wh_only', 20500);
      expect(w1.body).toMatchObject({ status: 'processed' });
      await flushAll();
      expect(wv.count('new_order_alert', id)).toBe(1);
      expect((await row(id))).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      // App restarts: the active list shows the paid order and a verify call is harmless.
      const active = (await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id);
      expect(active).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      const v = await api.verify(c1, cp.body.razorpayOrderId, 'pay_wh_only');
      expect(v.status).toBe(200);
      expect(v.body.message).toMatch(/already verified/);
      expect((await api.createPayment(c1, id)).body.code).toBe('ALREADY_PAID');
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const otp = (await api.get(c1, id)).body.data.otpCode;
      expect((await api.otp(r1, id, otp)).body.data.status).toBe('DELIVERED');
      await flushAll();
      expect(wv.count('new_order_alert', id)).toBe(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(20500);
      expectHygiene([wv], [wr], []);
    });

    test('verify + webhook (+ duplicate webhooks) arriving concurrently: one winner, one alert, one paidAt, one payment row', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      for (let round = 0; round < 3; round++) {
        const wv = await watch(v1);
        const id = await place(c1, v1);
        const cp = await api.createPayment(c1, id);
        const rzp = cp.body.razorpayOrderId; const pid = `pay_race_${round}`;
        ledger.capture(rzp, pid, 20500);
        const res = await Promise.all([
          api.verify(c1, rzp, pid), api.webhookCaptured(rzp, pid, 20500), api.verify(c1, rzp, pid), api.webhookCaptured(rzp, pid, 20500, 'order.paid'), api.webhookCaptured(rzp, pid, 20500),
        ]);
        expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
        await flushAll();
        expect(wv.count('new_order_alert', id)).toBe(1);
        const o = await row(id);
        expect(o.payments).toHaveLength(1);
        expect(o.payments[0]).toMatchObject({ status: 'PAID', razorpayPaymentId: pid });
        const firstPaid = o.paidAt!.getTime();
        await api.webhookCaptured(rzp, pid, 20500);
        expect((await row(id)).paidAt!.getTime()).toBe(firstPaid);
        expect(await refundsOf(id)).toHaveLength(0);
        wv.disconnect();
        await prisma.order.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } }); // free the slot; money checked above
      }
    });
  });

  // =========================================================================================
  // 3. Payment failure, expiry, late payment
  // =========================================================================================
  describe('J3 failure / expiry / late payment', () => {
    test('payment fails, the customer retries on the SAME order and pays; nobody else heard of the failed attempt', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wv = await watch(v1); const wr = await watch(r1); const wc = await watch(c1);
      const id = await place(c1, v1);
      await wc.join(`order_${id}`);
      const cp = await api.createPayment(c1, id);
      const rzp = cp.body.razorpayOrderId;
      expect((await api.webhookFailed(rzp, 'pay_try1', 20500)).status).toBe(200);
      await flushAll();
      expect((await api.get(c1, id)).body.data).toMatchObject({ status: 'PLACED', paymentStatus: 'FAILED' });
      expect(wc.last('order_updated', id)).toMatchObject({ paymentStatus: 'FAILED' });
      expect((await api.get(v1, id)).status).toBe(404);
      expect(wv.count('order_updated', id) + wv.count('new_order_alert', id) + wr.count('order_available', id)).toBe(0);
      // A FAILED order still counts towards the 3 unpaid limit. (Bug hunt BE1-01: a new checkout at the SAME restaurant replaces an
      // abandoned or failed order, so the two other open orders are at the other restaurant, each with a payment just opened.)
      const v2 = W.vendors[1];
      for (let i = 0; i < 2; i++) {
        await prisma.order.create({
          data: {
            customerId: c1.id, vendorId: v2.vendorId, subtotal: 90, deliveryFee: 25, taxAndPackaging: 15, discount: 0, totalAmount: 130, dropoffHostel: 'BH2', status: 'PLACED', paymentStatus: 'PENDING',
            payments: { create: { razorpayOrderId: `rzp_filler_${randomUUID()}`, amount: 130, status: 'PENDING' } },
          },
        });
      }
      expect((await api.place(c1, v2)).status).toBe(429);
      // Retry: same Razorpay order, second attempt succeeds.
      const again = await api.createPayment(c1, id);
      expect(again.body.razorpayOrderId).toBe(rzp);
      ledger.capture(rzp, 'pay_try2', 20500);
      expect((await api.verify(c1, rzp, 'pay_try2')).status).toBe(200);
      await flushAll();
      expect((await row(id))).toMatchObject({ paymentStatus: 'PAID' });
      expect(wv.count('new_order_alert', id)).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1);
      // A late "payment.failed" for the first attempt (webhooks can arrive out of order) must not undo the payment.
      await api.webhookFailed(rzp, 'pay_try1', 20500);
      expect((await row(id))).toMatchObject({ paymentStatus: 'PAID' });
      expect((await row(id)).payments[0].status).toBe('PAID');
    });

    test('unpaid order expires after 15 minutes (injected time): CANCELLED by SYSTEM, nobody but the customer and admin notified', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1); const wr = await watch(r1); const wa = await watch(W.admin);
      const id = await place(c1, v1);
      await wc.join(`order_${id}`);
      await api.createPayment(c1, id);
      expect((await runOrderMaintenance(minutesFromNow(14))).expired).not.toContain(id);
      expect((await row(id)).status).toBe('PLACED');
      const s = await runOrderMaintenance(minutesFromNow(16));
      expect(s.expired).toContain(id);
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Payment not completed', paymentStatus: 'PENDING' });
      expect((await api.get(c1, id)).body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Payment not completed', payBy: null });
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
      expect(wa.last('order_updated', id).status).toBe('CANCELLED');
      expect(wv.count('order_updated', id) + wv.count('new_order_alert', id) + wr.count('order_available', id) + wr.count('order_unavailable', id)).toBe(0);
      expect((await api.createPayment(c1, id)).body.code).toBe('ORDER_CLOSED');
      // The expired order no longer counts against the unpaid limit.
      for (let i = 0; i < 3; i++) expect((await api.place(c1, v1)).status).toBe(201);
      // And a second run does nothing.
      expect((await runOrderMaintenance(minutesFromNow(30))).expired).not.toContain(id);
    });

    test.each(['webhook', 'verify', 'concurrent'] as const)('late payment after expiry (%s): automatic refund exactly once, order stays CANCELLED, restaurant and riders never hear', async (path) => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wv = await watch(v1); const wr = await watch(r1); const wc = await watch(c1);
      const id = await place(c1, v1);
      await wc.join(`order_${id}`);
      const cp = await api.createPayment(c1, id);
      const rzp = cp.body.razorpayOrderId; const pid = `pay_late_${path}`;
      await runOrderMaintenance(minutesFromNow(16));
      ledger.capture(rzp, pid, 20500);
      if (path === 'webhook') expect((await api.webhookCaptured(rzp, pid, 20500)).body.status).toBe('processed');
      if (path === 'verify') {
        const v = await api.verify(c1, rzp, pid);
        expect(v.status).toBe(409);
        expect(v.body.code).toBe('ORDER_CANCELLED');
      }
      if (path === 'concurrent') {
        const rs = await Promise.all([api.verify(c1, rzp, pid), api.webhookCaptured(rzp, pid, 20500), api.verify(c1, rzp, pid), api.webhookCaptured(rzp, pid, 20500)]);
        expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 409, 409]);
      }
      await flushAll();
      const o = await row(id);
      expect(o).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', paidAt: null, cancelledBy: 'SYSTEM' });
      expect(o.payments[0]).toMatchObject({ status: 'REFUNDED', razorpayPaymentId: pid });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect((await api.get(v1, id)).status).toBe(404);
      expect((await api.list(v1, '?scope=history')).body.data.map((x: any) => x.id)).not.toContain(id);
      expect((await api.list(v1)).body.data.map((x: any) => x.id)).not.toContain(id);
      expect(wv.count('order_updated', id) + wv.count('new_order_alert', id) + wr.count('order_available', id)).toBe(0);
      // Replays change nothing; the job finds nothing to do; the admin has nothing to fix.
      await api.webhookCaptured(rzp, pid, 20500);
      await runOrderMaintenance(new Date());
      await __waitForBackgroundWork();
      expect(await refundsOf(id)).toHaveLength(1);
      const na = (await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id);
      expect(na).toBeUndefined();
      expect(await audit(id, 'PAYMENT_AFTER_CANCEL')).toBe(1);
    });

    test('customer cancels the unpaid order, then pays from the still-open checkout: refunded, restaurant never hears', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const wv = await watch(v1);
      const id = await place(c1, v1);
      const cp = await api.createPayment(c1, id);
      expect((await api.cancel(c1, id, 'changed my mind')).body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', paymentStatus: 'PENDING' });
      ledger.capture(cp.body.razorpayOrderId, 'pay_after_cancel', 20500);
      expect((await api.verify(c1, cp.body.razorpayOrderId, 'pay_after_cancel')).body.code).toBe('ORDER_CANCELLED');
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(wv.count('order_updated', id) + wv.count('new_order_alert', id)).toBe(0);
    });
  });

  // =========================================================================================
  // 4. Cancellations
  // =========================================================================================
  describe('J4 customer cancel / restaurant reject / restaurant silent', () => {
    test('customer cancels a PAID PLACED order: refunded once (double cancel, duplicate webhook, job run all idempotent); cancel after accept is refused', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wv = await watch(v1); const wr = await watch(r1); const wc = await watch(c1);
      const { id, rzp, payId, amount } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      const cancels = await Promise.all([api.cancel(c1, id, 'too slow'), api.cancel(c1, id, 'too slow'), api.cancel(c1, id)]);
      expect(cancels.map((c) => c.status)).toEqual([200, 200, 200]);
      await api.webhookCaptured(rzp, payId, amount);
      await runOrderMaintenance(minutesFromNow(20));
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(wv.last('order_updated', id)).toMatchObject({ status: 'CANCELLED' }); // the restaurant saw this order live, so it hears it is gone
      expect(wr.count('order_available', id)).toBe(0);
      // The restaurant cannot accept it any more; the rider cannot claim it.
      expect((await api.setStatus(v1, id, 'ACCEPTED')).body.code).toBe('ORDER_CLOSED');
      expect((await api.claim(r1, id)).body.code).toBe('ORDER_NOT_AVAILABLE');

      const o2 = await placePaid(c1, v1);
      expect((await api.setStatus(v1, o2.id, 'ACCEPTED')).status).toBe(200);
      const refused = await api.cancel(c1, o2.id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CANNOT_CANCEL');
      expect((await api.setStatus(c1, o2.id, 'CANCELLED')).status).toBe(409);
      expect(await row(o2.id)).toMatchObject({ status: 'ACCEPTED', paymentStatus: 'PAID' });
      expect(await refundsOf(o2.id)).toHaveLength(0);
    });

    test('customer cancel racing the restaurant accept: exactly one wins and money matches (10 rounds)', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      for (let i = 0; i < 10; i++) {
        const { id } = await placePaid(c1, v1);
        const [cancel, accept] = await Promise.all([api.cancel(c1, id), api.setStatus(v1, id, 'ACCEPTED')]);
        const o = await row(id);
        if (o.status === 'CANCELLED') {
          expect(cancel.status).toBe(200);
          expect([404, 409]).toContain(accept.status);
          expect(o).toMatchObject({ paymentStatus: 'REFUNDED', cancelledBy: 'CUSTOMER' });
          expect(await refundsOf(id)).toHaveLength(1);
        } else {
          expect(accept.status).toBe(200);
          expect(cancel.status).toBe(409);
          expect(o).toMatchObject({ status: 'ACCEPTED', paymentStatus: 'PAID' });
          expect(await refundsOf(id)).toHaveLength(0);
        }
        await prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });
      }
    });

    test('restaurant rejects with a reason: customer sees it (REST + socket), refunded once even when rejected 5x at once', async () => {
      const [c1] = W.customers; const [v1, v2] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1); const wr = await watch(r1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      expect((await api.reject(v1, id, 'x')).body.field).toBe('reason');
      expect((await api.reject(v2, id, 'Not my order')).status).toBe(404);
      const rs = await Promise.all(Array.from({ length: 5 }, () => api.reject(v1, id, 'Out of paneer today')));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      await flushAll();
      expect(await refundsOf(id)).toHaveLength(1);
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'VENDOR', cancelReason: 'Out of paneer today', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect((await api.get(c1, id)).body.data).toMatchObject({ cancelledBy: 'VENDOR', cancelReason: 'Out of paneer today', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Out of paneer today', cancelledBy: 'VENDOR' });
      expect((await api.list(v1, '?scope=history')).body.data.map((o: any) => o.id)).toContain(id);
      expect(wr.count('order_available', id)).toBe(0);
      // Rejecting an unpaid order is not possible (the restaurant cannot even see it); rejecting an accepted one is refused.
      const unpaid = await place(c1, v1);
      expect((await api.reject(v1, unpaid, 'No thanks')).status).toBe(404);
      const acc = await placePaid(c1, v1);
      await api.setStatus(v1, acc.id, 'ACCEPTED');
      expect((await api.reject(v1, acc.id, 'Too late now')).body.code).toBe('CANNOT_REJECT');
      expectHygiene([wv], [wr], [wc]);
    });

    test('restaurant silent for 10 minutes: job cancels + refunds exactly once (even with two job runs at once); late accept is refused', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1); const wr = await watch(r1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      expect((await runOrderMaintenance(minutesFromNow(9))).autoCancelled).not.toContain(id);
      const [a, b] = await Promise.all([runOrderMaintenance(minutesFromNow(11)), runOrderMaintenance(minutesFromNow(11))]);
      expect([...a.autoCancelled, ...b.autoCancelled].filter((x) => x === id)).toHaveLength(1);
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Restaurant did not respond', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(await audit(id, 'ORDER_CANCELLED')).toBe(1);
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Restaurant did not respond', paymentStatus: 'REFUNDED' });
      expect((await api.setStatus(v1, id, 'ACCEPTED')).body.code).toBe('ORDER_CLOSED');
      expect(wr.count('order_available', id)).toBe(0);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
    });

    test('restaurant accepts at minute 9: the job never cancels it later', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const { id } = await placePaid(c1, v1);
      await api.setStatus(v1, id, 'ACCEPTED');
      const s = await runOrderMaintenance(minutesFromNow(60));
      expect(s.autoCancelled).not.toContain(id);
      expect((await row(id)).status).toBe('ACCEPTED');
    });
  });

  // =========================================================================================
  // 5. Riders and partners mid-delivery, admin cancels, OTP lock
  // =========================================================================================
  describe('J5 rider / restaurant / admin interventions', () => {
    test('rider claims then releases; another claims; the first rider loses all access and hears nothing more', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const wc = await watch(c1); const w1 = await watch(r1); const w2 = await watch(r2);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await api.setStatus(v1, id, 'ACCEPTED');
      expect((await api.claim(r1, id)).status).toBe(200);
      expect(await w1.join(`order_${id}`)).toBe(true);
      await until(() => w2.count('order_unavailable', id) === 1, 3000);
      expect((await api.release(r2, id)).status).toBe(404); // not theirs
      const m2 = w2.mark();
      expect((await api.release(r1, id)).status).toBe(200);
      await flushAll();
      expect(w2.since(m2, 'order_available', id)).toHaveLength(1); // back in the pool for the others
      expect((await row(id)).driverId).toBeNull();
      expect(await dutyOf(r1)).toBe('ONLINE');
      expect(wc.last('order_updated', id).driver).toBeNull();
      expect(await audit(id, 'ORDER_RELEASED')).toBe(1);
      expect((await api.claim(r2, id)).status).toBe(200);
      const m1 = w1.mark();
      await api.setStatus(v1, id, 'PREPARING');
      await api.setStatus(v1, id, 'READY_FOR_PICKUP');
      await flushAll();
      expect(w1.since(m1, 'order_updated', id)).toEqual([]); // r1 left the room when released
      expect((await api.get(r1, id)).status).toBe(404);
      expect((await api.setStatus(r1, id, 'PICKED_UP')).status).toBe(404);
      expect((await api.release(r1, id)).status).toBe(404);
      expect((await api.setStatus(r2, id, 'PICKED_UP')).status).toBe(200);
      expect((await api.release(r2, id)).body.code).toBe('CANNOT_RELEASE');
      expect(wc.last('order_updated', id).driver.id).toBe(r2.id);
      // r1 is free to take a new order straight away.
      const o2 = await placePaid(c1, v1);
      await api.setStatus(v1, o2.id, 'ACCEPTED');
      expect((await api.claim(r1, o2.id)).status).toBe(200);
    });

    test('rider suspended mid-delivery (PICKED_UP): readable but blocked, admin sees it, reassigns; the new rider finishes with the OTP', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const wc = await watch(c1); const w1 = await watch(r1); const w2 = await watch(r2);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await driveTo(id, 'PICKED_UP', v1, r1);
      expect((await api.partnerStatus(W.admin, 'driver', r1.profileId, 'SUSPENDED')).status).toBe(200);
      // Suspension revokes the old sessions; signing in again gives a token that can still READ but not WORK.
      expect([(await api.get(r1, id)).status, (await api.get(r1, id)).body.code]).toEqual([401, 'TOKEN_REVOKED']);
      const r1n = await reissue(r1);
      expect((await api.get(r1n, id)).status).toBe(200);
      const blocked = await api.setStatus(r1n, id, 'ARRIVED_AT_GATE');
      expect([blocked.status, blocked.body.code]).toEqual([403, 'PARTNER_NOT_APPROVED']);
      expect((await api.otp(r1n, id, '1234')).body.code).toBe('PARTNER_NOT_APPROVED');
      expect((await api.release(r1n, id)).status).toBe(403);
      expect((await api.location(r1n, 23.07, 76.85)).status).toBe(403);
      const na = (await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id);
      expect(na.problems).toContain('RIDER_NOT_APPROVED');
      expect((await api.reassign(W.admin, id, r1.profileId)).status).toBe(400); // suspended rider
      const re = await api.reassign(W.admin, id, r2.profileId);
      expect(re.status).toBe(200);
      expect(re.body.data.driver.id).toBe(r2.id);
      await flushAll();
      expect((await api.get(r1n, id)).status).toBe(404);
      expect(wc.last('order_updated', id).driver.id).toBe(r2.id);
      expect(await dutyOf(r2)).toBe('IN_TRANSIT');
      expect((await api.setStatus(r2, id, 'ARRIVED_AT_GATE')).status).toBe(200);
      await flushAll();
      const otp = wc.last('order_updated', id).otpCode;
      expect(otp).toMatch(/^\d{4}$/);
      const m = w1.mark();
      expect((await api.otp(r1n, id, otp)).status).toBe(403); // suspended + no longer assigned
      expect((await api.otp(r2, id, otp)).body.data.status).toBe('DELIVERED');
      await flushAll();
      expect(w1.since(m).filter((e) => e.otpCode)).toEqual([]);
      expect(w1.events.map((e) => e.data?.otpCode ?? null).filter(Boolean)).toEqual([]);
      expect(await dutyOf(r2)).toBe('ONLINE');
      expect(await audit(id, 'ORDER_REASSIGNED')).toBe(1);
      expectHygiene([], [w1, w2], [wc]);
    });

    test('a suspended rider who holds a claimed (not picked up) order: admin un-assigns it and it returns to the pool', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const w2 = await watch(r2);
      const { id } = await placePaid(c1, v1);
      await api.setStatus(v1, id, 'ACCEPTED');
      await api.claim(r1, id);
      await api.partnerStatus(W.admin, 'driver', r1.profileId, 'SUSPENDED');
      const m = w2.mark();
      expect((await api.reassign(W.admin, id, null)).status).toBe(200);
      await flushAll();
      expect(w2.since(m, 'order_available', id)).toHaveLength(1);
      expect((await api.claim(r2, id)).status).toBe(200);
    });

    test('restaurant suspended mid-order: owner blocked, order readable, rider keeps going, admin cancels -> one refund, rider freed', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await driveTo(id, 'PREPARING', v1, r1);
      expect((await api.partnerStatus(W.admin, 'vendor', v1.vendorId, 'SUSPENDED')).status).toBe(200);
      expect((await api.get(v1, id)).status).toBe(401); // suspension revokes the owner's sessions
      const v1n = await reissue(v1);
      expect((await api.get(v1n, id)).status).toBe(200);
      expect((await api.get(c1, id)).status).toBe(200);
      expect((await api.setStatus(v1n, id, 'READY_FOR_PICKUP')).body.code).toBe('PARTNER_NOT_APPROVED');
      expect((await api.place(c1, v1)).body.code).toBe('VENDOR_UNAVAILABLE');
      expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id).problems).toContain('VENDOR_NOT_APPROVED');
      const c = await Promise.all([api.adminCancel(W.admin, id, 'Restaurant suspended'), api.adminCancel(W.admin, id, 'Restaurant suspended')]);
      expect(c.map((x) => x.status)).toEqual([200, 200]);
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(await dutyOf(r1)).toBe('ONLINE');
      expect(wc.last('order_updated', id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Restaurant suspended' });
      // The suspended owner's live socket was closed and dropped from the restaurant room: it hears nothing more about the order.
      expect(wv.connected).toBe(false);
      expect(wv.last('order_updated', id)?.status).not.toBe('CANCELLED');
    });

    test('restaurant suspended while a PAID order is still PLACED: it cannot accept; the job cancels + refunds after 10 minutes', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const { id } = await placePaid(c1, v1);
      await api.partnerStatus(W.admin, 'vendor', v1.vendorId, 'SUSPENDED');
      expect((await api.setStatus(v1, id, 'ACCEPTED')).body.code).toBe('TOKEN_REVOKED');
      const v1n = await reissue(v1);
      expect((await api.setStatus(v1n, id, 'ACCEPTED')).body.code).toBe('PARTNER_NOT_APPROVED');
      expect((await api.reject(v1n, id, 'closing down')).body.code).toBe('PARTNER_NOT_APPROVED');
      await runOrderMaintenance(minutesFromNow(11));
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(await refundsOf(id)).toHaveLength(1);
    });

    test('closing the store (isAcceptingOrders=false) never touches live orders; new orders get VENDOR_CLOSED', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const { id } = await placePaid(c1, v1);
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { isAcceptingOrders: false } });
      expect((await api.place(c1, v1)).body.code).toBe('VENDOR_CLOSED');
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const otp = (await api.get(c1, id)).body.data.otpCode;
      expect((await api.otp(r1, id, otp)).body.data.status).toBe('DELIVERED');
    });

    test.each(['PLACED', 'ACCEPTED', 'CLAIMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'])('admin cancels at %s: one refund (even concurrent), customer/rider/pool updated, rider freed, old OTP useless', async (state) => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const wc = await watch(c1); const w1 = await watch(r1); const w2 = await watch(r2); const wv = await watch(v1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      if (state !== 'PLACED') await driveTo(id, state === 'ACCEPTED' ? 'ACCEPTED' : state, v1, r1);
      const hadRider = ['CLAIMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'].includes(state);
      // note: driveTo('PREPARING') etc. claims only when it passes the CLAIMED step; PREPARING/READY come before it
      const row0 = await row(id);
      const assigned = !!row0.driverId;
      expect(assigned).toBe(['CLAIMED', 'PICKED_UP', 'ARRIVED_AT_GATE'].includes(state));
      void hadRider;
      const otp = row0.otpCode;
      if (assigned) await w1.join(`order_${id}`);
      const m = { c: wc.mark(), r: w1.mark(), r2: w2.mark() };
      const rs = await Promise.all([api.adminCancel(W.admin, id, 'Customer called support'), api.adminCancel(W.admin, id, 'Customer called support')]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      await flushAll();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', cancelReason: 'Customer called support', paymentStatus: 'REFUNDED', refundStatus: 'DONE', otpCode: null });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      expect(wc.since(m.c, 'order_updated', id).at(-1)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', otpCode: null, cancelReason: 'Customer called support' });
      expect((await api.get(c1, id)).body.data.otpCode).toBeNull();
      if (assigned) expect(w1.since(m.r, 'order_updated', id).at(-1)).toMatchObject({ status: 'CANCELLED' });
      if (!assigned && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(state)) expect(w2.since(m.r2, 'order_unavailable', id)).toHaveLength(1);
      expect(await dutyOf(r1)).toBe('ONLINE');
      // The rider cannot do anything with the dead order, not even with the code the customer had.
      if (assigned) {
        expect((await api.setStatus(r1, id, 'PICKED_UP')).status).toBe(409);
        if (otp) expect((await api.otp(r1, id, otp)).status).toBe(409);
      }
      expect(['ORDER_NOT_AVAILABLE', 'ALREADY_TAKEN']).toContain((await api.claim(r2, id)).body.code); // a cancelled order keeps its driverId: ALREADY_TAKEN is a misleading code (noted in the report)
      expect((await api.available(r2)).body.data.map((o: any) => o.id)).not.toContain(id);
      // Location is no longer forwarded for a cancelled order.
      const lm = wc.mark();
      await api.location(r1, 23.07, 76.85);
      await flushAll();
      expect(wc.since(lm, 'rider_location')).toEqual([]);
      // The freed rider can take the next order.
      const next = await placePaid(c1, v1);
      await api.setStatus(v1, next.id, 'ACCEPTED');
      expect((await api.claim(r1, next.id)).status).toBe(200);
      expectHygiene([wv], [w1, w2], [wc]);
    });

    test('admin cancels an unpaid order (no refund) and a delivered order cannot be cancelled', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const id = await place(c1, v1);
      const r = await api.adminCancel(W.admin, id, 'Duplicate order');
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING', refundStatus: 'NONE' });
      expect(ledger.calls.refundPayment).toBe(0);
      const paid = await placePaid(c1, v1);
      await driveTo(paid.id, 'ARRIVED_AT_GATE', v1, r1);
      await api.otp(r1, paid.id, (await api.get(c1, paid.id)).body.data.otpCode);
      expect((await api.adminCancel(W.admin, paid.id, 'Too late')).body.code).toBe('ORDER_CLOSED');
      expect((await api.adminCancel(c1, paid.id, 'Too late')).status).toBe(403);
      expect(await refundsOf(paid.id)).toHaveLength(0);
    });

    test('OTP wrong x5 -> locked (even the right code) -> customer cannot unlock -> admin unlocks -> new OTP reaches only the customer -> delivered', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1); const wr = await watch(r1); const wa = await watch(W.admin);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const first = (await api.get(c1, id)).body.data.otpCode as string;
      const wrongs = ['0000', '1111', '2222', '3333', '4444'].map((c) => (c === first ? '9999' : c));
      for (const [i, code] of wrongs.entries()) {
        const r = await api.otp(r1, id, code);
        expect(r.status).toBe(i < 4 ? 400 : 423);
        expect(r.body.code).toBe(i < 4 ? 'OTP_INVALID' : 'OTP_LOCKED');
        if (i < 4) expect(r.body.attemptsLeft).toBe(4 - i);
      }
      await flushAll();
      expect(await row(id)).toMatchObject({ otpLocked: true, otpAttempts: 5, status: 'ARRIVED_AT_GATE' });
      expect((await api.otp(r1, id, first)).status).toBe(423); // the right code is refused while locked
      expect((await api.setStatus(r1, id, 'DELIVERED', { otpCode: first })).status).toBe(423); // and the generic route too
      expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id).problem).toBe('OTP_LOCKED');
      expect(wa.last('order_updated', id)).toMatchObject({ otpLocked: true });
      expect((await api.resetOtp(c1, id)).status).toBe(403);
      expect((await api.resetOtp(r1, id)).status).toBe(403);
      expect((await api.resetOtp(v1, id)).status).toBe(403);
      const m = { c: wc.mark(), r: wr.mark(), v: wv.mark() };
      expect((await api.resetOtp(W.admin, id)).status).toBe(200);
      await flushAll();
      const fresh = (await row(id)).otpCode!;
      expect(fresh).toMatch(/^\d{4}$/);
      expect((await row(id))).toMatchObject({ otpLocked: false, otpAttempts: 0 });
      expect(wc.since(m.c, 'order_updated', id).at(-1).otpCode).toBe(fresh);
      expect((await api.get(c1, id)).body.data.otpCode).toBe(fresh);
      expect(wr.since(m.r, 'order_updated', id).map((o) => o.otpCode ?? null)).toEqual(wr.since(m.r, 'order_updated', id).map(() => null));
      expect(wv.since(m.v, 'order_updated', id).map((o) => o.otpCode ?? null).filter(Boolean)).toEqual([]);
      if (fresh !== first) expect((await api.otp(r1, id, first)).status).toBe(400); // the old code no longer works
      const ok = await api.otp(r1, id, fresh);
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('DELIVERED');
      expect((await api.list(W.admin, '?status=DELIVERED')).body.data.map((o: any) => o.id)).toContain(id);
      expect(await audit(id, 'OTP_LOCKED')).toBe(1);
      expect(await audit(id, 'OTP_UNLOCKED')).toBe(1);
      expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id)).toBeUndefined();
      expectHygiene([wv], [wr], [wc]);
    });

    test('rider enters wrong codes concurrently while the right one is also sent: never more than 5 counted, delivery only with the right code', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const { id } = await placePaid(c1, v1);
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const otp = (await api.get(c1, id)).body.data.otpCode as string;
      const wrongs = Array.from({ length: 8 }, (_, i) => String(1000 + i)).filter((c) => c !== otp);
      const rs = await Promise.all([...wrongs.map((c) => api.otp(r1, id, c)), api.otp(r1, id, otp)]);
      const o = await row(id);
      expect(o.otpAttempts).toBeLessThanOrEqual(5);
      if (o.status === 'DELIVERED') expect(rs.filter((r) => r.status === 200 && /verified successfully/.test(r.body.message))).toHaveLength(1);
      else expect(o).toMatchObject({ otpLocked: true, status: 'ARRIVED_AT_GATE' });
    });
  });

  // =========================================================================================
  // 6. Isolation
  // =========================================================================================
  describe('J6 isolation between customers, restaurants and riders', () => {
    test('customer B / restaurant Y / rider without the claim can neither see nor act on customer A / restaurant X / the claimed order', async () => {
      const [cA, cB] = W.customers; const [vX, vY] = W.vendors; const [r1, r2] = W.riders;
      const wA = await watch(cA); const wB = await watch(cB); const wX = await watch(vX); const wY = await watch(vY); const w1 = await watch(r1); const w2 = await watch(r2);
      const { id, rzp } = await placePaid(cA, vX);
      await wA.join(`order_${id}`);
      expect(await wB.join(`order_${id}`)).toBe(false);
      expect(await wY.join(`order_${id}`)).toBe(false);
      expect(await wY.join(`vendor_${vX.vendorId}`)).toBe(false);
      expect(await wB.join(`vendor_${vX.vendorId}`)).toBe(false);
      expect(await wB.join('drivers')).toBe(false);
      expect(await wB.join('admins')).toBe(false);
      expect(await wA.join('user_x')).toBe(false);
      // Customer B
      expect((await api.get(cB, id)).status).toBe(404);
      expect((await api.cancel(cB, id)).status).toBe(404);
      expect((await api.createPayment(cB, id)).status).toBe(404);
      expect((await api.verify(cB, rzp, 'pay_x')).status).toBe(404);
      expect((await api.list(cB)).body.data).toEqual([]);
      expect((await api.claim(cB, id)).status).toBe(403);
      expect((await api.setStatus(cB, id, 'ACCEPTED')).status).toBe(403);
      expect((await api.otp(cB, id, '1234')).status).toBe(403);
      // identical to a missing order: no existence leak
      expect((await api.get(cB, 'no-such-order')).body).toEqual((await api.get(cB, id)).body);
      // Restaurant Y
      expect((await api.get(vY, id)).status).toBe(404);
      expect((await api.setStatus(vY, id, 'ACCEPTED')).status).toBe(404);
      expect((await api.reject(vY, id, 'Not mine')).status).toBe(404);
      expect((await api.list(vY)).body.data).toEqual([]);
      expect((await api.list(vY, '?scope=history')).body.data).toEqual([]);
      // Accept, then rider isolation.
      expect((await api.setStatus(vX, id, 'ACCEPTED')).status).toBe(200);
      expect((await api.claim(r1, id)).status).toBe(200);
      await w1.join(`order_${id}`);
      expect(await w2.join(`order_${id}`)).toBe(false);
      for (const call of [() => api.setStatus(r2, id, 'PICKED_UP'), () => api.release(r2, id), () => api.otp(r2, id, '1234'), () => api.get(r2, id)]) expect((await call()).status).toBe(404);
      expect((await api.setStatus(r2, id, 'DELIVERED', { otpCode: '1234' })).status).toBe(404);
      expect((await api.list(r2)).body.data).toEqual([]);
      expect((await api.available(r2)).body.data.map((o: any) => o.id)).not.toContain(id);
      expect((await api.reassign(r2, id, r2.profileId)).status).toBe(403);
      expect((await api.adminCancel(r1, id)).status).toBe(403);
      expect((await api.needsAttention(vX)).status).toBe(403);
      await api.setStatus(vX, id, 'PREPARING'); await api.setStatus(vX, id, 'READY_FOR_PICKUP');
      expect((await api.setStatus(r1, id, 'PICKED_UP')).status).toBe(200);
      // rider 2's own GPS (no active order) and rider 1's GPS: only A hears rider 1's.
      await api.location(r2, 23.1, 76.9);
      await api.location(r1, 23.2, 76.8);
      await api.setStatus(r1, id, 'ARRIVED_AT_GATE');
      await flushAll();
      expect(wA.of('rider_location').map((l) => l.driverId)).toEqual([r1.id]);
      for (const w of [wB, wX, wY, w2]) expect(w.count('rider_location')).toBe(0);
      expect(wA.last('order_updated', id).otpCode).toMatch(/^\d{4}$/);
      // None of B / Y's sockets ever heard about the order or the OTP.
      for (const w of [wB, wY]) expect(w.events.filter((e) => e.data?.id === id || e.data?.orderId === id)).toEqual([]);
      expect(w2.events.filter((e) => (e.data?.id === id && e.event !== 'order_available' && e.event !== 'order_unavailable') || e.data?.orderId === id)).toEqual([]);
      expect(JSON.stringify(wB.events) + JSON.stringify(wY.events) + JSON.stringify(w2.events)).not.toContain(wA.last('order_updated', id).otpCode ? `"otpCode":"${wA.last('order_updated', id).otpCode}"` : 'zz');
      expect((await row(id)).status).toBe('ARRIVED_AT_GATE');
      expectHygiene([wX, wY], [w1, w2], [wA, wB]);
    });

    test('the same clientRequestId used by two customers makes two separate orders and never returns the other customer\'s order', async () => {
      const [cA, cB] = W.customers; const [vX] = W.vendors;
      const key = randomUUID();
      const a = await api.place(cA, vX, { clientRequestId: key });
      const b = await api.place(cB, vX, { clientRequestId: key });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.data.id).not.toBe(b.body.data.id);
      expect(b.body.data.customer.id).toBe(cB.id);
      expect((await api.place(cB, vX, { clientRequestId: key })).body.data.id).toBe(b.body.data.id);
    });

    test('unauthenticated, garbage and expired tokens are refused everywhere (REST and socket)', async () => {
      const [cA] = W.customers; const [vX] = W.vendors;
      const id = await place(cA, vX);
      for (const tok of [null, 'garbage', 'Bearer x.y.z']) {
        expect((await api.raw('anon', 'get', `/api/orders/${id}`, tok)).status).toBe(401);
        expect((await api.raw('anon', 'post', `/api/orders/${id}/cancel`, tok, {})).status).toBe(401);
      }
      await expect(new Watcher(server.baseUrl, { ...cA, token: '' }).connect()).rejects.toBeTruthy();
      await expect(new Watcher(server.baseUrl, { ...cA, token: 'nope' }).connect()).rejects.toBeTruthy();
      expect((await row(id)).status).toBe('PLACED');
    });
  });

  // =========================================================================================
  // 7. Reconnection
  // =========================================================================================
  describe('J7 reconnection: REST restores the truth', () => {
    test('every role drops its socket mid-order, misses events, reconnects: REST (scope=active) is the truth, auto-rooms come back, order rooms need a re-join', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const wc = await watch(c1); const wv = await watch(v1); const wr = await watch(r1); const wr2 = await watch(r2); const wa = await watch(W.admin);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await api.setStatus(v1, id, 'ACCEPTED');
      expect((await api.claim(r1, id)).status).toBe(200);
      await wr.join(`order_${id}`); await wa.join(`order_${id}`);
      await flushAll();
      // Everybody drops.
      for (const w of [wc, wv, wr, wr2, wa]) w.disconnect();
      // The world moves on without them.
      await api.setStatus(v1, id, 'PREPARING');
      await api.setStatus(v1, id, 'READY_FOR_PICKUP');
      await api.setStatus(r1, id, 'PICKED_UP');
      await api.location(r1, 23.07, 76.85);
      await api.setStatus(r1, id, 'ARRIVED_AT_GATE');
      const otp = (await row(id)).otpCode!;
      const seen = { c: wc.events.length, v: wv.events.length, r: wr.events.length, a: wa.events.length };
      for (const w of [wc, wv, wr, wr2, wa]) await w.reconnect(false);
      await flushAll();
      // Nothing is replayed.
      expect([wc.events.length, wv.events.length, wr.events.length, wa.events.length]).toEqual([seen.c, seen.v, seen.r, seen.a]);
      // REST has everything, per role.
      const cv = (await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id);
      expect(cv).toMatchObject({ status: 'ARRIVED_AT_GATE', otpCode: otp, driver: { id: r1.id, phone: r1.phone } });
      const vv = (await api.list(v1, '?scope=active')).body.data.find((o: any) => o.id === id);
      expect(vv).toMatchObject({ status: 'ARRIVED_AT_GATE', otpCode: null });
      const rv = (await api.list(r1, '?scope=active')).body.data.find((o: any) => o.id === id);
      expect(rv).toMatchObject({ status: 'ARRIVED_AT_GATE', otpCode: null, customer: { phone: c1.phone } });
      const av = (await api.list(W.admin, '?status=ARRIVED_AT_GATE')).body.data.find((o: any) => o.id === id);
      expect(av).toMatchObject({ otpCode: otp });
      expect((await api.list(r2, '?scope=active')).body.data).toEqual([]);
      // The customer's order room is NOT restored automatically; after the re-join events flow again.
      const m = wc.mark();
      await api.location(r1, 23.08, 76.86);
      await flushAll();
      expect(wc.since(m, 'rider_location')).toEqual([]);
      expect(await wc.join(`order_${id}`)).toBe(true);
      await api.location(r1, 23.09, 76.87);
      await flushAll();
      expect(wc.since(m, 'rider_location')).toHaveLength(1);
      // Auto rooms (restaurant, drivers, admins) work again without any join.
      const { id: id2 } = await placePaid(c1, v1);
      await api.setStatus(v1, id2, 'ACCEPTED');
      await flushAll();
      expect(wv.count('new_order_alert', id2)).toBe(1);
      expect(wr2.count('order_available', id2)).toBe(1);
      expect(wa.count('new_order_alert', id2)).toBe(1);
      expect((await api.otp(r1, id, otp)).body.data.status).toBe('DELIVERED');
    });

    test('rider goes offline mid-delivery: keeps the active order, can finish it, cannot claim another, stays OFFLINE afterwards', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wc = await watch(c1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await driveTo(id, 'PICKED_UP', v1, r1);
      expect((await api.duty(r1, false)).body.dutyStatus).toBe('OFFLINE');
      expect((await api.list(r1, '?scope=active')).body.data.map((o: any) => o.id)).toContain(id);
      expect((await api.get(r1, id)).status).toBe(200);
      expect((await api.available(r1)).body.data).toEqual([]);
      const o2 = await placePaid(c1, v1);
      await api.setStatus(v1, o2.id, 'ACCEPTED');
      expect((await api.claim(r1, o2.id)).body.code).toBe('RIDER_OFFLINE');
      expect((await row(id)).driverId).toBe(r1.id);
      expect((await api.location(r1, 23.07, 76.85)).status).toBe(200);
      await flushAll();
      expect(wc.count('rider_location', id)).toBe(1); // the customer keeps seeing the rider
      expect((await api.setStatus(r1, id, 'ARRIVED_AT_GATE')).status).toBe(200);
      // Going back online while carrying shows IN_TRANSIT, not ONLINE.
      expect((await api.duty(r1, true)).body.dutyStatus).toBe('IN_TRANSIT');
      expect((await api.duty(r1, false)).body.dutyStatus).toBe('OFFLINE');
      const otp = (await api.get(c1, id)).body.data.otpCode;
      expect((await api.otp(r1, id, otp)).body.data.status).toBe('DELIVERED');
      expect(await dutyOf(r1)).toBe('OFFLINE'); // delivering does not put an off-duty rider back on duty
    });

    test('customer app killed at the gate and restarted: GET /orders?scope=active gives the OTP again; killed after delivery: the finished order is still listed for 10 minutes', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const { id } = await placePaid(c1, v1);
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const otp = (await row(id)).otpCode!;
      expect((await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id).otpCode).toBe(otp);
      await api.otp(r1, id, otp);
      expect((await api.list(c1, '?scope=active')).body.data.find((o: any) => o.id === id)).toMatchObject({ status: 'DELIVERED', otpCode: null });
      await prisma.order.update({ where: { id }, data: { deliveredAt: new Date(Date.now() - 11 * 60_000) } });
      expect((await api.list(c1, '?scope=active')).body.data.map((o: any) => o.id)).not.toContain(id);
      expect((await api.list(c1, '?scope=history')).body.data.map((o: any) => o.id)).toContain(id);
    });
  });

  // =========================================================================================
  // 8. Provider failure injection
  // =========================================================================================
  describe('J8 payment provider failures', () => {
    test('provider down during create-order: 503, no half-created payment, order intact, retry works', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const wv = await watch(v1); const wr = await watch(r1);
      const id = await place(c1, v1);
      ledger.mode.createDown = true;
      const down = await api.createPayment(c1, id);
      expect([down.status, down.body.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(0);
      expect(await row(id)).toMatchObject({ status: 'PLACED', paymentStatus: 'PENDING' });
      ledger.mode.createDown = false;
      const up = await api.createPayment(c1, id);
      expect(up.status).toBe(200);
      ledger.capture(up.body.razorpayOrderId, 'pay_after_outage', 20500);
      expect((await api.verify(c1, up.body.razorpayOrderId, 'pay_after_outage')).status).toBe(200);
      await flushAll();
      expect(wv.count('new_order_alert', id)).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1);
      void wr;
    });

    test('provider down during refund: FAILED + visible to admin with the right problem; the job retries with backoff WITHOUT using up attempts; recovery refunds exactly once', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const wc = await watch(c1);
      const { id } = await placePaid(c1, v1);
      await wc.join(`order_${id}`);
      await api.setStatus(v1, id, 'ACCEPTED');
      ledger.mode.refundDown = true;
      const c = await api.adminCancel(W.admin, id, 'Kitchen fire');
      expect(c.status).toBe(200);
      expect(c.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'FAILED', refundError: 'Razorpay is down' });
      const cv = (await api.get(c1, id)).body.data;
      expect(cv).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'FAILED' });
      expect(JSON.stringify(cv)).not.toContain('Razorpay is down'); // internal provider text stays away from customers
      expect(wc.last('order_updated', id)).toMatchObject({ refundStatus: 'FAILED' });
      let na = (await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id);
      expect(na).toMatchObject({ problem: 'REFUND_FAILED', detail: expect.stringContaining('Razorpay is down'), since: expect.stringMatching(/Z$/) });
      // The outage is transient: the attempt taken by the lease is given back, so the cap (3 permanent failures) is untouched.
      expect(na.order.refundAttempts).toBe(0);
      // Backoff: a tick right away does not hammer the provider; ticks after the "not before" time retry, still no attempts used.
      expect((await runOrderMaintenance(new Date())).refundsRetried).not.toContain(id);
      for (let i = 1; i <= 14; i++) expect((await runOrderMaintenance(minutesFromNow(i * 70))).refundsRetried).toContain(id);
      expect((await row(id)).refundAttempts).toBe(0);
      expect((await row(id)).refundStatus).toBe('FAILED');
      expect(await refundsOf(id)).toHaveLength(0);
      na = (await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id);
      expect(na.problem).toBe('REFUND_FAILED');
      // Provider recovers: the job alone refunds it (no admin button needed), once.
      ledger.mode.refundDown = false;
      expect((await runOrderMaintenance(minutesFromNow(14 * 70 + 120))).refundsDone).toContain(id);
      await flushAll();
      expect(await refundsOf(id)).toHaveLength(1);
      expect((await api.get(c1, id)).body.data).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id)).toBeUndefined();
      expect(await audit(id, 'REFUND_DONE')).toBe(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
    });

    test('provider recovers before the cap: the next job tick refunds once', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const { id } = await placePaid(c1, v1);
      ledger.mode.refundDown = true;
      await api.cancel(c1, id);
      expect((await row(id)).refundStatus).toBe('FAILED');
      ledger.mode.refundDown = false;
      expect((await runOrderMaintenance(minutesFromNow(5))).refundsDone).toContain(id);
      expect(await row(id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE', refundError: null });
      expect(await refundsOf(id)).toHaveLength(1);
    });

    test('refund succeeded at the provider but the answer was lost: FAILED, then the job finds the refund and never refunds twice', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const { id } = await placePaid(c1, v1);
      ledger.mode.refundLostAnswer = true;
      await api.cancel(c1, id);
      expect((await row(id)).refundStatus).toBe('FAILED');
      expect(await refundsOf(id)).toHaveLength(1); // the provider already refunded
      ledger.mode.refundLostAnswer = false;
      await runOrderMaintenance(minutesFromNow(5));
      expect(await row(id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(ledger.calls.refundPayment).toBe(1);
    });

    test('provider TIMEOUT on a refund that actually succeeded (real 15 s provider timeout): FAILED with a clear reason, retry finds the refund', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const { id } = await placePaid(c1, v1);
      ledger.mode.refundHangAfterSuccess = true;
      const t0 = Date.now();
      const r = await api.cancel(c1, id);
      const took = Date.now() - t0;
      expect(r.status).toBe(200);
      expect(took).toBeGreaterThanOrEqual(14_000);
      expect(took).toBeLessThan(25_000);
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', refundStatus: 'FAILED' });
      expect((await row(id)).refundError).toMatch(/did not answer/);
      expect(await refundsOf(id)).toHaveLength(1);
      ledger.mode.refundHangAfterSuccess = false;
      expect((await runOrderMaintenance(minutesFromNow(5))).refundsDone).toContain(id);
      expect(await row(id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
      expect(ledger.calls.refundPayment).toBe(1);
    }, 60_000);

    test('refund outage on the webhook (late payment) path: the webhook still answers 200, the refund heals on the next tick', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const id = await place(c1, v1);
      const cp = await api.createPayment(c1, id);
      await api.cancel(c1, id);
      ledger.mode.refundDown = true;
      ledger.capture(cp.body.razorpayOrderId, 'pay_late_outage', 20500);
      const w = await api.webhookCaptured(cp.body.razorpayOrderId, 'pay_late_outage', 20500);
      expect(w.status).toBe(200);
      await __waitForBackgroundWork();
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'FAILED' });
      expect((await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === id).problem).toBe('REFUND_FAILED');
      ledger.mode.refundDown = false;
      await runOrderMaintenance(minutesFromNow(5));
      expect(await row(id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(id)).toHaveLength(1);
    });

    test('provider HANGS during create-order: the customer gets 503 after the 15 s provider timeout, and a cancel sent meanwhile completes right after (the order lock is held, not leaked)', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const id = await place(c1, v1);
      ledger.mode.createHang = true;
      const t0 = Date.now();
      const pending = api.createPayment(c1, id);
      await sleep(300);
      const cancel = api.cancel(c1, id, 'impatient');
      const [pr, cr] = await Promise.all([pending, cancel]);
      const took = Date.now() - t0;
      expect(pr.status).toBe(503);
      expect(cr.status).toBe(200);
      expect(took).toBeLessThan(25_000);
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER' });
      expect(await prisma.payment.count({ where: { orderId: id } })).toBe(0);
    }, 60_000);
  });

  // =========================================================================================
  // Exploratory probes of admin overrides (kept as assertions of the contract's intent)
  // =========================================================================================
  describe('J10 admin overrides keep the rider invariants', () => {
    test('PROVE: admin reassign must not give a rider a second active order (MAX_ACTIVE_ORDERS_PER_RIDER=1): 409 RIDER_BUSY', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const a = await placePaid(c1, v1); await driveTo(a.id, 'CLAIMED', v1, r1);
      const b = await placePaid(c1, v1); await driveTo(b.id, 'CLAIMED', v1, r2);
      const re = await api.reassign(W.admin, b.id, r1.profileId); // r1 already carries order a
      const active = await prisma.order.count({ where: { driverId: r1.id, status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] } } });
      expect([re.status, re.body.code, active]).toEqual([409, 'RIDER_BUSY', 1]);
      // ... but an admin can still move it to a rider who is free, and re-assigning to the rider who already holds it is a no-op
      const free = await api.reassign(W.admin, b.id, W.riders[2].profileId);
      expect([free.status, free.body.data.driver.id]).toEqual([200, W.riders[2].id]);
      expect((await api.reassign(W.admin, b.id, W.riders[2].profileId)).status).toBe(200);
    });

    test('PROVE: removing the rider of an order that is already PICKED_UP (reassign null) is refused 409 CANNOT_UNASSIGN (food is in the rider\'s bag)', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const a = await placePaid(c1, v1); await driveTo(a.id, 'PICKED_UP', v1, r1);
      const re = await api.reassign(W.admin, a.id, null);
      expect([re.status, re.body.code]).toEqual([409, 'CANNOT_UNASSIGN']);
      expect((await row(a.id)).driverId).toBe(r1.id);
      // an OFFLINE rider is refused unless the admin forces it (the order is theirs to finish, so move it to another ONLINE rider)
      await prisma.driverPartner.update({ where: { id: W.riders[1].profileId }, data: { dutyStatus: 'OFFLINE' } });
      const off = await api.reassign(W.admin, a.id, W.riders[1].profileId);
      expect([off.status, off.body.code]).toEqual([409, 'RIDER_OFFLINE']);
      expect((await api.reassign(W.admin, a.id, W.riders[1].profileId, true)).status).toBe(200);
    });

    test('a cancelled-unpaid order whose payment.failed webhook arrives keeps the customer-facing state sane (stays CANCELLED, no alerts)', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const wv = await watch(v1);
      const id = await place(c1, v1);
      const cp = await api.createPayment(c1, id);
      await api.cancel(c1, id);
      await api.webhookFailed(cp.body.razorpayOrderId, 'pay_f', 20500);
      await flushAll();
      const o = await row(id);
      expect(o.status).toBe('CANCELLED');
      expect(wv.events.filter((e) => e.data?.id === id)).toEqual([]);
    });

  });

  describe('J11 accounts that no longer exist', () => {
    test('PROVE: a valid token of a user that does not exist in the database gets 401 on every order endpoint, never 500', async () => {
      const ghost = { id: 'jy-ghost-1', phone: '+91 9777199999', role: 'STUDENT' as const };
      const { generateTestToken } = await import('../harness/auth');
      const token = generateTestToken(ghost as any);
      const [vX] = W.vendors;
      const placed = await api.raw('ghost', 'post', '/api/orders', token, { vendorId: vX.vendorId, items: [{ itemId: vX.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2', clientRequestId: randomUUID() });
      const list = await api.raw('ghost', 'get', '/api/orders', token);
      const calls500 = api.calls.filter((c) => c.status >= 500).length;
      api.calls.length = 0; // the 500 (if any) is reported by the assertions below, not again by afterEach
      expect([placed.status, list.status, calls500]).toEqual([401, 401, 0]);
      expect(await prisma.order.count({ where: { customerId: ghost.id } })).toBe(0);
    });

    test('PROVE: after DELETE /auth/account the old token (30 days) cannot place and pay new orders as "Deleted user" (401)', async () => {
      const [c3] = [W.customers[2]]; const [vX] = W.vendors;
      expect((await api.raw('c', 'delete', '/api/auth/account', c3.token)).status).toBe(200);
      const r = await api.place(c3, vX);
      try {
        expect(r.status).toBe(401);
      } finally {
        await prisma.user.update({ where: { id: c3.id }, data: { name: c3.name, phone: c3.phone, hostelBlock: 'Block 3' } });
      }
    });
  });

  // =========================================================================================
  // Misc: lists, pool ordering, hygiene
  // =========================================================================================
  describe('J9 lists and pool', () => {
    test('pool shows only PAID + accepted + unassigned orders, ready food first, max 20; offline riders see nothing; pool events are for approved riders only', async () => {
      const [c1, c2] = W.customers; const [v1, v2] = W.vendors; const [r1, r2, r3] = W.riders;
      const w3 = await watch(r3);
      const unpaid = await place(c1, v1);
      const placedOnly = await placePaid(c1, v1);
      const accepted = await placePaid(c1, v1); await api.setStatus(v1, accepted.id, 'ACCEPTED');
      const ready = await placePaid(c2, v2); await api.setStatus(v2, ready.id, 'ACCEPTED'); await api.setStatus(v2, ready.id, 'PREPARING'); await api.setStatus(v2, ready.id, 'READY_FOR_PICKUP');
      const taken = await placePaid(c2, v2); await api.setStatus(v2, taken.id, 'ACCEPTED'); await api.claim(r1, taken.id);
      const pool = (await api.available(r2)).body.data.map((o: any) => o.id);
      expect(pool).toEqual([ready.id, accepted.id]);
      expect(pool).not.toContain(unpaid); expect(pool).not.toContain(placedOnly.id); expect(pool).not.toContain(taken.id);
      await api.duty(r2, false);
      expect((await api.available(r2)).body.data).toEqual([]);
      await prisma.driverPartner.update({ where: { id: r3.profileId }, data: { approvalStatus: 'PENDING' } });
      expect((await api.available(r3)).status).toBe(403);
      expect(await w3.join('drivers')).toBe(false); // re-checked on request: a rider who is no longer approved cannot (re)join
      void w3;
    });
  });
});
