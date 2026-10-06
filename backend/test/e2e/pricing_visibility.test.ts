/**
 * Pricing phase 1, money and visibility (Docs/21 sections 2, 3, 9). Real PostgreSQL, real HTTP, real socket.io, a fake push sender.
 *
 *  - order totals with the all-in fee (settings), coupons that only reduce the customer total, stored snapshots
 *  - THE visibility proof: a restaurant never reads a customer price, commission, fee, discount, coupon or order total through any
 *    endpoint, socket event or push text it can reach; admin sees everything; customer and rider views keep their shape
 *  - legacy rows (backfilled by the migration) behave exactly as before
 *  - the migration backfill itself, run on legacy-shaped tables
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Socket } from 'socket.io-client';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { connectTestSocket, disconnectTestSocket } from '../harness/socket';
import { setPaymentProvider, createSimulatedProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache } from '../../src/services/settings';
import { setPushProvider, __resetPushProvider } from '../../src/services/push/provider';
import { __waitForPushWork } from '../../src/services/push/pushService';
import { PushMessage, PushProvider } from '../../src/services/push/types';

jest.setTimeout(60_000);

const VENDOR = { id: 'usr-pv-v1', phone: '+91 9999872222', vendorId: 'pv-ven-1' };
const OTHER_VENDOR = { id: 'usr-pv-v2', phone: '+91 9999872223', vendorId: 'pv-ven-2' };
const RIDER = { id: 'usr-4', phone: '+91 9876543213' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const tVendor = getVendorToken(VENDOR.id, VENDOR.phone);
const tOtherVendor = getVendorToken(OTHER_VENDOR.id, OTHER_VENDOR.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const H = (t: string) => getAuthHeader(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error('condition not met in time');
};

/**
 * Numbers chosen so that none of them can appear by accident in a restaurant payload:
 *   dish A: restaurant Rs 100, commission 20%  -> customer Rs 120
 *   dish B: restaurant Rs 33.33, commission 12.5% -> 37.50 -> rounded up to Rs 38
 *   fee Rs 37, coupon VITFIRST (20% capped at Rs 50)
 * order of A x2 + B x1: subtotal 278, discount 50, fee 37, total 265, restaurant earns 233.33, Kraveo keeps 44.67
 */
const LEAKY = [120, 38, 240, 278, 265, 37, 50, 44.67, 55.6, 20, 12.5, 228, 315, 87];

const numbersIn = (v: unknown, acc: number[] = []): number[] => {
  if (typeof v === 'number') acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbersIn(x, acc));
  return acc;
};
const keysIn = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysIn(x, acc); }
  return acc;
};
const stringsIn = (v: unknown, acc: string[] = []): string[] => {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, acc));
  return acc;
};
const VENDOR_FORBIDDEN_KEYS = ['deliveryFee', 'taxAndPackaging', 'discount', 'couponCode', 'vendorSubtotal', 'commissionTotal', 'feeBreakdown', 'vendorUnitPrice', 'commissionUnit', 'commission', 'payments', 'refundStatus', 'settlementId'];
/** Throws (via expect) when a payload meant for the restaurant carries anything a restaurant must not see. */
const assertVendorSafe = (payload: unknown, where: string) => {
  const keys = keysIn(payload);
  for (const k of VENDOR_FORBIDDEN_KEYS) if (keys.has(k)) throw new Error(`[${where}] restaurant payload has the field '${k}': ${JSON.stringify(payload).slice(0, 400)}`);
  const leaked = numbersIn(payload).filter((n) => LEAKY.some((l) => Math.abs(l - n) < 1e-9));
  if (leaked.length) throw new Error(`[${where}] restaurant payload carries the customer-side number(s) ${leaked.join(', ')}: ${JSON.stringify(payload).slice(0, 400)}`);
  for (const s of stringsIn(payload)) if (!/^\d{4}-\d\d-\d\dT/.test(s) && /\b(265|278|37|44\.67)\b/.test(s)) throw new Error(`[${where}] restaurant text carries a customer-side amount: ${s}`);
};

class FakeProvider implements PushProvider {
  readonly enabled = true;
  sent: PushMessage[] = [];
  async send(m: PushMessage) { this.sent.push(m); }
}

describe('Pricing: money and visibility', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let sim: ReturnType<typeof createSimulatedProvider>;
  let fake: FakeProvider;
  const sockets: Socket[] = [];
  // A brand-new customer for every test: VITFIRST is first-order only, and nobody hits the unpaid-orders limit.
  let cur = { id: '', token: '' };
  let cur2 = { id: '', token: '' };
  const freshStudent = async () => {
    const n = randomUUID().replace(/-/g, '').slice(0, 10);
    const phone = `+91 9999${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
    const id = `usr-pv-f${n}`;
    await prisma.user.create({ data: { id, name: 'Fresh Student', phone, role: Role.STUDENT, hostelBlock: 'BH2' } });
    return { id, token: getStudentToken(id, phone) };
  };
  let dishA = '';
  let dishB = '';

  const connect = async (token: string) => { const s = await connectTestSocket(server.baseUrl, { auth: { token } }); sockets.push(s); return s; };
  const record = (s: Socket, events: string[]) => {
    const log: { event: string; data: any }[] = [];
    for (const e of events) s.on(e, (d: any) => log.push({ event: e, data: d }));
    return log;
  };
  const settle = async () => { await __waitForPushWork(); await __waitForBackgroundWork(); await __waitForPushWork(); await sleep(60); };
  const adminPut = (group: string, body: unknown) => request.put(`/api/admin/settings/${group}`).set(H(tAdmin)).send(body as any);
  const resetSettings = async () => { await prisma.appSetting.deleteMany({}); invalidateSettingsCache(); };

  const place = (token = cur.token, extra: Record<string, unknown> = {}) =>
    request.post('/api/orders').set(H(token)).send({
      vendorId: VENDOR.vendorId, items: [{ itemId: dishA, quantity: 2 }, { itemId: dishB, quantity: 1 }], dropoffHostel: 'BH2', dropoffNotes: 'Room 214, call 9876501234', clientRequestId: randomUUID(), ...extra,
    });
  const pay = async (id: string, token = cur.token) => {
    const c = await request.post('/api/payments/create-order').set(H(token)).send({ orderId: id });
    expect(c.status).toBe(200);
    const v = await request.post('/api/payments/verify-signature').set(H(token)).send({ razorpayOrderId: c.body.razorpayOrderId, razorpayPaymentId: `pay_${randomUUID().slice(0, 12)}`, razorpaySignature: 'sim' });
    expect(v.status).toBe(200);
    return { rzp: c.body.razorpayOrderId as string, amountInPaise: c.body.amountInPaise as number };
  };
  const status = (id: string, st: string, token: string) => request.patch(`/api/orders/${id}/status`).set(H(token)).send({ status: st });

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    for (const u of [
      { id: VENDOR.id, name: 'PV Owner', phone: VENDOR.phone, role: Role.VENDOR },
      { id: OTHER_VENDOR.id, name: 'PV Owner Two', phone: OTHER_VENDOR.phone, role: Role.VENDOR },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    for (const v of [VENDOR, OTHER_VENDOR]) {
      await prisma.vendor.upsert({
        where: { id: v.vendorId }, update: { userId: v.id, approvalStatus: 'APPROVED', isAcceptingOrders: true },
        create: { id: v.vendorId, userId: v.id, name: `PV Kitchen ${v.vendorId.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '' },
      });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
    setPaymentProvider(createSimulatedProvider());
    await adminPut('fees', { baseFee: 37 });
    const mk = async (name: string, vendorPrice: number, commissionValue: number) =>
      (await request.post('/api/admin/catalog').set(H(tAdmin)).send({ vendorId: VENDOR.vendorId, name, vendorPrice, commissionType: 'PERCENT', commissionValue })).body.data;
    const a = await mk('Dish A', 100, 20);
    const b = await mk('Dish B', 33.33, 12.5);
    expect([a.price, b.price]).toEqual([120, 38]);
    dishA = a.id; dishB = b.id;
    await resetSettings();
  });

  beforeEach(async () => {
    sim = createSimulatedProvider();
    setPaymentProvider(sim);
    fake = new FakeProvider();
    setPushProvider(fake);
    __resetRateLimits();
    await resetSettings();
    await adminPut('fees', { baseFee: 37 });
    cur = await freshStudent();
    cur2 = await freshStudent();
    await prisma.pushLog.deleteMany({});
    await prisma.deviceToken.deleteMany({});
    await prisma.driverPartner.updateMany({ where: { userId: { not: RIDER.id } }, data: { dutyStatus: 'OFFLINE' } });
    await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
    await prisma.order.updateMany({ where: { driverId: RIDER.id, status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  });

  afterEach(async () => {
    await settle();
    while (sockets.length) disconnectTestSocket(sockets.pop()!);
    setPaymentProvider(null);
    __resetPushProvider();
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    const vids = [VENDOR.vendorId, OTHER_VENDOR.vendorId];
    await prisma.order.deleteMany({ where: { vendorId: { in: vids } } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: vids } } });
    await prisma.vendor.deleteMany({ where: { id: { in: vids } } });
    await prisma.deviceToken.deleteMany({});
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('order totals', () => {
    test('one all-in fee from the settings, the old separate Rs 15 is gone, coupons only lower the customer total', async () => {
      const r = await place(cur.token, { couponCode: 'vitfirst' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ subtotal: 278, deliveryFee: 37, taxAndPackaging: 0, discount: 50, totalAmount: 265, paymentStatus: 'PENDING' });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.id }, include: { items: { orderBy: { name: 'asc' } } } });
      expect(row).toMatchObject({ subtotal: 278, vendorSubtotal: 233.33, commissionTotal: 44.67, deliveryFee: 37, taxAndPackaging: 0, discount: 50, totalAmount: 265, couponCode: 'VITFIRST' });
      expect(row.feeBreakdown).toEqual({ version: 1, total: 37, baseFee: 37, baseWaived: false, smallOrderFee: 0, restaurants: 1, extraRestaurantFee: 0, extraRestaurants: 0, lines: [] });
      expect(row.items.map((i) => [i.name, i.quantity, i.price, i.vendorUnitPrice, i.commissionUnit])).toEqual([['Dish A', 2, 120, 100, 20], ['Dish B', 1, 38, 33.33, 4.67]]);
      // the money invariant in paise: customer total = food + fee - discount; food = restaurant + Kraveo's part
      const p = (n: number) => Math.round(n * 100);
      expect(p(row.totalAmount)).toBe(p(row.subtotal) + p(row.deliveryFee) + p(row.taxAndPackaging) - p(row.discount));
      expect(p(row.subtotal)).toBe(p(row.vendorSubtotal) + p(row.commissionTotal));
    });

    test('the default fee is Rs 25 all-in: a Rs 100 food order costs Rs 125', async () => {
      await resetSettings();
      const dish = (await request.post('/api/admin/catalog').set(H(tAdmin)).send({ vendorId: VENDOR.vendorId, name: 'Hundred', vendorPrice: 100 })).body.data;
      const r = await place(cur.token, { items: [{ itemId: dish.id, quantity: 1 }] });
      expect(r.body.data).toMatchObject({ subtotal: 100, deliveryFee: 25, taxAndPackaging: 0, discount: 0, totalAmount: 125 });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.id } });
      expect(row).toMatchObject({ vendorSubtotal: 100, commissionTotal: 0 });
    });

    test('free fee above a limit, small-order fee, and a fee changed later does not touch an order already placed', async () => {
      const first = await place(cur.token);
      expect(first.body.data).toMatchObject({ deliveryFee: 37, totalAmount: 315 });
      expect((await adminPut('fees', { baseFee: 37, freeFeeAbove: 250 })).status).toBe(200);
      const free = await place(cur.token, { clientRequestId: randomUUID() });
      expect(free.body.data).toMatchObject({ subtotal: 278, deliveryFee: 0, totalAmount: 278 });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: free.body.data.id } })).feeBreakdown).toMatchObject({ baseWaived: true, total: 0, lines: [] });
      expect((await adminPut('fees', { freeFeeAbove: 0, smallOrderBelow: 300, smallOrderFee: 9 })).status).toBe(200);
      const small = await place(cur.token, { clientRequestId: randomUUID() });
      expect(small.body.data).toMatchObject({ deliveryFee: 46, totalAmount: 324 });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: small.body.data.id } })).feeBreakdown).toMatchObject({ baseFee: 37, smallOrderFee: 9, total: 46 });
      // the first order is untouched by the later settings
      expect(await prisma.order.findUniqueOrThrow({ where: { id: first.body.data.id } })).toMatchObject({ deliveryFee: 37, totalAmount: 315 });
    });

    test('named fee lines are stored in the breakdown for the records; the customer still sees one amount', async () => {
      expect((await adminPut('fees', { baseFee: 37, lines: [{ key: 'delivery', label: 'Delivery', amount: 20 }, { key: 'gst', label: 'GST', amount: 7 }, { key: 'packing', label: 'Packaging', amount: 6 }, { key: 'service', label: 'Service', amount: 4 }] })).status).toBe(200);
      const r = await place();
      expect(r.body.data.deliveryFee).toBe(37);
      expect(keysIn(r.body.data).has('feeBreakdown')).toBe(false);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.id } });
      expect((row.feeBreakdown as any).lines.map((l: any) => [l.key, l.amount])).toEqual([['delivery', 20], ['gst', 7], ['packing', 6], ['service', 4]]);
    });

    test('payment amount, captured amount and refund are the customer total in paise; the restaurant part never decides money in or out', async () => {
      const placed = await place(cur.token, { couponCode: 'VITFIRST' });
      const id = placed.body.data.id;
      const paid = await pay(id);
      expect(paid.amountInPaise).toBe(26500);
      expect((await prisma.payment.findFirstOrThrow({ where: { orderId: id } })).capturedAmountPaise).toBe(26500);
      const cancel = await request.post(`/api/orders/${id}/cancel`).set(H(cur.token)).send({});
      expect(cancel.status).toBe(200);
      await settle();
      const refunds = [...sim.refunds.values()].flat();
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amountPaise).toBe(26500);
    });

    test('the second use of a single-use coupon is refused, and the failure changes no totals', async () => {
      const first = await place(cur2.token, { couponCode: 'VITFIRST' });
      expect(first.status).toBe(201);
      await pay(first.body.data.id, cur2.token); // an unpaid first checkout would be replaced by the next one and release the code
      const again = await place(cur2.token, { couponCode: 'VITFIRST', clientRequestId: randomUUID() });
      expect([again.status, again.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
    });
  });

  // =========================================================================================
  describe('who sees which numbers', () => {
    /** One full order driven through every state, with sockets for every role and push tokens for the restaurant. */
    const drive = async () => {
      await prisma.deviceToken.create({ data: { userId: VENDOR.id, token: 'tok_pv_vendor_AAAAAAAAAAAAAAAAAAAAAAAA', app: 'VENDOR' } });
      const vs = await connect(tVendor);
      const as = await connect(tAdmin);
      const cs = await connect(cur.token);
      const rs = await connect(tRider);
      const vLog = record(vs, ['order_updated', 'new_order_alert', 'order_available']);
      const aLog = record(as, ['order_updated', 'new_order_alert']);
      const cLog = record(cs, ['order_updated']);
      const rLog = record(rs, ['order_updated', 'order_available']);
      const placed = await place(cur.token, { couponCode: 'VITFIRST' });
      expect(placed.status).toBe(201);
      const id = placed.body.data.id as string;
      expect((await cs.emitWithAck('join_room', `order_${id}`)).ok).toBe(true);
      expect((await vs.emitWithAck('join_room', `order_${id}`)).ok).toBe(false); // unpaid: the restaurant cannot even join
      await pay(id);
      await settle();
      expect((await vs.emitWithAck('join_room', `order_${id}`)).ok).toBe(true);
      const rest: Record<string, any> = {};
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) { const r = await status(id, st, tVendor); expect(r.status).toBe(200); rest[st] = r.body; }
      await settle();
      expect((await request.post(`/api/orders/${id}/accept-driver`).set(H(tRider)).send({})).status).toBe(200);
      expect((await status(id, 'PICKED_UP', tRider)).status).toBe(200);
      expect((await status(id, 'ARRIVED_AT_GATE', tRider)).status).toBe(200);
      const otp = (await request.get(`/api/orders/${id}`).set(H(cur.token))).body.data.otpCode;
      expect((await request.post(`/api/orders/${id}/verify-gate-otp`).set(H(tRider)).send({ otp })).status).toBe(200);
      await settle();
      return { id, vLog, aLog, cLog, rLog, rest };
    };

    test('RESTAURANT: every REST response and every socket event and push text of a whole order carries only what it earns', async () => {
      const { id, vLog, rest } = await drive();

      // 1. REST: detail, lists (active and history), status responses
      const detail = await request.get(`/api/orders/${id}`).set(H(tVendor));
      expect(detail.status).toBe(200);
      assertVendorSafe(detail.body, 'GET /orders/:id');
      expect(detail.body.data).toMatchObject({ id, subtotal: 233.33, totalAmount: 233.33, status: 'DELIVERED' });
      expect(detail.body.data.items.map((i: any) => [i.name, i.quantity, i.price]).sort()).toEqual([['Dish A', 2, 100], ['Dish B', 1, 33.33]]);
      for (const scope of ['', '?scope=history', '?scope=active', '?limit=200']) {
        const list = await request.get(`/api/orders${scope}`).set(H(tVendor));
        expect(list.status).toBe(200);
        assertVendorSafe(list.body, `GET /orders${scope}`);
      }
      const mine = (await request.get('/api/orders?scope=history').set(H(tVendor))).body.data.find((o: any) => o.id === id);
      expect(mine).toMatchObject({ totalAmount: 233.33, subtotal: 233.33 });
      for (const [st, body] of Object.entries(rest)) { assertVendorSafe(body, `PATCH status ${st}`); expect(body.data).toMatchObject({ totalAmount: 233.33, subtotal: 233.33 }); }

      // 2. sockets: everything the restaurant's socket received
      expect(vLog.length).toBeGreaterThanOrEqual(5);
      expect(vLog.some((e) => e.event === 'new_order_alert')).toBe(true);
      for (const e of vLog) { assertVendorSafe(e.data, `socket ${e.event}`); }
      // the restaurant is never offered the rider pool
      expect(vLog.filter((e) => e.event === 'order_available')).toHaveLength(0);

      // 3. push text
      const vendorPushes = fake.sent.filter((m) => m.token.startsWith('tok_pv_vendor'));
      expect(vendorPushes.length).toBeGreaterThanOrEqual(1);
      const newOrder = vendorPushes.find((m) => m.data.event === 'NEW_ORDER')!;
      expect(newOrder.body).toBe('3 items - You earn Rs 233.33. Tap to accept.');
      for (const m of vendorPushes) assertVendorSafe({ title: m.title, body: m.body, data: m.data }, `push ${m.data.event}`);
    });

    test('RESTAURANT: the other restaurant, an unpaid order and every admin / payment endpoint give it nothing', async () => {
      const placed = await place(cur.token, { couponCode: 'VITFIRST' });
      const id = placed.body.data.id;
      // unpaid: invisible
      expect((await request.get(`/api/orders/${id}`).set(H(tVendor))).status).toBe(404);
      expect((await request.get('/api/orders').set(H(tVendor))).body.data.find((o: any) => o.id === id)).toBeUndefined();
      await pay(id);
      // another restaurant sees nothing of it
      expect((await request.get(`/api/orders/${id}`).set(H(tOtherVendor))).status).toBe(404);
      expect((await request.get('/api/orders').set(H(tOtherVendor))).body.data.find((o: any) => o.id === id)).toBeUndefined();
      // the endpoints that do carry customer money are closed to a restaurant
      const closed: [string, string, any?][] = [
        ['get', '/api/admin/orders/needs-attention'], ['get', '/api/admin/payments/reconcile'], ['get', '/api/admin/customers'], ['get', '/api/analytics'],
        ['get', '/api/admin/catalog'], ['get', '/api/admin/catalog/pending-count'], ['get', '/api/admin/settings'], ['get', '/api/admin/settings/fees'],
        ['put', '/api/admin/settings/fees', { baseFee: 1 }], ['patch', `/api/admin/vendors/${VENDOR.vendorId}/commission`, { type: 'FLAT', value: 0 }],
        ['post', '/api/admin/catalog/preview', { vendorId: VENDOR.vendorId, vendorPrice: 5 }], ['get', '/api/orders/available'],
        ['post', '/api/payments/create-order', { orderId: id }], ['post', `/api/admin/orders/${id}/cancel`, { reason: 'abc' }],
      ];
      for (const [m, p, b] of closed) {
        const r = await (request as any)[m](p).set(H(tVendor)).send(b ?? {});
        expect([m, p, r.status >= 400]).toEqual([m, p, true]);
        expect([m, p, [401, 403, 404].includes(r.status)]).toEqual([m, p, true]);
      }
      // and its own menu endpoints show its prices only (customers' prices of its dishes are not in them)
      for (const p of [`/api/vendors/${VENDOR.vendorId}/menu-manage`, `/api/menus/${VENDOR.vendorId}`, '/api/vendors', `/api/vendors/${VENDOR.vendorId}`]) {
        const r = await request.get(p).set(H(tVendor));
        expect([p, r.status]).toEqual([p, 200]);
        const nums = numbersIn(r.body).filter((n) => [120, 38].includes(n));
        expect([p, nums]).toEqual([p, []]);
      }
      // the restaurant rejects it: the response is still restaurant-safe
      const rej = await request.post(`/api/orders/${id}/reject`).set(H(tVendor)).send({ reason: 'Out of stock today' });
      expect(rej.status).toBe(200);
      assertVendorSafe(rej.body, 'POST reject');
      await settle();
    });

    test('ADMIN sees everything: customer money, restaurant part, commission, fee breakdown, coupon, per-item snapshots, over REST and sockets', async () => {
      const { id, aLog } = await drive();
      const admin = (await request.get(`/api/orders/${id}`).set(H(tAdmin))).body.data;
      expect(admin).toMatchObject({ subtotal: 278, deliveryFee: 37, taxAndPackaging: 0, discount: 50, totalAmount: 265, vendorSubtotal: 233.33, commissionTotal: 44.67, couponCode: 'VITFIRST' });
      expect(admin.feeBreakdown).toMatchObject({ total: 37, baseFee: 37 });
      expect(admin.items.map((i: any) => [i.name, i.price, i.vendorUnitPrice, i.commissionUnit]).sort()).toEqual([['Dish A', 120, 100, 20], ['Dish B', 38, 33.33, 4.67]]);
      expect(admin.payments).toHaveLength(1);
      const list = (await request.get(`/api/orders?vendorId=${VENDOR.vendorId}`).set(H(tAdmin))).body.data.find((o: any) => o.id === id);
      expect(list).toMatchObject({ vendorSubtotal: 233.33, commissionTotal: 44.67 });
      const last = aLog.filter((e) => e.event === 'order_updated').pop()!.data;
      expect(last).toMatchObject({ totalAmount: 265, vendorSubtotal: 233.33, commissionTotal: 44.67 });
    });

    test('CUSTOMER keeps the old shape: one fee line, taxAndPackaging 0, its own prices, and none of the restaurant-side fields', async () => {
      const { id, cLog } = await drive();
      const view = (await request.get(`/api/orders/${id}`).set(H(cur.token))).body.data;
      expect(view).toMatchObject({ subtotal: 278, deliveryFee: 37, taxAndPackaging: 0, discount: 50, totalAmount: 265 });
      expect(view.items.map((i: any) => [i.name, i.price]).sort()).toEqual([['Dish A', 120], ['Dish B', 38]]);
      for (const p of [view, ...cLog.map((e) => e.data), (await request.get('/api/orders').set(H(cur.token))).body.data]) {
        for (const k of ['vendorSubtotal', 'commissionTotal', 'feeBreakdown', 'vendorUnitPrice', 'commissionUnit', 'settlementId']) expect([k, keysIn(p).has(k)]).toEqual([k, false]);
      }
      expect(cLog.length).toBeGreaterThan(3);
      for (const e of cLog) expect(e.data).toMatchObject({ subtotal: 278, deliveryFee: 37, totalAmount: 265 });
      // dishes in the menu: customer price, no restaurant price
      const menu = (await request.get(`/api/menus/${VENDOR.vendorId}`)).body.data;
      expect(menu.filter((d: any) => d.name.startsWith('Dish ')).map((d: any) => [d.name, d.price]).sort()).toEqual([['Dish A', 120], ['Dish B', 38]]);
      for (const k of ['vendorPrice', 'commissionType', 'commissionValue', 'pendingVendorPrice', 'approvalStatus']) expect([k, keysIn(menu).has(k)]).toEqual([k, false]);
    });

    test('RIDER keeps the old shape (pool and own order) and gets no commission or restaurant-side fields', async () => {
      const placed = await place(cur.token, { couponCode: 'VITFIRST' });
      const id = placed.body.data.id;
      await pay(id);
      for (const st of ['ACCEPTED', 'PREPARING']) await status(id, st, tVendor);
      const pool = await request.get('/api/orders/available').set(H(tRider));
      const inPool = pool.body.data.find((o: any) => o.id === id);
      expect(inPool).toMatchObject({ subtotal: 278, deliveryFee: 37, taxAndPackaging: 0, totalAmount: 265 });
      await request.post(`/api/orders/${id}/accept-driver`).set(H(tRider)).send({});
      const own = (await request.get(`/api/orders/${id}`).set(H(tRider))).body.data;
      expect(own).toMatchObject({ subtotal: 278, deliveryFee: 37, totalAmount: 265 });
      for (const p of [inPool, own]) for (const k of ['vendorSubtotal', 'commissionTotal', 'feeBreakdown', 'vendorUnitPrice', 'commissionUnit', 'couponCode', 'payments']) expect([k, keysIn(p).has(k)]).toEqual([k, false]);
    });
  });

  // =========================================================================================
  describe('legacy data (what the migration backfills) behaves as before', () => {
    test('an old dish (vendorPrice = price, approved, no commission) is visible and orderable at its old price; an old order shows its old numbers to every role', async () => {
      await resetSettings(); // default fee, as production starts
      await prisma.menuItem.create({ data: { id: 'pv-legacy-dish', vendorId: VENDOR.vendorId, name: 'Legacy thali', price: 99.5, vendorPrice: 99.5, category: 'Old', description: '', imageUrl: '' } });
      expect((await request.get(`/api/menus/${VENDOR.vendorId}`)).body.data.find((d: any) => d.id === 'pv-legacy-dish').price).toBe(99.5);
      const r = await place(cur.token, { items: [{ itemId: 'pv-legacy-dish', quantity: 2 }] });
      expect(r.body.data).toMatchObject({ subtotal: 199, deliveryFee: 25, taxAndPackaging: 0, totalAmount: 224 });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.id } })).toMatchObject({ vendorSubtotal: 199, commissionTotal: 0 });

      // an order created before the change: old fee, old Rs 15 tax, backfilled restaurant part
      const old = await prisma.order.create({
        data: {
          customerId: cur.id, vendorId: VENDOR.vendorId, subtotal: 180, deliveryFee: 25, taxAndPackaging: 15, discount: 0, totalAmount: 220, vendorSubtotal: 180, dropoffHostel: 'BH2',
          status: 'DELIVERED', paymentStatus: 'PAID', paidAt: new Date(Date.now() - 3_600_000), deliveredAt: new Date(Date.now() - 1_800_000),
          items: { create: [{ name: 'Old thali', quantity: 1, price: 180, vendorUnitPrice: 180 }] },
        },
      });
      const cust = (await request.get(`/api/orders/${old.id}`).set(H(cur.token))).body.data;
      expect(cust).toMatchObject({ subtotal: 180, deliveryFee: 25, taxAndPackaging: 15, totalAmount: 220 });
      const ven = (await request.get(`/api/orders/${old.id}`).set(H(tVendor))).body.data;
      expect(ven).toMatchObject({ subtotal: 180, totalAmount: 180 });
      expect(ven.items[0].price).toBe(180);
      expect(keysIn(ven).has('taxAndPackaging')).toBe(false);
      expect((await request.get(`/api/orders/${old.id}`).set(H(tAdmin))).body.data).toMatchObject({ taxAndPackaging: 15, totalAmount: 220, vendorSubtotal: 180, commissionTotal: 0 });
    });

    test('rows written by code that does not know the new columns (restaurant part still 0) are read as "no commission", never as Rs 0 earned', async () => {
      const o = await prisma.order.create({
        data: {
          customerId: cur.id, vendorId: VENDOR.vendorId, subtotal: 150, deliveryFee: 25, taxAndPackaging: 15, totalAmount: 190, dropoffHostel: 'BH2', status: 'PREPARING', paymentStatus: 'PAID', paidAt: new Date(),
          items: { create: [{ name: 'Fixture', quantity: 1, price: 150 }] },
        },
      });
      const ven = (await request.get(`/api/orders/${o.id}`).set(H(tVendor))).body.data;
      expect(ven).toMatchObject({ subtotal: 150, totalAmount: 150 });
      expect(ven.items[0].price).toBe(150);
      assertVendorSafe(ven, 'legacy fixture');
    });
  });

  // =========================================================================================
  describe('the migration backfill', () => {
    test('20261009_pricing_catalog on legacy-shaped tables: every legacy row gets vendorPrice = price, APPROVED, vendorUnitPrice = price, vendorSubtotal = subtotal; updatedAt untouched; vendorPrice has no default', async () => {
      const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261009_pricing_catalog/migration.sql'), 'utf8');
      const statements = sql
        .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
        .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
      expect(statements.some((s) => /lock_timeout/.test(s))).toBe(true);
      const old = new Date('2026-09-01T10:00:00Z');
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS pv_mig CASCADE');
      await prisma.$executeRawUnsafe('CREATE SCHEMA pv_mig');
      try {
        const out = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL search_path TO pv_mig');
          await tx.$executeRawUnsafe('CREATE TABLE "Vendor" (id text primary key)');
          await tx.$executeRawUnsafe('CREATE TABLE "MenuItem" (id text primary key, "vendorId" text not null, name text not null, price double precision not null)');
          await tx.$executeRawUnsafe('CREATE TABLE "Order" (id text primary key, subtotal double precision not null default 0, "deliveryFee" double precision not null default 30, "taxAndPackaging" double precision not null default 0, "totalAmount" double precision not null, "updatedAt" timestamp(3) not null)');
          await tx.$executeRawUnsafe('CREATE TABLE "OrderItem" (id text primary key, "orderId" text not null, name text not null, price double precision not null)');
          await tx.$executeRawUnsafe(`INSERT INTO "Vendor" VALUES ('v1')`);
          await tx.$executeRawUnsafe(`INSERT INTO "MenuItem" VALUES ('m1','v1','Thali',180), ('m2','v1','Chai',12.5), ('m3','v1','Odd',33.33)`);
          await tx.$executeRawUnsafe(`INSERT INTO "Order" VALUES ('o1',180,25,15,220,'${old.toISOString()}'), ('o2',0,30,0,60,'${old.toISOString()}'), ('o3',99.5,25,15,139.5,'${old.toISOString()}')`);
          await tx.$executeRawUnsafe(`INSERT INTO "OrderItem" VALUES ('i1','o1','Thali',180), ('i2','o3','Odd',33.33)`);
          for (const stmt of statements) await tx.$executeRawUnsafe(stmt);
          const items = await tx.$queryRawUnsafe<any[]>('SELECT id, price, "vendorPrice", "approvalStatus"::text AS status, "commissionType", "commissionValue", "createdBy", "deletedAt", "pendingVendorPrice", "rejectionReason" FROM "MenuItem" ORDER BY id');
          const orders = await tx.$queryRawUnsafe<any[]>('SELECT id, subtotal, "vendorSubtotal", "commissionTotal", "feeBreakdown", "settlementId", "deliveryFee", "taxAndPackaging", "totalAmount", "updatedAt" FROM "Order" ORDER BY id');
          const oi = await tx.$queryRawUnsafe<any[]>('SELECT id, price, "vendorUnitPrice", "commissionUnit" FROM "OrderItem" ORDER BY id');
          const def = await tx.$queryRawUnsafe<any[]>(`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'pv_mig' AND table_name = 'MenuItem' AND column_name IN ('vendorPrice', 'approvalStatus')`);
          const vendor = await tx.$queryRawUnsafe<any[]>('SELECT * FROM "Vendor"');
          const setting = await tx.$queryRawUnsafe<any[]>('SELECT count(*)::int AS n FROM "AppSetting"');
          return { items, orders, oi, def, vendor, setting };
        });
        expect(out.items.map((i) => [i.id, i.price, i.vendorPrice, i.status, i.commissionType, i.commissionValue, i.createdBy, i.deletedAt, i.pendingVendorPrice, i.rejectionReason]))
          .toEqual([['m1', 180, 180, 'APPROVED', null, null, 'VENDOR', null, null, null], ['m2', 12.5, 12.5, 'APPROVED', null, null, 'VENDOR', null, null, null], ['m3', 33.33, 33.33, 'APPROVED', null, null, 'VENDOR', null, null, null]]);
        expect(out.orders.map((o) => [o.id, o.subtotal, o.vendorSubtotal, o.commissionTotal, o.feeBreakdown, o.settlementId, o.deliveryFee, o.taxAndPackaging, o.totalAmount]))
          .toEqual([['o1', 180, 180, 0, null, null, 25, 15, 220], ['o2', 0, 0, 0, null, null, 30, 0, 60], ['o3', 99.5, 99.5, 0, null, null, 25, 15, 139.5]]);
        expect(out.orders.every((o) => new Date(o.updatedAt).toISOString().slice(0, 19) === '2026-09-01T10:00:00')).toBe(true); // nobody sees an order as changed
        expect(out.oi.map((i) => [i.id, i.price, i.vendorUnitPrice, i.commissionUnit])).toEqual([['i1', 180, 180, 0], ['i2', 33.33, 33.33, 0]]);
        const vp = out.def.find((d) => d.column_name === 'vendorPrice');
        expect([vp.column_default, vp.is_nullable]).toEqual([null, 'NO']); // no default: a forgotten writer fails loudly
        expect(out.setting[0].n).toBe(0); // AppSetting created empty: defaults apply
      } finally {
        await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS pv_mig CASCADE');
      }
    });

    test('the real test database has the same shape: no default on MenuItem.vendorPrice, new enum, AppSetting table', async () => {
      const cols = await prisma.$queryRawUnsafe<any[]>(`SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'MenuItem' AND column_name IN ('vendorPrice', 'approvalStatus', 'createdBy')`);
      expect(Object.fromEntries(cols.map((c) => [c.column_name, c.column_default]))).toMatchObject({ vendorPrice: null });
      await expect(prisma.$executeRawUnsafe(`INSERT INTO "MenuItem" (id, "vendorId", name, price, category, description, "imageUrl") VALUES ('pv-bad', '${VENDOR.vendorId}', 'x', 1, 'c', '', '')`)).rejects.toThrow();
    });
  });
});
