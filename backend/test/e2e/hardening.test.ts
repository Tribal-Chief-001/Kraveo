/**
 * Backend hardening (security audit + QA, 2026-10-03). One test group per fixed finding; every test here failed
 * before the fix. Real PostgreSQL, real sockets, the payment provider replaced by the in-memory ledger.
 */
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, cleanTestOrders } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { generateTestToken } from '../harness/auth';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { setGoogleVerifier } from '../../src/services/googleAuth';
import { __resetRateLimits, __rateLimitKeyCount, rateLimitMiddleware, FailureLimiter, SlidingWindow } from '../../src/middleware/rateLimit';
import { __resetLoginLimiter, __loginLimiterSize, sweepLoginLimiter, recordFailure, isLocked } from '../../src/services/loginLimiter';
import { __resetAdminLoginLimiter } from '../../src/routes/api';
import { assertRuntimeConfig } from '../../src/config/runtimeConfig';
import { fail } from '../../src/utils/http';
import { placeOrder, OrderFlowError } from '../../src/services/orderFlow';
import { invalidateAuthCache } from '../../src/middleware/auth';
import { hashPassword } from '../../src/services/password';
import {
  World, Person, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi, reissue, sleep,
} from '../harness/journey';

jest.setTimeout(60_000);

describe('Backend hardening', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  let watchers: Watcher[] = [];
  const cleanupIds: string[] = [];
  const envBackup: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in envBackup)) envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  const restoreEnv = () => { for (const k of Object.keys(envBackup)) { if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k]; delete envBackup[k]; } };

  const watch = async (p: Person) => { const w = await new Watcher(server.baseUrl, p).connect(); watchers.push(w); return w; };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const row = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });

  const place = async (c: Customer, v: Vendor, extra: Record<string, unknown> = {}, itemIdx = 0) => {
    const r = await api.place(c, v, extra, itemIdx);
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };
  const pay = async (c: Customer, orderId: string) => {
    const cp = await api.createPayment(c, orderId);
    expect(cp.status).toBe(200);
    const payId = `pay_${randomUUID().slice(0, 12)}`;
    ledger.capture(cp.body.razorpayOrderId, payId, cp.body.amountInPaise);
    expect((await api.verify(c, cp.body.razorpayOrderId, payId)).status).toBe(200);
  };
  const placePaid = async (c: Customer, v: Vendor, extra: Record<string, unknown> = {}) => {
    const id = await place(c, v, extra);
    await pay(c, id);
    return id;
  };
  const driveTo = async (id: string, target: string, v: Vendor, r: Rider) => {
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CLAIMED', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
      if (st === 'CLAIMED') expect((await api.claim(r, id)).status).toBe(200);
      else if (['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(st)) expect((await api.setStatus(v, id, st)).status).toBe(200);
      else expect((await api.setStatus(r, id, st)).status).toBe(200);
      if (st === target) return;
    }
  };
  const deliver = async (c: Customer, v: Vendor, r: Rider, extra: Record<string, unknown> = {}) => {
    const id = await placePaid(c, v, extra);
    await driveTo(id, 'ARRIVED_AT_GATE', v, r);
    const otp = (await row(id)).otpCode!;
    expect((await api.otp(r, id, otp)).status).toBe(200);
    return { id, otp };
  };

  beforeAll(async () => {
    await cleanTestOrders();
    W = await createWorld('hd', '8', { customers: 4, vendors: 2, riders: 3 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
    request = supertest(server.app);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    await prisma.user.updateMany({ where: { id: { startsWith: 'hd-' } }, data: { deletedAt: null } });
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits(); __resetLoginLimiter(); __resetAdminLoginLimiter(); invalidateAuthCache();
    setEnv('ADMIN_PASSCODE', 'hardening-passcode-123');
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    for (const w of watchers) w.disconnect();
    watchers = [];
    setPaymentProvider(null);
    setGoogleVerifier(null);
    restoreEnv();
  });
  afterAll(async () => {
    await stopTestServer(server);
    await purgeWorld('hd');
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: cleanupIds } }, { id: { startsWith: 'hd-' } }, { email: { endsWith: '@hardening.test' } }] } });
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  // 1. GET /drivers/:id no longer leaks rider PII
  // =========================================================================================
  describe('1. rider directory', () => {
    test('a pending rider, another rider and a student cannot read a rider; a rider reads only their own non-PII profile; the admin reads everything', async () => {
      const [r1, r2, r3] = W.riders;
      await prisma.driverPartner.update({ where: { id: r1.profileId }, data: { upiId: 'rider1@upi', emergencyPhone: '+91 9000011111', vehicleRegNo: 'MP04AB1234', studentRegNo: '21BCG1' } });
      await prisma.driverPartner.update({ where: { id: r3.profileId }, data: { approvalStatus: 'PENDING' } });

      const other = await request.get(`/api/drivers/${r1.profileId}`).set(bearer(r2.token));
      expect(other.status).toBe(404);
      expect(JSON.stringify(other.body)).not.toMatch(/rider1@upi|9000011111|MP04AB1234/);
      expect((await request.get(`/api/drivers/${r1.id}`).set(bearer(r3.token))).status).toBe(404); // pending, someone else's id
      expect((await request.get(`/api/drivers/${r3.id}`).set(bearer(r3.token))).status).toBe(404); // pending, even their own
      expect((await request.get(`/api/drivers/${r1.profileId}`).set(bearer(W.customers[0].token))).status).toBe(403);
      expect((await request.get(`/api/drivers/${r1.profileId}`)).status).toBe(401);

      const own = await request.get(`/api/drivers/${r1.id}`).set(bearer(r1.token));
      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ id: r1.profileId, runnerCode: expect.any(String) });
      const ownJson = JSON.stringify(own.body);
      for (const secret of ['rider1@upi', '9000011111', 'MP04AB1234', '21BCG1', 'phone', 'upiId', 'emergencyPhone', 'vehicleRegNo', 'studentRegNo', 'passwordHash']) expect(ownJson).not.toContain(secret);

      const admin = await request.get(`/api/drivers/${r1.profileId}`).set(bearer(W.admin.token));
      expect(admin.status).toBe(200);
      expect(admin.body.data).toMatchObject({ upiId: 'rider1@upi', emergencyPhone: '+91 9000011111', vehicleRegNo: 'MP04AB1234' });
      expect(JSON.stringify(admin.body)).not.toMatch(/passwordHash|googleSub|fcmToken/);
      const list = await request.get('/api/drivers').set(bearer(W.admin.token));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|googleSub|fcmToken|scrypt/);
      expect((await request.get('/api/drivers/%00').set(bearer(W.admin.token))).status).toBe(400);
    });
  });

  // =========================================================================================
  // 3. Reviews
  // =========================================================================================
  describe('3. reviews', () => {
    const post = (c: Person, body: unknown) => request.post('/api/reviews').set(bearer(c.token)).send(body as any);

    test('validation: ids, ratings, dishes of the order, text caps, list sizes, owner only, once; invalid input never costs coins', async () => {
      const [c1, c2] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const { id } = await deliver(c1, v1, r1);
      const dish = v1.items[0].id;
      const coins = async () => (await prisma.user.findUniqueOrThrow({ where: { id: c1.id } })).kraveoCoins;
      const before = await coins();

      for (const orderId of [undefined, 123, { $ne: 1 }, ['a'], '', 'x'.repeat(65), '../etc', '%00']) {
        const r = await post(c1, { orderId, driverRating: 5 });
        expect([String(orderId), r.status]).toEqual([String(orderId), 400]);
      }
      for (const driverRating of [0, 6, 2.5, '5', -1, 1e9, true, {}]) {
        const r = await post(c1, { orderId: id, driverRating });
        expect([JSON.stringify(driverRating), r.status]).toEqual([JSON.stringify(driverRating), 400]);
      }
      const bad = (dishReviews: unknown) => post(c1, { orderId: id, driverRating: 5, dishReviews });
      expect((await bad([{ dishId: dish, rating: 6 }])).status).toBe(400);
      expect((await bad([{ dishId: dish, rating: 3.5 }])).status).toBe(400);
      expect((await bad([{ dishId: dish, rating: '5' }])).status).toBe(400);
      expect((await bad([{ dishId: 12, rating: 5 }])).status).toBe(400);
      expect((await bad([{ dishId: v1.items[1].id, rating: 5 }])).status).toBe(400); // a dish that was not in this order
      expect((await bad([{ dishId: W.vendors[1].items[0].id, rating: 5 }])).status).toBe(400); // another restaurant's dish
      expect((await bad([{ dishId: dish, rating: 5 }, { dishId: dish, rating: 1 }])).status).toBe(400); // twice
      expect((await bad('lots')).status).toBe(400);
      expect((await bad(Array.from({ length: 31 }, () => ({ dishId: dish, rating: 5 })))).status).toBe(400);
      expect((await post(c1, { orderId: id, driverNotes: 'n'.repeat(301) })).status).toBe(400);
      expect((await post(c1, { orderId: id, dhabaNotes: 'n'.repeat(301) })).status).toBe(400);
      expect((await post(c1, { orderId: id, dhabaNotes: 12 })).status).toBe(400);
      expect((await post(c1, { orderId: id, driverTags: ['x'.repeat(41)] })).status).toBe(400);
      expect((await post(c1, { orderId: id, driverTags: Array.from({ length: 11 }, () => 'a') })).status).toBe(400);
      expect((await post(c2, { orderId: id, driverRating: 5 })).status).toBe(403); // someone else's order
      expect((await request.post('/api/reviews').send({ orderId: id })).status).toBe(401);
      expect((await post(W.admin, { orderId: id })).status).toBe(403);
      expect((await post(c1, { orderId: 'nonexistent-order-1' })).status).toBe(404);
      expect(await coins()).toBe(before);
      expect((await row(id)).isReviewed).toBe(false);

      const ok = await post(c1, { orderId: id, driverRating: 4, driverTags: ['Polite'], driverNotes: 'n'.repeat(300), dishReviews: [{ dishId: dish, rating: 5, evil: '<script>' }], dhabaNotes: 'tasty', junk: 'ignored' });
      expect(ok.status).toBe(200);
      expect(ok.body.totalCoins).toBe(before + 10);
      expect(ok.body.review).not.toHaveProperty('customerId');
      const stored = await prisma.reviewRecord.findUniqueOrThrow({ where: { orderId: id } });
      expect(stored.dishReviews).toEqual([{ dishId: dish, rating: 5 }]); // only the validated fields are stored
      const again = await post(c1, { orderId: id, driverRating: 5 });
      expect(again.status).toBe(400);
      expect(await coins()).toBe(before + 10);
      // Two taps at the same moment: one review, one payout.
      const second = await deliver(c1, v1, r1);
      const both = await Promise.all([post(c1, { orderId: second.id, driverRating: 5 }), post(c1, { orderId: second.id, driverRating: 5 })]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await coins()).toBe(before + 20);
    });

    test('an undelivered order cannot be reviewed', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const id = await placePaid(c1, v1);
      expect((await post(c1, { orderId: id, driverRating: 5 })).status).toBe(403);
    });

    test('review lists need a login, are paginated (max 50) and expose no customer / driver / order ids', async () => {
      const [c1, c2] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      for (const [c, rating] of [[c1, 5], [c2, 3], [c1, 4]] as [Customer, number][]) {
        const { id } = await deliver(c, v1, r1);
        expect((await post(c, { orderId: id, driverRating: rating, driverNotes: 'ok', dhabaNotes: 'fine', dishReviews: [{ dishId: v1.items[0].id, rating }] })).status).toBe(200);
      }
      expect((await request.get(`/api/reviews/vendor/${v1.vendorId}`)).status).toBe(401);
      expect((await request.get(`/api/reviews/driver/${r1.id}`)).status).toBe(401);
      const list = await request.get(`/api/reviews/vendor/${v1.vendorId}`).set(bearer(W.customers[3].token));
      expect(list.status).toBe(200);
      expect(list.body.count).toBe(3);
      const raw = JSON.stringify(list.body);
      for (const forbidden of ['customerId', 'driverId', 'vendorId', 'orderId', c1.id, c2.id, r1.id]) expect(raw).not.toContain(forbidden);
      expect(list.body.data[0]).toMatchObject({ reviewer: expect.stringMatching(/^Cust[12]$/), driverRating: expect.any(Number), createdAt: expect.any(String) });
      expect(list.body.data.map((r: any) => r.reviewer)).not.toContain('Cust1 Tester'); // first name only

      const p1 = await request.get(`/api/reviews/vendor/${v1.vendorId}?limit=2`).set(bearer(r1.token));
      expect(p1.body.count).toBe(2);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      const p2 = await request.get(`/api/reviews/vendor/${v1.vendorId}?limit=2&cursor=${p1.body.nextCursor}`).set(bearer(r1.token));
      expect(p2.body.count).toBe(1);
      expect(p2.body.nextCursor).toBeNull();
      expect([...p1.body.data, ...p2.body.data].map((r: any) => r.id)).toEqual(list.body.data.map((r: any) => r.id));
      expect((await request.get(`/api/reviews/vendor/${v1.vendorId}?limit=99999`).set(bearer(c1.token))).body.count).toBe(3);
      expect((await request.get(`/api/reviews/vendor/${v1.vendorId}?cursor=%00`).set(bearer(c1.token))).status).toBe(400);
      expect((await request.get('/api/reviews/vendor/%00').set(bearer(c1.token))).status).toBe(400);
      const drv = await request.get(`/api/reviews/driver/${r1.profileId}`).set(bearer(c1.token));
      expect([drv.status, drv.body.count]).toEqual([200, 3]);
      expect(JSON.stringify(drv.body)).not.toMatch(/customerId|driverId/);
    });
  });

  // =========================================================================================
  // 2. Coupons: rounding, single use, redeem-coins
  // =========================================================================================
  describe('2. coupons', () => {
    test('the discount threshold is compared on the rounded subtotal (0.7 x 14 + 8.2 x 11 = 99.99999999999999 counts as Rs 100.00)', async () => {
      const { validateAndCalculateOrder } = await import('../../src/utils/validation');
      const [v1] = W.vendors;
      await prisma.menuItem.createMany({ data: [
        { id: 'hd-thr-a', vendorId: v1.vendorId, name: 'thr a', price: 0.7, category: 't', description: '', imageUrl: '' },
        { id: 'hd-thr-b', vendorId: v1.vendorId, name: 'thr b', price: 8.2, category: 't', description: '', imageUrl: '' },
      ] });
      const r = await validateAndCalculateOrder(v1.vendorId, [{ itemId: 'hd-thr-a', quantity: 14 }, { itemId: 'hd-thr-b', quantity: 11 }], 'VITFIRST');
      expect([r.calculatedSubtotal, r.calculatedDiscount, r.calculatedTotalAmount, r.appliedCoupon]).toEqual([100, 20, 120, 'VITFIRST']);
    });

    test('an unknown code or a cart under the minimum is a 400 COUPON_NOT_APPLICABLE with a readable message; no order is created', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const unknown = await api.place(c1, v1, { couponCode: 'NOSUCH' });
      expect([unknown.status, unknown.body.code, unknown.body.field]).toEqual([400, 'COUPON_NOT_APPLICABLE', 'couponCode']);
      expect(unknown.body.message).toMatch(/NOSUCH/);
      const small = await api.place(c1, v1, { couponCode: 'KRAVEO50' }, 1); // Rs 90 < Rs 150
      expect([small.status, small.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect(small.body.message).toMatch(/at least/);
      expect(await prisma.order.count({ where: { customerId: c1.id } })).toBe(0);
      // whitespace / empty means "no coupon"
      expect((await api.place(c1, v1, { couponCode: '   ' })).status).toBe(201);
      expect((await api.place(c1, v1, { couponCode: '' })).status).toBe(201);
    });

    test('redeem-coins takes 50 coins atomically and only for students; 10 concurrent redemptions with 100 coins give exactly 2 uses of KRAVEO20', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      await prisma.user.update({ where: { id: c1.id }, data: { kraveoCoins: 100, kraveo20Redeemed: 0 } });
      const res = await Promise.all(Array.from({ length: 10 }, () => request.post('/api/coupons/redeem-coins').set(bearer(c1.token)).send({})));
      expect(res.filter((r) => r.status === 200)).toHaveLength(2);
      expect(res.filter((r) => r.status === 400).every((r) => r.body.code === 'INSUFFICIENT_COINS')).toBe(true);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: c1.id } });
      expect([u.kraveoCoins, u.kraveo20Redeemed]).toEqual([0, 2]);
      expect((await request.post('/api/coupons/redeem-coins').set(bearer(W.riders[0].token)).send({})).status).toBe(403);
      expect((await request.post('/api/coupons/redeem-coins').send({})).status).toBe(401);
      // (Bug hunt BE1-01: an abandoned checkout is replaced by the next one, so each order gets a payment in flight to stay "live".)
      const a = await api.place(c1, v1, { couponCode: 'KRAVEO20' });
      expect((await api.createPayment(c1, a.body.data.id)).status).toBe(200);
      const b = await api.place(c1, v1, { couponCode: 'KRAVEO20' });
      expect((await api.createPayment(c1, b.body.data.id)).status).toBe(200);
      const c = await api.place(c1, v1, { couponCode: 'KRAVEO20' });
      expect([a.status, b.status, c.status]).toEqual([201, 201, 400]);
      expect(c.body.code).toBe('COUPON_NOT_APPLICABLE');
    });

    test('an order with a coupon replayed with another coupon is a mismatch (see 17); the stored couponCode is the normalised code', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const key = randomUUID();
      const first = await api.place(c1, v1, { clientRequestId: key, couponCode: 'kraveo50 ' });
      expect(first.status).toBe(201);
      expect((await row(first.body.data.id)).couponCode).toBe('KRAVEO50');
      const same = await api.place(c1, v1, { clientRequestId: key, couponCode: 'KRAVEO50' });
      expect([same.status, same.body.idempotentReplay]).toEqual([200, true]);
      const other = await api.place(c1, v1, { clientRequestId: key });
      expect([other.status, other.body.code]).toEqual([409, 'CLIENT_REQUEST_MISMATCH']);
    });
  });

  // =========================================================================================
  // 4. The gate OTP never reaches the logs
  // =========================================================================================
  describe('4. logs', () => {
    test('ARRIVED_AT_GATE: the OTP, the push body and the token are in no console.log / info / warn / error / debug line', async () => {
      const crypto = require('crypto'); // the real module object (an `import *` namespace is a copy)
      const spy = jest.spyOn(crypto, 'randomInt').mockImplementation((() => 7391) as any);
      const out: string[] = [];
      const grab = (...a: unknown[]) => { out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(grab as any));
      try {
        const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
        await prisma.user.update({ where: { id: c1.id }, data: { fcmToken: 'fcm-token-hardening-test-0123456789abcdef' } });
        const id = await placePaid(c1, v1);
        await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
        await __waitForBackgroundWork();
        await sleep(100);
        expect((await row(id)).otpCode).toBe('7391'); // the spy took effect: this IS the code the push carried
        const text = out.join('\n');
        expect(text).toMatch(/RUNNER_ARRIVED for order/); // the event is logged...
        expect(text).toContain(id);
        expect(text).not.toContain('7391'); // ...the code is not
        expect(text).not.toMatch(/Handshake|waiting at the gate|otpCode/i);
        expect(text).not.toContain('fcm-token-hardening');
        expect(text).not.toContain(c1.token);
      } finally {
        spies.forEach((s) => s.mockRestore());
        spy.mockRestore();
      }
    });
  });

  // =========================================================================================
  // 5. Token revocation, deleted users, ghosts
  // =========================================================================================
  describe('5. tokens and accounts', () => {
    const googleAs = (email: string, sub: string, name = 'Hardening Student') => setGoogleVerifier(async () => ({ sub, email, emailVerified: true, name }));
    const googleLogin = (email: string, sub: string) => { googleAs(email, sub); return request.post('/api/auth/google').send({ idToken: 'g'.repeat(40) }); };

    test('DELETE /auth/account kills the old token at once (401 everywhere, POST /orders included) and the account cannot be signed into again', async () => {
      const [v1] = W.vendors;
      const login = await googleLogin('del1@hardening.test', 'g-sub-del-1');
      expect(login.status).toBe(200);
      const token = login.body.token as string;
      const userId = login.body.user.id as string;
      cleanupIds.push(userId);
      expect(jwt.decode(token)).toMatchObject({ id: userId, tv: 0 });
      const body = { vendorId: v1.vendorId, items: [{ itemId: v1.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2', clientRequestId: randomUUID() };
      expect((await request.get('/api/auth/profile').set(bearer(token))).status).toBe(200);
      expect((await request.delete('/api/auth/account').set(bearer(token))).status).toBe(200);
      for (const r of [
        await request.get('/api/auth/profile').set(bearer(token)),
        await request.post('/api/orders').set(bearer(token)).send(body),
        await request.get('/api/orders').set(bearer(token)),
        await request.delete('/api/auth/account').set(bearer(token)),
      ]) expect([r.status, r.body.code]).toEqual([401, 'TOKEN_REVOKED']);
      const row0 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row0.deletedAt).not.toBeNull();
      expect(row0.tokenVersion).toBe(1);
      expect(await prisma.order.count({ where: { customerId: userId } })).toBe(0);
      // Signing in with the same Google account never resurrects the deleted row: it is a brand-new account.
      const again = await googleLogin('del1@hardening.test', 'g-sub-del-1');
      expect([again.status, again.body.isNewUser]).toEqual([200, true]);
      expect(again.body.user.id).not.toBe(userId);
      cleanupIds.push(again.body.user.id);
      // and the service itself refuses to place an order for a deleted / missing customer (4xx, not a 500)
      for (const id of [userId, 'hd-never-existed']) {
        await expect(placeOrder(id, { vendorId: v1.vendorId, items: [{ itemId: v1.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2', dropoffNotes: null, clientRequestId: null }))
          .rejects.toMatchObject({ status: 401, code: 'ACCOUNT_UNAVAILABLE' });
      }
    });

    test('a valid token of a user that does not exist is 401 on every authenticated route and on the socket; a wrong tv claim is 401, a missing tv claim means 0', async () => {
      const ghost = generateTestToken({ id: 'hd-ghost-1', phone: '+91 9777899991', role: 'STUDENT' as any });
      const [v1] = W.vendors; const [c1] = W.customers;
      for (const [m, url] of [['get', '/api/orders'], ['get', '/api/auth/profile'], ['get', '/api/orders/available'], ['post', '/api/payments/create-order'], ['get', '/api/drivers/locations']] as const) {
        const r = await (request as any)[m](url).set(bearer(ghost)).send({});
        expect([url, r.status]).toEqual([url, 401]);
      }
      const r = await request.post('/api/orders').set(bearer(ghost)).send({ vendorId: v1.vendorId, items: [{ itemId: v1.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2' });
      expect(r.status).toBe(401);
      await expect(new Watcher(server.baseUrl, { ...c1, id: 'hd-ghost-1', token: ghost }).connect()).rejects.toThrow();

      // tv: the world's tokens carry no claim (= 0) and work; a token claiming tv 5 does not match the database's 0
      expect((await request.get('/api/auth/profile').set(bearer(c1.token))).status).toBe(200);
      const wrongTv = generateTestToken({ id: c1.id, phone: c1.phone, role: 'STUDENT' as any, tv: 5 });
      expect((await request.get('/api/auth/profile').set(bearer(wrongTv))).status).toBe(401);
      const rightTv = generateTestToken({ id: c1.id, phone: c1.phone, role: 'STUDENT' as any, tv: 0 });
      expect((await request.get('/api/auth/profile').set(bearer(rightTv))).status).toBe(200);
      await prisma.user.update({ where: { id: c1.id }, data: { tokenVersion: 3 } });
      expect((await request.get('/api/auth/profile').set(bearer(c1.token))).status).toBe(401); // old, claimless token
      expect((await request.get('/api/auth/profile').set(bearer(await reissue(c1).then((p) => p.token)))).status).toBe(200);
      await expect(new Watcher(server.baseUrl, c1).connect()).rejects.toThrow(); // sockets use the same check
      expect((await watch(await reissue(c1))).connected).toBe(true);
    });

    test('admin reset-password revokes the partner\'s old sessions and sockets; the new password works', async () => {
      const [v1] = W.vendors;
      const PW = 'Old-Password-12';
      await prisma.user.update({ where: { id: v1.id }, data: { passwordHash: await hashPassword(PW) } });
      const login = await request.post('/api/auth/partner-login').send({ phone: v1.phone, password: PW, role: 'VENDOR' });
      expect(login.status).toBe(200);
      const wv = await watch({ ...v1, token: login.body.token });
      expect((await request.get('/api/partner/me').set(bearer(login.body.token))).status).toBe(200);
      const reset = await request.post(`/api/admin/partners/${v1.id}/reset-password`).set(bearer(W.admin.token)).send({ password: 'Brand-New-Pass-34' });
      expect(reset.status).toBe(200);
      const dead = await request.get('/api/partner/me').set(bearer(login.body.token));
      expect([dead.status, dead.body.code]).toEqual([401, 'TOKEN_REVOKED']);
      await sleep(150);
      expect(wv.connected).toBe(false); // the live socket was closed too
      __resetLoginLimiter();
      const fresh = await request.post('/api/auth/partner-login').send({ phone: v1.phone, password: 'Brand-New-Pass-34', role: 'VENDOR' });
      expect(fresh.status).toBe(200);
      expect((await request.get('/api/partner/me').set(bearer(fresh.body.token))).status).toBe(200);
    });

    test('the in-memory cache spares the database but is cleared the moment a token is revoked through the application', async () => {
      const [c1, , c3] = W.customers;
      setEnv('AUTH_CACHE_TTL_MS', '60000');
      invalidateAuthCache();
      expect((await request.get('/api/orders').set(bearer(c1.token))).status).toBe(200); // looked up, cached
      await prisma.user.update({ where: { id: c1.id }, data: { tokenVersion: 9 } }); // behind the application's back
      expect((await request.get('/api/orders').set(bearer(c1.token))).status).toBe(200); // still served from the cache (no query)
      invalidateAuthCache(c1.id);
      expect((await request.get('/api/orders').set(bearer(c1.token))).status).toBe(401); // looked up again: revoked
      // A bump made by the application (suspension / reset / delete) drops the entry itself: the very next request is refused.
      expect((await request.get('/api/orders').set(bearer(c3.token))).status).toBe(200);
      const { bumpTokenVersion } = await import('../../src/middleware/auth');
      await bumpTokenVersion(c3.id);
      expect((await request.get('/api/orders').set(bearer(c3.token))).status).toBe(401);
      // a ghost is never cached as "fine"
      const ghost = generateTestToken({ id: 'hd-ghost-2', phone: '+91 9777899993', role: 'STUDENT' as any });
      expect((await request.get('/api/orders').set(bearer(ghost))).status).toBe(401);
      await prisma.user.create({ data: { id: 'hd-ghost-2', name: 'Ghost Two', phone: '+91 9777899993', role: 'STUDENT' } });
      expect((await request.get('/api/orders').set(bearer(ghost))).status).toBe(200);
    });
  });

  // =========================================================================================
  // 6 + 7. Rate limits, trust proxy, admin login
  // =========================================================================================
  describe('6. rate limits', () => {
    test('the 9th order within the window is 429 RATE_LIMITED with retryAfterSeconds; limits are per user', async () => {
      setEnv('RL_ORDER_CREATE_MAX', '8');
      const [c1, c2] = W.customers; const [v1] = W.vendors;
      for (let i = 0; i < 8; i++) {
        const r = await api.place(c1, v1);
        expect(r.status).toBe(201);
        expect((await api.cancel(c1, r.body.data.id)).status).toBe(200); // keeps the 3-unpaid-orders rule out of the way
      }
      const ninth = await api.place(c1, v1);
      expect([ninth.status, ninth.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect(ninth.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(ninth.headers['retry-after'])).toBe(ninth.body.retryAfterSeconds);
      expect(await prisma.order.count({ where: { customerId: c1.id } })).toBe(8);
      expect((await api.place(c2, v1)).status).toBe(201); // another customer is unaffected
      expect((await api.list(c1)).status).toBe(200); // other routes of the limited user are unaffected
    });

    test('cancellations (5) and payment create-order (10) are limited per user', async () => {
      setEnv('RL_ORDER_CANCEL_MAX', '5');
      setEnv('RL_PAYMENT_CREATE_MAX', '10');
      const [c1, c2] = W.customers; const [v1] = W.vendors;
      for (let i = 0; i < 5; i++) {
        const id = await place(c1, v1);
        expect((await api.cancel(c1, id)).status).toBe(200);
      }
      const id = await place(c1, v1);
      const sixth = await api.cancel(c1, id);
      expect([sixth.status, sixth.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await row(id)).status).toBe('PLACED');
      const viaPatch = await api.setStatus(c1, id, 'CANCELLED'); // the other way to cancel is limited too
      expect(viaPatch.status).toBe(429);
      const id2 = await place(c2, v1);
      expect((await api.cancel(c2, id2)).status).toBe(200);

      const oid = await place(c2, v1);
      for (let i = 0; i < 10; i++) expect((await api.createPayment(c2, oid)).status).toBe(200); // the same order again and again (a double-tapping client)
      const eleventh = await api.createPayment(c2, oid);
      expect([eleventh.status, eleventh.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await api.createPayment(c1, id)).status).toBe(200); // another user is unaffected
    });

    test('per IP caps on the auth routes (X-Forwarded-For through the proxy) and window sweeping', async () => {
      setEnv('RL_AUTH_IP_MAX', '5');
      const hit = (ip: string) => request.post('/api/auth/google').set('X-Forwarded-For', ip).send({});
      for (let i = 0; i < 5; i++) expect((await hit('198.51.100.7')).status).toBe(400);
      const sixth = await hit('198.51.100.7');
      expect([sixth.status, sixth.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await hit('198.51.100.8')).status).toBe(400); // another address is fine
      // nginx appends the real client address: a client that prepends fake entries still lands in its own bucket
      expect((await hit('203.0.113.99, 198.51.100.7')).status).toBe(429);
      expect((await request.post('/api/auth/admin-login').set('X-Forwarded-For', '198.51.100.7').send({ passcode: 'x' })).status).toBe(429);
    });

    test('the default limits are the specified ones when not under test (8 orders / 5 cancels / 10 payments / 60 auth per window)', () => {
      const prev = process.env.NODE_ENV;
      for (const k of ['RL_ORDER_CREATE_MAX', 'RL_ORDER_CANCEL_MAX', 'RL_PAYMENT_CREATE_MAX', 'RL_AUTH_IP_MAX']) setEnv(k, undefined);
      process.env.NODE_ENV = 'production';
      try {
        const tok = generateTestToken({ id: 'hd-limit-user', phone: '+91 9777899992', role: 'STUDENT' as any });
        const call = (method: string, p: string, body: any = {}) => {
          let status = 200; let json: any = null;
          const res: any = { setHeader() {}, status(s: number) { status = s; return this; }, json(b: any) { json = b; return this; } };
          let nexted = false;
          rateLimitMiddleware({ method, path: p, body, headers: { authorization: `Bearer ${tok}` }, ip: '192.0.2.1', socket: {} } as any, res, () => { nexted = true; });
          return { nexted, status, json };
        };
        const run = (method: string, p: string, n: number, body?: any) => Array.from({ length: n + 1 }, () => call(method, p, body)).map((r) => r.nexted);
        expect(run('POST', '/orders', 8)).toEqual([...Array(8).fill(true), false]);
        expect(run('POST', '/orders/abc/cancel', 5)).toEqual([...Array(5).fill(true), false]);
        expect(run('POST', '/payments/create-order', 10)).toEqual([...Array(10).fill(true), false]);
        expect(run('POST', '/auth/google', 60)).toEqual([...Array(60).fill(true), false]);
        expect(call('POST', '/orders').json).toMatchObject({ code: 'RATE_LIMITED' });
      } finally {
        process.env.NODE_ENV = prev;
        __resetRateLimits();
      }
    });

    test('limiter bookkeeping: SlidingWindow / FailureLimiter drop idle keys', () => {
      const sw = new SlidingWindow();
      expect(sw.hit('a', 2, 1000, 0)).toEqual({ ok: true });
      expect(sw.hit('a', 2, 1000, 10)).toEqual({ ok: true });
      expect(sw.hit('a', 2, 1000, 20)).toEqual({ ok: false, retryAfterSeconds: 1 });
      expect(sw.hit('a', 2, 1000, 1001)).toEqual({ ok: true }); // window slid
      sw.sweep(5000);
      expect(sw.size).toBe(0);
      const fl = new FailureLimiter({ maxFails: 2, windowMs: 1000 });
      fl.fail('k', 0); expect(fl.blockedFor('k', 1)).toBe(0);
      fl.fail('k', 2); expect(fl.blockedFor('k', 3)).toBeGreaterThan(0);
      expect(fl.blockedFor('k', 900)).toBe(1);
      expect(fl.blockedFor('k', 1500)).toBe(0); // both failures left the window
      fl.sweep(10_000); expect(fl.size).toBe(0);
      expect(__rateLimitKeyCount()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('7. trust proxy, admin login, login limiter', () => {
    const adminLogin = (ip: string, passcode: string) => request.post('/api/auth/admin-login').set('X-Forwarded-For', ip).send({ passcode });

    test('wrong passcodes lock only THEIR address; the real admin from another address still gets in; only failures count; a success clears', async () => {
      for (let i = 0; i < 4; i++) expect((await adminLogin('192.0.2.10', 'wrong')).status).toBe(401);
      expect((await adminLogin('192.0.2.10', 'hardening-passcode-123')).status).toBe(200); // 4 typos then the right one: fine, and the count restarts
      for (let i = 0; i < 5; i++) expect((await adminLogin('192.0.2.10', 'wrong')).status).toBe(401);
      const locked = await adminLogin('192.0.2.10', 'wrong');
      expect([locked.status, locked.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
      expect((await adminLogin('192.0.2.10', 'hardening-passcode-123')).status).toBe(429); // the attacker's address stays locked, even with the right code
      const real = await adminLogin('192.0.2.11', 'hardening-passcode-123');
      expect(real.status).toBe(200);
      expect(real.body.token).toEqual(expect.any(String));
      // successful logins from one address are never counted against it
      for (let i = 0; i < 12; i++) expect((await adminLogin('192.0.2.12', 'hardening-passcode-123')).status).toBe(200);
      // the spoofed first entry does not move the attacker into a fresh bucket
      expect((await adminLogin('9.9.9.9, 192.0.2.10', 'wrong')).status).toBe(429);
    });

    test('partner-login also has a per-IP cap (30 wrong logins, any phone numbers); another IP is unaffected', async () => {
      const bad = (ip: string, n: number) => request.post('/api/auth/partner-login').set('X-Forwarded-For', ip).send({ phone: `90000${String(10000 + n)}`, password: 'wrong-password-1', role: 'VENDOR' });
      let last: any;
      for (let i = 0; i < 30; i++) last = await bad('192.0.2.20', i);
      expect(last.status).toBe(401);
      const blocked = await bad('192.0.2.20', 99);
      expect([blocked.status, blocked.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await bad('192.0.2.21', 1)).status).toBe(401);
    });

    test('the per-phone login limiter sweeps idle counters, not only finished locks', () => {
      __resetLoginLimiter();
      const t0 = Date.now();
      recordFailure('9000000001', t0); // one typo, then nothing
      for (let i = 0; i < 5; i++) recordFailure('9000000002', t0); // locked
      expect(__loginLimiterSize()).toBe(2);
      expect(isLocked('9000000002', t0 + 1000)).toBeGreaterThan(0);
      sweepLoginLimiter(t0 + 60_000);
      expect(__loginLimiterSize()).toBe(2); // neither idle long enough nor lock over
      sweepLoginLimiter(t0 + 16 * 60_000);
      expect(__loginLimiterSize()).toBe(0);
    });

    test('app.set("trust proxy", 1): the test app is configured like production', () => {
      expect(server.app.get('trust proxy')).toBe(1);
    });
  });

  // =========================================================================================
  // 8. Config guards
  // =========================================================================================
  describe('8. configuration', () => {
    const FULL = { JWT_SECRET: 's', DATABASE_URL: 'postgresql://x', ADMIN_PASSCODE: 'p', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 'ks', RAZORPAY_WEBHOOK_SECRET: 'w', GOOGLE_WEB_CLIENT_ID: 'g' };

    test('assertRuntimeConfig: every hard setting is required, GOOGLE_WEB_CLIENT_ID is only a warning', () => {
      expect(assertRuntimeConfig(FULL)).toEqual({ warnings: [] });
      for (const key of ['JWT_SECRET', 'DATABASE_URL', 'ADMIN_PASSCODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
        expect(() => assertRuntimeConfig({ ...FULL, [key]: undefined })).toThrow(new RegExp(key));
        expect(() => assertRuntimeConfig({ ...FULL, [key]: '   ' })).toThrow(new RegExp(key));
      }
      expect(() => assertRuntimeConfig({})).toThrow(/JWT_SECRET.*DATABASE_URL/);
      const soft = assertRuntimeConfig({ ...FULL, GOOGLE_WEB_CLIENT_ID: '' });
      expect(soft.warnings).toHaveLength(1);
      expect(soft.warnings[0]).toMatch(/GOOGLE_WEB_CLIENT_ID/);
    });

    test('the server refuses to boot without its secrets whenever NODE_ENV is not "test" (real src/index.ts in a child process)', () => {
      const bin = path.join(__dirname, '../../node_modules/.bin/ts-node');
      const script = path.join(__dirname, '../../src/index.ts');
      for (const nodeEnv of ['production', '']) {
        const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: path.join(__dirname, '../../tsconfig.json'), PORT: '0', ADMIN_PASSCODE: '' }; // Prisma loads backend/.env into the child whatever its cwd; this one is forced empty so it can never boot
        if (nodeEnv) env.NODE_ENV = nodeEnv;
        const r = spawnSync(bin, [script], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 60_000 }); // cwd without a .env file
        expect([nodeEnv, r.status === 0]).toEqual([nodeEnv, false]);
        expect(`${r.stderr}${r.stdout}`).toMatch(/Missing required configuration: .*ADMIN_PASSCODE/);
      }
    }, 120_000);
  });

  // =========================================================================================
  // 9. Error handling
  // =========================================================================================
  describe('9. errors', () => {
    test('garbage path ids are 400 (public routes) with no database text; oversized body 413; bad JSON 400', async () => {
      for (const url of ['/api/vendors/%00', '/api/menus/%00', '/api/vendors/' + 'a'.repeat(300), '/api/vendors/a%20b', '/api/menus/%E0%A4%A']) {
        const r = await request.get(url);
        expect([url.slice(0, 40), r.status >= 400 && r.status < 500]).toEqual([url.slice(0, 40), true]);
        expect(JSON.stringify(r.body)).not.toMatch(/prisma|invocation|\/home\/|node_modules|PrismaClient/i);
      }
      expect((await request.get('/api/vendors/%00')).status).toBe(400);
      expect((await request.get('/api/menus/%00')).status).toBe(400);
      expect((await request.get(`/api/orders/%00`).set(bearer(W.customers[0].token))).status).toBe(400);
      expect((await request.patch('/api/vendors/items/%00').set(bearer(W.vendors[0].token)).send({ price: 10 })).status).toBe(400);
      expect((await request.patch('/api/menus/%00/toggle').set(bearer(W.vendors[0].token))).status).toBe(400);
      expect((await request.post('/api/admin/partners/driver/%00/status').set(bearer(W.admin.token)).send({ status: 'APPROVED' })).status).toBe(400);
      expect((await request.get('/api/admin/customers/%00').set(bearer(W.admin.token))).status).toBe(400);

      const big = await request.post('/api/auth/google').set('Content-Type', 'application/json').send(JSON.stringify({ idToken: 'x'.repeat(200_000) }));
      expect([big.status, big.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      const bigAuthed = await request.post('/api/orders').set(bearer(W.customers[0].token)).send({ vendorId: 'v', items: [], dropoffNotes: 'n'.repeat(200_000) });
      expect(bigAuthed.status).toBe(413);
      const bad = await request.post('/api/auth/google').set('Content-Type', 'application/json').send('{"idToken": ');
      expect([bad.status, bad.body.message]).toEqual([400, 'Invalid or malformed JSON payload.']);
    });

    test('an unexpected error answers a generic 500 and never leaks Prisma text, paths or code; the cause is logged without query arguments', () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        let status = 0; let body: any;
        const res: any = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } };
        const leaky = Object.assign(new Error('\nInvalid `prisma.user.update()` invocation in\n/home/lucifer/app/src/routes/api.ts:55:20\n  data: { phone: "+91 9876543210", otpCode: "4821" }'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
        fail(res, leaky, 'test op');
        expect(status).toBe(500);
        expect(JSON.stringify(body)).not.toMatch(/prisma|home|9876543210|4821|invocation/i);
        expect(body.message).toBe('Something went wrong. Please try again.');
        const logged = errSpy.mock.calls.flat().join(' ');
        expect(logged).toContain('P2002');
        expect(logged).not.toMatch(/9876543210|4821/);
        const known = new OrderFlowError(409, 'X_CODE', 'readable message', { field: 'f' });
        fail(res, known, 'test op');
        expect([status, body]).toEqual([409, { success: false, code: 'X_CODE', message: 'readable message', field: 'f' }]);
      } finally { errSpy.mockRestore(); }
    });
  });

  // =========================================================================================
  // 10. Menu prices
  // =========================================================================================
  describe('10. menu prices', () => {
    test('POST /vendors/:id/items: negative, zero, NaN/null, string, huge, sub-paise, and over-long fields are 400; valid prices are stored exactly', async () => {
      const [v1, v2] = W.vendors;
      const post = (body: unknown, who: Person = v1) => request.post(`/api/vendors/${v1.vendorId}/items`).set(bearer(who.token)).send(body as any);
      for (const price of [-50, 0, 'abc', '120', null, 1e12, 10000.01, 10.005, 0.001, Infinity, true, {}, [1]]) {
        const r = await post({ name: 'Bad price', price });
        expect([JSON.stringify(price), r.status]).toEqual([JSON.stringify(price), 400]);
        expect(r.body.field).toBe('price');
      }
      expect((await post({ name: 'No price' })).status).toBe(400);
      expect((await post({ price: 50 })).status).toBe(400);
      expect((await post({ name: 'x'.repeat(81), price: 50 })).status).toBe(400);
      expect((await post({ name: 'ok', price: 50, category: 'c'.repeat(41) })).status).toBe(400);
      expect((await post({ name: 'ok', price: 50, description: 'd'.repeat(301) })).status).toBe(400);
      expect((await post({ name: 'ok', price: 50, imageUrl: 'javascript:alert(1)' })).status).toBe(400);
      expect((await post({ name: 'ok', price: 50, isVeg: 'yes' })).status).toBe(400);
      expect((await post({ name: { $ne: 1 }, price: 50 })).status).toBe(400);
      expect(await prisma.menuItem.count({ where: { vendorId: v1.vendorId, name: { in: ['Bad price', 'No price', 'ok'] } } })).toBe(0);
      const ok = await post({ name: '  Fresh   Lime ', price: 19.99, category: 'Drinks', description: 'cold' });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ name: 'Fresh Lime', price: 19.99, category: 'Drinks', isAvailable: true });
      expect((await post({ name: 'Max', price: 10000 })).status).toBe(201);
      expect((await post({ name: 'Min', price: 0.01 })).status).toBe(201);
      expect((await post({ name: 'Not mine', price: 10 }, v2)).status).toBe(403);
    });

    test('PATCH /vendors/items/:itemId: the same price rules (no silent ignore), empty body 400, availability toggles', async () => {
      const [v1] = W.vendors;
      const itemId = v1.items[0].id;
      const patch = (body: unknown) => request.patch(`/api/vendors/items/${itemId}`).set(bearer(v1.token)).send(body as any);
      for (const price of [-1, 0, 'abc', '10', null, 1e12, 10.005, 10000.5, false]) {
        const r = await patch({ price });
        expect([JSON.stringify(price), r.status]).toEqual([JSON.stringify(price), 400]);
      }
      expect((await patch({})).status).toBe(400);
      expect((await patch({ isAvailable: 'no' })).status).toBe(400);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } })).price).toBe(180);
      expect((await patch({ price: 175.5 })).body.item.price).toBe(175.5);
      expect((await patch({ isAvailable: false })).body.item.isAvailable).toBe(false);
    });
  });

  // =========================================================================================
  // 11. Sockets
  // =========================================================================================
  describe('11. sockets', () => {
    test('a suspended restaurant cannot join its room, loses it at the moment of suspension and is not reconnectable; re-approval restores', async () => {
      const [v1] = W.vendors; const [c1] = W.customers;
      const wv = await watch(v1);
      expect(await wv.join(`vendor_${v1.vendorId}`)).toBe(true);
      expect((await api.partnerStatus(W.admin, 'vendor', v1.vendorId, 'SUSPENDED')).status).toBe(200);
      await sleep(150);
      expect(wv.connected).toBe(false); // revoked + closed
      // A brand-new connection with a fresh token: connects, but is not put in the room, and join_room says no.
      const v1n = await reissue(v1);
      const w2 = await watch(v1n);
      expect(await w2.join(`vendor_${v1.vendorId}`)).toBe(false);
      const id = await placePaid(c1, W.vendors[1]); // unrelated order, just proves the socket stays quiet
      expect(w2.events.filter((e) => e.event === 'new_order_alert' || e.event === 'order_updated')).toEqual([]);
      void id;
      // the owner pending/rejected the same
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { approvalStatus: 'PENDING' } });
      expect(await w2.join(`vendor_${v1.vendorId}`)).toBe(false);
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { approvalStatus: 'APPROVED' } });
      expect(await w2.join(`vendor_${v1.vendorId}`)).toBe(true);
    });

    test('restaurant alerts reach the restaurant room only while the restaurant is APPROVED', async () => {
      const [v1] = W.vendors; const [c1] = W.customers;
      const idQuiet = await place(c1, v1);
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { approvalStatus: 'SUSPENDED' } }); // direct: the token stays valid
      const quiet = await watch(v1); // connects with a valid token but is not auto-joined
      await pay(c1, idQuiet);
      await quiet.flush();
      expect(quiet.of('new_order_alert', idQuiet)).toHaveLength(0);
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { approvalStatus: 'APPROVED' } });
      const live = await watch(v1);
      const idLive = await placePaid(c1, v1);
      await live.flush();
      expect(live.of('new_order_alert', idLive)).toHaveLength(1);
    });

    test('order_available goes only to riders who are ONLINE and approved; going OFFLINE leaves the room, going ONLINE rejoins it', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2, r3] = W.riders;
      await prisma.driverPartner.update({ where: { id: r2.profileId }, data: { dutyStatus: 'OFFLINE' } });
      await prisma.driverPartner.update({ where: { id: r3.profileId }, data: { dutyStatus: 'ONLINE' } });
      const w1 = await watch(r1); const w2 = await watch(r2); const w3 = await watch(r3);
      expect(await w2.join('drivers')).toBe(false); // off duty: not allowed into the room
      const first = await placePaid(c1, v1);
      expect((await api.setStatus(v1, first, 'ACCEPTED')).status).toBe(200);
      await Promise.all([w1.flush(), w2.flush(), w3.flush()]);
      expect([w1.count('order_available', first), w2.count('order_available', first), w3.count('order_available', first)]).toEqual([1, 0, 1]);

      // r3 goes off duty through the API: leaves the room at once and hears nothing more
      expect((await api.duty(r3, false)).status).toBe(200);
      const second = await placePaid(c1, v1);
      expect((await api.setStatus(v1, second, 'ACCEPTED')).status).toBe(200);
      await Promise.all([w1.flush(), w3.flush()]);
      expect([w1.count('order_available', second), w3.count('order_available', second)]).toEqual([1, 0]);

      // r2 goes on duty: the already open socket joins the room and receives the next offer
      expect((await api.duty(r2, true)).status).toBe(200);
      const third = await placePaid(c1, v1);
      expect((await api.setStatus(v1, third, 'ACCEPTED')).status).toBe(200);
      await Promise.all([w1.flush(), w2.flush(), w3.flush()]);
      expect([w1.count('order_available', third), w2.count('order_available', third), w3.count('order_available', third)]).toEqual([1, 1, 0]);

      // belt and braces: a socket still in the room while the database says OFFLINE does not get offers
      await prisma.driverPartner.update({ where: { id: r1.profileId }, data: { dutyStatus: 'OFFLINE' } });
      const fourth = await placePaid(c1, v1);
      expect((await api.setStatus(v1, fourth, 'ACCEPTED')).status).toBe(200);
      await Promise.all([w1.flush(), w2.flush()]);
      expect([w1.count('order_available', fourth), w2.count('order_available', fourth)]).toEqual([0, 1]);
    });

    test('logout takes a rider out of the drivers room', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const w1 = await watch(r1);
      expect((await request.post('/api/auth/logout').set(bearer(r1.token))).status).toBe(200);
      const id = await placePaid(c1, v1);
      expect((await api.setStatus(v1, id, 'ACCEPTED')).status).toBe(200);
      await w1.flush();
      expect(w1.count('order_available', id)).toBe(0);
    });
  });

  // =========================================================================================
  // 12. Google sign-in identity
  // =========================================================================================
  describe('12. google identity', () => {
    const login = (email: string, sub: string) => {
      setGoogleVerifier(async () => ({ sub, email, emailVerified: true, name: 'Google Person' }));
      return request.post('/api/auth/google').send({ idToken: 'g'.repeat(40) });
    };

    test('match by googleSub first; link by email only when the stored googleSub is NULL; never overwrite a different googleSub', async () => {
      const email = 'link@hardening.test';
      await prisma.user.create({ data: { id: 'hd-g-nosub', name: 'No Sub', email, role: 'STUDENT' } }); // e.g. created by an admin: email, no sub
      const linked = await login(email, 'g-sub-A');
      expect([linked.status, linked.body.isNewUser, linked.body.user.id]).toEqual([200, false, 'hd-g-nosub']);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: 'hd-g-nosub' } })).googleSub).toBe('g-sub-A');

      // Another Google account that claims the same email must NOT take the account over.
      const hijack = await login(email, 'g-sub-B');
      expect([hijack.status, hijack.body.code]).toEqual([409, 'ACCOUNT_CONFLICT']);
      expect(hijack.body.token).toBeUndefined();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: 'hd-g-nosub' } })).googleSub).toBe('g-sub-A');
      expect(await prisma.user.count({ where: { googleSub: 'g-sub-B' } })).toBe(0);

      // The owner of the sub is found by sub even when Google reports a changed email.
      const moved = await login('moved@hardening.test', 'g-sub-A');
      expect([moved.status, moved.body.user.id, moved.body.user.email]).toEqual([200, 'hd-g-nosub', 'moved@hardening.test']);
      expect(await prisma.user.count({ where: { googleSub: 'g-sub-A' } })).toBe(1);

      // A changed email that belongs to somebody else is a conflict, not a crash.
      await prisma.user.create({ data: { id: 'hd-g-other', name: 'Other', email: 'taken@hardening.test', googleSub: 'g-sub-Z', role: 'STUDENT' } });
      const clash = await login('taken@hardening.test', 'g-sub-A');
      expect([clash.status, clash.body.code]).toEqual([409, 'ACCOUNT_CONFLICT']);
      // A partner's e-mail is still a partner account
      await prisma.user.create({ data: { id: 'hd-g-partner', name: 'Partner Person', email: 'partner@hardening.test', role: 'VENDOR' } });
      expect((await login('partner@hardening.test', 'g-sub-P')).status).toBe(403);
    });
  });

  // =========================================================================================
  // 13. Public vendor shape
  // =========================================================================================
  describe('13. public catalogue', () => {
    test('customers (and anonymous callers) get only what the app needs; the admin and the owner keep the full row', async () => {
      const [v1, v2] = W.vendors;
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { fssaiNumber: '12345678901234' } });
      const allowedVendor = ['id', 'name', 'category', 'rating', 'totalRatingsCount', 'eta', 'bannerImage', 'address', 'isAcceptingOrders', 'lat', 'lng', 'menuItems'];
      const allowedItem = ['id', 'vendorId', 'name', 'price', 'category', 'description', 'imageUrl', 'isAvailable', 'isVeg', 'rating', 'ratingCount'];
      const ownerHeaders = bearer(v2.token);
      for (const headers of [{}, bearer(W.customers[0].token), ownerHeaders, bearer(W.riders[0].token)]) {
        const list = await request.get('/api/vendors').set(headers);
        const mine = list.body.data.find((v: any) => v.id === v1.vendorId);
        expect(Object.keys(mine).sort()).toEqual([...allowedVendor].sort());
        expect(mine.menuItems.length).toBeGreaterThan(0);
        for (const item of mine.menuItems) expect(Object.keys(item).sort()).toEqual([...allowedItem].sort());
        // every restaurant in the list has the public shape, except the viewer's own (the owner keeps the full row)
        const notOwn = list.body.data.filter((v: any) => v.userId !== (headers as any).Authorization?.slice(7) && v.id !== (headers === ownerHeaders ? v2.vendorId : ''));
        expect(JSON.stringify(notOwn)).not.toMatch(/fssaiNumber|userId|approvalStatus|rejectionReason|appliedAt|reviewedAt|createdAt|updatedAt/);
        const one = await request.get(`/api/vendors/${v1.vendorId}`).set(headers);
        expect(Object.keys(one.body.data).sort()).toEqual([...allowedVendor, 'menu'].sort());
        expect(one.body.data.menu).toEqual(one.body.data.menuItems);
        const menu = await request.get(`/api/menus/${v1.vendorId}`).set(headers);
        expect(Object.keys(menu.body.data[0]).sort()).toEqual([...allowedItem].sort());
      }
      for (const who of [W.admin, v1]) {
        const one = await request.get(`/api/vendors/${v1.vendorId}`).set(bearer(who.token));
        expect(one.body.data).toMatchObject({ userId: v1.id, fssaiNumber: '12345678901234', approvalStatus: 'APPROVED' });
        const list = await request.get('/api/vendors').set(bearer(who.token));
        expect(list.body.data.find((v: any) => v.id === v1.vendorId)).toHaveProperty('fssaiNumber');
        const menu = await request.get(`/api/menus/${v1.vendorId}`).set(bearer(who.token));
        expect(menu.body.data[0]).toHaveProperty('createdAt');
      }
      // another restaurant's owner sees the public shape of this restaurant
      const other = await request.get(`/api/vendors/${v1.vendorId}`).set(bearer(v2.token));
      expect(other.body.data).not.toHaveProperty('fssaiNumber');
      // suspended restaurants stay invisible to the public
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { approvalStatus: 'SUSPENDED' } });
      expect((await request.get(`/api/vendors/${v1.vendorId}`)).status).toBe(404);
      expect((await request.get(`/api/vendors/${v1.vendorId}`).set(bearer(W.admin.token))).status).toBe(200);
    });
  });

  // =========================================================================================
  // 15. Admin reassign rules
  // =========================================================================================
  describe('15. reassign', () => {
    test('a rider never gets a second active order (RIDER_BUSY, force does not override); concurrent claim vs reassign cannot double-book', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const a = await placePaid(c1, v1); await driveTo(a, 'CLAIMED', v1, r1);
      const b = await placePaid(c1, v1); await driveTo(b, 'CLAIMED', v1, r2);
      for (const force of [undefined, true]) {
        const re = await api.reassign(W.admin, b, r1.profileId, force);
        expect([re.status, re.body.code]).toEqual([409, 'RIDER_BUSY']);
      }
      expect((await row(b)).driverId).toBe(r2.id);
      // free order c: admin assigns it while r2 also tries to claim a third order: the rider ends with one active order
      const c = await placePaid(c1, v1);
      expect((await api.setStatus(v1, c, 'ACCEPTED')).status).toBe(200);
      const d = await placePaid(c1, v1);
      expect((await api.setStatus(v1, d, 'ACCEPTED')).status).toBe(200);
      const r3 = W.riders[2];
      const race = await Promise.all([api.reassign(W.admin, c, r3.profileId), api.claim(r3, d), api.reassign(W.admin, c, r3.profileId), api.claim(r3, c)]);
      expect(race.every((x) => x.status < 500)).toBe(true);
      const active = await prisma.order.count({ where: { driverId: r3.id, status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] } } });
      expect(active).toBe(1);
      // moving the order the rider already holds to the same rider is a no-op, not RIDER_BUSY
      const held = (await prisma.order.findFirstOrThrow({ where: { driverId: r3.id, status: 'ACCEPTED' } })).id;
      expect((await api.reassign(W.admin, held, r3.profileId)).status).toBe(200);
    });

    test('un-assigning is refused once the food is picked up; before that it returns the order to the pool', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const a = await placePaid(c1, v1); await driveTo(a, 'PICKED_UP', v1, r1);
      const picked = await api.reassign(W.admin, a, null);
      expect([picked.status, picked.body.code]).toEqual([409, 'CANNOT_UNASSIGN']);
      expect((await api.setStatus(r1, a, 'ARRIVED_AT_GATE')).status).toBe(200);
      expect((await api.reassign(W.admin, a, null)).body.code).toBe('CANNOT_UNASSIGN'); // also at the gate
      expect((await row(a)).driverId).toBe(r1.id);
      const b = await placePaid(c1, v1); await driveTo(b, 'READY_FOR_PICKUP', v1, r2);
      expect((await api.claim(r2, b)).status).toBe(200);
      expect((await api.reassign(W.admin, b, null)).status).toBe(200);
      expect((await row(b)).driverId).toBeNull();
    });

    test('an OFFLINE rider is refused (RIDER_OFFLINE) unless the admin sends force: true; force must be a boolean', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [, r2] = W.riders;
      const a = await placePaid(c1, v1);
      expect((await api.setStatus(v1, a, 'ACCEPTED')).status).toBe(200);
      await prisma.driverPartner.update({ where: { id: r2.profileId }, data: { dutyStatus: 'OFFLINE' } });
      const refused = await api.reassign(W.admin, a, r2.profileId);
      expect([refused.status, refused.body.code]).toEqual([409, 'RIDER_OFFLINE']);
      expect((await api.reassign(W.admin, a, r2.profileId, false)).status).toBe(409);
      expect((await api.raw('admin', 'patch', `/api/orders/${a}/reassign`, W.admin.token, { driverId: r2.profileId, force: 'yes' })).status).toBe(400);
      expect((await row(a)).driverId).toBeNull();
      const forced = await api.reassign(W.admin, a, r2.profileId, true);
      expect([forced.status, forced.body.data.driver.id]).toEqual([200, r2.id]);
      expect(await prisma.adminAuditLog.count({ where: { action: 'ORDER_REASSIGNED', targetId: a, summary: { contains: 'Forced' } } })).toBe(1);
      // an online rider needs no force
      const [, , r3] = W.riders;
      expect((await api.reassign(W.admin, a, r3.profileId)).status).toBe(200);
    });
  });

  // =========================================================================================
  // 16. Claim of a cancelled order, gate OTP on a delivered order
  // =========================================================================================
  describe('16. terminal orders', () => {
    test('a second rider claiming a CANCELLED order that still has a driverId gets ORDER_NOT_AVAILABLE, not ALREADY_TAKEN', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const a = await placePaid(c1, v1); await driveTo(a, 'CLAIMED', v1, r1);
      expect((await api.adminCancel(W.admin, a)).status).toBe(200);
      expect((await row(a)).driverId).toBe(r1.id);
      const second = await api.claim(r2, a);
      expect([second.status, second.body.code]).toEqual([409, 'ORDER_NOT_AVAILABLE']);
      const same = await api.claim(r1, a); // the former carrier too: it is over
      expect([same.status, same.body.code]).toEqual([409, 'ORDER_NOT_AVAILABLE']);
      // a live order held by someone else is still ALREADY_TAKEN
      const b = await placePaid(c1, v1); await driveTo(b, 'CLAIMED', v1, r1);
      expect((await api.claim(r2, b)).body.code).toBe('ALREADY_TAKEN');
    });

    test('verify-gate-otp on a DELIVERED order: only the retry of the SAME code is the idempotent success; a wrong / missing code or an unassigned rider never gets one', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1, r2] = W.riders;
      const { id, otp } = await deliver(c1, v1, r1);
      const wrong = otp === '1234' ? '4321' : '1234';
      const retry = await api.otp(r1, id, otp);
      expect([retry.status, retry.body.message]).toEqual([200, expect.stringMatching(/already DELIVERED/)]);
      expect((await api.otp(r1, id, Number(otp))).status).toBe(200); // number form of the same code
      for (const bad of [wrong, undefined, '', 'abcd', null]) {
        const r = await api.otp(r1, id, bad);
        expect([String(bad), r.status, r.body.code, r.body.success]).toEqual([String(bad), 409, 'ALREADY_DELIVERED', false]);
      }
      expect((await api.otp(r2, id, otp)).status).toBe(404); // another rider never learns anything
      expect((await api.setStatus(r1, id, 'DELIVERED', { otpCode: wrong })).status).toBe(409);
      expect((await api.setStatus(r1, id, 'DELIVERED', { otpCode: otp })).status).toBe(200);
      expect((await api.otp(W.admin, id, wrong)).status).toBe(200); // the admin can always see the order is done
      const o = await row(id);
      expect([o.otpCode, o.otpAttempts, o.status]).toEqual(['USED', 0, 'DELIVERED']);
      expect(o.otpProof).toMatch(/^[0-9a-f]{64}$/);
      expect(o.otpProof).not.toContain(otp);
    });
  });

  // =========================================================================================
  // 17. clientRequestId
  // =========================================================================================
  describe('17. idempotency key', () => {
    test('the same clientRequestId with a different vendor, items, quantity, drop point, notes or coupon is 409 CLIENT_REQUEST_MISMATCH; the identical request replays', async () => {
      const [c1] = W.customers; const [v1, v2] = W.vendors;
      const key = randomUUID();
      const body = { clientRequestId: key, dropoffHostel: 'Block 2', dropoffNotes: 'Room 214' };
      const first = await api.place(c1, v1, body, 0, 2);
      expect(first.status).toBe(201);
      const id = first.body.data.id;
      const same = await api.place(c1, v1, body, 0, 2);
      expect([same.status, same.body.idempotentReplay, same.body.data.id]).toEqual([200, true, id]);
      // item order does not matter
      const twoLines = { clientRequestId: randomUUID(), items: [{ itemId: v1.items[0].id, quantity: 1 }, { itemId: v1.items[1].id, quantity: 2 }] };
      const t1 = await api.raw('c', 'post', '/api/orders', c1.token, { vendorId: v1.vendorId, dropoffHostel: 'Block 2', ...twoLines });
      expect(t1.status).toBe(201);
      const t2 = await api.raw('c', 'post', '/api/orders', c1.token, { vendorId: v1.vendorId, dropoffHostel: 'Block 2', clientRequestId: twoLines.clientRequestId, items: [...twoLines.items].reverse() });
      expect([t2.status, t2.body.data.id]).toEqual([200, t1.body.data.id]);

      const variants: [string, () => Promise<any>][] = [
        ['quantity', () => api.place(c1, v1, body, 0, 3)],
        ['item', () => api.place(c1, v1, body, 1, 2)],
        ['vendor', () => api.place(c1, v2, body, 0, 2)],
        ['dropoff', () => api.place(c1, v1, { ...body, dropoffHostel: 'Block 5' }, 0, 2)],
        ['notes', () => api.place(c1, v1, { ...body, dropoffNotes: 'Other room' }, 0, 2)],
        ['coupon', () => api.place(c1, v1, { ...body, couponCode: 'KRAVEO50' }, 0, 2)],
        ['extra line', () => api.raw('c', 'post', '/api/orders', c1.token, { vendorId: v1.vendorId, dropoffHostel: 'Block 2', dropoffNotes: 'Room 214', clientRequestId: key, items: [{ itemId: v1.items[0].id, quantity: 2 }, { itemId: v1.items[1].id, quantity: 1 }] })],
      ];
      for (const [what, send] of variants) {
        const r = await send();
        expect([what, r.status, r.body.code]).toEqual([what, 409, 'CLIENT_REQUEST_MISMATCH']);
        expect(r.body.data).toBeUndefined();
      }
      expect(await prisma.order.count({ where: { id } })).toBe(1);
      // two simultaneous requests with the same key and the same payload -> one order; with different payloads -> one order + one mismatch
      const c2 = W.customers[1];
      const k2 = randomUUID();
      const same2 = await Promise.all([api.place(c2, v1, { clientRequestId: k2 }), api.place(c2, v1, { clientRequestId: k2 })]);
      expect(same2.map((r) => r.status).sort()).toEqual([200, 201]);
      const k3 = randomUUID();
      const diff = await Promise.all([api.place(c2, v1, { clientRequestId: k3 }, 0, 1), api.place(c2, v1, { clientRequestId: k3 }, 0, 2)]);
      expect(diff.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.order.count({ where: { customerId: c2.id, clientRequestId: k3 } })).toBe(1);
    });
  });
});
