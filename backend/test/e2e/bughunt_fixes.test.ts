/**
 * Pre-demo bug hunt fixes (6 Oct 2026, Docs/bughunt/BE1_orders_money.md and BE2_auth_security_admin.md). One group per fixed
 * finding; each test here failed before the fix. Real PostgreSQL, real sockets, payment provider replaced by the in-memory ledger.
 */
import http from 'http';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { prisma, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { setPaymentProvider } from '../../src/services/paymentService';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits, rateLimitMiddleware, normalizedPath } from '../../src/middleware/rateLimit';
import { __resetSignupLimiter } from '../../src/routes/partners';
import { __resetAdminLoginLimiter } from '../../src/routes/api';
import { __resetLoginLimiter } from '../../src/services/loginLimiter';
import { invalidateAuthCache } from '../../src/middleware/auth';
import { NAME_RE } from '../../src/utils/names';
import { startOfIstDay, istHour } from '../../src/utils/time';
import { createProcessGuards } from '../../src/processGuards';
import { JOIN_LIMIT, MAX_ORDER_ROOMS_PER_SOCKET } from '../../src/realtime';
import { generateTestToken } from '../harness/auth';
import {
  World, Person, Customer, Vendor, Rider, Watcher, Ledger, Api, createWorld, purgeWorld, resetWorldState, createLedger, createApi,
} from '../harness/journey';

jest.setTimeout(60_000);

const ZZ = 'ZZ Bughunt';

describe('Pre-demo bug hunt fixes', () => {
  let server: TestServerInstance;
  let W: World;
  let api: Api;
  let ledger: Ledger;
  let request: ReturnType<typeof supertest>;
  let watchers: Watcher[] = [];
  const envBackup: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in envBackup)) envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  const restoreEnv = () => { for (const k of Object.keys(envBackup)) { if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k]; delete envBackup[k]; } };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const watch = async (p: Person) => { const w = await new Watcher(server.baseUrl, p).connect(); watchers.push(w); return w; };
  const row = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    return payId;
  };
  const driveTo = async (id: string, target: string, v: Vendor, r: Rider) => {
    for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CLAIMED', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
      if (st === 'CLAIMED') expect((await api.claim(r, id)).status).toBe(200);
      else if (['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(st)) expect((await api.setStatus(v, id, st)).status).toBe(200);
      else expect((await api.setStatus(r, id, st)).status).toBe(200);
      if (st === target) return;
    }
  };

  const cleanupPartners = async () => {
    await prisma.vendor.deleteMany({ where: { name: { startsWith: ZZ } } });
    await prisma.driverPartner.deleteMany({ where: { phone: { startsWith: '+91 9000' } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetType: 'PARTNER' } });
    await cleanTestUsers();
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanupPartners();
    W = await createWorld('bf', '9', { customers: 4, vendors: 2, riders: 2 });
    server = await startTestServer(0);
    api = createApi(server.baseUrl);
    request = supertest(server.app);
  });
  beforeEach(async () => {
    await resetWorldState(W);
    ledger = createLedger();
    setPaymentProvider(ledger.provider);
    __resetRateLimits(); __resetSignupLimiter(); __resetAdminLoginLimiter(); __resetLoginLimiter(); invalidateAuthCache();
    api.calls.length = 0;
  });
  afterEach(async () => {
    await __waitForBackgroundWork();
    for (const w of watchers) w.disconnect();
    watchers = [];
    setPaymentProvider(null);
    restoreEnv();
  });
  afterAll(async () => {
    await stopTestServer(server);
    await purgeWorld('bf');
    await cleanupPartners();
    await cleanTestOrders();
    await prisma.$disconnect();
  });

  // =========================================================================================
  // 1. BE2-02 names
  // =========================================================================================
  describe('1. person names accept every script, marks, curly apostrophes and digits', () => {
    test.each([
      'राहुल शर्मा', 'அருண் குமார்', "D’Souza", "D'Souza", 'Anne-Marie Smith Jr.', 'RAHUL SHARMA 22BCE10123', 'Ab', 'محمد علي', '李小龍',
    ])('accepts %s', (name) => expect(NAME_RE.test(name)).toBe(true));
    test.each([
      'A', '', '9Rahul', ' Rahul', 'Ramesh 😀', '<script>alert(1)</script>', 'Rahul <b>', 'Rahul\u0000Sharma', 'Rahul\nSharma', 'Rahul\tSharma', 'Rahul_Sharma', 'a'.repeat(61),
    ])('rejects %j', (name) => expect(NAME_RE.test(name)).toBe(false));
    test('exactly 60 characters is the limit', () => {
      expect(NAME_RE.test('a'.repeat(60))).toBe(true);
      expect(NAME_RE.test('राहुल'.repeat(12))).toBe(true);
    });

    test('profile save: Hindi name, a Google name with digits and a curly apostrophe are saved; markup and emoji are refused', async () => {
      const c = W.customers[0];
      const put = (name: string) => request.put('/api/auth/profile').set(bearer(c.token)).send({ name });
      for (const name of ['राहुल शर्मा', 'RAHUL SHARMA 22BCE10123', 'Mary D’Souza']) {
        const res = await put(name);
        expect([name, res.status]).toEqual([name, 200]);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).name).toBe(name);
      }
      for (const name of ['<b>Rahul</b>', 'Rahul 😀', 'R']) {
        const res = await put(name);
        expect([name, res.status, res.body.field]).toEqual([name, 400, 'name']);
      }
    });

    test('partner sign-up accepts a Hindi owner name', async () => {
      const res = await request.post('/api/auth/partner-signup').send({
        role: 'VENDOR', name: 'रमेश कुमार', phone: '9000001001', password: 'Sup3rSecret!', restaurantName: `${ZZ} Hindi`, category: 'North Indian', address: 'Ashta road, near gate 2',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.name).toBe('रमेश कुमार');
    });
  });

  // =========================================================================================
  // 2. BE2-05 / BE1-07 rate limit rules are matched on a normalised path
  // =========================================================================================
  describe('2. rate-limit rules cannot be skipped by spelling the URL differently', () => {
    test('normalizedPath', () => {
      expect(normalizedPath('/orders/')).toBe('/orders');
      expect(normalizedPath('/ORDERS')).toBe('/orders');
      expect(normalizedPath('//orders//')).toBe('/orders');
      expect(normalizedPath('/Payments/Create-Order///')).toBe('/payments/create-order');
      expect(normalizedPath('/')).toBe('/');
      expect(normalizedPath('')).toBe('/');
    });

    test('every rule fires for trailing slash, upper case and double slash spellings (rule unit test)', () => {
      const prev = process.env.NODE_ENV;
      for (const k of ['RL_ORDER_CREATE_MAX', 'RL_ORDER_CANCEL_MAX', 'RL_PAYMENT_CREATE_MAX', 'RL_AUTH_IP_MAX', 'RL_DEVICE_WRITE_MAX', 'RL_VENDOR_LOCATION_MAX']) setEnv(k, undefined);
      process.env.NODE_ENV = 'production';
      try {
        const tok = generateTestToken({ id: 'bf-limit-user', phone: '+91 9777999992', role: 'STUDENT' as any });
        const attempt = (method: string, p: string, body: any = {}) => {
          let nexted = false;
          const res: any = { setHeader() {}, status() { return this; }, json() { return this; } };
          rateLimitMiddleware({ method, path: p, body, headers: { authorization: `Bearer ${tok}` }, ip: '192.0.2.1', socket: {} } as any, res, () => { nexted = true; });
          return nexted;
        };
        const cases: [string, string, string[], number, any?][] = [
          ['POST', 'ORDER_CREATE', ['/orders', '/orders/', '/ORDERS', '//orders//', '/Orders/'], 8],
          ['POST', 'ORDER_CANCEL', ['/orders/abc/cancel', '/orders/abc/cancel/', '/ORDERS/ABC/CANCEL', '/orders//abc/cancel'], 5],
          ['PATCH', 'ORDER_CANCEL (patch)', ['/orders/abc/status', '/orders/abc/status/', '/Orders/ABC/Status'], 5, { status: 'CANCELLED' }],
          ['POST', 'PAYMENT_CREATE', ['/payments/create-order', '/payments/create-order/', '/PAYMENTS/Create-Order'], 10],
          ['POST', 'DEVICE_WRITE', ['/devices', '/devices/', '/DEVICES'], 30],
          ['PUT', 'VENDOR_LOCATION', ['/partner/vendor/location', '/partner/vendor/location/', '/PARTNER/Vendor/Location'], 10],
          ['POST', 'AUTH_IP', ['/auth/google', '/auth/google/', '/AUTH/Google', '/auth/partner-login/', '/Auth/Admin-Login', '/auth/partner-signup//'], 60],
        ];
        for (const [method, name, spellings, max, body] of cases) {
          __resetRateLimits();
          // Spend the whole budget with a rotation of spellings: the next request, in ANY spelling, must be refused.
          for (let i = 0; i < max; i++) expect([name, attempt(method, spellings[i % spellings.length], body)]).toEqual([name, true]);
          for (const sp of spellings) expect([name, sp, attempt(method, sp, body)]).toEqual([name, sp, false]);
        }
        // not matched: other paths and other methods keep passing
        __resetRateLimits();
        for (let i = 0; i < 100; i++) expect(attempt('GET', '/orders/')).toBe(true);
        expect(attempt('POST', '/orders/abc/status', { status: 'ACCEPTED' })).toBe(true);
      } finally {
        process.env.NODE_ENV = prev;
        __resetRateLimits();
      }
    });

    test('through the real app: POST /api/orders/ and /api/ORDERS count against the same 8-per-window order limit', async () => {
      setEnv('RL_ORDER_CREATE_MAX', '3');
      const c = W.customers[1]; const v = W.vendors[0];
      const body = () => ({ vendorId: v.vendorId, items: [{ itemId: v.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2', clientRequestId: randomUUID() });
      const statuses: number[] = [];
      for (const url of ['/api/orders', '/api/orders/', '/api/ORDERS', '/api/Orders/']) {
        statuses.push((await request.post(url).set(bearer(c.token)).send(body())).status);
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
    });

    test('through the real app: payments/create-order with a trailing slash is limited', async () => {
      setEnv('RL_PAYMENT_CREATE_MAX', '2');
      const c = W.customers[1]; const v = W.vendors[0];
      const id = await place(c, v);
      const out: number[] = [];
      for (const url of ['/api/payments/create-order/', '/api/payments/create-order', '/api/PAYMENTS/create-order/']) {
        out.push((await request.post(url).set(bearer(c.token)).send({ orderId: id })).status);
      }
      expect(out).toEqual([200, 200, 429]);
    });
  });

  // =========================================================================================
  // 3. BE2-04 partner sign-up throttle
  // =========================================================================================
  describe('3. partner sign-up throttle counts only real sign-ups', () => {
    const body = (phone: string, extra: object = {}) => ({
      role: 'DRIVER', name: 'Sunil Verma', phone, password: 'Sup3rSecret!', vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234', emergencyPhone: '9000009999', ...extra,
    });
    const signup = (b: object, ip = '198.51.100.20') => request.post('/api/auth/partner-signup').set('X-Forwarded-For', ip).send(b);

    test('"already registered" (409) answers and validation failures never use up the visitor\'s allowance', async () => {
      expect((await signup(body('9000002001'))).status).toBe(201);
      for (let i = 0; i < 6; i++) expect((await signup(body('9000002001'))).status).toBe(409); // a presenter retrying a number that exists
      for (let i = 0; i < 6; i++) expect((await signup(body('9000002002', { name: 'X' }))).status).toBe(400); // typos
      expect((await signup(body('9000002002'))).status).toBe(201); // the same phone as the typos, from the same address, still works
      expect((await signup(body('9000002003'))).status).toBe(201);
    });

    test('rehearsal: the same phone signs up, is deleted, and signs up again without hitting a limit', async () => {
      for (let i = 0; i < 2; i++) {
        const r = await signup(body('9000002010'));
        expect([i, r.status]).toEqual([i, 201]);
        await prisma.driverPartner.deleteMany({ where: { userId: r.body.user.id } });
        await prisma.user.delete({ where: { id: r.body.user.id } });
      }
    });

    test('still effective against scripted spam: 10 sign-ups per address and hour, 3 per phone, 80 overall', async () => {
      for (let i = 0; i < 10; i++) expect([i, (await signup(body(`90000030${String(i).padStart(2, '0')}`), '203.0.113.5')).status]).toEqual([i, 201]);
      const eleventh = await signup(body('9000003099'), '203.0.113.5');
      expect([eleventh.status, eleventh.body.message]).toEqual([429, 'Too many sign-up attempts. Please try again in an hour.']);
      expect((await signup(body('9000003098'), '203.0.113.6')).status).toBe(201); // another address is unaffected
      expect(await prisma.user.count({ where: { phone: { startsWith: '+91 900000300' } } })).toBe(10);
    });

    test('slots of duplicates are given back (lost race on the unique phone is a 409, not a used slot)', async () => {
      // parallel sign-ups with the same phone: exactly one account, everybody else is 409 and the address stays usable
      const ip = '203.0.113.9';
      const rs = await Promise.all(Array.from({ length: 6 }, () => signup(body('9000004001'), ip)));
      // the first reaches the insert; the duplicates get 409 (or 429 when more than 3 are in flight for one phone at the very same moment)
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.every((r) => [201, 409, 429].includes(r.status))).toBe(true);
      expect(await prisma.user.count({ where: { phone: '+91 9000004001' } })).toBe(1);
      for (let i = 0; i < 5; i++) expect((await signup(body(`900000410${i}`), ip)).status).toBe(201);
    });
  });

  // =========================================================================================
  // 4. BE2-06 analytics
  // =========================================================================================
  describe('4. analytics: Asia/Kolkata hours and "today", delivery time from deliveredAt', () => {
    test('startOfIstDay / istHour', () => {
      expect(startOfIstDay(new Date('2026-10-05T20:00:00Z')).toISOString()).toBe('2026-10-05T18:30:00.000Z'); // 01:30 IST on the 6th
      expect(startOfIstDay(new Date('2026-10-06T10:00:00Z')).toISOString()).toBe('2026-10-05T18:30:00.000Z');
      expect(startOfIstDay(new Date('2026-10-05T18:29:59Z')).toISOString()).toBe('2026-10-04T18:30:00.000Z');
      expect(startOfIstDay(new Date('2026-10-05T18:30:00Z')).toISOString()).toBe('2026-10-05T18:30:00.000Z');
      expect(istHour(new Date('2026-10-06T08:30:00Z'))).toBe(14);
      expect(istHour(new Date('2026-10-06T18:29:00Z'))).toBe(23);
      expect(istHour(new Date('2026-10-06T18:30:00Z'))).toBe(0);
    });

    test('hourly buckets use the Indian clock, today starts at Indian midnight, and a later review does not change the delivery time', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const id = await place(c1, v1);
      await pay(c1, id);
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      const otp = (await row(id)).otpCode!;
      expect((await api.otp(r1, id, otp)).status).toBe(200);
      // 2 days ago 08:30 UTC = 14:00 IST; delivered 18 minutes later
      const d = new Date(); d.setUTCDate(d.getUTCDate() - 2); d.setUTCHours(8, 30, 0, 0);
      await prisma.order.update({ where: { id }, data: { createdAt: d, deliveredAt: new Date(d.getTime() + 18 * 60_000) } });
      // a review an hour later bumps updatedAt (the old calculation read that as the delivery time)
      const rv = await request.post('/api/reviews').set(bearer(c1.token)).send({ orderId: id, driverRating: 4, dishReviews: [] });
      expect(rv.status).toBe(200);
      const res = await request.get('/api/analytics?range=7d').set(bearer(W.admin.token));
      expect(res.status).toBe(200);
      const hours = res.body.data.hourlyOrders as { hour: string; orders: number }[];
      expect(hours[14]).toEqual({ hour: '14:00', orders: 1 });
      expect(hours[8].orders).toBe(0);
      expect(res.body.data.averageDeliveryMinutes).toBe(18);
      expect(Object.keys(res.body.data).sort()).toEqual(['activeStudents', 'averageDeliveryMinutes', 'cancellationRate', 'generatedAt', 'grossOrderVolume', 'hostelOrders', 'hourlyOrders', 'orderCount', 'range', 'topVendor']);

      const today = await request.get('/api/analytics?range=today').set(bearer(W.admin.token));
      expect(today.status).toBe(200);
      expect(today.body.data.range.from).toBe(startOfIstDay(new Date()).toISOString());
      expect(today.body.data.orderCount).toBe(0); // the order above is two days old
    });
  });

  // =========================================================================================
  // 5. BE2-08 process guards
  // =========================================================================================
  describe('5. crash handling', () => {
    const make = () => {
      const exits: number[] = []; const logs: string[] = [];
      const guards = createProcessGuards({ exit: (c) => { exits.push(c); }, log: (l) => logs.push(l), exitDelayMs: 20 });
      return { guards, exits, logs };
    };

    test('an uncaught exception is logged without its data and the process exits non-zero (once) after a short flush', async () => {
      const { guards, exits, logs } = make();
      const err = Object.assign(new Error('Invalid `prisma.user.create()` invocation:\nUnique constraint failed on phone +91 9876543210'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
      guards.onUncaughtException(err);
      guards.onUncaughtException(err);
      expect(exits).toEqual([]); // not before the flush delay
      await sleep(80);
      expect(exits).toEqual([1]);
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain('[FATAL] uncaught exception');
      expect(logs[0]).toContain('P2002');
      expect(logs.join('\n')).not.toMatch(/9876543210|Unique constraint/);
    });

    test('an unhandled rejection is logged and the server keeps running', async () => {
      const { guards, exits, logs } = make();
      guards.onUnhandledRejection(new Error('push exploded\nuser@example.com'));
      guards.onUnhandledRejection('a plain string');
      await sleep(60);
      expect(exits).toEqual([]);
      expect(logs).toHaveLength(2);
      expect(logs.join('\n')).not.toContain('user@example.com');
    });

    test('a failed listen (port in use) exits non-zero', async () => {
      const blocker = http.createServer();
      await new Promise<void>((r) => blocker.listen(0, r));
      const port = (blocker.address() as any).port;
      const { guards, exits, logs } = make();
      const second = http.createServer();
      second.on('error', guards.onListenError);
      second.listen(port);
      await sleep(120);
      expect(exits).toEqual([1]);
      expect(logs[0]).toContain('EADDRINUSE');
      await new Promise<void>((r) => blocker.close(() => r()));
    });
  });

  // =========================================================================================
  // 6. BE2-10 / BE1-10 socket join throttle
  // =========================================================================================
  describe('6. join_room is throttled per socket; reconnect flows keep working', () => {
    test('a customer keeps at most MAX_ORDER_ROOMS_PER_SOCKET (30) order rooms (oldest dropped), every join of a real order answers ok', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const w = await watch(c1);
      // Docs/22 raised the room cap from 10 to 30 (two 5-restaurant groups fit), which is above the join allowance of 30 a minute: lift the throttle for this test only.
      const savedMax = JOIN_LIMIT.max;
      JOIN_LIMIT.max = 100;
      const ids: string[] = [];
      for (let i = 0; i < MAX_ORDER_ROOMS_PER_SOCKET + 2; i++) {
        const id = await place(c1, v1, {}, i % 2);
        ids.push(id);
        expect(await w.join(`order_${id}`)).toBe(true);
      }
      const inRoom = async (id: string) => (await server.io.in(`order_${id}`).fetchSockets()).length;
      expect(await inRoom(ids[0])).toBe(0);
      expect(await inRoom(ids[1])).toBe(0);
      for (const id of ids.slice(2)) expect(await inRoom(id)).toBe(1);
      // re-joining an old one works and drops the now-oldest
      expect(await w.join(`order_${ids[0]}`)).toBe(true);
      expect(await inRoom(ids[0])).toBe(1);
      expect(await inRoom(ids[2])).toBe(0);
      JOIN_LIMIT.max = savedMax;
    });

    test('a flood is refused with a polite answer, and a reconnect (new socket) starts with a fresh allowance', async () => {
      const [c1] = W.customers;
      const w = await watch(c1);
      const answers: any[] = [];
      for (let i = 0; i < JOIN_LIMIT.max + 5; i++) answers.push(await w.socket!.timeout(5000).emitWithAck('join_room', `order_flood${i}`));
      expect(answers.slice(0, JOIN_LIMIT.max).every((a) => a.ok === false && a.code === undefined)).toBe(true); // refused by the room check, not by the throttle
      const throttled = answers.slice(JOIN_LIMIT.max);
      expect(throttled).toHaveLength(5);
      for (const a of throttled) expect(a).toMatchObject({ ok: false, code: 'RATE_LIMITED', message: expect.stringContaining('Too many room requests') });
      expect(throttled[0].retryAfterSeconds).toBeGreaterThan(0);

      // the app reconnects and re-joins its order room
      const v1 = W.vendors[0];
      const id = await place(c1, v1);
      await w.reconnect(false);
      expect(await w.join(`order_${id}`)).toBe(true);
    });

    test('a restaurant and a rider reconnecting repeatedly always get back in', async () => {
      const [v1] = W.vendors; const [r1] = W.riders;
      for (let i = 0; i < 5; i++) {
        const wv = await watch(v1); const wr = await watch(r1);
        expect(await wv.join(`vendor_${v1.vendorId}`)).toBe(true);
        expect(await wr.join('drivers')).toBe(true);
        wv.disconnect(); wr.disconnect();
      }
    });
  });

  // =========================================================================================
  // 7. BE1-04 duplicate concurrent "place order"
  // =========================================================================================
  describe('7. a concurrent duplicate checkout is an idempotent replay, not a coupon / limit error', () => {
    const sameBody = (v: Vendor, extra: Record<string, unknown> = {}) => ({
      vendorId: v.vendorId, items: [{ itemId: v.items[0].id, quantity: 1 }], dropoffHostel: 'Block 2', dropoffNotes: 'Room 214', clientRequestId: randomUUID(), ...extra,
    });
    const post = (c: Customer, b: object) => request.post('/api/orders').set(bearer(c.token)).send(b);

    test('same clientRequestId with VITFIRST, 6 at once: one order, everybody gets it', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const b = sameBody(v1, { couponCode: 'VITFIRST' });
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(c1, b)));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
      expect(await prisma.order.count({ where: { customerId: c1.id } })).toBe(1);
      expect((await row(rs[0].body.data.id)).couponCode).toBe('VITFIRST');
    });

    test('same clientRequestId when the customer already has 2 unpaid orders elsewhere (3rd allowed, its twin must replay, not 429)', async () => {
      const [c1] = W.customers; const [v1, v2] = W.vendors;
      for (let i = 0; i < 2; i++) {
        await prisma.order.create({ data: { customerId: c1.id, vendorId: v2.vendorId, subtotal: 90, deliveryFee: 25, taxAndPackaging: 15, discount: 0, totalAmount: 130, dropoffHostel: 'BH2', status: 'PLACED', paymentStatus: 'PENDING' } });
      }
      expect(await prisma.order.count({ where: { customerId: c1.id, status: 'PLACED' } })).toBe(2);
      const b = sameBody(v1);
      const rs = await Promise.all(Array.from({ length: 4 }, () => post(c1, b)));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
      expect(await prisma.order.count({ where: { customerId: c1.id, status: 'PLACED' } })).toBe(3);
    });

    test('the same id with a different cart is still refused (409), also under the lock', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const b = sameBody(v1);
      expect((await post(c1, b)).status).toBe(201);
      const rs = await Promise.all([post(c1, { ...b, items: [{ itemId: v1.items[1].id, quantity: 2 }] }), post(c1, { ...b, items: [{ itemId: v1.items[1].id, quantity: 2 }] })]);
      expect(rs.map((r) => r.body.code)).toEqual(['CLIENT_REQUEST_MISMATCH', 'CLIENT_REQUEST_MISMATCH']);
    });
  });

  // =========================================================================================
  // 8. BE1-01 an abandoned unpaid checkout is replaced by the next one
  // =========================================================================================
  describe('8. a new checkout replaces the customer\'s own abandoned unpaid orders at the same restaurant', () => {
    const backdatePayments = (orderId: string, minutes: number) => prisma.payment.updateMany({ where: { orderId }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });

    test('VITFIRST: the second checkout works, the first order is cancelled by SYSTEM with its coupon released', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const wc = await watch(c1);
      const a = await place(c1, v1, { couponCode: 'VITFIRST' });
      await wc.join(`order_${a}`);
      const b = await place(c1, v1, { couponCode: 'VITFIRST' });
      expect(await row(a)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Replaced by a newer order', paymentStatus: 'PENDING', paidAt: null });
      expect(await row(b)).toMatchObject({ status: 'PLACED', paymentStatus: 'PENDING', couponCode: 'VITFIRST' });
      expect((await row(a)).refundStatus).toBeNull(); // nothing was paid, nothing to refund
      expect(await prisma.adminAuditLog.count({ where: { targetId: a, action: 'ORDER_CANCELLED' } })).toBe(1);
      await wc.flush();
      expect(wc.last('order_updated', a)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
      // and the new order can be paid normally
      await pay(c1, b);
      expect(await row(b)).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
      // the coupon is now really used: a third checkout with it is refused
      const third = await api.place(c1, v1, { couponCode: 'VITFIRST' });
      expect([third.status, third.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
    });

    test('three abandoned checkouts no longer lock the customer out (the 3-unpaid cap)', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      for (let i = 0; i < 6; i++) await place(c1, v1);
      expect(await prisma.order.count({ where: { customerId: c1.id, status: 'PLACED' } })).toBe(1);
      expect(await prisma.order.count({ where: { customerId: c1.id, status: 'CANCELLED', cancelledBy: 'SYSTEM' } })).toBe(5);
    });

    test('orders of another restaurant are not touched (and still count towards the cap)', async () => {
      const [c1] = W.customers; const [v1, v2] = W.vendors;
      const a = await place(c1, v2);
      await place(c1, v1);
      expect((await row(a)).status).toBe('PLACED');
    });

    test('a PAID order is never touched', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const a = await place(c1, v1);
      await pay(c1, a);
      const b = await place(c1, v1);
      expect(await row(a)).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
      expect((await row(b)).status).toBe('PLACED');
      expect(ledger.totalRefunded()).toBe(0);
    });

    test('an accepted order and a delivered order are never touched', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      const a = await place(c1, v1);
      await pay(c1, a);
      expect((await api.setStatus(v1, a, 'ACCEPTED')).status).toBe(200);
      await place(c1, v1);
      expect((await row(a)).status).toBe('ACCEPTED');
      void r1;
    });

    test('a payment opened less than 2 minutes ago is "in flight": nothing is cancelled and the coupon stays held; after 2 minutes it is replaced', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const a = await place(c1, v1, { couponCode: 'VITFIRST' });
      expect((await api.createPayment(c1, a)).status).toBe(200);
      const blocked = await api.place(c1, v1, { couponCode: 'VITFIRST' });
      expect([blocked.status, blocked.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect((await row(a)).status).toBe('PLACED');
      await backdatePayments(a, 3);
      const b = await place(c1, v1, { couponCode: 'VITFIRST' });
      expect((await row(a)).status).toBe('CANCELLED');
      expect((await row(b)).status).toBe('PLACED');
    });

    test('a payment that already failed is not "in flight"', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const a = await place(c1, v1);
      const cp = await api.createPayment(c1, a);
      expect((await api.webhookFailed(cp.body.razorpayOrderId, 'pay_failed_1', 22000)).status).toBe(200);
      expect(await row(a)).toMatchObject({ paymentStatus: 'FAILED' });
      await place(c1, v1);
      expect((await row(a)).status).toBe('CANCELLED');
    });

    test('a payment with a recorded captured amount is never superseded', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const a = await place(c1, v1);
      await api.createPayment(c1, a);
      await prisma.payment.updateMany({ where: { orderId: a }, data: { capturedAmountPaise: 1234, createdAt: new Date(Date.now() - 10 * 60_000) } });
      await place(c1, v1);
      expect((await row(a)).status).toBe('PLACED');
    });

    test('payment after supersede: the late capture is refunded automatically, exactly once, and the order stays cancelled', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const wv = await watch(v1);
      const a = await place(c1, v1);
      const cp = await api.createPayment(c1, a);
      await backdatePayments(a, 5); // the customer opened the payment sheet earlier and walked away
      const b = await place(c1, v1);
      expect((await row(a)).status).toBe('CANCELLED');
      // ... but the customer pays on the still-open sheet
      const pid = 'pay_late_after_supersede';
      ledger.capture(cp.body.razorpayOrderId, pid, cp.body.amountInPaise);
      const v = await api.verify(c1, cp.body.razorpayOrderId, pid);
      expect([v.status, v.body.code]).toEqual([409, 'ORDER_CANCELLED']);
      await api.webhookCaptured(cp.body.razorpayOrderId, pid, cp.body.amountInPaise);
      await __waitForBackgroundWork();
      expect(await row(a)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', paidAt: null });
      expect(ledger.refundsOf(pid)).toHaveLength(1);
      expect(ledger.totalCaptured() - ledger.totalRefunded()).toBe(0);
      expect((await row(b)).status).toBe('PLACED'); // the new order is untouched
      expect(wv.count('new_order_alert', a) + wv.count('order_updated', a)).toBe(0); // the restaurant never heard of it
    });

    test('a customer cannot affect another customer\'s orders, and a failed checkout rolls the replacement back', async () => {
      const [c1, c2] = W.customers; const [v1] = W.vendors;
      const other = await place(c2, v1, { couponCode: 'VITFIRST' });
      const mine = await place(c1, v1);
      // c1 checks out again: c2's order is not part of it
      await place(c1, v1);
      expect((await row(other)).status).toBe('PLACED');
      expect((await row(mine)).status).toBe('CANCELLED');
      // KRAVEO20 without coins fails INSIDE the transaction: the replacement must not have happened
      const open = await prisma.order.findFirstOrThrow({ where: { customerId: c1.id, status: 'PLACED' } });
      const bad = await api.place(c1, v1, { couponCode: 'KRAVEO20' });
      expect([bad.status, bad.body.code]).toEqual([400, 'COUPON_NOT_APPLICABLE']);
      expect((await row(open.id)).status).toBe('PLACED');
      // someone else's order id cannot be reached through any request of c1
      expect((await api.cancel(c1, other)).status).toBe(404);
      expect((await row(other)).status).toBe('PLACED');
    });

    test('a replay of the newest checkout changes nothing else', async () => {
      const [c1] = W.customers; const [v1] = W.vendors;
      const cid = randomUUID();
      const a = await place(c1, v1);
      const bRes = await api.place(c1, v1, { clientRequestId: cid });
      expect(bRes.status).toBe(201);
      const again = await api.place(c1, v1, { clientRequestId: cid });
      expect([again.status, again.body.data.id]).toEqual([200, bRes.body.data.id]);
      expect((await row(a)).status).toBe('CANCELLED');
      expect((await row(bRes.body.data.id)).status).toBe('PLACED');
    });
  });

  // =========================================================================================
  // 9. BE2-07 / BE1-09 ratings
  // =========================================================================================
  describe('9. a review does not move the restaurant rating (the star value is the rider\'s)', () => {
    test('restaurant rating and count stay as they are; the rider rating and the coins are updated', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { rating: 4.8, totalRatingsCount: 124 } });
      await prisma.driverPartner.update({ where: { id: r1.profileId }, data: { rating: 4.0 } });
      for (let i = 0; i < 3; i++) {
        const id = await place(c1, v1);
        await pay(c1, id);
        await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
        expect((await api.otp(r1, id, (await row(id)).otpCode!)).status).toBe(200);
        const res = await request.post('/api/reviews').set(bearer(c1.token)).send({ orderId: id, driverRating: 5, dishReviews: [{ dishId: v1.items[0].id, rating: 5 }] });
        expect(res.status).toBe(200);
        expect(res.body.newVendorRating).toBe(4.8);
      }
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: v1.vendorId } });
      expect([v.rating, v.totalRatingsCount]).toEqual([4.8, 124]);
      const d = await prisma.driverPartner.findUniqueOrThrow({ where: { id: r1.profileId } });
      expect(d.rating).toBeGreaterThan(4.0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: c1.id } })).kraveoCoins).toBeGreaterThanOrEqual(30);
    });

    test('a 1-star rider rating no longer drags the restaurant down', async () => {
      const [c1] = W.customers; const [v1] = W.vendors; const [r1] = W.riders;
      await prisma.vendor.update({ where: { id: v1.vendorId }, data: { rating: 4.6, totalRatingsCount: 50 } });
      const id = await place(c1, v1);
      await pay(c1, id);
      await driveTo(id, 'ARRIVED_AT_GATE', v1, r1);
      expect((await api.otp(r1, id, (await row(id)).otpCode!)).status).toBe(200);
      expect((await request.post('/api/reviews').set(bearer(c1.token)).send({ orderId: id, driverRating: 1, dishReviews: [{ dishId: v1.items[0].id, rating: 5 }] })).status).toBe(200);
      expect((await prisma.vendor.findUniqueOrThrow({ where: { id: v1.vendorId } })).rating).toBe(4.6);
    });
  });

  // =========================================================================================
  // 10. security headers
  // =========================================================================================
  describe('10. security headers', () => {
    test('every response carries nosniff / DENY / no-referrer, never X-Powered-By, and HSTS only over https', async () => {
      for (const res of [await request.get('/health'), await request.get('/api/vendors'), await request.get('/nope'), await request.get('/api/orders')]) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['strict-transport-security']).toBeUndefined();
      }
      const https = await request.get('/health').set('X-Forwarded-Proto', 'https');
      expect(https.headers['strict-transport-security']).toBe('max-age=15552000');
      const plain = await request.get('/health').set('X-Forwarded-Proto', 'http');
      expect(plain.headers['strict-transport-security']).toBeUndefined();
    });

    test('CORS headers are intact and the socket.io handshake still works', async () => {
      const res = await request.get('/api/vendors').set('Origin', 'https://admin.kraveo.site');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
      expect(res.headers['x-frame-options']).toBe('DENY');
      const w = await watch(W.customers[0]);
      expect(w.connected).toBe(true);
      const poll = await supertest(server.baseUrl).get('/socket.io/?EIO=4&transport=polling');
      expect(poll.status).toBe(200);
      void sleep;
    });
  });
});
