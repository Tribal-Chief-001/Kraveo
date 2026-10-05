/**
 * Push notifications (Docs/18_push_notifications_contract.md): device registration, every event with its recipients and payload,
 * idempotency, retries, dead tokens, privacy (no OTP / phone / address), and "push can never change an order result".
 * Real PostgreSQL, real HTTP endpoints; the sender is a fake PushProvider (Firebase is never contacted).
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { setPaymentProvider, createSimulatedProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { setPushProvider, getPushProvider, __resetPushProvider, classifyPushError } from '../../src/services/push/provider';
import { notifyOrderEvent, retryDuePushes, pruneOldPushData, __waitForPushWork } from '../../src/services/push/pushService';
import { PUSH_EVENTS, PushMessage, PushProvider } from '../../src/services/push/types';

jest.setTimeout(30_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const STUDENT2 = { id: 'usr-push-stu2', phone: '+91 9999851111' };
const STUDENT3 = { id: 'usr-push-stu3', phone: '+91 9999851112' };
const VENDOR = { id: 'usr-3', phone: '+91 9876543212' };
const RIDER = { id: 'usr-4', phone: '+91 9876543213' };
const RIDER2 = { id: 'usr-push-rid2', phone: '+91 9999852222' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };

const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tStudent2 = getStudentToken(STUDENT2.id, STUDENT2.phone);
const tStudent3 = getStudentToken(STUDENT3.id, STUDENT3.phone);
const tVendor = getVendorToken(VENDOR.id, VENDOR.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);
const tRider2 = getDriverToken(RIDER2.id, RIDER2.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);

const TOK = {
  cust: 'tok_customer_phone_AAAAAAAAAAAAAAAAAAAA',
  custB: 'tok_customer_phone_BBBBBBBBBBBBBBBBBBBB',
  vendor: 'tok_vendor_tablet_CCCCCCCCCCCCCCCCCCCC',
  rider: 'tok_rider_one_phone_DDDDDDDDDDDDDDDDDDD',
  rider2: 'tok_rider_two_phone_EEEEEEEEEEEEEEEEEEE',
};
const OWNER_OF: Record<string, string> = { [TOK.cust]: 'CUSTOMER', [TOK.custB]: 'CUSTOMER', [TOK.vendor]: 'VENDOR', [TOK.rider]: 'RIDER', [TOK.rider2]: 'RIDER2' };

const H = (t: string) => getAuthHeader(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake FCM: records every message, behaviour can be changed per test. */
class FakeProvider implements PushProvider {
  readonly enabled = true;
  sent: PushMessage[] = [];
  attemptsLog: PushMessage[] = [];
  behaviour: (m: PushMessage) => Promise<void> | void = () => undefined;
  async send(m: PushMessage) {
    this.attemptsLog.push(m);
    await this.behaviour(m);
    this.sent.push(m);
  }
  to(orderId: string, event: string) {
    return this.sent.filter((m) => m.data.orderId === orderId && m.data.event === event);
  }
  events(orderId: string) {
    return this.sent.filter((m) => m.data.orderId === orderId).map((m) => `${m.data.event}>${OWNER_OF[m.token]}`);
  }
}
const fcmError = (code: string, message = 'fcm') => Object.assign(new Error(message), { code });

describe('Push notifications', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let sim: ReturnType<typeof createSimulatedProvider>;
  let fake: FakeProvider;
  /** Every message any test sent (for the final privacy scan). */
  const everything: PushMessage[] = [];
  const secrets = { otps: new Set<string>() };

  // ---------------- helpers ----------------
  const place = (token = tStudent, extra: Record<string, unknown> = {}) =>
    request.post('/api/orders').set(H(token)).send({
      vendorId: 'ven-1', items: [{ itemId: 'item-1', quantity: 1 }, { itemId: 'item-2', quantity: 2 }], dropoffHostel: 'Block 2', dropoffNotes: 'Room 214, call 9876501234', clientRequestId: randomUUID(), ...extra,
    });
  const createPayment = (orderId: string, token = tStudent) => request.post('/api/payments/create-order').set(H(token)).send({ orderId });
  const verify = (rzpOrderId: string, token = tStudent) =>
    request.post('/api/payments/verify-signature').set(H(token)).send({ razorpayOrderId: rzpOrderId, razorpayPaymentId: `pay_${randomUUID().slice(0, 12)}`, razorpaySignature: 'sim' });
  const setStatus = (id: string, status: string, token: string, extra: object = {}) => request.patch(`/api/orders/${id}/status`).set(H(token)).send({ status, ...extra });
  const claim = (id: string, token = tRider) => request.post(`/api/orders/${id}/accept-driver`).set(H(token)).send({});
  const flush = async () => { await __waitForPushWork(); await __waitForBackgroundWork(); await __waitForPushWork(); };

  const placeOnly = async (token = tStudent) => {
    const placed = await place(token);
    expect(placed.status).toBe(201);
    return placed.body.data.id as string;
  };
  const payOrder = async (orderId: string, token = tStudent) => {
    const pay = await createPayment(orderId, token);
    expect(pay.status).toBe(200);
    const v = await verify(pay.body.razorpayOrderId, token);
    expect(v.status).toBe(200);
    return v;
  };
  const placePaid = async (token = tStudent) => {
    const id = await placeOnly(token);
    await payOrder(id, token);
    await flush();
    return id;
  };
  const freeRiders = () => prisma.order.updateMany({ where: { driverId: { in: [RIDER.id, RIDER2.id] }, status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  const logOf = (orderId: string, event: string) => prisma.pushLog.findMany({ where: { orderId, event } });
  const registerAll = async () => {
    const mk = (userId: string, token: string, app: string) => prisma.deviceToken.create({ data: { userId, token, app } });
    await mk(STUDENT.id, TOK.cust, 'CUSTOMER');
    await mk(VENDOR.id, TOK.vendor, 'VENDOR');
    await mk(RIDER.id, TOK.rider, 'DRIVER');
    await mk(RIDER2.id, TOK.rider2, 'DRIVER');
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    for (const u of [
      { id: STUDENT2.id, name: 'Priya Nair', phone: STUDENT2.phone, role: Role.STUDENT },
      { id: STUDENT3.id, name: 'Dev Patel', phone: STUDENT3.phone, role: Role.STUDENT },
      { id: RIDER2.id, name: 'Arjun Rider', phone: RIDER2.phone, role: Role.DRIVER },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    await prisma.driverPartner.upsert({
      where: { id: 'dp-push-rid2' },
      update: { userId: RIDER2.id, dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' },
      create: { id: 'dp-push-rid2', userId: RIDER2.id, name: 'Arjun Rider', phone: RIDER2.phone, runnerCode: 'RUN-PUSH2', vehicleType: 'Bike', dutyStatus: 'ONLINE' },
    });
    await prisma.user.update({ where: { id: STUDENT.id }, data: { name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' } });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    sim = createSimulatedProvider();
    setPaymentProvider(sim);
    fake = new FakeProvider();
    setPushProvider(fake);
    __resetRateLimits();
    await prisma.pushLog.deleteMany({});
    await prisma.deviceToken.deleteMany({});
    await freeRiders();
    await prisma.order.updateMany({ where: { status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.vendor.update({ where: { id: 'ven-1' }, data: { isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
    // Only the two riders of this suite are on duty: leftovers of other suites must not become recipients.
    await prisma.driverPartner.updateMany({ where: { userId: { notIn: [RIDER.id, RIDER2.id] } }, data: { dutyStatus: 'OFFLINE' } });
    await prisma.driverPartner.updateMany({ where: { userId: { in: [RIDER.id, RIDER2.id] } }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
    await prisma.user.updateMany({ where: { id: { in: [RIDER.id, RIDER2.id, VENDOR.id] } }, data: { tokenVersion: 0 } });
    delete process.env.PUSH_SEND_TIMEOUT_MS;
  });

  afterEach(async () => {
    await flush();
    everything.push(...fake.sent);
    setPaymentProvider(null);
    setPushProvider(null);
    delete process.env.RL_DEVICE_WRITE_MAX;
  });

  afterAll(async () => {
    await prisma.pushLog.deleteMany({});
    await prisma.deviceToken.deleteMany({});
    await prisma.driverPartner.deleteMany({ where: { id: 'dp-push-rid2' } });
    await cleanTestOrders();
    await prisma.user.deleteMany({ where: { id: { in: [STUDENT3.id] } } });
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================
  // POST /api/devices, DELETE /api/devices
  // =========================================================================
  describe('device registration', () => {
    const reg = (token: string, body: Record<string, unknown>) => request.post('/api/devices').set(H(token)).send(body);
    const T = 'fcm_token_for_register_0123456789';

    test('registers a token for the caller; the user id never comes from the body', async () => {
      const r = await reg(tStudent, { token: T, app: 'CUSTOMER', platform: 'android', appVersion: '1.5.0+9', userId: 'someone-else' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true });
      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } });
      expect(row).toMatchObject({ userId: STUDENT.id, app: 'CUSTOMER', platform: 'android', appVersion: '1.5.0+9', disabledAt: null });
      // platform and appVersion are optional
      expect((await reg(tVendor, { token: `${T}_v`, app: 'VENDOR' })).status).toBe(200);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: `${T}_v` } })).appVersion).toBeNull();
    });

    test('the same token twice is one row; lastSeenAt moves forward', async () => {
      await reg(tStudent, { token: T, app: 'CUSTOMER' });
      const first = await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } });
      await sleep(5);
      expect((await reg(tStudent, { token: T, app: 'CUSTOMER' })).status).toBe(200);
      expect(await prisma.deviceToken.count({ where: { token: T } })).toBe(1);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } })).lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    });

    test('validation: token length / characters, app, platform, appVersion; no token = 401', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ token: 'short', app: 'CUSTOMER' }, 'token'],
        [{ token: 'x'.repeat(2049), app: 'CUSTOMER' }, 'token'],
        [{ token: 'has space in the token 0123456789', app: 'CUSTOMER' }, 'token'],
        [{ token: 12345678901234567890, app: 'CUSTOMER' }, 'token'],
        [{ app: 'CUSTOMER' }, 'token'],
        [{ token: T, app: 'ADMIN' }, 'app'],
        [{ token: T }, 'app'],
        [{ token: T, app: 'CUSTOMER', platform: 'ios' }, 'platform'],
        [{ token: T, app: 'CUSTOMER', appVersion: 'v'.repeat(33) }, 'appVersion'],
        [{ token: T, app: 'CUSTOMER', appVersion: 5 }, 'appVersion'],
      ];
      for (const [body, field] of cases) {
        const r = await reg(tStudent, body);
        expect([r.status, r.body.field]).toEqual([400, field]);
      }
      expect(await prisma.deviceToken.count()).toBe(0);
      expect((await request.post('/api/devices').send({ token: T, app: 'CUSTOMER' })).status).toBe(401);
      expect((await request.delete('/api/devices').send({ token: T })).status).toBe(401);
    });

    test('the app must match the role: 403 ROLE_NOT_ALLOWED (customer as vendor, rider as customer, admin never)', async () => {
      for (const [tok, app] of [[tStudent, 'VENDOR'], [tStudent, 'DRIVER'], [tVendor, 'CUSTOMER'], [tRider, 'VENDOR'], [tAdmin, 'CUSTOMER'], [tAdmin, 'VENDOR']] as const) {
        const r = await reg(tok, { token: T, app });
        expect([r.status, r.body.code]).toEqual([403, 'ROLE_NOT_ALLOWED']);
      }
      expect(await prisma.deviceToken.count()).toBe(0);
      expect((await reg(tRider, { token: T, app: 'DRIVER' })).status).toBe(200);
    });

    test('a token moves to the new user on a shared phone and is re-enabled', async () => {
      await reg(tStudent, { token: T, app: 'CUSTOMER' });
      await prisma.deviceToken.update({ where: { token: T }, data: { disabledAt: new Date(), disabledReason: 'LOGOUT' } });
      expect((await reg(tStudent2, { token: T, app: 'CUSTOMER' })).status).toBe(200);
      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } });
      expect(row).toMatchObject({ userId: STUDENT2.id, disabledAt: null, disabledReason: null });
      expect(await prisma.deviceToken.count({ where: { token: T } })).toBe(1);
    });

    test('at most 10 active tokens per user: the oldest are disabled', async () => {
      const tokens = Array.from({ length: 12 }, (_, i) => `limit_token_number_${String(i).padStart(2, '0')}_xxxxxxxx`);
      for (const t of tokens) {
        expect((await reg(tStudent, { token: t, app: 'CUSTOMER' })).status).toBe(200);
        await sleep(4);
      }
      const rows = await prisma.deviceToken.findMany({ where: { userId: STUDENT.id } });
      expect(rows.filter((r) => !r.disabledAt)).toHaveLength(10);
      const off = rows.filter((r) => r.disabledAt).map((r) => r.token).sort();
      expect(off).toEqual([tokens[0], tokens[1]]);
      expect(rows.find((r) => r.token === tokens[0])!.disabledReason).toBe('LIMIT');
      expect(rows.find((r) => r.token === tokens[11])!.disabledAt).toBeNull(); // the newest always stays
    });

    test('DELETE: the owner switches the token off; others and unknown tokens are a quiet success', async () => {
      await reg(tStudent, { token: T, app: 'CUSTOMER' });
      // someone else cannot remove it (still 200, nothing changes)
      expect((await request.delete('/api/devices').set(H(tStudent2)).send({ token: T })).body).toEqual({ success: true });
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } })).disabledAt).toBeNull();
      // the owner can, twice
      expect((await request.delete('/api/devices').set(H(tStudent)).send({ token: T })).status).toBe(200);
      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token: T } });
      expect(row.disabledAt).not.toBeNull();
      expect(row.disabledReason).toBe('LOGOUT');
      expect((await request.delete('/api/devices').set(H(tStudent)).send({ token: T })).status).toBe(200);
      // unknown token, malformed token
      expect((await request.delete('/api/devices').set(H(tStudent)).send({ token: 'unknown_token_0123456789abcdef' })).body).toEqual({ success: true });
      expect((await request.delete('/api/devices').set(H(tStudent)).send({})).status).toBe(400);
    });

    test('rate limited like the other write routes (RL_DEVICE_WRITE_MAX)', async () => {
      process.env.RL_DEVICE_WRITE_MAX = '3';
      __resetRateLimits();
      for (let i = 0; i < 3; i++) expect((await reg(tStudent, { token: T, app: 'CUSTOMER' })).status).toBe(200);
      const r = await reg(tStudent, { token: T, app: 'CUSTOMER' });
      expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
      expect((await reg(tStudent2, { token: `${T}_2`, app: 'CUSTOMER' })).status).toBe(200); // per user
    });
  });

  // =========================================================================
  // Events: recipients and payload shape
  // =========================================================================
  describe('events', () => {
    test('a full order sends every status event to the right people with the exact payload', async () => {
      await registerAll();
      const id = await placeOnly();
      const refTail = id.slice(-6).toUpperCase();
      expect(fake.sent).toHaveLength(0); // unpaid orders push nothing

      await payOrder(id);
      await flush();
      expect(fake.events(id)).toEqual(['NEW_ORDER>VENDOR']);
      const [newOrder] = fake.to(id, 'NEW_ORDER');
      expect(newOrder).toEqual({
        token: TOK.vendor, title: 'New order', body: expect.stringMatching(/^3 items - Rs \d+(\.\d{2})?\. Tap to accept\.$/),
        channelId: 'new_orders', priority: 'high', ttlSeconds: 120, collapseKey: `NEW_ORDER:${id}`, data: { event: 'NEW_ORDER', orderId: id, v: '1' },
      });
      const total = (await prisma.order.findUniqueOrThrow({ where: { id } })).totalAmount;
      expect(newOrder.body).toBe(`3 items - Rs ${Number.isInteger(total) ? total : total.toFixed(2)}. Tap to accept.`);

      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_ACCEPTED')).toEqual([{
        token: TOK.cust, title: 'Order accepted', body: 'Sharma Highway Dhaba is preparing your food.', channelId: 'order_updates', priority: 'normal', ttlSeconds: 3600,
        collapseKey: `ORDER_ACCEPTED:${id}`, data: { event: 'ORDER_ACCEPTED', orderId: id, v: '1' },
      }]);

      expect((await setStatus(id, 'PREPARING', tVendor)).status).toBe(200);
      await flush();
      expect(fake.events(id)).toEqual(['NEW_ORDER>VENDOR', 'ORDER_ACCEPTED>CUSTOMER']); // PREPARING is not pushed

      expect((await setStatus(id, 'READY_FOR_PICKUP', tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_READY')).toEqual([{
        token: TOK.cust, title: 'Food is ready', body: 'Waiting for a rider.', channelId: 'order_updates', priority: 'normal', ttlSeconds: 3600,
        collapseKey: `ORDER_READY:${id}`, data: { event: 'ORDER_READY', orderId: id, v: '1' },
      }]);
      const deliveries = fake.to(id, 'NEW_DELIVERY');
      expect(deliveries.map((m) => m.token).sort()).toEqual([TOK.rider, TOK.rider2].sort());
      expect(deliveries[0]).toMatchObject({ title: 'New delivery', body: 'Sharma Highway Dhaba to Block 2. Tap to accept.', channelId: 'new_deliveries', priority: 'high', ttlSeconds: 120, collapseKey: `NEW_DELIVERY:${id}`, data: { event: 'NEW_DELIVERY', orderId: id, v: '1' } });

      expect((await claim(id)).status).toBe(200);
      await flush();
      expect(fake.sent.filter((m) => m.data.orderId === id)).toHaveLength(1 + 1 + 1 + 2); // claiming pushes nothing

      expect((await setStatus(id, 'PICKED_UP', tRider)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_PICKED_UP')).toEqual([{
        token: TOK.cust, title: 'On the way', body: 'Vikram picked up your order.', channelId: 'order_attention', priority: 'high', ttlSeconds: 3600,
        collapseKey: `ORDER_PICKED_UP:${id}`, data: { event: 'ORDER_PICKED_UP', orderId: id, v: '1' },
      }]);

      expect((await setStatus(id, 'ARRIVED_AT_GATE', tRider)).status).toBe(200);
      await flush();
      const otp = (await prisma.order.findUniqueOrThrow({ where: { id } })).otpCode!;
      expect(otp).toMatch(/^\d{4}$/);
      secrets.otps.add(otp);
      expect(fake.to(id, 'RIDER_AT_GATE')).toEqual([{
        token: TOK.cust, title: 'Your rider is at the gate', body: 'Open Kraveo to see your code.', channelId: 'order_attention', priority: 'high', ttlSeconds: 3600,
        collapseKey: `RIDER_AT_GATE:${id}`, data: { event: 'RIDER_AT_GATE', orderId: id, v: '1' },
      }]);

      const done = await setStatus(id, 'DELIVERED', tRider, { otpCode: otp });
      expect(done.status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_DELIVERED')).toEqual([{
        token: TOK.cust, title: 'Delivered', body: 'Enjoy your meal! Rate your order.', channelId: 'order_updates', priority: 'normal', ttlSeconds: 3600,
        collapseKey: `ORDER_DELIVERED:${id}`, data: { event: 'ORDER_DELIVERED', orderId: id, v: '1' },
      }]);
      // (pushes of one transition are sent concurrently, so compare as a set)
      expect(fake.events(id).sort()).toEqual([
        'NEW_ORDER>VENDOR', 'ORDER_ACCEPTED>CUSTOMER', 'ORDER_READY>CUSTOMER', 'NEW_DELIVERY>RIDER', 'NEW_DELIVERY>RIDER2',
        'ORDER_PICKED_UP>CUSTOMER', 'RIDER_AT_GATE>CUSTOMER', 'ORDER_DELIVERED>CUSTOMER',
      ].sort());
      expect(refTail).toHaveLength(6);

      // Every delivered row is in the log, one per (order, event, user).
      const rows = await prisma.pushLog.findMany({ where: { orderId: id } });
      expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.sentAt)).toBe(true);
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
      expect(rows.map((r) => r.key)).toContain(`${id}:NEW_ORDER:${VENDOR.id}`);
    });

    test('NEW_DELIVERY goes only to approved ONLINE riders without an active order', async () => {
      await registerAll();
      // RIDER2 is busy with another order, so only RIDER hears about the new pool order.
      const other = await prisma.order.create({
        data: { customerId: STUDENT2.id, vendorId: 'ven-1', driverId: RIDER2.id, totalAmount: 100, dropoffHostel: 'Block 1', status: 'PICKED_UP', paymentStatus: 'PAID', paidAt: new Date() },
      });
      const id = await placePaid();
      for (const s of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) expect((await setStatus(id, s, tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'NEW_DELIVERY').map((m) => OWNER_OF[m.token])).toEqual(['RIDER']);
      expect(other.id).toBeTruthy();
    });

    test('NEW_DELIVERY skips OFFLINE and SUSPENDED riders and a rider with an assigned order; nothing when the order already has a rider', async () => {
      await registerAll();
      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'OFFLINE' } });
      await prisma.driverPartner.updateMany({ where: { userId: RIDER2.id }, data: { approvalStatus: 'SUSPENDED' } });
      const id = await placePaid();
      for (const s of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) expect((await setStatus(id, s, tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'NEW_DELIVERY')).toHaveLength(0);
      expect(fake.to(id, 'ORDER_READY')).toHaveLength(1);

      // A rider who claimed before READY: the order is not in the pool when it becomes ready.
      await prisma.driverPartner.updateMany({ where: { userId: { in: [RIDER.id, RIDER2.id] } }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
      const id2 = await placePaid();
      for (const s of ['ACCEPTED', 'PREPARING']) expect((await setStatus(id2, s, tVendor)).status).toBe(200);
      expect((await claim(id2)).status).toBe(200);
      expect((await setStatus(id2, 'READY_FOR_PICKUP', tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id2, 'NEW_DELIVERY')).toHaveLength(0);
    });

    test('customer cancels a paid order: no self-push, restaurant told, then REFUND_PROCESSED', async () => {
      await registerAll();
      const id = await placePaid();
      const r = await request.post(`/api/orders/${id}/cancel`).set(H(tStudent)).send({ reason: 'Changed my mind' });
      expect(r.status).toBe(200);
      await flush();
      // The customer who pressed Cancel is not pushed about it (they know); the refund push still follows.
      expect(fake.to(id, 'ORDER_CANCELLED')).toHaveLength(0);
      const ref = id.slice(-6).toUpperCase();
      expect(fake.to(id, 'ORDER_CANCELLED_VENDOR')).toEqual([{
        token: TOK.vendor, title: 'Order cancelled', body: `Order #${ref} was cancelled.`, channelId: 'order_updates', priority: 'high', ttlSeconds: 3600,
        collapseKey: `ORDER_CANCELLED_VENDOR:${id}`, data: { event: 'ORDER_CANCELLED_VENDOR', orderId: id, v: '1' },
      }]);
      expect(fake.to(id, 'DELIVERY_CANCELLED')).toHaveLength(0);
      const total = (await prisma.order.findUniqueOrThrow({ where: { id } })).totalAmount;
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).refundStatus).toBe('DONE');
      expect(fake.to(id, 'REFUND_PROCESSED')).toEqual([{
        token: TOK.cust, title: 'Refund processed', body: `Rs ${Number.isInteger(total) ? total : total.toFixed(2)} is on its way to your account (5-7 working days).`,
        channelId: 'order_updates', priority: 'normal', ttlSeconds: 3600, collapseKey: `REFUND_PROCESSED:${id}`, data: { event: 'REFUND_PROCESSED', orderId: id, v: '1' },
      }]);
    });

    test('an unpaid order the customer cancels: nobody is pushed (customer knows, restaurant never saw it)', async () => {
      await registerAll();
      const id = await placeOnly();
      expect((await request.post(`/api/orders/${id}/cancel`).set(H(tStudent)).send({})).status).toBe(200);
      await flush();
      expect(fake.events(id)).toEqual([]);
    });

    test('the restaurant rejects: the customer is told, the restaurant is not pushed about its own action; reason is sanitised and capped at 80', async () => {
      await registerAll();
      const id = await placePaid();
      const reason = `We are out of paneer, call me on 9876543210 or code 4821 ${'blah '.repeat(25)}`;
      const r = await request.post(`/api/orders/${id}/reject`).set(H(tVendor)).send({ reason });
      expect(r.status).toBe(200);
      await flush();
      expect(fake.events(id).sort()).toEqual(['ORDER_CANCELLED>CUSTOMER', 'REFUND_PROCESSED>CUSTOMER', 'NEW_ORDER>VENDOR'].sort());
      const body = fake.to(id, 'ORDER_CANCELLED')[0].body;
      expect(body).not.toMatch(/\d{3,}/);
      expect(body.endsWith(' Your refund is on its way.')).toBe(true);
      expect(body.length).toBeLessThanOrEqual(80 + '. Your refund is on its way.'.length);
    });

    test('admin cancels an order a rider holds: DELIVERY_CANCELLED to that rider only, plus customer and restaurant', async () => {
      await registerAll();
      const id = await placePaid();
      for (const s of ['ACCEPTED', 'PREPARING']) expect((await setStatus(id, s, tVendor)).status).toBe(200);
      expect((await claim(id)).status).toBe(200);
      await flush();
      const before = fake.sent.length;
      expect((await setStatus(id, 'CANCELLED', tAdmin, { reason: 'Kitchen fire' })).status).toBe(200);
      await flush();
      const after = fake.sent.slice(before).filter((m) => m.data.orderId === id);
      expect(after.map((m) => `${m.data.event}>${OWNER_OF[m.token]}`).sort()).toEqual(['DELIVERY_CANCELLED>RIDER', 'ORDER_CANCELLED>CUSTOMER', 'ORDER_CANCELLED_VENDOR>VENDOR', 'REFUND_PROCESSED>CUSTOMER'].sort());
      expect(fake.to(id, 'DELIVERY_CANCELLED')[0]).toMatchObject({
        title: 'Delivery cancelled', body: `Order #${id.slice(-6).toUpperCase()} was cancelled.`, channelId: 'order_updates', priority: 'high', ttlSeconds: 3600,
      });
    });

    test('the maintenance job cancels an order the restaurant ignored: customer, restaurant and refund are pushed', async () => {
      await registerAll();
      const id = await placePaid();
      await prisma.order.update({ where: { id }, data: { paidAt: new Date(Date.now() - 20 * 60_000) } });
      const summary = await runOrderMaintenance();
      expect(summary.autoCancelled).toContain(id);
      await flush();
      expect(fake.to(id, 'ORDER_CANCELLED')[0].body).toBe('Restaurant did not respond. Your refund is on its way.');
      expect(fake.to(id, 'ORDER_CANCELLED_VENDOR')).toHaveLength(1);
      expect(fake.to(id, 'REFUND_PROCESSED')).toHaveLength(1);
    });

    test('admin reassign pushes DELIVERY_ASSIGNED to that rider only; a rider claiming by themselves is not pushed', async () => {
      await registerAll();
      const id = await placePaid();
      for (const s of ['ACCEPTED', 'PREPARING']) expect((await setStatus(id, s, tVendor)).status).toBe(200);
      await flush();
      const re = await request.patch(`/api/orders/${id}/reassign`).set(H(tAdmin)).send({ driverId: RIDER2.id });
      expect(re.status).toBe(200);
      await flush();
      expect(fake.to(id, 'DELIVERY_ASSIGNED')).toEqual([{
        token: TOK.rider2, title: 'Delivery assigned', body: 'Sharma Highway Dhaba to Block 2.', channelId: 'new_deliveries', priority: 'high', ttlSeconds: 3600,
        collapseKey: `DELIVERY_ASSIGNED:${id}`, data: { event: 'DELIVERY_ASSIGNED', orderId: id, v: '1' },
      }]);
      // moving it to the other rider assigns again (a different recipient = a different key)
      expect((await request.patch(`/api/orders/${id}/reassign`).set(H(tAdmin)).send({ driverId: RIDER.id })).status).toBe(200);
      await flush();
      expect(fake.to(id, 'DELIVERY_ASSIGNED').map((m) => OWNER_OF[m.token])).toEqual(['RIDER2', 'RIDER']);
    });

    test('a user with two devices gets the push on both; a device of another app is never used', async () => {
      await registerAll();
      await prisma.deviceToken.create({ data: { userId: STUDENT.id, token: TOK.custB, app: 'CUSTOMER' } });
      // a token the customer account holds for another app must not receive customer pushes
      await prisma.deviceToken.create({ data: { userId: STUDENT.id, token: 'wrong_app_token_0123456789abcdef', app: 'VENDOR' } });
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_ACCEPTED').map((m) => m.token).sort()).toEqual([TOK.cust, TOK.custB].sort());
      expect(await logOf(id, 'ORDER_ACCEPTED')).toHaveLength(1); // one log row per (order, event, user)
    });
  });

  // =========================================================================
  // Idempotency, retries, dead tokens, no devices
  // =========================================================================
  describe('delivery guarantees', () => {
    test('double payment confirmation (verify twice + webhook) sends NEW_ORDER once', async () => {
      await registerAll();
      const id = await placeOnly();
      const pay = await createPayment(id);
      const a = await verify(pay.body.razorpayOrderId);
      const b = await verify(pay.body.razorpayOrderId); // the second confirmation is answered, not re-processed
      const amountPaise = Math.round((await prisma.order.findUniqueOrThrow({ where: { id } })).totalAmount * 100);
      const hook = await request.post('/api/payments/webhook').set('x-razorpay-signature', 'valid_test_wh_signature').send({
        event: 'payment.captured',
        payload: { payment: { entity: { id: `pay_${randomUUID().slice(0, 12)}`, order_id: pay.body.razorpayOrderId, amount: amountPaise, status: 'captured', notes: {} } } },
      });
      expect(a.status).toBe(200);
      expect(b.status).toBeLessThan(500);
      expect(hook.status).toBeLessThan(500);
      await flush();
      expect(fake.to(id, 'NEW_ORDER')).toHaveLength(1);
      expect(await logOf(id, 'NEW_ORDER')).toHaveLength(1);
    });

    test('the same (order, event, user) is claimed once in the database even when called twice at the same time', async () => {
      await registerAll();
      const id = await placePaid();
      fake.sent.length = 0;
      await prisma.pushLog.deleteMany({});
      await Promise.all([notifyOrderEvent(id, 'ORDER_ACCEPTED'), notifyOrderEvent(id, 'ORDER_ACCEPTED'), notifyOrderEvent(id, 'ORDER_ACCEPTED')]);
      expect(fake.to(id, 'ORDER_ACCEPTED')).toHaveLength(1);
      await notifyOrderEvent(id, 'ORDER_ACCEPTED');
      expect(fake.to(id, 'ORDER_ACCEPTED')).toHaveLength(1);
    });

    test('a transient failure is retried by the 60 s maintenance job and ends SENT', async () => {
      await registerAll();
      let fail = true;
      fake.behaviour = () => { if (fail) throw fcmError('messaging/server-unavailable'); };
      const id = await placePaid();
      let row = (await logOf(id, 'NEW_ORDER'))[0];
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'UNAVAILABLE' });
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      expect(fake.to(id, 'NEW_ORDER')).toHaveLength(0);

      // Too early: nothing happens.
      expect(await retryDuePushes(new Date())).toBe(0);
      expect((await logOf(id, 'NEW_ORDER'))[0].attempts).toBe(1);

      // FCM is back; the maintenance tick (one minute later) retries it.
      fail = false;
      await runOrderMaintenance(new Date(Date.now() + 61_000));
      row = (await logOf(id, 'NEW_ORDER'))[0];
      expect(row).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
      expect(row.sentAt).not.toBeNull();
      expect(fake.to(id, 'NEW_ORDER')).toHaveLength(1);
      // and it is not sent a third time
      await runOrderMaintenance(new Date(Date.now() + 10 * 60_000));
      expect(fake.to(id, 'NEW_ORDER')).toHaveLength(1);
    });

    test('QUOTA_EXCEEDED, INTERNAL and network errors (no code, timeout) are transient; five attempts then FAILED', async () => {
      expect(['messaging/message-rate-exceeded', 'QUOTA_EXCEEDED', 'messaging/internal-error', 'INTERNAL', 'UNAVAILABLE'].map((c) => classifyPushError(fcmError(c)).transient)).toEqual([true, true, true, true, true]);
      expect(classifyPushError(new Error('socket hang up')).transient).toBe(true);
      expect(classifyPushError(Object.assign(new Error('x'), { code: 'app/network-error' })).transient).toBe(true);
      expect(classifyPushError(fcmError('messaging/third-party-auth-error')).transient).toBe(false);

      await registerAll();
      fake.behaviour = () => { throw fcmError('messaging/internal-error'); };
      const id = await placePaid();
      const start = Date.now();
      for (let i = 1; i <= 6; i++) await retryDuePushes(new Date(start + i * 5 * 60_000));
      const row = (await logOf(id, 'NEW_ORDER'))[0];
      // NEW_ORDER is only useful for 10 minutes, so it gives up as soon as the backoff passes that window.
      expect(row.status).toBe('FAILED');
      expect(row.attempts).toBeLessThanOrEqual(5);
      expect(row.nextAttemptAt).toBeNull();

      // A status event (30 minutes) really uses all five attempts.
      fake.attemptsLog.length = 0;
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      const t0 = Date.now();
      for (let i = 1; i <= 8; i++) await retryDuePushes(new Date(t0 + i * 3 * 60_000));
      const acc = (await logOf(id, 'ORDER_ACCEPTED'))[0];
      expect(acc).toMatchObject({ status: 'FAILED', attempts: 5, lastError: 'INTERNAL' });
      expect(fake.attemptsLog.filter((m) => m.data.event === 'ORDER_ACCEPTED')).toHaveLength(5);
    });

    test('a retry that comes too late is dropped (EXPIRED) and one that is no longer true is SKIPPED (STALE)', async () => {
      await registerAll();
      fake.behaviour = () => { throw fcmError('messaging/server-unavailable'); };
      const late = await placePaid();
      fake.behaviour = () => undefined;
      await retryDuePushes(new Date(Date.now() + 11 * 60_000));
      expect(await logOf(late, 'NEW_ORDER')).toEqual([expect.objectContaining({ status: 'FAILED', lastError: 'EXPIRED' })]);
      expect(fake.to(late, 'NEW_ORDER')).toHaveLength(0);

      fake.behaviour = () => { throw fcmError('messaging/server-unavailable'); };
      const stale = await placePaid();
      expect((await logOf(stale, 'NEW_ORDER'))[0].status).toBe('PENDING');
      fake.behaviour = () => undefined;
      expect((await setStatus(stale, 'ACCEPTED', tVendor)).status).toBe(200); // someone handled it meanwhile
      await flush();
      await retryDuePushes(new Date(Date.now() + 61_000));
      expect(await logOf(stale, 'NEW_ORDER')).toEqual([expect.objectContaining({ status: 'SKIPPED', lastError: 'STALE' })]);
      expect(fake.to(stale, 'NEW_ORDER')).toHaveLength(0);
    });

    test('a dead token is disabled at once and never retried; the other device still gets the push', async () => {
      for (const code of ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument:token', 'SENDER_ID_MISMATCH']) {
        await prisma.pushLog.deleteMany({});
        await prisma.deviceToken.deleteMany({});
        await registerAll();
        await prisma.deviceToken.create({ data: { userId: STUDENT.id, token: TOK.custB, app: 'CUSTOMER' } });
        fake.sent.length = 0;
        fake.behaviour = (m) => { if (m.token === TOK.cust) throw (code.endsWith(':token') ? fcmError('messaging/invalid-argument', 'The registration token is not a valid FCM registration token') : fcmError(code)); };
        const id = await placePaid();
        expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
        await flush();
        const dead = await prisma.deviceToken.findUniqueOrThrow({ where: { token: TOK.cust } });
        expect(dead.disabledAt).not.toBeNull();
        expect(dead.disabledReason).toMatch(/^(UNREGISTERED|INVALID_TOKEN|SENDER_ID_MISMATCH)$/);
        expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: TOK.custB } })).disabledAt).toBeNull();
        expect(fake.to(id, 'ORDER_ACCEPTED').map((m) => m.token)).toEqual([TOK.custB]);
        expect((await logOf(id, 'ORDER_ACCEPTED'))[0].status).toBe('SENT');
      }
    });

    test('a MESSAGE problem (INVALID_ARGUMENT that is not about the token) fails that push only: the token stays enabled and nothing is retried', async () => {
      await registerAll();
      fake.behaviour = (m) => { if (m.token === TOK.cust) throw fcmError('messaging/invalid-argument', 'Invalid JSON payload received. Unknown name "foo"'); };
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(await logOf(id, 'ORDER_ACCEPTED')).toEqual([expect.objectContaining({ status: 'FAILED', lastError: 'INVALID_PAYLOAD', nextAttemptAt: null })]);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: TOK.cust } })).disabledAt).toBeNull();
      expect(await retryDuePushes(new Date(Date.now() + 3600_000))).toBe(0);
    });

    test('only dead tokens: FAILED, nothing pending, and the next event skips the dead device', async () => {
      await registerAll();
      fake.behaviour = (m) => { if (m.token === TOK.cust) throw fcmError('messaging/registration-token-not-registered'); };
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(await logOf(id, 'ORDER_ACCEPTED')).toEqual([expect.objectContaining({ status: 'FAILED', lastError: 'UNREGISTERED', nextAttemptAt: null })]);
      expect(await retryDuePushes(new Date(Date.now() + 3600_000))).toBe(0);
      fake.attemptsLog.length = 0;
      expect((await setStatus(id, 'PREPARING', tVendor)).status).toBe(200);
      expect((await setStatus(id, 'READY_FOR_PICKUP', tVendor)).status).toBe(200);
      await flush();
      expect(await logOf(id, 'ORDER_READY')).toEqual([expect.objectContaining({ status: 'SKIPPED', lastError: 'NO_DEVICE' })]);
      expect(fake.attemptsLog.filter((m) => m.token === TOK.cust)).toHaveLength(0);
    });

    test('a user without any active device is SKIPPED and the provider is not called for them', async () => {
      await prisma.deviceToken.create({ data: { userId: VENDOR.id, token: TOK.vendor, app: 'VENDOR' } });
      await prisma.deviceToken.create({ data: { userId: STUDENT.id, token: TOK.cust, app: 'CUSTOMER', disabledAt: new Date(), disabledReason: 'LOGOUT' } });
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(await logOf(id, 'ORDER_ACCEPTED')).toEqual([expect.objectContaining({ status: 'SKIPPED', attempts: 0, userId: STUDENT.id })]);
      expect(fake.sent.map((m) => m.token)).toEqual([TOK.vendor]);
    });

    test('a logged-out device (DELETE /devices) gets nothing more', async () => {
      await request.post('/api/devices').set(H(tStudent)).send({ token: TOK.cust, app: 'CUSTOMER' });
      await request.post('/api/devices').set(H(tVendor)).send({ token: TOK.vendor, app: 'VENDOR' });
      const id = await placePaid();
      expect(fake.to(id, 'NEW_ORDER')).toHaveLength(1);
      await request.delete('/api/devices').set(H(tStudent)).send({ token: TOK.cust });
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'ORDER_ACCEPTED')).toHaveLength(0);
    });
  });

  // =========================================================================
  // Suspension, deletion
  // =========================================================================
  describe('accounts', () => {
    test('a suspended restaurant gets nothing and its devices are disabled', async () => {
      await registerAll();
      const id = await placeOnly(); // placed while the restaurant was fine
      const vendorRow = await prisma.vendor.findUniqueOrThrow({ where: { id: 'ven-1' } });
      const s = await request.post(`/api/admin/partners/vendor/${vendorRow.id}/status`).set(H(tAdmin)).send({ status: 'SUSPENDED', reason: 'Hygiene check failed' });
      expect(s.status).toBe(200);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: TOK.vendor } }))).toMatchObject({ disabledReason: 'PARTNER_SUSPENDED' });
      await prisma.user.update({ where: { id: VENDOR.id }, data: { tokenVersion: 0 } });
      await payOrder(id);
      await flush();
      expect(fake.sent.filter((m) => m.token === TOK.vendor)).toHaveLength(0);
      expect(await logOf(id, 'NEW_ORDER')).toHaveLength(0);
      // even if the device registers again, an unapproved partner is not a recipient
      await prisma.deviceToken.update({ where: { token: TOK.vendor }, data: { disabledAt: null, disabledReason: null } });
      await notifyOrderEvent(id, 'NEW_ORDER');
      expect(fake.sent.filter((m) => m.token === TOK.vendor)).toHaveLength(0);
    });

    test('a suspended rider stops getting deliveries; the other rider still does', async () => {
      await registerAll();
      const dp = await prisma.driverPartner.findFirstOrThrow({ where: { userId: RIDER2.id } });
      const s = await request.post(`/api/admin/partners/driver/${dp.id}/status`).set(H(tAdmin)).send({ status: 'SUSPENDED', reason: 'Too many complaints' });
      expect(s.status).toBe(200);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: TOK.rider2 } })).disabledAt).not.toBeNull();
      const id = await placePaid();
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) expect((await setStatus(id, st, tVendor)).status).toBe(200);
      await flush();
      expect(fake.to(id, 'NEW_DELIVERY').map((m) => OWNER_OF[m.token])).toEqual(['RIDER']);
    });

    test('a rejected application disables the applicant devices', async () => {
      const u = await prisma.user.create({ data: { id: 'usr-push-pending', name: 'Pending Rider', phone: '+91 9999853333', role: Role.DRIVER } });
      const dp = await prisma.driverPartner.create({ data: { id: 'dp-push-pending', userId: u.id, name: 'Pending Rider', phone: u.phone!, runnerCode: 'RUN-PUSHP', vehicleType: 'Bike', approvalStatus: 'PENDING' } });
      await prisma.deviceToken.create({ data: { userId: u.id, token: 'pending_rider_token_0123456789ab', app: 'DRIVER' } });
      const r = await request.post(`/api/admin/partners/driver/${dp.id}/status`).set(H(tAdmin)).send({ status: 'REJECTED', reason: 'Documents unclear' });
      expect(r.status).toBe(200);
      expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: 'pending_rider_token_0123456789ab' } })).disabledReason).toBe('PARTNER_REJECTED');
      await prisma.driverPartner.delete({ where: { id: dp.id } });
    });

    test('deleting the account disables its devices', async () => {
      await prisma.deviceToken.create({ data: { userId: STUDENT3.id, token: 'deleted_user_token_0123456789ab', app: 'CUSTOMER' } });
      const r = await request.delete('/api/auth/account').set(H(tStudent3));
      expect(r.status).toBe(200);
      expect(await prisma.deviceToken.findUniqueOrThrow({ where: { token: 'deleted_user_token_0123456789ab' } })).toMatchObject({ disabledReason: 'ACCOUNT_DELETED' });
      await prisma.user.update({ where: { id: STUDENT3.id }, data: { deletedAt: null, name: 'Dev Patel' } }); // keep the fixture reusable
    });
  });

  // =========================================================================
  // Push can never change an order
  // =========================================================================
  describe('isolation from the order engine', () => {
    const failing: [string, (m: PushMessage) => Promise<void> | void][] = [
      ['throws synchronously', () => { throw new Error('boom'); }],
      ['rejects', async () => { throw fcmError('messaging/internal-error'); }],
      ['never answers (timeout)', () => new Promise<void>(() => undefined)],
    ];

    test.each(failing)('a provider that %s changes neither the status nor the HTTP answer of pay / advance / cancel', async (_name, behaviour) => {
      process.env.PUSH_SEND_TIMEOUT_MS = '60';
      await registerAll();
      fake.behaviour = behaviour;

      const id = await placeOnly();
      const pay = await createPayment(id);
      const paid = await verify(pay.body.razorpayOrderId);
      expect(paid.status).toBe(200);
      expect(paid.body.data).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });

      const acc = await setStatus(id, 'ACCEPTED', tVendor);
      expect(acc.status).toBe(200);
      expect(acc.body.data.status).toBe('ACCEPTED');
      for (const s of ['PREPARING', 'READY_FOR_PICKUP']) expect((await setStatus(id, s, tVendor)).status).toBe(200);
      expect((await claim(id)).status).toBe(200);
      expect((await setStatus(id, 'PICKED_UP', tRider)).status).toBe(200);
      expect((await setStatus(id, 'ARRIVED_AT_GATE', tRider)).status).toBe(200);
      const otp = (await prisma.order.findUniqueOrThrow({ where: { id } })).otpCode!;
      const done = await setStatus(id, 'DELIVERED', tRider, { otpCode: otp });
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe('DELIVERED');

      const id2 = await placePaid();
      const c = await request.post(`/api/orders/${id2}/cancel`).set(H(tStudent)).send({ reason: 'Changed my mind' });
      expect(c.status).toBe(200);
      expect(c.body.data.status).toBe('CANCELLED');
      await flush();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: id2 } })).toMatchObject({ status: 'CANCELLED', refundStatus: 'DONE', paymentStatus: 'REFUNDED' });
      expect(await prisma.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID' });
      expect(fake.sent).toHaveLength(0);
      // the failures are in the log, as codes
      const rows = await prisma.pushLog.findMany({});
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status !== 'SENT')).toBe(true);
    });

    test('a hung provider does not delay the HTTP answer', async () => {
      process.env.PUSH_SEND_TIMEOUT_MS = '3000';
      await registerAll();
      fake.behaviour = () => new Promise<void>(() => undefined);
      const id = await placeOnly();
      const pay = await createPayment(id);
      const t0 = Date.now();
      const paid = await verify(pay.body.razorpayOrderId);
      expect(paid.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2500);
      process.env.PUSH_SEND_TIMEOUT_MS = '50';
      await flush();
    });

    test('notifyOrderEvent and retryDuePushes never reject (unknown order, unknown event row, database row for a deleted order)', async () => {
      await expect(notifyOrderEvent('no-such-order', 'NEW_ORDER')).resolves.toBeUndefined();
      await prisma.pushLog.create({ data: { key: 'ghost:NEW_ORDER:u', orderId: 'ghost', userId: 'u', event: 'NEW_ORDER', status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000) } });
      await prisma.pushLog.create({ data: { key: 'ghost2:WEIRD:u', orderId: 'ghost2', userId: 'u', event: 'WEIRD', status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000) } });
      await expect(retryDuePushes(new Date())).resolves.toBeGreaterThanOrEqual(0);
      expect((await prisma.pushLog.findUniqueOrThrow({ where: { key: 'ghost:NEW_ORDER:u' } })).status).toBe('SKIPPED');
      expect((await prisma.pushLog.findUniqueOrThrow({ where: { key: 'ghost2:WEIRD:u' } })).lastError).toBe('UNKNOWN_EVENT');
    });

    test('the maintenance job survives a push database error', async () => {
      await registerAll();
      const spy = jest.spyOn(prisma.pushLog, 'findMany').mockRejectedValue(new Error('db down'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(runOrderMaintenance()).resolves.toBeTruthy();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Configuration
  // =========================================================================
  describe('provider configuration', () => {
    const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
      const saved: Record<string, string | undefined> = {};
      for (const k of [...Object.keys(env), 'NODE_ENV']) saved[k] = process.env[k];
      try {
        for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
        await fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
        __resetPushProvider();
      }
    };

    test('unconfigured = no-op: no database work, no push, orders unaffected', async () => {
      setPushProvider(null);
      __resetPushProvider();
      expect(getPushProvider().enabled).toBe(false);
      await registerAll();
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      expect(await prisma.pushLog.count()).toBe(0);
      expect(await retryDuePushes(new Date(Date.now() + 3600_000))).toBe(0);
      expect(fake.attemptsLog).toHaveLength(0);
    });

    test('under NODE_ENV=test the real provider is never built, even with credentials in the environment', async () => {
      await withEnv({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ private_key: 'x', client_email: 'y@z' }), NODE_ENV: 'test' }, () => {
        setPushProvider(null);
        __resetPushProvider();
        expect(getPushProvider().enabled).toBe(false);
      });
    });

    test('missing or invalid credentials outside tests: ONE warning, push off, no throw', async () => {
      const cases: Record<string, string | undefined>[] = [
        { FIREBASE_KEY_PATH: undefined, FIREBASE_SERVICE_ACCOUNT: undefined },
        { FIREBASE_KEY_PATH: '/no/such/file.json', FIREBASE_SERVICE_ACCOUNT: undefined },
        { FIREBASE_KEY_PATH: undefined, FIREBASE_SERVICE_ACCOUNT: 'this is not json' },
        { FIREBASE_KEY_PATH: undefined, FIREBASE_SERVICE_ACCOUNT: '{"type":"service_account"}' },
      ];
      for (const c of cases) {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await withEnv({ ...c, NODE_ENV: 'production' }, () => {
          setPushProvider(null);
          __resetPushProvider();
          expect(getPushProvider().enabled).toBe(false);
          expect(getPushProvider().enabled).toBe(false);
          expect(warn).toHaveBeenCalledTimes(1);
          const line = String(warn.mock.calls[0][0]);
          expect(line).toMatch(/push notifications are OFF/);
          expect(line).not.toMatch(/this is not json|service_account/);
        });
        warn.mockRestore();
      }
    });
  });

  // =========================================================================
  // Housekeeping
  // =========================================================================
  describe('pruning', () => {
    test('PushLog older than 14 days and tokens disabled for more than 60 days are deleted; fresh ones stay', async () => {
      const day = 86_400_000;
      const old = new Date(Date.now() - 15 * day);
      await prisma.pushLog.createMany({ data: [
        { key: 'old:E:u', orderId: 'old', userId: 'u', event: 'ORDER_READY', status: 'SENT', createdAt: old },
        { key: 'new:E:u', orderId: 'new', userId: 'u', event: 'ORDER_READY', status: 'SENT' },
      ] });
      await prisma.deviceToken.createMany({ data: [
        { userId: STUDENT.id, token: 'old_disabled_token_0123456789abc', app: 'CUSTOMER', disabledAt: new Date(Date.now() - 61 * day), disabledReason: 'LOGOUT' },
        { userId: STUDENT.id, token: 'recent_disabled_token_0123456789a', app: 'CUSTOMER', disabledAt: new Date(Date.now() - 30 * day), disabledReason: 'LOGOUT' },
        { userId: STUDENT.id, token: 'active_old_token_0123456789abcde', app: 'CUSTOMER', createdAt: new Date(Date.now() - 400 * day) },
      ] });
      expect(await pruneOldPushData()).toEqual({ logs: 1, tokens: 1 });
      expect((await prisma.pushLog.findMany()).map((r) => r.key)).toEqual(['new:E:u']);
      expect((await prisma.deviceToken.findMany()).map((r) => r.token).sort()).toEqual(['active_old_token_0123456789abcde', 'recent_disabled_token_0123456789a']);
    });
  });

  // =========================================================================
  // Privacy scan over everything sent by every test above
  // =========================================================================
  describe('privacy', () => {
    test('no OTP, phone number, address or private note in any title / body / data of any event', async () => {
      // Make sure each of the 12 events was exercised by the tests above.
      const seen = new Set(everything.map((m) => m.data.event));
      expect([...PUSH_EVENTS].filter((e) => !seen.has(e))).toEqual([]);
      expect(secrets.otps.size).toBeGreaterThan(0);

      const phones = [STUDENT, STUDENT2, STUDENT3, VENDOR, RIDER, RIDER2, ADMIN].map((u) => u.phone.replace(/\D/g, '').slice(-10));
      for (const m of everything) {
        const all = JSON.stringify(m);
        expect(Object.keys(m.data).sort()).toEqual(['event', 'orderId', 'v']);
        expect(m.data.v).toBe('1');
        for (const otp of secrets.otps) expect(all).not.toContain(otp);
        for (const p of phones) expect(all.replace(/\D/g, '')).not.toContain(p);
        expect(all).not.toMatch(/9876501234|Room 214|Ashta-Kothri|Highway, 1\.2km|otp|OTP|password/);
        // The only digits allowed in a title/body: counts, rupee amounts, "5-7 working days" and the "#REF" of an order.
        const text = `${m.title} ${m.body}`.replace(/#[A-Z0-9]{6}\b/g, '').replace(/Rs \d+(\.\d{2})?/g, '').replace(/\b\d+ items?\b/g, '').replace(/5-7/g, '').replace(/\b(Block|Gate) \d\b/g, '');
        expect(text).not.toMatch(/\d/);
        expect(m.token).toMatch(/^tok_/);
        expect(`${m.title} ${m.body}`).not.toContain(m.token);
      }
    });

    test('the push code never logs tokens, titles or bodies', async () => {
      const lines: string[] = [];
      jest.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
      jest.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
      await registerAll();
      fake.behaviour = () => { throw Object.assign(new Error(`bad token ${TOK.cust} body New order`), { code: 'messaging/internal-error' }); };
      const id = await placePaid();
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await flush();
      const joined = lines.join('\n');
      expect(joined).not.toContain('tok_');
      expect(joined).not.toMatch(/New order|Tap to accept|Order accepted/);
      const rows = await prisma.pushLog.findMany({});
      expect(JSON.stringify(rows)).not.toContain('tok_');
    });
  });
});
