/**
 * Multi-restaurant orders (Docs/22), part 1: settings, quote, placing, payment and refund of a combined order.
 * Real PostgreSQL, real HTTP endpoints, the payment provider replaced by a ledger around the in-memory simulator.
 * Invariants proved here: quote == charge, children add up to the group total in paise, ONE payment, ONE refund (siblings never carry
 * refundStatus), idempotent placing, abandoned checkouts replaced as whole groups, single-restaurant behaviour untouched.
 */
import { randomUUID } from 'crypto';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider, createSimulatedProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { invalidateSettingsCache } from '../../src/services/settings';
import { DEFAULT_SETTINGS } from '../../src/services/pricing';
import {
  World, Person, Customer, Vendor, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, cartOf, minutesFromNow,
} from '../harness/journey';

jest.setTimeout(120_000);

const paise = (n: number) => Math.round(n * 100);

describe('Order groups: settings, quote, place, pay, refund', () => {
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
  const setProvider = () => { ledger = createLedger(); setPaymentProvider(ledger.provider); };
  const setFees = async (patch: Record<string, unknown>) => {
    const value = { ...DEFAULT_SETTINGS.fees, ...patch };
    await prisma.appSetting.upsert({ where: { key: 'fees' }, update: { value: value as any }, create: { key: 'fees', value: value as any } });
    invalidateSettingsCache();
  };
  const children = (groupId: string) => prisma.order.findMany({ where: { groupId }, orderBy: { groupIndex: 'asc' }, include: { payments: true, items: true } });
  const rowOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const audit = (targetId: string, action: string) => prisma.adminAuditLog.count({ where: { targetId, action } });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + paise(b), 0);

  /** Places a group (201) and returns its GroupView. */
  const placeG = async (c: Customer, carts: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await api.placeGroup(c, carts, extra);
    expect([r.status, r.body.code]).toEqual([201, undefined]);
    return r.body.data;
  };
  /** createPayment on the primary + provider capture. `via`: how the money notification reaches the server. */
  const pay = async (c: Customer, primaryId: string, via: 'verify' | 'webhook' | 'none' = 'verify', payId = `pay_${randomUUID().slice(0, 12)}`) => {
    const cp = await api.createPayment(c, primaryId);
    expect(cp.status).toBe(200);
    const rzp = cp.body.razorpayOrderId as string;
    const amount = cp.body.amountInPaise as number;
    if (via === 'none') return { rzp, payId, amount };
    ledger.capture(rzp, payId, amount);
    if (via === 'verify') expect((await api.verify(c, rzp, payId)).status).toBe(200);
    else expect((await api.webhookCaptured(rzp, payId, amount)).status).toBe(200);
    return { rzp, payId, amount };
  };

  beforeAll(async () => {
    await cleanTestOrders();
    W = await createWorld('gp', '3', { customers: 3, vendors: 6, riders: 2 });
    // dishes with odd paise so rounding bugs cannot hide
    for (const v of W.vendors) {
      for (const [i, price] of [[3, 33.33], [4, 7.77], [5, 101.01]] as const) {
        await prisma.menuItem.create({ data: { id: `${v.vendorId}-i${i}`, vendorId: v.vendorId, name: `Odd ${price}`, price, vendorPrice: price, category: 'Test', description: 'd', imageUrl: '', isAvailable: true } });
        v.items.push({ id: `${v.vendorId}-i${i}`, price });
      }
    }
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    await prisma.appSetting.deleteMany({ where: { key: 'fees' } });
    invalidateSettingsCache();
    await prisma.user.updateMany({ where: { id: { startsWith: 'gp-' } }, data: { kraveo20Redeemed: 0 } });
    setProvider();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    for (const w of watchers) w.disconnect();
    watchers = [];
    setPaymentProvider(null);
    delete process.env.RL_ORDER_QUOTE_MAX;
    delete process.env.RL_ORDER_GROUP_CREATE_MAX;
    expect(api.calls.filter((c) => c.status >= 500)).toEqual([]); // never a 5xx, whatever a test does on purpose
  });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'fees' } });
    invalidateSettingsCache();
    await stopTestServer(server);
    await purgeWorld('gp');
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('settings', () => {
    test('GET shows maxRestaurantsPerOrder 3 by default; PUT validates 1..5 and extraRestaurantFee 0..200', async () => {
      const get = await api.raw('admin', 'get', '/api/admin/settings/fees', W.admin.token);
      expect(get.body.data.value).toMatchObject({ maxRestaurantsPerOrder: 3, extraRestaurantFee: 15 });
      const put = (body: object) => api.raw('admin', 'put', '/api/admin/settings/fees', W.admin.token, body);
      for (const v of [0, 6, 2.5, '3', null]) expect([(await put({ maxRestaurantsPerOrder: v })).status, v]).toEqual([400, v]);
      expect((await put({ maxRestaurantsPerOrder: 5 })).body.data.value.maxRestaurantsPerOrder).toBe(5);
      expect((await put({ maxRestaurantsPerOrder: 1 })).status).toBe(200);
      expect((await put({ extraRestaurantFee: 201 })).status).toBe(400);
      expect((await put({ extraRestaurantFee: 200 })).status).toBe(200);
      expect((await put({ extraRestaurantFee: 0 })).status).toBe(200);
      expect((await put({ extraRestaurantFee: -1 })).status).toBe(400);
      expect(await prisma.adminAuditLog.count({ where: { action: 'SETTINGS_UPDATED', summary: { contains: 'maxRestaurantsPerOrder' } } })).toBeGreaterThan(0);
    });

    test('a fees row stored before Docs/22 (no maxRestaurantsPerOrder) is read as 3 and keeps working', async () => {
      const { maxRestaurantsPerOrder: _x, ...old } = DEFAULT_SETTINGS.fees;
      await prisma.appSetting.upsert({ where: { key: 'fees' }, update: { value: old as any }, create: { key: 'fees', value: old as any } });
      invalidateSettingsCache();
      const q = await api.quote(W.customers[0], [cartOf(W.vendors[0]), cartOf(W.vendors[1]), cartOf(W.vendors[2])]);
      expect(q.status).toBe(200);
      expect(q.body.data.maxRestaurants).toBe(3);
      expect((await api.quote(W.customers[0], [0, 1, 2, 3].map((i) => cartOf(W.vendors[i])))).body.code).toBe('TOO_MANY_RESTAURANTS');
    });

    test('max 1 switches combined orders off (MULTI_DISABLED), a single-restaurant quote and order still work; max 2 refuses a third restaurant', async () => {
      const c = W.customers[0];
      await setFees({ maxRestaurantsPerOrder: 1 });
      const two = [cartOf(W.vendors[0]), cartOf(W.vendors[1])];
      expect(await api.quote(c, two).then((r) => [r.status, r.body.code])).toEqual([400, 'MULTI_DISABLED']);
      expect(await api.placeGroup(c, two).then((r) => [r.status, r.body.code])).toEqual([400, 'MULTI_DISABLED']);
      expect((await api.quote(c, [cartOf(W.vendors[0])])).body.data).toMatchObject({ restaurantCount: 1, maxRestaurants: 1, total: 205 });
      expect((await api.place(c, W.vendors[0])).status).toBe(201);
      await setFees({ maxRestaurantsPerOrder: 2 });
      const three = [0, 1, 2].map((i) => cartOf(W.vendors[i]));
      expect(await api.placeGroup(c, three).then((r) => [r.status, r.body.code, r.body.maxRestaurants])).toEqual([400, 'TOO_MANY_RESTAURANTS', 2]);
      expect(await api.quote(c, three).then((r) => [r.status, r.body.code])).toEqual([400, 'TOO_MANY_RESTAURANTS']);
      expect((await api.placeGroup(c, [cartOf(W.vendors[3]), cartOf(W.vendors[4])])).status).toBe(201);
    });
  });

  // =========================================================================================
  describe('quote', () => {
    test('shape and numbers for 1, 2 and 3 restaurants; nothing is written', async () => {
      const c = W.customers[0];
      const [v1, v2, v3] = W.vendors;
      const before = [await prisma.order.count(), await prisma.orderGroup.count(), await prisma.payment.count()];
      const one = await api.quote(c, [cartOf(v1)]);
      expect(one.status).toBe(200);
      expect(one.body).toEqual({
        success: true,
        data: {
          restaurantCount: 1, subtotal: 180,
          fees: { total: 25, base: 25, baseWaived: false, extraRestaurants: 0, extraRestaurantFee: 15, extraTotal: 0 },
          discount: 0, couponCode: null, total: 205,
          perRestaurant: [{ vendorId: v1.vendorId, vendorName: 'Kitchen 1', subtotal: 180, fee: 25 }],
          maxRestaurants: 3,
        },
      });
      const three = await api.quote(c, [cartOf(v1, [[0, 1]]), cartOf(v2, [[1, 2]]), cartOf(v3, [[1, 1]])]);
      expect(three.body.data).toEqual({
        restaurantCount: 3, subtotal: 450,
        fees: { total: 55, base: 25, baseWaived: false, extraRestaurants: 2, extraRestaurantFee: 15, extraTotal: 30 },
        discount: 0, couponCode: null, total: 505,
        perRestaurant: [
          { vendorId: v1.vendorId, vendorName: 'Kitchen 1', subtotal: 180, fee: 25 },
          { vendorId: v2.vendorId, vendorName: 'Kitchen 2', subtotal: 180, fee: 15 },
          { vendorId: v3.vendorId, vendorName: 'Kitchen 3', subtotal: 90, fee: 15 },
        ],
        maxRestaurants: 3,
      });
      expect([await prisma.order.count(), await prisma.orderGroup.count(), await prisma.payment.count()]).toEqual(before);
    });

    test('free-fee and small-order rules use the COMBINED subtotal; the coupon minimum too', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      await setFees({ freeFeeAbove: 300 });
      // 90 + 90 = 180 < 300 -> fee; 180 + 180 = 360 >= 300 -> base waived although no single restaurant reaches 300
      expect((await api.quote(c, [cartOf(v1, [[1, 1]]), cartOf(v2, [[1, 1]])])).body.data.fees).toMatchObject({ total: 40, base: 25, baseWaived: false });
      const free = (await api.quote(c, [cartOf(v1), cartOf(v2)])).body.data;
      expect(free.fees).toMatchObject({ total: 15, base: 0, baseWaived: true, extraRestaurants: 1 });
      expect(free).toMatchObject({ total: 375, perRestaurant: [{ fee: 0 }, { fee: 15 }] });
      await setFees({ smallOrderBelow: 200, smallOrderFee: 10 });
      expect((await api.quote(c, [cartOf(v1, [[1, 1]]), cartOf(v2, [[1, 1]])])).body.data).toMatchObject({ fees: { total: 50, base: 35 }, total: 230 });
      await setFees({});
      // KRAVEO50 needs 150: neither 90 alone reaches it, 180 combined does
      const lone = await api.quote(c, [cartOf(v1, [[1, 1]])], 'KRAVEO50');
      expect([lone.status, lone.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      const both = await api.quote(c, [cartOf(v1, [[1, 1]]), cartOf(v2, [[1, 1]])], 'kraveo50');
      expect(both.body.data).toMatchObject({ discount: 50, couponCode: 'KRAVEO50', total: 180 + 40 - 50 });
    });

    test('same validation as placing: closed or unapproved restaurant, bad items, bad coupon, duplicates, shape errors; students only', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      const q = (restaurants: unknown, coupon?: string) => api.quote(c, restaurants, coupon).then((r) => [r.status, r.body.code ?? null]);
      expect(await q([cartOf(v1), cartOf(v1)])).toEqual([400, 'DUPLICATE_RESTAURANT']);
      expect(await q([])).toEqual([400, 'BAD_REQUEST']);
      expect(await q('nope')).toEqual([400, 'BAD_REQUEST']);
      expect(await q([{ vendorId: v1.vendorId, items: [] }])).toEqual([400, 'BAD_REQUEST']);
      expect(await q([{ vendorId: v1.vendorId, items: [{ itemId: 'nope', quantity: 1 }] }])).toEqual([400, 'INVALID_ITEMS']);
      expect(await q([{ vendorId: v1.vendorId, items: [{ itemId: v1.items[0].id, quantity: 0 }] }])).toEqual([400, 'INVALID_ITEMS']);
      expect(await q([cartOf(v1), { vendorId: v2.vendorId, items: [{ itemId: v1.items[0].id, quantity: 1 }] }])).toEqual([400, 'INVALID_ITEMS']); // another restaurant's dish
      expect(await q([cartOf(v1)], 'NOPE')).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect(await q(Array.from({ length: 11 }, (_, i) => ({ vendorId: `x${i}`, items: [{ itemId: 'a', quantity: 1 }] })))).toEqual([400, 'TOO_MANY_RESTAURANTS']);
      expect(await q([{ vendorId: 'nope-id', items: [{ itemId: 'a', quantity: 1 }] }])).toEqual([400, 'VENDOR_UNAVAILABLE']);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { isAcceptingOrders: false } });
      expect(await q([cartOf(v1), cartOf(v2)])).toEqual([400, 'VENDOR_CLOSED']);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { isAcceptingOrders: true, approvalStatus: 'SUSPENDED' } });
      expect(await q([cartOf(v1), cartOf(v2)])).toEqual([400, 'VENDOR_UNAVAILABLE']);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { approvalStatus: 'APPROVED' } });
      await prisma.menuItem.update({ where: { id: v1.items[1].id }, data: { isAvailable: false } });
      expect(await q([cartOf(v1, [[1, 1]]), cartOf(v2)])).toEqual([400, 'INVALID_ITEMS']);
      // roles and auth
      expect((await api.raw('v', 'post', '/api/orders/quote', v1.token, { restaurants: [cartOf(v1)] })).status).toBe(403);
      expect((await api.raw('anon', 'post', '/api/orders/quote', null, { restaurants: [cartOf(v1)] })).status).toBe(401);
      expect((await api.raw('d', 'post', '/api/orders/quote', W.riders[0].token, { restaurants: [cartOf(v1)] })).status).toBe(403);
      expect((await api.raw('c', 'post', '/api/orders/quote', c.token, { restaurants: [cartOf(v1)], couponCode: 5 })).status).toBe(400);
    });

    test('coupon eligibility is reported for THIS customer (VITFIRST only for a first order, single use)', async () => {
      const [c1, c2] = W.customers;
      const [v1, v2] = W.vendors;
      expect((await api.quote(c1, [cartOf(v1), cartOf(v2)], 'VITFIRST')).body.data).toMatchObject({ couponCode: 'VITFIRST', discount: 50 }); // 20% of 360 = 72 -> max 50
      expect((await api.place(c1, v1)).status).toBe(201); // c1 now has an order
      const r = await api.quote(c1, [cartOf(v1), cartOf(v2)], 'VITFIRST');
      expect([r.status, r.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect((await api.quote(c2, [cartOf(v1), cartOf(v2)], 'VITFIRST')).status).toBe(200);
    });

    test('rate limited (ORDER_QUOTE)', async () => {
      process.env.RL_ORDER_QUOTE_MAX = '3';
      const c = W.customers[2];
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await api.quote(c, [cartOf(W.vendors[0])])).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });

    test('PROPERTY: random carts over 1..5 restaurants (odd paise prices, coupons): quote == placed total == group view == Razorpay amount == sum of the children', async () => {
      let seed = 99;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const c = W.customers[0];
      await setFees({ maxRestaurantsPerOrder: 5, extraRestaurantFee: 12.34, baseFee: 27.5, freeFeeAbove: 400, smallOrderBelow: 120, smallOrderFee: 6.25 });
      let accepted = 0;
      for (let k = 0; k < 24; k++) {
        const n = 2 + Math.floor(rnd() * 4);
        const picked = [...W.vendors].sort(() => rnd() - 0.5).slice(0, n);
        const carts = picked.map((v) => cartOf(v, [[Math.floor(rnd() * 5), 1 + Math.floor(rnd() * 3)], ...(rnd() < 0.5 ? [[Math.floor(rnd() * 5), 1] as [number, number]] : [])].filter((l, i, a) => a.findIndex((x) => x[0] === l[0]) === i) as [number, number][]));
        const coupon = ['', 'KRAVEO50', 'VITFIRST', 'NOPE'][Math.floor(rnd() * 4)];
        const q = await api.quote(c, carts, coupon || undefined);
        const placed = await api.placeGroup(c, carts, coupon ? { couponCode: coupon } : {});
        if (q.status !== 200) { // the same cart is refused identically when placing
          expect([placed.status, placed.body.code]).toEqual([q.status, q.body.code]);
          continue;
        }
        expect(placed.status).toBe(201);
        accepted += 1;
        const g = placed.body.data;
        expect(g.total).toBe(q.body.data.total);
        expect(g.discount).toBe(q.body.data.discount);
        expect(g.feeTotal).toBe(q.body.data.fees.total);
        expect(g.subtotal).toBe(q.body.data.subtotal);
        const kids = await children(g.id);
        expect(sum(kids.map((o) => o.totalAmount))).toBe(paise(g.total));
        expect(sum(kids.map((o) => o.subtotal))).toBe(paise(g.subtotal));
        expect(sum(kids.map((o) => o.deliveryFee))).toBe(paise(g.feeTotal));
        expect(sum(kids.map((o) => o.discount))).toBe(paise(g.discount));
        expect(kids.map((o) => o.deliveryFee)).toEqual(q.body.data.perRestaurant.map((p: any) => p.fee));
        for (const o of kids) expect(paise(o.totalAmount)).toBe(paise(o.subtotal) + paise(o.deliveryFee) - paise(o.discount));
        expect(kids.map((o) => o.couponCode)).toEqual(kids.map((_, i) => (i === 0 ? q.body.data.couponCode : null)));
        const cp = await api.createPayment(c, g.payOrderId);
        expect(cp.body.amountInPaise).toBe(paise(g.total));
        expect(paise((await prisma.payment.findFirstOrThrow({ where: { orderId: g.payOrderId } })).amount)).toBe(paise(g.total));
        // free the customer's unpaid slots / single-use coupon again
        expect((await api.cancel(c, g.payOrderId)).status).toBe(200);
      }
      expect(accepted).toBeGreaterThanOrEqual(10); // most random carts are valid: the property really ran
    });
  });

  // =========================================================================================
  describe('placing a group', () => {
    test('201 GroupView: money split, ids, per-child fee rules, coupon only on child 0, customer view of the children', async () => {
      const c = W.customers[0];
      const [v1, v2, v3] = W.vendors;
      const r = await api.placeGroup(c, [cartOf(v1, [[0, 1]]), cartOf(v2, [[1, 2]]), cartOf(v3, [[0, 1], [1, 1]])], { couponCode: 'KRAVEO50', dropoffNotes: 'near the gate' });
      expect(r.status).toBe(201);
      const g = r.body.data;
      expect(r.body).toMatchObject({ success: true, idempotentReplay: false });
      expect(g).toMatchObject({
        status: 'AWAITING_RESTAURANTS', paymentStatus: 'PENDING', subtotal: 630, feeTotal: 55, discount: 50, total: 635, couponCode: 'KRAVEO50',
        restaurantCount: 3, dropoffHostel: 'BH2', dropoffNotes: 'near the gate',
      });
      expect(g.payOrderId).toBe(g.orders[0].id);
      expect(g.orders.map((o: any) => o.vendor.id)).toEqual([v1.vendorId, v2.vendorId, v3.vendorId]); // groupIndex order = request order
      expect(g.orders.map((o: any) => o.deliveryFee)).toEqual([25, 15, 15]);
      expect(g.orders.map((o: any) => o.subtotal)).toEqual([180, 180, 270]);
      expect(g.orders.map((o: any) => o.discount)).toEqual([14.29, 14.28, 21.43]); // 50.00 over 630: 14.2857 / 14.2857 / 21.4286 -> floors 14.28 / 14.28 / 21.42, the 2 leftover paise go to the largest remainders (third, then first)
      expect(g.orders.map((o: any) => o.totalAmount)).toEqual([190.71, 180.72, 263.57]);
      expect(sum(g.orders.map((o: any) => o.totalAmount))).toBe(paise(635));
      for (const o of g.orders) expect(o).toMatchObject({ status: 'PLACED', paymentStatus: 'PENDING', taxAndPackaging: 0, dropoffHostel: 'BH2', otpCode: null });
      // customer sees the group on every child
      g.orders.forEach((o: any, i: number) => {
        expect(o.group).toMatchObject({ id: g.id, index: i, size: 3, primary: i === 0 });
        expect(o.group.stops).toHaveLength(3);
        expect(o.group.stops.map((s: any) => s.orderId)).toEqual(g.orders.map((x: any) => x.id));
        expect(o.group.stops[0]).toMatchObject({ index: 0, status: 'PLACED', vendor: { name: 'Kitchen 1', address: 'Gate 1' }, itemCount: 1 });
        expect(o.group.stops[2].itemCount).toBe(2);
      });
      // database
      const group = await prisma.orderGroup.findUniqueOrThrow({ where: { id: g.id } });
      expect(group).toMatchObject({ customerId: c.id, restaurantCount: 3, couponCode: 'KRAVEO50', subtotal: 630, feeTotal: 55, discount: 50, totalAmount: 635 });
      const kids = await children(g.id);
      expect(kids.map((o) => o.groupIndex)).toEqual([0, 1, 2]);
      expect(kids.map((o) => o.clientRequestId)).toEqual([0, 1, 2].map((i) => `g:${group.clientRequestId}:${i}`));
      expect(kids.map((o) => o.couponCode)).toEqual(['KRAVEO50', null, null]);
      for (const o of kids) {
        expect(o.items.reduce((s, i) => s + i.price * i.quantity, 0)).toBeCloseTo(o.subtotal, 5);
        expect(o.vendorSubtotal).toBe(o.subtotal); // no commission configured
        expect(o.commissionTotal).toBe(0);
        expect(o.groupId).toBe(g.id);
      }
      // readable by owner and admin, not by others (404, no leak); restaurants and riders do not see an unpaid order or its group
      expect((await api.getGroup(c, g.id)).body.data.id).toBe(g.id);
      expect((await api.getGroup(W.admin, g.id)).body.data.orders).toHaveLength(3);
      for (const p of [W.customers[1], v1, W.riders[0]]) expect((await api.getGroup(p, g.id)).status).toBe(404);
      expect((await api.getGroup(c, 'does-not-exist')).status).toBe(404);
      expect((await api.getGroup(c, 'bad id!')).status).toBe(400);
      expect((await api.raw('anon', 'get', `/api/order-groups/${g.id}`, null)).status).toBe(401);
      expect((await api.list(v1)).body.data).toEqual([]);
    });

    test('validation: one restaurant, duplicates, drop point, notes, coupon, clientRequestId, items, closed/unapproved restaurants, roles', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      const p = (restaurants: unknown, extra: Record<string, unknown> = {}) => api.placeGroup(c, restaurants, extra).then((r) => [r.status, r.body.code ?? null, r.body.field ?? null]);
      expect(await p([cartOf(v1)])).toEqual([400, 'USE_SINGLE_ORDER', 'restaurants']);
      expect(await p([cartOf(v1), cartOf(v1)])).toEqual([400, 'DUPLICATE_RESTAURANT', 'restaurants']);
      expect(await p([cartOf(v1), cartOf(v2)], { dropoffHostel: 'Moon Base' })).toEqual([400, 'BAD_REQUEST', 'dropoffHostel']);
      expect(await p([cartOf(v1), cartOf(v2)], { dropoffNotes: 'x'.repeat(301) })).toEqual([400, 'BAD_REQUEST', 'dropoffNotes']);
      expect(await p([cartOf(v1), cartOf(v2)], { couponCode: 'N'.repeat(31) })).toEqual([400, 'BAD_REQUEST', 'couponCode']);
      expect(await p([cartOf(v1), cartOf(v2)], { couponCode: 'NOPE' })).toEqual([400, 'COUPON_NOT_APPLICABLE', 'couponCode']);
      expect(await p([cartOf(v1), cartOf(v2)], { clientRequestId: undefined })).toEqual([400, 'BAD_REQUEST', 'clientRequestId']);
      expect(await p([cartOf(v1), cartOf(v2)], { clientRequestId: 'short' })).toEqual([400, 'BAD_REQUEST', 'clientRequestId']);
      expect(await p([cartOf(v1), { vendorId: v2.vendorId, items: [{ itemId: v2.items[0].id, quantity: 21 }] }])).toEqual([400, 'INVALID_ITEMS', 'items']);
      expect(await p([cartOf(v1), { vendorId: v2.vendorId, items: [{ itemId: v1.items[0].id, quantity: 1 }] }])).toEqual([400, 'INVALID_ITEMS', 'items']);
      expect(await p([cartOf(v1), { vendorId: v2.vendorId, items: [] }])).toEqual([400, 'BAD_REQUEST', 'items']);
      expect(await p([cartOf(v1), 5])).toEqual([400, 'BAD_REQUEST', 'restaurants']);
      expect(await p([cartOf(v1), { vendorId: 'a b', items: [{ itemId: 'x', quantity: 1 }] }])).toEqual([400, 'BAD_REQUEST', 'restaurants']);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { isAcceptingOrders: false } });
      expect(await p([cartOf(v1), cartOf(v2)])).toEqual([400, 'VENDOR_CLOSED', null]);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { isAcceptingOrders: true, approvalStatus: 'PENDING' } });
      expect(await p([cartOf(v1), cartOf(v2)])).toEqual([400, 'VENDOR_UNAVAILABLE', null]);
      expect(await prisma.orderGroup.count({ where: { customerId: c.id } })).toBe(0);
      expect((await api.raw('v', 'post', '/api/order-groups', v1.token, { restaurants: [cartOf(v1), cartOf(v2)] })).status).toBe(403);
      expect((await api.raw('d', 'post', '/api/order-groups', W.riders[0].token, {})).status).toBe(403);
      expect((await api.raw('anon', 'post', '/api/order-groups', null, {})).status).toBe(401);
      await prisma.vendor.update({ where: { id: v2.vendorId }, data: { approvalStatus: 'APPROVED' } });
      // legacy spellings of a drop point are canonicalised like for single orders
      expect((await api.placeGroup(c, [cartOf(v1), cartOf(v2)], { dropoffHostel: 'boys hostel block 3' })).body.data.dropoffHostel).toBe('BH3');
    });

    test('idempotent by clientRequestId: same cart = 200 replay (same ids), different content = 409 CLIENT_REQUEST_MISMATCH, concurrent duplicates make one group', async () => {
      const c = W.customers[0];
      const [v1, v2, v3] = W.vendors;
      const id = randomUUID();
      const first = await api.placeGroup(c, [cartOf(v1), cartOf(v2, [[1, 2]])], { clientRequestId: id });
      expect(first.status).toBe(201);
      const again = await api.placeGroup(c, [cartOf(v2, [[1, 2]]), cartOf(v1)], { clientRequestId: id }); // order of restaurants does not matter
      expect([again.status, again.body.idempotentReplay]).toEqual([200, true]);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(again.body.data.orders.map((o: any) => o.id).sort()).toEqual(first.body.data.orders.map((o: any) => o.id).sort());
      const mismatches: [unknown[], Record<string, unknown>][] = [
        [[cartOf(v1), cartOf(v2, [[1, 3]])], {}], // quantity
        [[cartOf(v1), cartOf(v3, [[1, 2]])], {}], // other restaurant
        [[cartOf(v1), cartOf(v2, [[0, 2]])], {}], // other dish
        [[cartOf(v1), cartOf(v2, [[1, 2]]), cartOf(v3)], {}], // extra restaurant
        [[cartOf(v1), cartOf(v2, [[1, 2]])], { dropoffHostel: 'BH5' }],
        [[cartOf(v1), cartOf(v2, [[1, 2]])], { dropoffNotes: 'other' }],
        [[cartOf(v1), cartOf(v2, [[1, 2]])], { couponCode: 'KRAVEO50' }],
      ];
      for (const [carts, extra] of mismatches) {
        const m = await api.placeGroup(c, carts, { clientRequestId: id, ...extra });
        expect([m.status, m.body.code]).toEqual([409, 'CLIENT_REQUEST_MISMATCH']);
      }
      expect(await prisma.orderGroup.count({ where: { customerId: c.id } })).toBe(1);
      // the same id as a SINGLE order is another namespace and cannot clash with the derived child ids
      expect((await api.place(c, v3, { clientRequestId: id })).status).toBe(201);
      // concurrent identical requests
      const id2 = randomUUID();
      const carts = [cartOf(W.vendors[3]), cartOf(W.vendors[4])];
      const rs = await Promise.all(Array.from({ length: 4 }, () => api.placeGroup(c, carts, { clientRequestId: id2 })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
      expect(await prisma.orderGroup.count({ where: { clientRequestId: id2 } })).toBe(1);
      expect(await prisma.order.count({ where: { groupId: rs[0].body.data.id } })).toBe(2);
    });

    test('the unpaid-orders limit counts a combined order as ONE', async () => {
      const c = W.customers[0];
      const [v1, v2, v3, v4, v5, v6] = W.vendors;
      // checkouts with a payment in flight are never "abandoned" (a fresh Razorpay order), so they stay open
      const g1 = await placeG(c, [cartOf(v1), cartOf(v2)]);
      await api.createPayment(c, g1.payOrderId);
      const g2 = await placeG(c, [cartOf(v3), cartOf(v4)]);
      await api.createPayment(c, g2.payOrderId);
      const s = await api.place(c, v5);
      expect(s.status).toBe(201); // 2 groups (4 child orders) + 1 single = 3 open unpaid checkouts, not 5
      await api.createPayment(c, s.body.data.id);
      const four = await api.placeGroup(c, [cartOf(v6), cartOf(v1)]); // v1 has an open (protected) checkout: not replaced -> limit hit
      expect([four.status, four.body.code]).toEqual([429, 'TOO_MANY_UNPAID_ORDERS']);
      const single = await api.place(c, v6);
      expect([single.status, single.body.code]).toEqual([429, 'TOO_MANY_UNPAID_ORDERS']);
      // cancelling the first group (any child, one call) frees ONE slot
      expect((await api.cancel(c, g1.orders[1].id)).status).toBe(200);
      expect((await api.place(c, v6)).status).toBe(201);
    });

    test('a new checkout replaces the customer\'s abandoned unpaid checkouts at the same restaurants: single orders and WHOLE groups', async () => {
      const c = W.customers[0];
      const [v1, v2, v3] = W.vendors;
      const old = await placeG(c, [cartOf(v1), cartOf(v2)]);
      const bystander = await api.place(W.customers[1], v1); // another customer's order is never touched
      const fresh = await placeG(c, [cartOf(v2), cartOf(v3)]); // overlaps at v2 only
      const oldRows = await children(old.id);
      expect(oldRows.map((o) => [o.status, o.cancelledBy])).toEqual([['CANCELLED', 'SYSTEM'], ['CANCELLED', 'SYSTEM']]); // v1's part went with it
      expect(oldRows.map((o) => o.cancelReason)).toEqual(expect.arrayContaining(['Replaced by a newer order', 'Another restaurant in your order could not take it']));
      expect(oldRows.every((o) => o.paymentStatus === 'PENDING' && o.refundStatus === null)).toBe(true);
      expect((await rowOf(bystander.body.data.id)).status).toBe('PLACED');
      expect((await children(fresh.id)).every((o) => o.status === 'PLACED')).toBe(true);
      expect(await audit(old.id, 'ORDER_GROUP_CANCELLED')).toBe(1);
      // a single order at a restaurant of an abandoned group replaces that group too
      const single = await api.place(c, v3);
      expect(single.status).toBe(201);
      expect((await children(fresh.id)).every((o) => o.status === 'CANCELLED')).toBe(true);
      // a checkout with a payment in flight is NOT abandoned
      const protectedG = await placeG(c, [cartOf(v1), cartOf(v2)]);
      await api.createPayment(c, protectedG.payOrderId);
      const next = await placeG(c, [cartOf(v1), cartOf(v3)]);
      expect((await children(protectedG.id)).every((o) => o.status === 'PLACED')).toBe(true);
      expect(next.id).not.toBe(protectedG.id);
    });

    test('coupons: single use per customer through the group (child 0 holds the code), a cancelled group releases it, VITFIRST only for a first order', async () => {
      const c = W.customers[0];
      const [v1, v2, v3, v4] = W.vendors;
      const g1 = await placeG(c, [cartOf(v1), cartOf(v2)], { couponCode: 'KRAVEO50' });
      expect(g1.couponCode).toBe('KRAVEO50');
      expect(await prisma.order.count({ where: { customerId: c.id, couponCode: 'KRAVEO50' } })).toBe(1); // counted once
      const used = await api.placeGroup(c, [cartOf(v3), cartOf(v4)], { couponCode: 'KRAVEO50' });
      expect([used.status, used.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect(used.body.message).toContain('already used');
      expect((await api.cancel(c, g1.payOrderId)).status).toBe(200);
      expect((await api.placeGroup(c, [cartOf(v3), cartOf(v4)], { couponCode: 'KRAVEO50' })).status).toBe(201);
      // VITFIRST: refused when the customer has any earlier non-cancelled order, even inside the same account's single orders
      const c2 = W.customers[1];
      expect((await api.place(c2, v1)).status).toBe(201);
      const vit = await api.placeGroup(c2, [cartOf(v3), cartOf(v4)], { couponCode: 'VITFIRST' });
      expect([vit.status, vit.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      // KRAVEO20 needs a coin redemption
      const k20 = await api.placeGroup(W.customers[2], [cartOf(v1), cartOf(v2)], { couponCode: 'KRAVEO20' });
      expect([k20.status, k20.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      await prisma.user.update({ where: { id: W.customers[2].id }, data: { kraveo20Redeemed: 1 } });
      expect((await api.placeGroup(W.customers[2], [cartOf(v1), cartOf(v2)], { couponCode: 'KRAVEO20' })).body.data.discount).toBe(20);
    });

    test('GET /order-groups lists the owner\'s groups (active / history, newest first, cursor); an old single order stays a single order', async () => {
      const c = W.customers[0];
      const [v1, v2, v3, v4] = W.vendors;
      const a = await placeG(c, [cartOf(v1), cartOf(v2)]);
      await api.createPayment(c, a.payOrderId);
      const b = await placeG(c, [cartOf(v3), cartOf(v4)]);
      await api.cancel(c, b.payOrderId);
      const active = await api.listGroups(c, '?scope=active');
      expect(active.body.data.map((g: any) => g.id)).toEqual([b.id, a.id]); // the cancelled one finished just now
      await prisma.order.updateMany({ where: { groupId: b.id }, data: { cancelledAt: minutesFromNow(-30) } });
      expect((await api.listGroups(c, '?scope=active')).body.data.map((g: any) => g.id)).toEqual([a.id]);
      expect((await api.listGroups(c, '?scope=history')).body.data.map((g: any) => g.id)).toEqual([b.id]);
      const page1 = await api.listGroups(c, '?limit=1');
      expect(page1.body).toMatchObject({ count: 1, nextCursor: expect.any(String) });
      const page2 = await api.listGroups(c, `?limit=1&cursor=${page1.body.nextCursor}`);
      expect(page2.body.data.map((g: any) => g.id)).not.toEqual(page1.body.data.map((g: any) => g.id));
      expect(page2.body.nextCursor).toBeNull();
      expect((await api.listGroups(W.customers[1])).body.data).toEqual([]);
      expect((await api.listGroups(c, '?scope=nope')).status).toBe(400);
      expect((await api.listGroups(v1)).status).toBe(403);
      const single = await api.place(c, v1);
      expect(single.body.data.group).toBeUndefined(); // single orders carry no group info at all
      expect(Object.keys(single.body.data)).not.toContain('group');
    });

    test('rate limited (ORDER_GROUP_CREATE)', async () => {
      process.env.RL_ORDER_GROUP_CREATE_MAX = '2';
      const c = W.customers[2];
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await api.placeGroup(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])])).status);
      expect(codes).toEqual([201, 201, 429]);
    });
  });

  // =========================================================================================
  describe('payment', () => {
    test('create-order on the PRIMARY charges the group total, is reused on retry; a sibling answers 409 PAY_VIA_GROUP with payOrderId', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      const g = await placeG(c, [cartOf(v1), cartOf(v2, [[1, 1]])]); // 180 + 90 + 25 + 15 = 310
      expect(g.total).toBe(310);
      const cp = await api.createPayment(c, g.payOrderId);
      expect(cp.status).toBe(200);
      expect(cp.body).toMatchObject({ amountInPaise: 31000, amount: 31000, currency: 'INR' });
      const again = await api.createPayment(c, g.payOrderId);
      expect(again.body.razorpayOrderId).toBe(cp.body.razorpayOrderId); // reused
      expect(ledger.calls.createOrder).toBe(1);
      const pays = await prisma.payment.findMany({ where: { orderId: { in: g.orders.map((o: any) => o.id) } } });
      expect(pays).toHaveLength(1);
      expect(pays[0]).toMatchObject({ orderId: g.payOrderId, amount: 310, status: 'PENDING' });
      const sib = await api.createPayment(c, g.orders[1].id);
      expect([sib.status, sib.body.code, sib.body.payOrderId]).toEqual([409, 'PAY_VIA_GROUP', g.payOrderId]);
      expect(await prisma.payment.count({ where: { orderId: g.orders[1].id } })).toBe(0);
      // someone else's group and unknown ids look the same
      expect((await api.createPayment(W.customers[1], g.payOrderId)).status).toBe(404);
      expect((await api.createPayment(W.customers[1], g.orders[1].id)).status).toBe(404);
    });

    test('paying the primary flips ALL children in one go, restaurants hear about THEIR child only, once (verify, webhook and a concurrent mix)', async () => {
      for (const via of ['verify', 'webhook', 'both'] as const) {
        await resetWorldState(W);
        const c = W.customers[0];
        const [v1, v2, v3] = W.vendors;
        const wv1 = await watch(v1, [`vendor_${v1.vendorId}`]);
        const wv2 = await watch(v2, [`vendor_${v2.vendorId}`]);
        const wv3 = await watch(v3, [`vendor_${v3.vendorId}`]);
        const wa = await watch(W.admin);
        const g = await placeG(c, [cartOf(v1), cartOf(v2), cartOf(v3)]);
        const cp = await api.createPayment(c, g.payOrderId);
        const payId = `pay_${via}`;
        ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        if (via === 'verify') expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
        if (via === 'webhook') expect((await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise)).body.status).toBe('processed');
        if (via === 'both') {
          const rs = await Promise.all([api.verify(c, cp.body.razorpayOrderId, payId), api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise), api.verify(c, cp.body.razorpayOrderId, payId), api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise)]);
          expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        }
        await flushAll();
        const kids = await children(g.id);
        expect(kids.every((o) => o.paymentStatus === 'PAID' && o.paidAt !== null && o.status === 'PLACED' && o.refundStatus === null)).toBe(true);
        expect(new Set(kids.map((o) => o.paidAt!.getTime())).size).toBe(1); // flipped together
        expect(kids[0].payments).toHaveLength(1);
        expect(kids[0].payments[0]).toMatchObject({ status: 'PAID', razorpayPaymentId: payId, capturedAmountPaise: paise(g.total) });
        expect(kids.slice(1).every((o) => o.payments.length === 0)).toBe(true);
        // each restaurant: exactly one alert, its own child, no other restaurant's data
        for (const [w, i] of [[wv1, 0], [wv2, 1], [wv3, 2]] as const) {
          expect(w.count('new_order_alert')).toBe(1);
          const alert = w.of('new_order_alert')[0];
          expect(alert.id).toBe(kids[i].id);
          expect(alert.group).toEqual({ size: 3, allAccepted: false });
          expect(w.of('new_order_alert').concat(w.of('order_updated')).every((e: any) => e.id === kids[i].id)).toBe(true);
          const text = JSON.stringify(w.events.map((e) => e.data));
          ['Kitchen 1', 'Kitchen 2', 'Kitchen 3'].forEach((name, j) => { if (j !== i) expect(text).not.toContain(name); }); // never another restaurant's name
        }
        expect(wa.count('new_order_alert')).toBe(3);
        expect((await api.getGroup(c, g.id)).body.data).toMatchObject({ paymentStatus: 'PAID', status: 'AWAITING_RESTAURANTS' });
        // the restaurants list their own paid child
        for (const [v, i] of [[v1, 0], [v2, 1], [v3, 2]] as const) expect((await api.list(v)).body.data.map((o: any) => o.id)).toEqual([kids[i].id]);
        // replays change nothing
        await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        await flushAll();
        expect(wv1.count('new_order_alert')).toBe(1);
        expect(ledger.totalRefunded()).toBe(0);
        for (const w of watchers) w.disconnect();
        watchers = [];
      }
    });

    test('amount mismatch (the primary child\'s own total instead of the group total, or one paisa off) is never marked paid and is flagged once', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      const g = await placeG(c, [cartOf(v1), cartOf(v2)]); // 400
      const cp = await api.createPayment(c, g.payOrderId);
      const wrongs = [paise(g.orders[0].totalAmount), paise(g.total) - 1, paise(g.total) + 1];
      for (const [i, amount] of wrongs.entries()) {
        const res = await api.webhookCaptured(cp.body.razorpayOrderId, `pay_wrong${i}`, amount);
        expect(res.body).toMatchObject({ status: 'rejected', code: 'AMOUNT_MISMATCH' });
      }
      const kids = await children(g.id);
      expect(kids.every((o) => o.paymentStatus === 'PENDING' && o.paidAt === null)).toBe(true);
      expect(await audit(g.payOrderId, 'PAYMENT_AMOUNT_MISMATCH')).toBe(3);
      const na = (await api.needsAttention(W.admin)).body.data.find((x: any) => x.order.id === g.payOrderId);
      expect(na).toMatchObject({ problem: 'PAYMENT_MISMATCH', groupId: g.id });
      expect(na.detail).toContain('Combined order of 2 restaurants (Kitchen 1, Kitchen 2)');
      expect((await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === g.id && x.order.id !== g.payOrderId && x.problem === 'PAYMENT_MISMATCH')).toEqual([]);
    });

    test('verify-signature with the right capture works through the provider check (payment fetched at Razorpay, group total expected)', async () => {
      const c = W.customers[0];
      const g = await placeG(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])]);
      const sim = createSimulatedProvider();
      setPaymentProvider(sim);
      const cp = await api.createPayment(c, g.payOrderId);
      // the customer paid only the primary child's share at the provider: verify must NOT mark the group paid
      sim.addPayment({ id: 'pay_short', orderId: cp.body.razorpayOrderId, amountPaise: paise(g.orders[0].totalAmount) });
      const short = await api.verify(c, cp.body.razorpayOrderId, 'pay_short');
      expect(short.status).toBe(409);
      expect(short.body.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect((await children(g.id)).every((o) => o.paymentStatus === 'PENDING')).toBe(true);
      // the right capture later (same Razorpay order) is accepted, like for a single order: the WHOLE group becomes paid
      sim.addPayment({ id: 'pay_full', orderId: cp.body.razorpayOrderId, amountPaise: paise(g.total) });
      expect((await api.verify(c, cp.body.razorpayOrderId, 'pay_full')).status).toBe(200);
      expect((await children(g.id)).every((o) => o.paymentStatus === 'PAID')).toBe(true);
    });

    test('a second captured payment for a paid group is refunded on its own (exactly once); the group and its payment stay as they are', async () => {
      const c = W.customers[0];
      const g = await placeG(c, [cartOf(W.vendors[0]), cartOf(W.vendors[1])]);
      const p1 = await pay(c, g.payOrderId, 'verify', 'pay_first');
      ledger.capture(p1.rzp, 'pay_second', p1.amount);
      const dup = await api.webhookCaptured(p1.rzp, 'pay_second', p1.amount);
      expect(dup.body.status).toBe('rejected');
      await flushAll();
      expect(ledger.refundsOf('pay_second')).toEqual([expect.objectContaining({ amountPaise: paise(g.total) })]);
      expect(ledger.refundsOf('pay_first')).toEqual([]);
      const kids = await children(g.id);
      expect(kids.every((o) => o.paymentStatus === 'PAID' && o.refundStatus === null && o.status === 'PLACED')).toBe(true);
      expect(await audit(g.payOrderId, 'PAYMENT_DUPLICATE')).toBe(1);
      // the retry loop does not refund it a second time
      await runOrderMaintenance(minutesFromNow(5));
      await __waitForBackgroundWork();
      expect(ledger.refundsOf('pay_second')).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(paise(g.total));
    });

    test('lost webhook + closed app: the job finds the capture at Razorpay and pays the WHOLE group (siblings included)', async () => {
      const c = W.customers[0];
      const [v1, v2] = W.vendors;
      const sim = createSimulatedProvider();
      setPaymentProvider(sim);
      const wv2 = await watch(v2, [`vendor_${v2.vendorId}`]);
      const g = await placeG(c, [cartOf(v1), cartOf(v2)]);
      const cp = await api.createPayment(c, g.payOrderId);
      sim.addPayment({ id: 'pay_lost', orderId: cp.body.razorpayOrderId, amountPaise: paise(g.total) });
      const tick = await runOrderMaintenance(minutesFromNow(3));
      expect(tick.reconciledPaid).toContain(g.payOrderId);
      await flushAll();
      const kids = await children(g.id);
      expect(kids.every((o) => o.paymentStatus === 'PAID' && o.paidAt)).toBe(true);
      expect(kids[0].payments[0]).toMatchObject({ status: 'PAID', capturedAmountPaise: paise(g.total) });
      expect(wv2.count('new_order_alert')).toBe(1);
      expect(await audit(g.payOrderId, 'PAYMENT_RECONCILED')).toBe(1);
      // a wrong amount found by reconcile is flagged, not paid
      const g2 = await placeG(W.customers[1], [cartOf(W.vendors[2]), cartOf(W.vendors[3])]);
      const cp2 = await api.createPayment(W.customers[1], g2.payOrderId);
      sim.addPayment({ id: 'pay_lost_wrong', orderId: cp2.body.razorpayOrderId, amountPaise: paise(g2.orders[0].totalAmount) });
      const t2 = await runOrderMaintenance(minutesFromNow(3));
      expect(t2.reconcileFlagged).toContain(g2.payOrderId);
      expect((await children(g2.id)).every((o) => o.paymentStatus === 'PENDING')).toBe(true);
    });
  });

  // =========================================================================================
  describe('refund', () => {
    const paidGroup = async (carts: unknown[] = [cartOf(W.vendors[0]), cartOf(W.vendors[1])], c = W.customers[0]) => {
      const g = await placeG(c, carts);
      const p = await pay(c, g.payOrderId);
      return { g, ...p, c };
    };

    test('cancelled paid group: ONE refund of the full group payment, only the primary carries refundStatus, siblings follow to REFUNDED when it completes', async () => {
      const { g, payId, c } = await paidGroup([cartOf(W.vendors[0]), cartOf(W.vendors[1], [[1, 2]]), cartOf(W.vendors[2])]);
      const r = await api.reject(W.vendors[1], g.orders[1].id, 'Out of paneer');
      expect(r.status).toBe(200);
      await flushAll();
      const kids = await children(g.id);
      expect(kids.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
      expect(kids[0]).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE', cancelledBy: 'SYSTEM' });
      expect(kids[0].cancelReason).toBe('Another restaurant in your order could not take it');
      expect(kids[1]).toMatchObject({ cancelledBy: 'VENDOR', cancelReason: 'Out of paneer', paymentStatus: 'REFUNDED', refundStatus: null });
      expect(kids[2]).toMatchObject({ cancelledBy: 'SYSTEM', paymentStatus: 'REFUNDED', refundStatus: null });
      expect(kids.slice(1).every((o) => o.refundStatus === null && o.payments.length === 0)).toBe(true);
      expect(ledger.refundsOf(payId)).toEqual([expect.objectContaining({ amountPaise: paise(g.total) })]);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      expect(kids[0].payments[0]).toMatchObject({ status: 'REFUNDED', razorpayRefundId: expect.any(String) });
      expect(await audit(kids[0].id, 'REFUND_DONE')).toBe(1);
      // customer view: refund visible on every part, group CANCELLED
      const view = (await api.getGroup(c, g.id)).body.data;
      expect(view).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(view.orders.map((o: any) => o.refundStatus)).toEqual(['DONE', 'DONE', 'DONE']);
      // nothing left for the admin; the job has nothing to do; a repeat never refunds twice
      expect((await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === g.id)).toEqual([]);
      await runOrderMaintenance(minutesFromNow(10));
      await __waitForBackgroundWork();
      expect(ledger.refundsOf(payId)).toHaveLength(1);
    });

    test('provider outage: the primary is FAILED (siblings never FAILED/PENDING), needs-attention names the group once, the retry finishes it exactly once', async () => {
      const { g, payId } = await paidGroup();
      ledger.mode.refundDown = true;
      expect((await api.adminCancel(W.admin, g.orders[1].id, 'Admin decision')).status).toBe(200);
      await flushAll();
      let kids = await children(g.id);
      expect(kids[0]).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'FAILED' });
      expect(kids[1]).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: null });
      expect(ledger.refundsOf(payId)).toEqual([]);
      const na = (await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === g.id);
      expect(na.map((x: any) => [x.order.id, x.problem])).toEqual([[g.orders[0].id, 'REFUND_FAILED']]); // ONE row, through the primary
      expect(na[0].detail).toContain('Combined order of 2 restaurants (Kitchen 1, Kitchen 2)');
      // sibling rows are not flagged for money problems, and the sibling's own retry is refused
      expect((await api.retryRefund(W.admin, g.orders[1].id)).status).toBe(409);
      // the provider recovers; the maintenance retry (after the backoff) completes it
      ledger.mode.refundDown = false;
      await runOrderMaintenance(minutesFromNow(5));
      await flushAll();
      kids = await children(g.id);
      expect(kids.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
      expect(kids.map((o) => o.refundStatus)).toEqual(['DONE', null]);
      expect(ledger.refundsOf(payId)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      // admin retry on the primary after success is refused (nothing failed)
      expect((await api.retryRefund(W.admin, g.orders[0].id)).status).toBe(409);
    });

    test('provider answer lost after a successful refund: no second refund, the group ends REFUNDED', async () => {
      const { g, payId } = await paidGroup();
      ledger.mode.refundLostAnswer = true;
      await api.adminCancel(W.admin, g.orders[0].id);
      await flushAll();
      expect((await children(g.id))[0].refundStatus).toBe('FAILED');
      ledger.mode.refundLostAnswer = false;
      await runOrderMaintenance(minutesFromNow(5));
      await flushAll();
      expect((await children(g.id)).map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
      expect(ledger.refundsOf(payId)).toHaveLength(1);
    });

    test('a payment that arrives AFTER the group was cancelled is refunded exactly once (verify, webhook, concurrent, replays); the group stays cancelled and the restaurants never hear', async () => {
      for (const path of ['verify', 'webhook', 'concurrent'] as const) {
        await resetWorldState(W);
        const c = W.customers[0];
        const [v1, v2] = W.vendors;
        const wv1 = await watch(v1, [`vendor_${v1.vendorId}`]);
        const g = await placeG(c, [cartOf(v1), cartOf(v2)]);
        const cp = await api.createPayment(c, g.payOrderId);
        expect((await api.cancel(c, g.orders[1].id, 'changed my mind')).status).toBe(200); // unpaid cancel of a sibling cancels the group
        const payId = `pay_late_${path}`;
        ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        if (path === 'webhook') expect((await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise)).body.status).toBe('processed');
        if (path === 'verify') expect((await api.verify(c, cp.body.razorpayOrderId, payId)).body.code).toBe('ORDER_CANCELLED');
        if (path === 'concurrent') {
          const rs = await Promise.all([api.verify(c, cp.body.razorpayOrderId, payId), api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise), api.verify(c, cp.body.razorpayOrderId, payId)]);
          expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        }
        await flushAll();
        const kids = await children(g.id);
        expect(kids.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
        expect(kids.every((o) => o.paidAt === null)).toBe(true);
        expect(kids.map((o) => o.refundStatus)).toEqual(['DONE', null]);
        expect(kids.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
        expect(ledger.refundsOf(payId)).toHaveLength(1);
        expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
        await api.webhookCaptured(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
        await runOrderMaintenance(minutesFromNow(5));
        await __waitForBackgroundWork();
        expect(ledger.refundsOf(payId)).toHaveLength(1);
        expect(wv1.count('new_order_alert') + wv1.count('order_updated')).toBe(0);
        expect(await audit(g.payOrderId, 'PAYMENT_AFTER_CANCEL')).toBe(1);
        expect((await api.needsAttention(W.admin)).body.data.filter((x: any) => x.groupId === g.id)).toEqual([]);
        for (const w of watchers) w.disconnect();
        watchers = [];
      }
    });

    test('the refund.processed webhook closes a stuck refund for the whole group; a later refund.failed reverts all of it', async () => {
      const { g, payId } = await paidGroup();
      ledger.mode.refundHangAfterSuccess = false;
      ledger.mode.refundDown = true;
      await api.adminCancel(W.admin, g.orders[0].id);
      await flushAll();
      expect((await children(g.id))[0].refundStatus).toBe('FAILED');
      // Razorpay processed it after all (e.g. our request timed out but went through)
      const done = await api.webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_manual', payment_id: payId, amount: paise(g.total) } } } });
      expect(done.body.status).toBe('processed');
      let kids = await children(g.id);
      expect(kids.map((o) => o.paymentStatus)).toEqual(['REFUNDED', 'REFUNDED']);
      expect(kids.map((o) => o.refundStatus)).toEqual(['DONE', null]);
      const failed = await api.webhook({ event: 'refund.failed', payload: { refund: { entity: { id: 'rfnd_manual', payment_id: payId, amount: paise(g.total), error_description: 'bank rejected' } } } });
      expect(failed.body.status).toBe('processed');
      kids = await children(g.id);
      expect(kids.map((o) => o.paymentStatus)).toEqual(['PAID', 'PAID']); // the money bounced for the whole group
      expect(kids.map((o) => o.refundStatus)).toEqual(['FAILED', null]);
    });
  });
});
