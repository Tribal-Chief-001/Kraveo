/**
 * Order flow v1 (Docs/16_order_flow_contract.md): money, status, visibility, realtime, gate OTP, refunds,
 * the maintenance job, and every failure mode of section 7. Runs against a real PostgreSQL and real
 * socket.io-client connections. The payment provider is the in-memory simulator (no network).
 *
 * WRITE_ORDER_FIXTURES=1 also writes the captured JSON to Docs/fixtures/order_flow_samples.json.
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
import { setPaymentProvider, createSimulatedProvider, PaymentProvider } from '../../src/services/paymentService';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { __waitForBackgroundWork } from '../../src/services/refundService';

jest.setTimeout(30_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const STUDENT2 = { id: 'usr-of-stu2', phone: '+91 9999811111' };
const VENDOR = { id: 'usr-3', phone: '+91 9876543212' };
const VENDOR2 = { id: 'usr-of-ven2', phone: '+91 9999833333' };
const RIDER = { id: 'usr-4', phone: '+91 9876543213' };
const RIDER2 = { id: 'usr-of-rid2', phone: '+91 9999822222' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };

const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tStudent2 = getStudentToken(STUDENT2.id, STUDENT2.phone);
const tVendor = getVendorToken(VENDOR.id, VENDOR.phone);
const tVendor2 = getVendorToken(VENDOR2.id, VENDOR2.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);
const tRider2 = getDriverToken(RIDER2.id, RIDER2.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Time shift past the refund retry backoff (transient provider failures wait 30 s, 1, 2, 4 ... minutes). */
const soon = (min = 5) => new Date(Date.now() + min * 60_000);
const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('condition not met in time');
};
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

const fixtures: Record<string, unknown> = {};
const capture = (key: string, value: unknown) => {
  if (!(key in fixtures)) fixtures[key] = JSON.parse(JSON.stringify(value));
};

describe('Order flow v1', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  let sim: ReturnType<typeof createSimulatedProvider>;
  const sockets: Socket[] = [];

  const H = (t: string) => getAuthHeader(t);
  const connect = async (token: string) => {
    const s = await connectTestSocket(server.baseUrl, { auth: { token } });
    sockets.push(s);
    return s;
  };
  const record = (s: Socket, events: string[]) => {
    const log: Record<string, any[]> = {};
    for (const e of events) {
      log[e] = [];
      s.on(e, (d: any) => log[e].push(d));
    }
    return log;
  };
  const join = async (s: Socket, room: string) => (await s.emitWithAck('join_room', room)).ok as boolean;

  // ---------------- API helpers ----------------
  const place = (token = tStudent, extra: Record<string, unknown> = {}) =>
    request.post('/api/orders').set(H(token)).send({
      vendorId: 'ven-1', items: [{ itemId: 'item-1', quantity: 1 }], dropoffHostel: 'Block 2', dropoffNotes: 'Room 214, call 98xxxxxx', clientRequestId: randomUUID(), ...extra,
    });
  const createPayment = (orderId: string, token = tStudent) => request.post('/api/payments/create-order').set(H(token)).send({ orderId });
  const verify = (rzpOrderId: string, paymentId = `pay_${randomUUID().slice(0, 12)}`, token = tStudent) =>
    request.post('/api/payments/verify-signature').set(H(token)).send({ razorpayOrderId: rzpOrderId, razorpayPaymentId: paymentId, razorpaySignature: 'sim' });
  const webhook = (body: unknown, signature = 'valid_test_wh_signature') =>
    request.post('/api/payments/webhook').set('x-razorpay-signature', signature).send(body as any);
  const captured = (rzpOrderId: string, amountPaise: number, paymentId = `pay_${randomUUID().slice(0, 12)}`) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, amount: amountPaise, status: 'captured', notes: {} } } },
  });
  const setStatus = (id: string, status: string, token: string, extra: object = {}) => request.patch(`/api/orders/${id}/status`).set(H(token)).send({ status, ...extra });
  const claim = (id: string, token = tRider) => request.post(`/api/orders/${id}/accept-driver`).set(H(token)).send({});
  const getOrder = (id: string, token: string) => request.get(`/api/orders/${id}`).set(H(token));
  const db = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const refundsOf = async (orderId: string) => {
    const pays = await prisma.payment.findMany({ where: { orderId } });
    return pays.flatMap((p) => (p.razorpayPaymentId ? sim.refunds.get(p.razorpayPaymentId) ?? [] : []));
  };

  /** Place + pay through the real endpoints. Returns ids. */
  const placePaid = async (token = tStudent) => {
    const placed = await place(token);
    expect(placed.status).toBe(201);
    const pay = await createPayment(placed.body.data.id, token);
    expect(pay.status).toBe(200);
    const v = await verify(pay.body.razorpayOrderId, undefined, token);
    expect(v.status).toBe(200);
    return { id: placed.body.data.id as string, rzp: pay.body.razorpayOrderId as string };
  };

  /** Drive a paid order to `target` through the real endpoints (vendor, rider). */
  const driveTo = async (target: string, rider = tRider) => {
    const o = await placePaid();
    const steps = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
    for (const st of steps) {
      if (target === 'PLACED') return o;
      expect((await setStatus(o.id, st, tVendor)).status).toBe(200);
      if (st === target) return o;
    }
    expect((await claim(o.id, rider)).status).toBe(200);
    if (target === 'CLAIMED') return o;
    expect((await setStatus(o.id, 'PICKED_UP', rider)).status).toBe(200);
    if (target === 'PICKED_UP') return o;
    expect((await setStatus(o.id, 'ARRIVED_AT_GATE', rider)).status).toBe(200);
    return o;
  };

  /** A paid order created directly in the database (with a captured Razorpay payment), for state setups. */
  const makePaidOrder = async (status: string, opts: { driverId?: string | null; customerId?: string; paidAgoMin?: number } = {}) => {
    const paymentId = `pay_fx_${randomUUID().slice(0, 12)}`;
    const order = await prisma.order.create({
      data: {
        customerId: opts.customerId ?? STUDENT.id, vendorId: 'ven-1', driverId: opts.driverId ?? null, totalAmount: 220, subtotal: 180, deliveryFee: 25, taxAndPackaging: 15,
        dropoffHostel: 'Block 3', status: status as any, paymentStatus: 'PAID', paidAt: new Date(Date.now() - (opts.paidAgoMin ?? 1) * 60_000),
        otpCode: status === 'ARRIVED_AT_GATE' ? '4821' : null,
        payments: { create: [{ razorpayOrderId: `order_fx_${randomUUID().slice(0, 12)}`, razorpayPaymentId: paymentId, amount: 220, capturedAmountPaise: 22000, status: 'PAID' }] },
      },
    });
    return order;
  };

  const freeRiders = () => prisma.order.updateMany({ where: { driverId: { in: [RIDER.id, RIDER2.id] }, status: { notIn: ['DELIVERED', 'CANCELLED'] } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });

  beforeAll(async () => {
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.adminAuditLog.deleteMany({});
    for (const u of [
      { id: STUDENT2.id, name: 'Priya Nair', phone: STUDENT2.phone, role: Role.STUDENT, hostelBlock: 'Girls Gate 1' },
      { id: RIDER2.id, name: 'Arjun Rider', phone: RIDER2.phone, role: Role.DRIVER },
      { id: VENDOR2.id, name: 'Other Owner', phone: VENDOR2.phone, role: Role.VENDOR },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    await prisma.driverPartner.upsert({
      where: { id: 'dp-of-rid2' },
      update: { userId: RIDER2.id, dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' },
      create: { id: 'dp-of-rid2', userId: RIDER2.id, name: 'Arjun Rider', phone: RIDER2.phone, runnerCode: 'RUN-OF02', vehicleType: 'Bike', dutyStatus: 'ONLINE' },
    });
    await prisma.vendor.upsert({
      where: { id: 'ven-of-2' },
      update: { userId: VENDOR2.id, approvalStatus: 'APPROVED' },
      create: { id: 'ven-of-2', userId: VENDOR2.id, name: 'Other Kitchen', category: 'Rolls', address: 'Gate 2', bannerImage: '' },
    });
    await prisma.user.update({ where: { id: STUDENT.id }, data: { name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' } });
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    sim = createSimulatedProvider();
    setPaymentProvider(sim);
    await freeRiders();
    // Leftover unpaid orders would hit the 3-unpaid limit.
    await prisma.order.updateMany({ where: { status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.vendor.update({ where: { id: 'ven-1' }, data: { isAcceptingOrders: true, approvalStatus: 'APPROVED' } });
    await prisma.driverPartner.updateMany({ where: { userId: { in: [RIDER.id, RIDER2.id] } }, data: { dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' } });
    // Suspending a rider through the API revokes their tokens (tokenVersion); the test tokens carry tv 0.
    await prisma.user.updateMany({ where: { id: { in: [RIDER.id, RIDER2.id, VENDOR.id] } }, data: { tokenVersion: 0 } });
  });

  afterEach(async () => {
    await __waitForBackgroundWork();
    while (sockets.length) disconnectTestSocket(sockets.pop()!);
    setPaymentProvider(null);
  });

  afterAll(async () => {
    if (process.env.WRITE_ORDER_FIXTURES === '1') {
      const file = path.resolve(__dirname, '../../../Docs/fixtures/order_flow_samples.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = {
        _about: 'Real responses captured by backend/test/e2e/order_flow_v1.test.ts (WRITE_ORDER_FIXTURES=1). Contract: Docs/16_order_flow_contract.md. Ids, times and codes differ on every run; the shape does not.',
        _capturedAt: new Date().toISOString(),
        ...Object.fromEntries(Object.keys(fixtures).sort().map((k) => [k, fixtures[k]])),
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    }
    await prisma.order.deleteMany({ where: { vendorId: 'ven-of-2' } });
    await prisma.menuItem.deleteMany({ where: { vendorId: 'ven-of-2' } });
    await prisma.vendor.deleteMany({ where: { id: 'ven-of-2' } });
    await prisma.driverPartner.deleteMany({ where: { id: 'dp-of-rid2' } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================
  // Happy path + visibility per role (REST and socket)
  // =========================================================================
  describe('lifecycle and visibility', () => {
    test('a full order: views per role over REST and over real sockets follow the visibility table', async () => {
      const cust = await connect(tStudent);
      const ven = await connect(tVendor);
      const rid = await connect(tRider);
      const rid2 = await connect(tRider2);
      const adm = await connect(tAdmin);
      const custLog = record(cust, ['order_updated', 'rider_location', 'new_order_alert']);
      const venLog = record(ven, ['order_updated', 'new_order_alert', 'rider_location']);
      const ridLog = record(rid, ['order_updated', 'order_available', 'order_unavailable', 'rider_location']);
      const rid2Log = record(rid2, ['order_updated', 'order_available', 'order_unavailable', 'rider_location']);
      const admLog = record(adm, ['order_updated', 'new_order_alert', 'rider_location', 'driver_location_update']);

      // 1. Customer places: server totals, unpaid, nobody else hears about it.
      const placed = await place();
      expect(placed.status).toBe(201);
      const id = placed.body.data.id;
      const v0 = placed.body.data;
      capture('customer_view_PLACED_unpaid', v0);
      expect(v0).toMatchObject({ status: 'PLACED', paymentStatus: 'PENDING', subtotal: 180, deliveryFee: 25, taxAndPackaging: 15, discount: 0, totalAmount: 220, otpCode: null, driver: null });
      expect(v0.customer).toEqual({ id: STUDENT.id, name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' });
      expect(Date.parse(v0.payBy) - Date.parse(v0.createdAt)).toBe(15 * 60_000);
      expect(await join(cust, `order_${id}`)).toBe(true);
      expect(await join(ven, `order_${id}`)).toBe(false); // unpaid: the restaurant may not watch it
      expect(await join(rid, `order_${id}`)).toBe(false);
      expect(await join(cust, `order_does-not-exist`)).toBe(false);
      expect((await getOrder(id, tVendor)).status).toBe(404);
      expect((await request.get('/api/orders?scope=active').set(H(tVendor))).body.data.some((o: any) => o.id === id)).toBe(false);
      expect((await request.get('/api/orders/available').set(H(tRider))).body.data.some((o: any) => o.id === id)).toBe(false);

      // 2. Payment: exactly one new_order_alert to the restaurant (and admins).
      const pay = await createPayment(id);
      const verified = await verify(pay.body.razorpayOrderId);
      expect(verified.status).toBe(200);
      capture('customer_view_PAID', verified.body.data);
      await until(() => venLog.new_order_alert.length === 1 && admLog.new_order_alert.length === 1);
      const alert = venLog.new_order_alert[0];
      capture('socket_new_order_alert_vendor', alert);
      expect(alert).toMatchObject({ id, paymentStatus: 'PAID', status: 'PLACED' });
      expect(alert.customer).toEqual({ id: STUDENT.id, name: 'Rahul', phone: null, hostelBlock: null });
      expect(alert.otpCode).toBeNull();
      expect(alert.acceptBy).toBeTruthy();
      expect(custLog.new_order_alert).toHaveLength(0);
      expect(ridLog.order_available).toHaveLength(0); // not in the pool before the restaurant accepts

      const vendorView = (await getOrder(id, tVendor)).body.data;
      capture('vendor_view_new_paid_order', vendorView);
      expect(vendorView.customer.phone).toBeNull();
      expect(vendorView.customer.name).toBe('Rahul');
      expect(JSON.stringify(vendorView)).not.toMatch(/razorpay|rzp_|pay_|payments/);

      // 3. Restaurant accepts -> it enters the rider pool (order_available, pool view).
      expect((await setStatus(id, 'ACCEPTED', tVendor)).status).toBe(200);
      await until(() => ridLog.order_available.length >= 1 && rid2Log.order_available.length >= 1);
      const offer = ridLog.order_available[0];
      capture('socket_order_available', offer);
      capture('rider_pool_view', offer);
      expect(offer.customer).toBeNull();
      expect(offer.dropoffNotes).toBeNull();
      expect(offer.driver).toBeNull();
      expect(offer.otpCode).toBeNull();
      const pool = (await request.get('/api/orders/available').set(H(tRider))).body.data.find((o: any) => o.id === id);
      expect(pool).toMatchObject({ id, customer: null, dropoffNotes: null });
      expect(await join(rid, `order_${id}`)).toBe(false); // pool riders cannot watch the order room

      // 4. Rider claims -> everybody else gets order_unavailable; the rider gets the assigned view.
      const claimed = await claim(id);
      expect(claimed.status).toBe(200);
      capture('rider_assigned_view_after_claim', claimed.body.data);
      expect(claimed.body.data.status).toBe('ACCEPTED'); // claiming never changes the status
      expect(claimed.body.data.customer).toEqual({ id: STUDENT.id, name: 'Rahul Sharma', phone: STUDENT.phone, hostelBlock: 'Block 3' });
      expect(claimed.body.data.driver).toMatchObject({ id: RIDER.id, phone: RIDER.phone });
      await until(() => rid2Log.order_unavailable.some((e) => e.id === id));
      capture('socket_order_unavailable', rid2Log.order_unavailable.find((e) => e.id === id));
      expect(Object.keys(rid2Log.order_unavailable.find((e) => e.id === id))).toEqual(['id']);
      expect(await join(rid, `order_${id}`)).toBe(true);
      expect(await join(rid2, `order_${id}`)).toBe(false);
      expect((await getOrder(id, tRider2)).status).toBe(404); // not in the pool any more, not theirs

      for (const st of ['PREPARING', 'READY_FOR_PICKUP']) expect((await setStatus(id, st, tVendor)).status).toBe(200);
      expect((await setStatus(id, 'PICKED_UP', tRider)).status).toBe(200);
      const custAfterPickup = (await getOrder(id, tStudent)).body.data;
      expect(custAfterPickup.driver).toEqual({ id: RIDER.id, name: 'Vikram Singh (Runner)', phone: RIDER.phone });
      expect(custAfterPickup.pickedUpAt).toBeTruthy();

      // 5. Live position: only the customer and admins of that order hear rider_location.
      expect(await join(ven, `order_${id}`)).toBe(true);
      expect(await join(adm, `order_${id}`)).toBe(true); // the dashboard watches the order to see the rider move
      expect((await request.post('/api/drivers/location').set(H(tRider)).send({ lat: 23.0771, lng: 76.8519, heading: 45 })).status).toBe(200);
      await until(() => custLog.rider_location.length === 1 && admLog.rider_location.length >= 1);
      capture('socket_rider_location', custLog.rider_location[0]);
      expect(custLog.rider_location[0]).toMatchObject({ orderId: id, driverId: RIDER.id, lat: 23.0771, lng: 76.8519 });
      await sleep(150);
      expect(venLog.rider_location).toHaveLength(0);
      expect(rid2Log.rider_location).toHaveLength(0);
      expect(ridLog.rider_location).toHaveLength(0);

      // 6. At the gate: only the customer (and admin) get the OTP - REST and socket.
      const before = { c: custLog.order_updated.length, r: ridLog.order_updated.length, v: venLog.order_updated.length, a: admLog.order_updated.length };
      const arrived = await setStatus(id, 'ARRIVED_AT_GATE', tRider);
      expect(arrived.status).toBe(200);
      expect(arrived.body.data.otpCode).toBeNull();
      capture('rider_assigned_view_ARRIVED_AT_GATE', arrived.body.data);
      await until(() => custLog.order_updated.length > before.c && ridLog.order_updated.length > before.r && venLog.order_updated.length > before.v && admLog.order_updated.length > before.a);
      const otp = (await db(id)).otpCode!;
      expect(otp).toMatch(/^\d{4}$/);
      expect(custLog.order_updated.at(-1).otpCode).toBe(otp);
      expect(ridLog.order_updated.at(-1).otpCode).toBeNull();
      expect(venLog.order_updated.at(-1).otpCode).toBeNull();
      expect(admLog.order_updated.at(-1).otpCode).toBe(otp);
      const custView = (await getOrder(id, tStudent)).body.data;
      capture('customer_view_ARRIVED_AT_GATE', custView);
      expect(custView.otpCode).toBe(otp);
      expect((await getOrder(id, tRider)).body.data.otpCode).toBeNull();
      expect((await request.get('/api/orders?scope=active').set(H(tRider))).body.data.find((o: any) => o.id === id).otpCode).toBeNull();
      expect((await getOrder(id, tVendor)).body.data.otpCode).toBeNull();
      const adminView = (await getOrder(id, tAdmin)).body.data;
      capture('admin_view', adminView);
      expect(adminView.otpCode).toBe(otp);
      expect(adminView.payments[0]).toMatchObject({ razorpayOrderId: pay.body.razorpayOrderId, status: 'PAID', capturedAmountPaise: 22000 });
      for (const t of [tStudent, tVendor, tRider]) expect(JSON.stringify((await getOrder(id, t)).body)).not.toMatch(/razorpay|"payments"/);

      // 7. Delivered with the code the customer reads out.
      const delivered = await request.post(`/api/orders/${id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: otp });
      expect(delivered.status).toBe(200);
      expect(delivered.body.data.status).toBe('DELIVERED');
      const final = await db(id);
      expect(final.otpCode).toBe('USED');
      expect(final.deliveredAt).not.toBeNull();
      // Times are UTC ISO strings.
      for (const k of ['createdAt', 'updatedAt', 'paidAt', 'acceptedAt', 'pickedUpAt', 'deliveredAt']) expect(delivered.body.data[k]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      // No order event reached another restaurant.
      const ven2 = await connect(tVendor2);
      expect(await join(ven2, 'vendor_ven-1')).toBe(false);
      expect(await join(ven2, 'drivers')).toBe(false);
      expect(await join(cust, 'admins')).toBe(false);
    });

    test('a pending (unapproved) rider is not put in the drivers room and cannot join it', async () => {
      await prisma.driverPartner.update({ where: { id: 'dp-of-rid2' }, data: { approvalStatus: 'PENDING' } });
      const s = await connect(tRider2);
      const log = record(s, ['order_available']);
      expect(await join(s, 'drivers')).toBe(false);
      const o = await placePaid();
      expect((await setStatus(o.id, 'ACCEPTED', tVendor)).status).toBe(200);
      await sleep(200);
      expect(log.order_available).toHaveLength(0);
    });

    test('suspending a rider removes their live socket from the drivers room at once', async () => {
      const s = await connect(tRider2);
      const log = record(s, ['order_available']);
      const dp = await prisma.driverPartner.findUniqueOrThrow({ where: { id: 'dp-of-rid2' } });
      const sus = await request.post(`/api/admin/partners/driver/${dp.id}/status`).set(H(tAdmin)).send({ status: 'SUSPENDED', reason: 'Testing suspension' });
      expect(sus.status).toBe(200);
      const o = await placePaid();
      expect((await setStatus(o.id, 'ACCEPTED', tVendor)).status).toBe(200);
      await sleep(200);
      expect(log.order_available).toHaveLength(0);
      await prisma.driverPartner.update({ where: { id: dp.id }, data: { approvalStatus: 'APPROVED' } });
    });
  });

  // =========================================================================
  // 1. Webhook / verify ordering and duplicates: exactly one set of side effects
  // =========================================================================
  describe('FM1 webhook and verify ordering', () => {
    const setup = async () => {
      const placed = await place();
      const pay = await createPayment(placed.body.data.id);
      const ven = await connect(tVendor);
      const log = record(ven, ['new_order_alert']);
      return { id: placed.body.data.id as string, rzp: pay.body.razorpayOrderId as string, log };
    };
    const alertsFor = (log: Record<string, any[]>, id: string) => log.new_order_alert.filter((a) => a.id === id).length;

    test('webhook before verify', async () => {
      const { id, rzp, log } = await setup();
      const payId = 'pay_wh_first_1';
      expect((await webhook(captured(rzp, 22000, payId))).body.status).toBe('processed');
      const v = await verify(rzp, payId);
      expect(v.status).toBe(200);
      expect(v.body.message).toMatch(/already verified/);
      await sleep(200);
      expect(alertsFor(log, id)).toBe(1);
      const o = await db(id);
      expect(o.paymentStatus).toBe('PAID');
      expect(o.payments[0]).toMatchObject({ status: 'PAID', razorpayPaymentId: payId, capturedAmountPaise: 22000 });
    });

    test('verify before webhook, then duplicate webhooks', async () => {
      const { id, rzp, log } = await setup();
      const payId = 'pay_vf_first_1';
      expect((await verify(rzp, payId)).status).toBe(200);
      const paidAt = (await db(id)).paidAt;
      for (let i = 0; i < 3; i++) expect((await webhook(captured(rzp, 22000, payId))).body.status).toBe('processed');
      await sleep(200);
      expect(alertsFor(log, id)).toBe(1);
      expect((await db(id)).paidAt).toEqual(paidAt);
    });

    test('concurrent webhooks + verify: one winner, one alert, one paidAt', async () => {
      const { id, rzp, log } = await setup();
      const payId = 'pay_race_1';
      const results = await Promise.all([
        webhook(captured(rzp, 22000, payId)), verify(rzp, payId), webhook(captured(rzp, 22000, payId)), verify(rzp, payId), webhook(captured(rzp, 22000, payId)),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      await sleep(300);
      expect(alertsFor(log, id)).toBe(1);
      const o = await db(id);
      expect(o.paymentStatus).toBe('PAID');
      expect(o.payments).toHaveLength(1);
    });

    test('payment.failed marks FAILED; a retry on the same Razorpay order still pays', async () => {
      const { id, rzp } = await setup();
      const failed = await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f1', order_id: rzp, amount: 22000 } } } });
      expect(failed.status).toBe(200);
      expect((await db(id)).paymentStatus).toBe('FAILED');
      const again = await createPayment(id);
      expect(again.body.razorpayOrderId).toBe(rzp); // reused, not a second Razorpay order
      expect((await verify(rzp, 'pay_f2')).status).toBe(200);
      expect((await db(id)).paymentStatus).toBe('PAID');
    });
  });

  // =========================================================================
  // 2. Wrong amount, unknown order, another customer's order, forged signatures
  // =========================================================================
  describe('FM2 bad payments', () => {
    test('wrong amount is never marked paid; it is audited and shown to the admin', async () => {
      const placed = await place();
      const pay = await createPayment(placed.body.data.id);
      const res = await webhook(captured(pay.body.razorpayOrderId, 100, 'pay_short_1'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'rejected', code: 'AMOUNT_MISMATCH' });
      const o = await db(placed.body.data.id);
      expect(o.paymentStatus).toBe('PENDING');
      expect(o.payments[0]).toMatchObject({ status: 'PENDING', capturedAmountPaise: 100 });
      expect(await prisma.adminAuditLog.count({ where: { action: 'PAYMENT_AMOUNT_MISMATCH', targetId: o.id } })).toBe(1);
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.body.data.find((r: any) => r.order.id === o.id)?.problems).toContain('PAYMENT_MISMATCH');
    });

    test('unknown Razorpay order / unknown order id: 200 rejected, nothing changes', async () => {
      const r1 = await webhook(captured('order_never_made_by_kraveo', 22000));
      expect(r1.body).toMatchObject({ success: true, status: 'rejected', code: 'UNKNOWN_PAYMENT' });
      const r2 = await webhook({ event: 'payment.captured', orderId: 'no-such-order' });
      expect(r2.body.code).toBe('UNKNOWN_PAYMENT');
      expect(await prisma.adminAuditLog.count({ where: { action: 'PAYMENT_UNKNOWN' } })).toBeGreaterThanOrEqual(2);
    });

    test('webhook whose notes name a different order than the payment record is rejected', async () => {
      const a = await place();
      const pay = await createPayment(a.body.data.id);
      const body = captured(pay.body.razorpayOrderId, 22000);
      (body.payload.payment.entity as any).notes = { orderId: 'someone-elses-order' };
      expect((await webhook(body)).body.code).toBe('ORDER_MISMATCH');
      expect((await db(a.body.data.id)).paymentStatus).toBe('PENDING');
    });

    test("verify-signature for another customer's order: 404 and the order is untouched", async () => {
      const a = await place();
      const pay = await createPayment(a.body.data.id);
      const res = await verify(pay.body.razorpayOrderId, 'pay_other', tStudent2);
      expect(res.status).toBe(404);
      expect((await db(a.body.data.id)).paymentStatus).toBe('PENDING');
      expect((await createPayment(a.body.data.id, tStudent2)).status).toBe(404);
    });

    test('forged signatures are refused (verify 400, webhook 400)', async () => {
      const a = await place();
      const rzp = `order_real_${randomUUID().slice(0, 8)}`; // not a simulator id, so the HMAC is really checked
      await prisma.payment.create({ data: { orderId: a.body.data.id, razorpayOrderId: rzp, amount: 220 } });
      const v = await request.post('/api/payments/verify-signature').set(H(tStudent)).send({ razorpayOrderId: rzp, razorpayPaymentId: 'pay_x', razorpaySignature: 'f'.repeat(64) });
      expect(v.status).toBe(400);
      const w = await webhook(captured(rzp, 22000), 'deadbeef'.repeat(8));
      expect(w.status).toBe(400);
      expect((await db(a.body.data.id)).paymentStatus).toBe('PENDING');
    });

    test('garbage webhook bodies never cause a 500', async () => {
      const bodies: unknown[] = [
        {}, [], { event: 123 }, { event: 'payment.captured' }, { event: 'payment.captured', payload: null }, { event: 'payment.captured', payload: { payment: { entity: 'x' } } },
        { event: 'payment.captured', payload: { payment: { entity: { order_id: 42, amount: '22000', id: {} } } } }, { event: 'payment.captured', orderId: 'x'.repeat(5000) },
        { event: 'payment.failed', payload: { payment: { entity: { order_id: ['a'] } } } }, { event: 'refund.processed', payload: {} }, { event: 'order.paid', razorpayOrderId: null },
      ];
      for (const b of bodies) {
        const r = await webhook(b);
        expect(r.status).toBe(200);
      }
      const raw = await request.post('/api/payments/webhook').set('x-razorpay-signature', 'valid_test_wh_signature').set('Content-Type', 'application/json').send('{not json');
      expect(raw.status).toBe(400);
      const noSig = await request.post('/api/payments/webhook').send({ event: 'payment.captured' });
      expect(noSig.status).toBe(400);
    });
  });

  // =========================================================================
  // 3. Payment after cancel or expiry -> automatic refund
  // =========================================================================
  describe('FM3 late payments are refunded', () => {
    test('customer cancels the unpaid order, the payment lands later: refunded, order stays cancelled, restaurant never hears', async () => {
      const ven = await connect(tVendor);
      const log = record(ven, ['new_order_alert', 'order_updated']);
      const placed = await place();
      const id = placed.body.data.id;
      const pay = await createPayment(id);
      const cancelled = await request.post(`/api/orders/${id}/cancel`).set(H(tStudent)).send({ reason: 'Changed my mind' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', paymentStatus: 'PENDING' });

      const res = await webhook(captured(pay.body.razorpayOrderId, 22000, 'pay_late_1'));
      expect(res.body.status).toBe('processed');
      await __waitForBackgroundWork();
      const o = await db(id);
      expect(o).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', paidAt: null });
      expect(o.payments[0]).toMatchObject({ status: 'REFUNDED', razorpayPaymentId: 'pay_late_1' });
      expect(o.payments[0].razorpayRefundId).toMatch(/^rfnd_sim_/);
      expect(await refundsOf(id)).toHaveLength(1);
      const view = (await getOrder(id, tStudent)).body.data;
      capture('customer_view_CANCELLED_REFUNDED', view);
      expect(view).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', cancelReason: 'Changed my mind' });
      await sleep(150);
      expect(log.new_order_alert.filter((a) => a.id === id)).toHaveLength(0);
      expect(log.order_updated.filter((a) => a.id === id)).toHaveLength(0);
      expect((await getOrder(id, tVendor)).status).toBe(404);
      // A duplicate webhook does not refund twice.
      await webhook(captured(pay.body.razorpayOrderId, 22000, 'pay_late_1'));
      await __waitForBackgroundWork();
      expect(await refundsOf(id)).toHaveLength(1);
    });

    test('order expired by the job, the customer then completes payment: verify says ORDER_CANCELLED and the money is refunded', async () => {
      const placed = await place();
      const id = placed.body.data.id;
      const pay = await createPayment(id);
      const summary = await runOrderMaintenance(minutesFromNow(16));
      expect(summary.expired).toContain(id);
      expect((await db(id))).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Payment not completed' });
      const v = await verify(pay.body.razorpayOrderId, 'pay_after_expiry');
      expect(v.status).toBe(409);
      expect(v.body.code).toBe('ORDER_CANCELLED');
      expect(v.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(await refundsOf(id)).toHaveLength(1);
    });
  });

  // =========================================================================
  // 4. Double taps, lost network, killed app
  // =========================================================================
  describe('FM4 checkout robustness', () => {
    test('the same clientRequestId 5 times at once creates exactly one order', async () => {
      const key = randomUUID();
      const res = await Promise.all(Array.from({ length: 5 }, () => place(tStudent, { clientRequestId: key })));
      const ids = new Set(res.map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 200).every((r) => r.body.idempotentReplay === true)).toBe(true);
      expect(await prisma.order.count({ where: { clientRequestId: key } })).toBe(1);
    });

    test('retry after a lost response returns the same order; max 3 unpaid open orders', async () => {
      const key = randomUUID();
      const first = await place(tStudent, { clientRequestId: key });
      const retry = await place(tStudent, { clientRequestId: key });
      expect(retry.status).toBe(200);
      expect(retry.body.data.id).toBe(first.body.data.id);
      await place();
      await place();
      const fourth = await place();
      expect(fourth.status).toBe(429);
      expect(fourth.body.code).toBe('TOO_MANY_UNPAID_ORDERS');
      // A different customer is not affected.
      expect((await place(tStudent2)).status).toBe(201);
    });

    test('double tap on Pay: one Razorpay order, one payment row', async () => {
      const placed = await place();
      const res = await Promise.all([createPayment(placed.body.data.id), createPayment(placed.body.data.id), createPayment(placed.body.data.id)]);
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(new Set(res.map((r) => r.body.razorpayOrderId)).size).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: placed.body.data.id } })).toBe(1);
      expect(res[0].body.amount).toBe(22000);
    });

    test('app killed after paying: the webhook alone completes it and the active list shows it', async () => {
      const placed = await place();
      const pay = await createPayment(placed.body.data.id);
      await webhook(captured(pay.body.razorpayOrderId, 22000));
      const list = await request.get('/api/orders?scope=active').set(H(tStudent));
      expect(list.body.data.find((o: any) => o.id === placed.body.data.id)).toMatchObject({ paymentStatus: 'PAID', status: 'PLACED' });
      expect((await createPayment(placed.body.data.id)).body.code).toBe('ALREADY_PAID');
    });

    test('the server ignores client prices, statuses and ids; unknown drop points are refused', async () => {
      const r = await place(tStudent, { totalAmount: 1, status: 'DELIVERED', paymentStatus: 'PAID', id: 'evil-id', customerId: STUDENT2.id });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ totalAmount: 220, status: 'PLACED', paymentStatus: 'PENDING' });
      expect(r.body.data.id).not.toBe('evil-id');
      expect(r.body.data.customer.id).toBe(STUDENT.id);
      expect((await place(tStudent, { dropoffHostel: 'Mars' })).body.field).toBe('dropoffHostel');
      expect((await place(tStudent, { dropoffHostel: 'Boys Hostel Block 3' })).status).toBe(201); // legacy name still accepted
      expect((await place(tStudent, { items: [{ itemId: 'item-1', quantity: 1.5 }] })).status).toBe(400);
      expect((await place(tStudent, { items: [null] })).status).toBe(400);
      expect((await place(tStudent, { clientRequestId: 'short' })).body.field).toBe('clientRequestId');
    });
  });

  // =========================================================================
  // 5. Restaurant: never responds, rejects, accepts unpaid, accepts twice
  // =========================================================================
  describe('FM5 restaurant', () => {
    test('restaurant never responds: the job cancels after 10 minutes and refunds', async () => {
      const o = await placePaid();
      expect((await runOrderMaintenance(minutesFromNow(9))).autoCancelled).not.toContain(o.id);
      const s = await runOrderMaintenance(minutesFromNow(11));
      expect(s.autoCancelled).toContain(o.id);
      const row = await db(o.id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'Restaurant did not respond', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      expect(await refundsOf(o.id)).toHaveLength(1);
    });

    test('restaurant rejects with a reason: refunded, the customer sees the reason; twice is idempotent', async () => {
      const o = await placePaid();
      expect((await request.post(`/api/orders/${o.id}/reject`).set(H(tVendor)).send({ reason: 'x' })).body.field).toBe('reason');
      const r = await request.post(`/api/orders/${o.id}/reject`).set(H(tVendor)).send({ reason: 'Out of paneer today' });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'VENDOR', paymentStatus: 'REFUNDED' });
      const again = await request.post(`/api/orders/${o.id}/reject`).set(H(tVendor)).send({ reason: 'Out of paneer today' });
      expect(again.status).toBe(200);
      expect(await refundsOf(o.id)).toHaveLength(1);
      expect((await getOrder(o.id, tStudent)).body.data.cancelReason).toBe('Out of paneer today');
      expect((await request.get('/api/orders?scope=history').set(H(tVendor))).body.data.some((x: any) => x.id === o.id)).toBe(true);
    });

    test('accepting an unpaid order fails; rejecting it fails; accepting twice is fine; skipping and going back are refused', async () => {
      const placed = await place();
      const id = placed.body.data.id;
      const acc = await setStatus(id, 'ACCEPTED', tVendor);
      expect(acc.status).toBe(404);
      expect((await request.post(`/api/orders/${id}/reject`).set(H(tVendor)).send({ reason: 'No thanks' })).status).toBe(404);
      expect((await setStatus(id, 'ACCEPTED', tAdmin)).body.code).toBe('PAYMENT_NOT_CONFIRMED');
      expect((await db(id)).status).toBe('PLACED');

      const o = await placePaid();
      expect((await setStatus(o.id, 'PREPARING', tVendor)).body.code).toBe('INVALID_TRANSITION');
      const a1 = await setStatus(o.id, 'ACCEPTED', tVendor);
      const acceptedAt = (await db(o.id)).acceptedAt;
      const a2 = await setStatus(o.id, 'ACCEPTED', tVendor);
      expect([a1.status, a2.status]).toEqual([200, 200]);
      expect((await db(o.id)).acceptedAt).toEqual(acceptedAt);
      expect((await setStatus(o.id, 'PLACED', tVendor)).status).toBe(403);
      expect((await setStatus(o.id, 'PICKED_UP', tVendor)).body.code).toBe('ROLE_NOT_ALLOWED');
      expect((await setStatus(o.id, 'CANCELLED', tVendor)).status).toBe(403);
      expect((await request.post(`/api/orders/${o.id}/reject`).set(H(tVendor)).send({ reason: 'Too late now' })).body.code).toBe('CANNOT_REJECT');
      // Another restaurant cannot see or touch it.
      expect((await setStatus(o.id, 'PREPARING', tVendor2)).status).toBe(404);
      expect((await getOrder(o.id, tVendor2)).status).toBe(404);
    });
  });

  // =========================================================================
  // 6. Riders: races, unpaid/cancelled/claimed orders, busy, offline, suspended, release
  // =========================================================================
  describe('FM6 rider claims', () => {
    test('two riders at the same moment: one wins, the other gets ALREADY_TAKEN', async () => {
      const o = await makePaidOrder('READY_FOR_PICKUP');
      const [a, b] = await Promise.all([claim(o.id, tRider), claim(o.id, tRider2)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('ALREADY_TAKEN');
      capture('error_409_ALREADY_TAKEN', loser.body);
      const again = await claim(o.id, a.status === 200 ? tRider : tRider2);
      expect(again.status).toBe(200); // the winner repeating is idempotent
    });

    test('unpaid, cancelled, not-yet-accepted and already-claimed orders cannot be claimed', async () => {
      const unpaid = await prisma.order.create({ data: { customerId: STUDENT.id, vendorId: 'ven-1', totalAmount: 220, dropoffHostel: 'Block 1', status: 'READY_FOR_PICKUP' } });
      expect((await claim(unpaid.id)).body.code).toBe('ORDER_NOT_AVAILABLE');
      expect((await claim('no-such-order')).status).toBe(404);
      const cancelled = await makePaidOrder('READY_FOR_PICKUP');
      await request.post(`/api/admin/orders/${cancelled.id}/cancel`).set(H(tAdmin)).send({ reason: 'Kitchen fire' });
      expect((await claim(cancelled.id)).body.code).toBe('ORDER_NOT_AVAILABLE');
      const notAccepted = await makePaidOrder('PLACED');
      expect((await claim(notAccepted.id)).body.code).toBe('ORDER_NOT_AVAILABLE');
      const taken = await makePaidOrder('PREPARING', { driverId: RIDER2.id });
      expect((await claim(taken.id)).body.code).toBe('ALREADY_TAKEN');
      expect((await db(taken.id)).driverId).toBe(RIDER2.id);
    });

    test('a rider with an active order cannot claim another, even two at once', async () => {
      const a = await makePaidOrder('READY_FOR_PICKUP');
      const b = await makePaidOrder('READY_FOR_PICKUP');
      const [ra, rb] = await Promise.all([claim(a.id), claim(b.id)]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      expect((ra.status === 409 ? ra : rb).body.code).toBe('RIDER_BUSY');
      expect(await prisma.order.count({ where: { driverId: RIDER.id, id: { in: [a.id, b.id] } } })).toBe(1);
      expect((await prisma.driverPartner.findFirstOrThrow({ where: { userId: RIDER.id } })).dutyStatus).toBe('IN_TRANSIT');
    });

    test('offline riders cannot claim and see an empty pool; suspended riders get PARTNER_NOT_APPROVED', async () => {
      const o = await makePaidOrder('READY_FOR_PICKUP');
      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'OFFLINE' } });
      expect((await claim(o.id)).body.code).toBe('RIDER_OFFLINE');
      expect((await request.get('/api/orders/available').set(H(tRider))).body.data).toEqual([]);
      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { dutyStatus: 'ONLINE', approvalStatus: 'SUSPENDED' } });
      const sus = await claim(o.id);
      expect(sus.status).toBe(403);
      expect(sus.body.code).toBe('PARTNER_NOT_APPROVED');
      capture('error_403_PARTNER_NOT_APPROVED', sus.body);
      expect((await request.get('/api/orders/available').set(H(tRider))).status).toBe(403);
      expect((await db(o.id)).driverId).toBeNull();
    });

    test('release before pickup puts it back in the pool for another rider; not after pickup', async () => {
      const o = await makePaidOrder('READY_FOR_PICKUP');
      const r2 = await connect(tRider2);
      const log = record(r2, ['order_available']);
      expect((await claim(o.id)).status).toBe(200);
      expect((await request.post(`/api/orders/${o.id}/release`).set(H(tRider2))).status).toBe(404); // not theirs
      const rel = await request.post(`/api/orders/${o.id}/release`).set(H(tRider));
      expect(rel.status).toBe(200);
      await until(() => log.order_available.some((x) => x.id === o.id));
      expect(await prisma.adminAuditLog.count({ where: { action: 'ORDER_RELEASED', targetId: o.id } })).toBe(1);
      expect((await prisma.driverPartner.findFirstOrThrow({ where: { userId: RIDER.id } })).dutyStatus).toBe('ONLINE');
      expect((await claim(o.id, tRider2)).status).toBe(200);
      expect((await getOrder(o.id, tRider)).status).toBe(404); // the old rider lost access
      expect((await setStatus(o.id, 'PICKED_UP', tRider2)).status).toBe(200);
      expect((await request.post(`/api/orders/${o.id}/release`).set(H(tRider2))).body.code).toBe('CANNOT_RELEASE');
    });

    test('riders cannot move restaurant statuses, nor statuses of orders that are not theirs', async () => {
      const o = await makePaidOrder('PREPARING', { driverId: RIDER.id });
      expect((await setStatus(o.id, 'READY_FOR_PICKUP', tRider)).body.code).toBe('ROLE_NOT_ALLOWED');
      expect((await setStatus(o.id, 'PICKED_UP', tRider)).body.code).toBe('INVALID_TRANSITION');
      expect((await setStatus(o.id, 'PICKED_UP', tRider2)).status).toBe(404);
      expect((await setStatus(o.id, 'CANCELLED', tRider)).status).toBe(403);
    });
  });

  // =========================================================================
  // 7. Gate OTP
  // =========================================================================
  describe('FM7 gate OTP', () => {
    test('no OTP: refused and not counted; 5 wrong: locked (423), even the right code; admin unlock issues a new code', async () => {
      const o = await makePaidOrder('ARRIVED_AT_GATE', { driverId: RIDER.id });
      const otpUrl = `/api/orders/${o.id}/verify-gate-otp`;
      expect((await request.post(otpUrl).set(H(tRider)).send({})).status).toBe(400);
      expect((await setStatus(o.id, 'DELIVERED', tRider)).status).toBe(400);
      expect((await db(o.id)).otpAttempts).toBe(0);

      const wrong = ['0000', '1111', '2222', '3333'];
      for (const [i, code] of wrong.entries()) {
        // Both delivery routes share one counter.
        const r = i % 2 ? await setStatus(o.id, 'DELIVERED', tRider, { otpCode: code }) : await request.post(otpUrl).set(H(tRider)).send({ otpCode: code });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'OTP_INVALID', error: 'Invalid Gate OTP', attemptsLeft: 4 - i });
      }
      const fifth = await request.post(otpUrl).set(H(tRider)).send({ otpCode: '5555' });
      expect(fifth.status).toBe(423);
      expect(fifth.body.code).toBe('OTP_LOCKED');
      capture('error_423_OTP_LOCKED', fifth.body);
      expect((await request.post(otpUrl).set(H(tRider)).send({ otpCode: '4821' })).status).toBe(423);
      expect((await db(o.id))).toMatchObject({ otpLocked: true, otpAttempts: 5, status: 'ARRIVED_AT_GATE' });
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.body.data.find((r: any) => r.order.id === o.id)?.problem).toBe('OTP_LOCKED');

      expect((await request.post(`/api/admin/orders/${o.id}/reset-otp-lock`).set(H(tRider))).status).toBe(403);
      const reset = await request.post(`/api/admin/orders/${o.id}/reset-otp-lock`).set(H(tAdmin));
      expect(reset.status).toBe(200);
      const fresh = (await db(o.id)).otpCode!;
      expect(fresh).toMatch(/^\d{4}$/);
      expect((await getOrder(o.id, tStudent)).body.data.otpCode).toBe(fresh);
      const ok = await request.post(otpUrl).set(H(tRider)).send({ otpCode: fresh });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('DELIVERED');
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: { in: ['OTP_LOCKED', 'OTP_UNLOCKED'] } } })).toBe(2);
    });

    test('10 wrong codes at once: exactly 5 counted, then locked', async () => {
      const o = await makePaidOrder('ARRIVED_AT_GATE', { driverId: RIDER.id });
      const res = await Promise.all(Array.from({ length: 10 }, (_, i) => request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: String(1000 + i) })));
      expect(res.filter((r) => r.status === 400)).toHaveLength(4);
      expect(res.filter((r) => r.status === 423)).toHaveLength(6);
      expect((await db(o.id))).toMatchObject({ otpAttempts: 5, otpLocked: true, status: 'ARRIVED_AT_GATE' });
    });

    test('a used OTP cannot be replayed to change anything; a numeric OTP with a leading zero works', async () => {
      const o = await makePaidOrder('ARRIVED_AT_GATE', { driverId: RIDER.id });
      await prisma.order.update({ where: { id: o.id }, data: { otpCode: '0421' } });
      const ok = await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otp: 421 });
      expect(ok.status).toBe(200);
      const replay = await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider)).send({ otpCode: '0421' });
      expect(replay.body.message).toMatch(/already DELIVERED/);
      const row = await db(o.id);
      expect(row.otpCode).toBe('USED');
      expect(row.otpAttempts).toBe(0);
    });

    test('a customer, a restaurant, another rider and an unassigned rider can never complete delivery', async () => {
      const o = await makePaidOrder('ARRIVED_AT_GATE', { driverId: RIDER.id });
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tStudent)).send({ otpCode: '4821' })).status).toBe(403);
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tVendor)).send({ otpCode: '4821' })).status).toBe(403);
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider2)).send({ otpCode: '4821' })).status).toBe(404);
      expect((await setStatus(o.id, 'DELIVERED', tStudent, { otpCode: '4821' })).status).toBe(403);
      expect((await setStatus(o.id, 'DELIVERED', tVendor, { otpCode: '4821' })).status).toBe(403);
      expect((await db(o.id)).status).toBe('ARRIVED_AT_GATE');
    });

    test('OTPs are random 4-digit codes', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const o = await makePaidOrder('PICKED_UP', { driverId: RIDER.id });
        expect((await setStatus(o.id, 'ARRIVED_AT_GATE', tRider)).status).toBe(200);
        codes.add((await db(o.id)).otpCode!);
        await prisma.order.update({ where: { id: o.id }, data: { status: 'DELIVERED' } });
      }
      for (const c of codes) expect(c).toMatch(/^\d{4}$/);
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  // 8. Customer cancel rules
  // =========================================================================
  describe('FM8 customer cancel', () => {
    test('paid order cancelled while PLACED is refunded once; cancelling twice is fine; after accept it is refused', async () => {
      const o = await placePaid();
      const c1 = await request.post(`/api/orders/${o.id}/cancel`).set(H(tStudent)).send({});
      expect(c1.status).toBe(200);
      expect(c1.body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
      const c2 = await request.post(`/api/orders/${o.id}/cancel`).set(H(tStudent)).send({});
      expect(c2.status).toBe(200);
      expect(await refundsOf(o.id)).toHaveLength(1);

      const accepted = await driveTo('ACCEPTED');
      const refused = await request.post(`/api/orders/${accepted.id}/cancel`).set(H(tStudent)).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('CANNOT_CANCEL');
      expect((await setStatus(accepted.id, 'CANCELLED', tStudent)).status).toBe(409);
      expect((await db(accepted.id)).status).toBe('ACCEPTED');
    });

    test("someone else's order: 404, unchanged", async () => {
      const o = await placePaid();
      expect((await request.post(`/api/orders/${o.id}/cancel`).set(H(tStudent2)).send({})).status).toBe(404);
      expect((await getOrder(o.id, tStudent2)).status).toBe(404);
      expect((await db(o.id)).status).toBe('PLACED');
    });
  });

  // =========================================================================
  // 9. Admin cancels in every state: refund exactly once
  // =========================================================================
  describe('FM9 admin cancel', () => {
    test.each(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'])('admin cancels a paid order at %s: refunded once', async (status) => {
      const driverId = ['PICKED_UP', 'ARRIVED_AT_GATE'].includes(status) ? RIDER.id : null;
      const o = await makePaidOrder(status, { driverId });
      expect((await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({})).body.field).toBe('reason');
      const r = await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Customer called support' });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', paymentStatus: 'REFUNDED', refundStatus: 'DONE', otpCode: null });
      const again = await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Customer called support' });
      expect(again.status).toBe(200);
      expect(await refundsOf(o.id)).toHaveLength(1);
      if (driverId) expect((await prisma.driverPartner.findFirstOrThrow({ where: { userId: driverId } })).dutyStatus).toBe('ONLINE');
    });

    test('admin cancels an unpaid order (no refund) and cannot cancel a delivered one', async () => {
      const placed = await place();
      const r = await request.post(`/api/admin/orders/${placed.body.data.id}/cancel`).set(H(tAdmin)).send({ reason: 'Duplicate order' });
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING', refundStatus: 'NONE' });
      const d = await makePaidOrder('DELIVERED');
      expect((await request.post(`/api/admin/orders/${d.id}/cancel`).set(H(tAdmin)).send({ reason: 'Too late' })).body.code).toBe('ORDER_CLOSED');
      expect((await request.post(`/api/admin/orders/${d.id}/cancel`).set(H(tVendor)).send({ reason: 'Too late' })).status).toBe(403);
    });
  });

  // =========================================================================
  // 10. Refund provider outage
  // =========================================================================
  describe('FM10 refund provider outage', () => {
    test('refund fails -> FAILED + visible to admin, retried by the job, done once the provider is back', async () => {
      const failing: PaymentProvider = {
        ...sim,
        refundPayment: async () => { throw Object.assign(new Error('x'), { error: { description: 'Razorpay is down' } }); },
      };
      setPaymentProvider(failing);
      const o = await makePaidOrder('ACCEPTED');
      const r = await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Restaurant closed early' });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'FAILED', refundError: 'Razorpay is down' });
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      const row = na.body.data.find((x: any) => x.order.id === o.id);
      expect(row.problem).toBe('REFUND_FAILED');
      expect(row).toMatchObject({ detail: expect.stringContaining('Razorpay is down'), since: expect.stringMatching(/Z$/) });
      expect(row.order.payments[0]).toEqual(expect.objectContaining({ id: expect.any(String), razorpayOrderId: expect.any(String), razorpayPaymentId: expect.any(String), razorpayRefundId: null, amount: 220, status: 'PAID' }));
      expect(row.order.refundError).toBe('Razorpay is down');
      expect(row.order.vendor.phone).toBe(VENDOR.phone); // admin view only
      capture('admin_needs_attention_row', row);
      expect((await getOrder(o.id, tStudent)).body.data).toMatchObject({ paymentStatus: 'PAID', refundStatus: 'FAILED' });

      const still = await runOrderMaintenance(soon());
      expect(still.refundsRetried).toContain(o.id);
      // A provider outage is transient: the attempt is given back (refundAttempts only counts permanent failures).
      expect((await db(o.id))).toMatchObject({ refundStatus: 'FAILED', refundAttempts: 0 });

      setPaymentProvider(sim);
      const later = await runOrderMaintenance(soon(30));
      expect(later.refundsDone).toContain(o.id);
      expect((await db(o.id))).toMatchObject({ refundStatus: 'DONE', paymentStatus: 'REFUNDED', refundError: null });
      expect(await refundsOf(o.id)).toHaveLength(1);
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'REFUND_FAILED' } })).toBe(2);
      expect(await prisma.adminAuditLog.count({ where: { targetId: o.id, action: 'REFUND_DONE' } })).toBe(1);
    });

    test('the provider refunded but the answer was lost: the retry finds the refund and never refunds twice', async () => {
      const lossy: PaymentProvider = {
        ...sim,
        refundPayment: async (input) => { await sim.refundPayment(input); throw new Error('socket hang up'); },
      };
      setPaymentProvider(lossy);
      const o = await makePaidOrder('PLACED');
      await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Testing lost answers' });
      expect((await db(o.id)).refundStatus).toBe('FAILED');
      setPaymentProvider(sim);
      await runOrderMaintenance(soon());
      expect((await db(o.id))).toMatchObject({ refundStatus: 'DONE', paymentStatus: 'REFUNDED' });
      expect(await refundsOf(o.id)).toHaveLength(1);
    });

    test('a paid order with no recorded payment is flagged (no blind refund); admin retry-refund needs a FAILED refund', async () => {
      const o = await prisma.order.create({ data: { customerId: STUDENT.id, vendorId: 'ven-1', totalAmount: 100, dropoffHostel: 'Block 1', status: 'PLACED', paymentStatus: 'PAID', paidAt: new Date() } });
      await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Legacy order' });
      expect((await db(o.id))).toMatchObject({ refundStatus: 'FAILED' });
      expect((await db(o.id)).refundError).toMatch(/No captured payment/);
      const retry = await request.post(`/api/admin/orders/${o.id}/retry-refund`).set(H(tAdmin));
      expect(retry.status).toBe(200);
      expect(retry.body.data.refundStatus).toBe('FAILED');
      const ok = await makePaidOrder('DELIVERED');
      expect((await request.post(`/api/admin/orders/${ok.id}/retry-refund`).set(H(tAdmin))).body.code).toBe('NO_FAILED_REFUND');
    });

    test('concurrent refund workers: only one talks to the provider', async () => {
      let calls = 0;
      const slow: PaymentProvider = { ...sim, refundPayment: async (input) => { calls += 1; await sleep(100); return sim.refundPayment(input); } };
      const o = await makePaidOrder('PLACED');
      await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', refundStatus: 'FAILED' } });
      setPaymentProvider(slow);
      await Promise.all([runOrderMaintenance(new Date()), runOrderMaintenance(new Date()), runOrderMaintenance(new Date())]);
      expect(calls).toBe(1);
      expect((await db(o.id)).refundStatus).toBe('DONE');
    });
  });

  // =========================================================================
  // 11. Suspended restaurant / rider mid-order
  // =========================================================================
  describe('FM11 suspensions mid-order', () => {
    test('restaurant suspended mid-order: order readable, owner blocked, admin sees it and can cancel with refund', async () => {
      const o = await driveTo('PREPARING');
      await prisma.vendor.update({ where: { id: 'ven-1' }, data: { approvalStatus: 'SUSPENDED' } });
      expect((await getOrder(o.id, tVendor)).status).toBe(200);
      expect((await getOrder(o.id, tStudent)).status).toBe(200);
      expect((await setStatus(o.id, 'READY_FOR_PICKUP', tVendor)).body.code).toBe('PARTNER_NOT_APPROVED');
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.body.data.find((r: any) => r.order.id === o.id)?.problems).toContain('VENDOR_NOT_APPROVED');
      const c = await request.post(`/api/admin/orders/${o.id}/cancel`).set(H(tAdmin)).send({ reason: 'Restaurant suspended' });
      expect(c.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    });

    test('rider suspended mid-delivery: order readable, rider blocked, admin reassigns to another rider who finishes', async () => {
      const o = await driveTo('PICKED_UP');
      await prisma.driverPartner.updateMany({ where: { userId: RIDER.id }, data: { approvalStatus: 'SUSPENDED' } });
      expect((await getOrder(o.id, tRider)).status).toBe(200);
      expect((await setStatus(o.id, 'ARRIVED_AT_GATE', tRider)).body.code).toBe('PARTNER_NOT_APPROVED');
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.body.data.find((r: any) => r.order.id === o.id)?.problems).toContain('RIDER_NOT_APPROVED');
      expect((await request.patch(`/api/orders/${o.id}/reassign`).set(H(tAdmin)).send({ driverId: RIDER.id })).status).toBe(400);
      const re = await request.patch(`/api/orders/${o.id}/reassign`).set(H(tAdmin)).send({ driverId: 'dp-of-rid2' });
      expect(re.status).toBe(200);
      expect(re.body.data.driver.id).toBe(RIDER2.id);
      expect((await getOrder(o.id, tRider)).status).toBe(404);
      expect((await setStatus(o.id, 'ARRIVED_AT_GATE', tRider2)).status).toBe(200);
      const otp = (await getOrder(o.id, tStudent)).body.data.otpCode;
      expect((await request.post(`/api/orders/${o.id}/verify-gate-otp`).set(H(tRider2)).send({ otpCode: otp })).status).toBe(200);
      expect(await prisma.adminAuditLog.count({ where: { action: 'ORDER_REASSIGNED', targetId: o.id } })).toBe(1);
    });
  });

  // =========================================================================
  // 12. Every endpoint: 401 / 403 / 404 / 400, never 500
  // =========================================================================
  describe('FM12 endpoint guards', () => {
    test('unauthenticated -> 401, wrong role -> 403, someone else -> 404, malformed -> 400, never 500', async () => {
      const o = await makePaidOrder('ACCEPTED');
      const id = o.id;
      type Call = [string, string, object?];
      const endpoints: Call[] = [
        ['post', '/api/orders', {}], ['get', '/api/orders'], ['get', '/api/orders/available'], ['get', `/api/orders/${id}`],
        ['post', `/api/orders/${id}/cancel`, {}], ['post', `/api/orders/${id}/reject`, { reason: 'abc' }], ['patch', `/api/orders/${id}/status`, { status: 'PREPARING' }],
        ['post', `/api/orders/${id}/accept-driver`, {}], ['post', `/api/orders/${id}/release`, {}], ['post', `/api/orders/${id}/verify-gate-otp`, { otpCode: '1234' }],
        ['patch', `/api/orders/${id}/reassign`, { driverId: null }], ['post', `/api/admin/orders/${id}/cancel`, { reason: 'abc' }], ['get', '/api/admin/orders/needs-attention'],
        ['post', `/api/admin/orders/${id}/reset-otp-lock`, {}], ['post', `/api/admin/orders/${id}/retry-refund`, {}], ['post', '/api/payments/create-order', { orderId: id }],
        ['post', '/api/payments/verify-signature', {}], ['post', '/api/drivers/location', { lat: 1, lng: 1 }],
      ];
      for (const [method, url, body] of endpoints) {
        const r = await (request as any)[method](url).send(body ?? {});
        expect([url, r.status]).toEqual([url, 401]);
      }
      const wrongRole: [Call, string][] = [
        [['post', '/api/orders', {}], tVendor], [['get', '/api/orders/available'], tStudent], [['post', `/api/orders/${id}/cancel`, {}], tRider],
        [['post', `/api/orders/${id}/reject`, { reason: 'abc' }], tStudent], [['post', `/api/orders/${id}/accept-driver`, {}], tAdmin], [['post', `/api/orders/${id}/release`, {}], tVendor],
        [['post', `/api/orders/${id}/verify-gate-otp`, { otpCode: '1234' }], tStudent], [['patch', `/api/orders/${id}/reassign`, { driverId: null }], tVendor],
        [['post', `/api/admin/orders/${id}/cancel`, { reason: 'abc' }], tStudent], [['get', '/api/admin/orders/needs-attention'], tRider],
        [['post', `/api/admin/orders/${id}/reset-otp-lock`, {}], tVendor], [['post', '/api/payments/verify-signature', {}], tVendor], [['post', '/api/drivers/location', { lat: 1, lng: 1 }], tStudent],
        [['patch', `/api/orders/${id}/status`, { status: 'PREPARING' }], tStudent],
      ];
      for (const [[method, url, body], token] of wrongRole) {
        const r = await (request as any)[method](url).set(H(token)).send(body ?? {});
        expect([method, url, r.status]).toEqual([method, url, 403]);
      }
      // Someone else's order: 404, identical to a missing one.
      const others: [Call, string][] = [
        [['get', `/api/orders/${id}`], tStudent2], [['post', `/api/orders/${id}/cancel`, {}], tStudent2], [['patch', `/api/orders/${id}/status`, { status: 'PREPARING' }], tVendor2],
        [['post', `/api/orders/${id}/reject`, { reason: 'abc' }], tVendor2], [['post', '/api/payments/create-order', { orderId: id }], tStudent2],
      ];
      for (const [[method, url, body], token] of others) {
        const r = await (request as any)[method](url).set(H(token)).send(body ?? {});
        const missing = await (request as any)[method](url.replace(id, 'missing-order-id')).set(H(token)).send(body ?? {});
        expect([url, r.status, missing.status]).toEqual([url, 404, 404]);
      }
      // Malformed ids and bodies.
      const malformed: [Call, string][] = [
        [['get', '/api/orders/bad%20id!'], tStudent], [['patch', `/api/orders/${id}/status`, { status: 'EATEN' }], tVendor], [['patch', `/api/orders/${id}/status`, {}], tVendor],
        [['post', `/api/orders/${id}/cancel`, { reason: { a: 1 } }], tStudent], [['post', '/api/orders', { vendorId: 'ven-1', items: 'lots' }], tStudent],
        [['post', '/api/orders', { vendorId: ['x'], items: [] }], tStudent], [['get', '/api/orders?scope=everything'], tStudent], [['get', '/api/orders?cursor=%27%3B--'], tStudent],
        [['post', '/api/payments/create-order', {}], tStudent], [['post', '/api/payments/verify-signature', { razorpayOrderId: 5 }], tStudent],
        [['patch', `/api/orders/${id}/reassign`, { driverId: 42 }], tAdmin], [['post', '/api/drivers/location', { lat: 'x', lng: 1 }], tRider],
        [['post', `/api/orders/${id}/reject`, { reason: 7 }], tVendor], [['post', `/api/admin/orders/${id}/cancel`, { reason: '' }], tAdmin],
      ];
      for (const [[method, url, body], token] of malformed) {
        const r = await (request as any)[method](url).set(H(token)).send(body ?? {});
        expect([url, r.status]).toEqual([url, 400]);
      }
    });
  });

  // =========================================================================
  // 13. Races with the job
  // =========================================================================
  describe('FM13 job races', () => {
    test('expiry job vs late payment: either live and paid, or cancelled and refunded - never cancelled with the money kept', async () => {
      for (let i = 0; i < 4; i++) {
        const placed = await place();
        const id = placed.body.data.id;
        const pay = await createPayment(id);
        await Promise.all([runOrderMaintenance(minutesFromNow(16)), webhook(captured(pay.body.razorpayOrderId, 22000))]);
        await __waitForBackgroundWork();
        const o = await db(id);
        if (o.status === 'CANCELLED') {
          expect(o).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'DONE' });
          expect(await refundsOf(id)).toHaveLength(1);
        } else {
          expect(o).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
          expect(await refundsOf(id)).toHaveLength(0);
        }
      }
    });

    test('accept-window job vs restaurant accepting: never accepted and refunded at the same time', async () => {
      for (let i = 0; i < 4; i++) {
        const o = await makePaidOrder('PLACED', { paidAgoMin: 11 });
        const [, acc] = await Promise.all([runOrderMaintenance(new Date()), setStatus(o.id, 'ACCEPTED', tVendor)]);
        const row = await db(o.id);
        if (acc.status === 200) {
          expect(row).toMatchObject({ status: 'ACCEPTED', paymentStatus: 'PAID' });
          expect(await refundsOf(o.id)).toHaveLength(0);
        } else {
          expect(row).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
          expect(await refundsOf(o.id)).toHaveLength(1);
        }
      }
    });

    test('the job running twice at once cancels and refunds each order once', async () => {
      const unpaid = (await place()).body.data.id;
      const paid = await makePaidOrder('PLACED', { paidAgoMin: 30 });
      const [a, b] = await Promise.all([runOrderMaintenance(minutesFromNow(16)), runOrderMaintenance(minutesFromNow(16))]);
      expect([...a.expired, ...b.expired].filter((x) => x === unpaid)).toHaveLength(1);
      expect([...a.autoCancelled, ...b.autoCancelled].filter((x) => x === paid.id)).toHaveLength(1);
      expect(await refundsOf(paid.id)).toHaveLength(1);
      expect(await prisma.adminAuditLog.count({ where: { action: 'ORDER_CANCELLED', targetId: paid.id } })).toBe(1);
    });

    test('legacy paid orders without paidAt are never auto-refunded; the admin sees them', async () => {
      const legacy = await prisma.order.create({ data: { customerId: STUDENT.id, vendorId: 'ven-1', totalAmount: 120, dropoffHostel: 'Block 1', status: 'PLACED', paymentStatus: 'PAID', createdAt: new Date(Date.now() - 3 * 3600_000) } });
      await runOrderMaintenance(minutesFromNow(60));
      expect((await db(legacy.id)).status).toBe('PLACED');
      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.body.data.find((r: any) => r.order.id === legacy.id)?.problem).toBe('STUCK_UNACCEPTED');
      // The restaurant still sees it (paid, live) and can accept it.
      expect((await setStatus(legacy.id, 'ACCEPTED', tVendor)).status).toBe(200);
    });
  });

  // =========================================================================
  // 14. Clock: server time only, UTC
  // =========================================================================
  describe('FM14 time', () => {
    test('windows are measured on the server; 14 min old stays, 16 min old expires; deadlines are UTC ISO', async () => {
      const placed = await place(tStudent, { createdAt: '2000-01-01T00:00:00Z' }); // client times are ignored
      const id = placed.body.data.id;
      expect(Math.abs(Date.parse(placed.body.data.createdAt) - Date.now())).toBeLessThan(60_000);
      expect(placed.body.data.payBy).toMatch(/Z$/);
      expect((await runOrderMaintenance(minutesFromNow(14))).expired).not.toContain(id);
      expect((await db(id)).status).toBe('PLACED');
      expect((await runOrderMaintenance(minutesFromNow(16))).expired).toContain(id);
      expect((await createPayment(id)).body.code).toBe('ORDER_CLOSED');
    });

    test('PAYMENT_WINDOW_MIN / VENDOR_ACCEPT_WINDOW_MIN are read from the environment', async () => {
      const saved = process.env.PAYMENT_WINDOW_MIN;
      process.env.PAYMENT_WINDOW_MIN = '1';
      try {
        const id = (await place()).body.data.id;
        expect((await runOrderMaintenance(minutesFromNow(2))).expired).toContain(id);
      } finally {
        if (saved === undefined) delete process.env.PAYMENT_WINDOW_MIN; else process.env.PAYMENT_WINDOW_MIN = saved;
      }
    });
  });

  // =========================================================================
  // needs-attention codes and payload hygiene
  // =========================================================================
  describe('needs-attention and payload hygiene', () => {
    const backdate = (id: string, minutes: number) => prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${new Date(Date.now() - minutes * 60_000)} WHERE "id" = ${id}`;

    test('every problem code shows up with { problem, problems, detail, since, order }', async () => {
      const noRider = await makePaidOrder('READY_FOR_PICKUP');
      await backdate(noRider.id, 20);
      const notPicked = await makePaidOrder('READY_FOR_PICKUP', { driverId: RIDER2.id });
      await backdate(notPicked.id, 20);
      const overdue = await makePaidOrder('PICKED_UP', { driverId: RIDER.id });
      await prisma.order.update({ where: { id: overdue.id }, data: { pickedUpAt: new Date(Date.now() - 90 * 60_000) } });
      const failedPay = (await place()).body.data.id;
      await prisma.order.update({ where: { id: failedPay }, data: { paymentStatus: 'FAILED' } });
      const pendingRefund = await makePaidOrder('PLACED');
      await prisma.order.update({ where: { id: pendingRefund.id }, data: { status: 'CANCELLED', refundStatus: 'PENDING', refundLeaseUntil: new Date(Date.now() + 3600_000) } });
      await backdate(pendingRefund.id, 10);
      const legacyCancelled = await prisma.order.create({ data: { customerId: STUDENT.id, vendorId: 'ven-1', totalAmount: 90, dropoffHostel: 'Block 1', status: 'CANCELLED', paymentStatus: 'PAID' } });

      const na = await request.get('/api/admin/orders/needs-attention').set(H(tAdmin));
      expect(na.status).toBe(200);
      const byId = new Map(na.body.data.map((r: any) => [r.order.id, r]));
      const expectations: [string, string][] = [
        [noRider.id, 'NO_RIDER'], [notPicked.id, 'RIDER_NOT_PICKED_UP'], [overdue.id, 'DELIVERY_OVERDUE'], [failedPay, 'PAYMENT_FAILED'],
        [pendingRefund.id, 'REFUND_PENDING'], [legacyCancelled.id, 'PAID_AFTER_CANCEL'],
      ];
      for (const [id, code] of expectations) {
        const row: any = byId.get(id);
        expect([code, row?.problem]).toEqual([code, code]);
        expect(row.problems).toContain(code);
        expect(typeof row.detail).toBe('string');
        expect(row.since === null || /Z$/.test(row.since)).toBe(true);
        expect(row.order.payments).toBeDefined();
      }
      for (const row of na.body.data) expect(Object.keys(row).sort()).toEqual(['detail', 'hint', 'order', 'problem', 'problems', 'since']);
      await prisma.order.update({ where: { id: pendingRefund.id }, data: { refundStatus: 'DONE', paymentStatus: 'REFUNDED', refundLeaseUntil: null } });
      await prisma.order.update({ where: { id: legacyCancelled.id }, data: { paymentStatus: 'REFUNDED' } });
    });

    test('no payload (REST or socket, any role) carries raw User/Vendor columns or secrets', async () => {
      const RAW_KEYS = ['passwordHash', 'googleSub', 'fcmToken', 'email', 'upiId', 'kraveoCoins', 'avatarId', 'isStudent', 'userId', 'approvalStatus', 'rejectionReason',
        'fssaiNumber', 'bannerImage', 'isAcceptingOrders', 'studentRegNo', 'emergencyPhone', 'vehicleRegNo', 'refundLeaseUntil', 'role', 'rating', 'totalRatingsCount', 'category', 'eta', 'user'];
      const ADMIN_ONLY = ['payments', 'razorpayOrderId', 'razorpayPaymentId', 'razorpayRefundId', 'capturedAmountPaise', 'refundError', 'refundAttempts', 'otpAttempts', 'otpLocked', 'customerId'];
      // (driverId is allowed: the rider_location event carries it, and it equals driver.id the viewer already sees.)
      const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
        if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
        return out;
      };
      const payloads: Record<string, unknown[]> = { STUDENT: [], VENDOR: [], DRIVER: [], ADMIN: [] };
      const socketsByRole: [string, Socket][] = [['STUDENT', await connect(tStudent)], ['VENDOR', await connect(tVendor)], ['DRIVER', await connect(tRider)], ['ADMIN', await connect(tAdmin)]];
      const ORDER_EVENTS = new Set(['order_updated', 'new_order_alert', 'order_available', 'order_unavailable', 'rider_location']);
      for (const [role, sock] of socketsByRole) sock.onAny((event, data) => { if (ORDER_EVENTS.has(event)) payloads[role].push(data); });

      const o = await placePaid();
      for (const [, sock] of socketsByRole) await join(sock, `order_${o.id}`);
      for (const st of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) await setStatus(o.id, st, tVendor);
      payloads.DRIVER.push((await request.get('/api/orders/available').set(H(tRider))).body);
      payloads.DRIVER.push((await claim(o.id)).body);
      await join(socketsByRole[2][1], `order_${o.id}`);
      payloads.DRIVER.push((await setStatus(o.id, 'PICKED_UP', tRider)).body);
      await request.post('/api/drivers/location').set(H(tRider)).send({ lat: 23.07, lng: 76.85 });
      payloads.DRIVER.push((await setStatus(o.id, 'ARRIVED_AT_GATE', tRider)).body);
      for (const [role, token] of [['STUDENT', tStudent], ['VENDOR', tVendor], ['DRIVER', tRider], ['ADMIN', tAdmin]] as const) {
        payloads[role].push((await getOrder(o.id, token)).body, (await request.get('/api/orders').set(H(token))).body);
      }
      payloads.ADMIN.push((await request.get('/api/admin/orders/needs-attention').set(H(tAdmin))).body);
      await sleep(200);

      for (const role of Object.keys(payloads)) {
        expect(payloads[role].length).toBeGreaterThan(2);
        const keys = keysOf(payloads[role]);
        expect([role, RAW_KEYS.filter((k) => keys.has(k))]).toEqual([role, []]);
        if (role !== 'ADMIN') expect([role, ADMIN_ONLY.filter((k) => keys.has(k))]).toEqual([role, []]);
        expect(JSON.stringify(payloads[role])).not.toMatch(/scrypt\$/);
      }
      // Rider directory endpoints (they used to return the full User row, password hash included).
      for (const url of ['/api/drivers', '/api/drivers/usr-4']) {
        const token = url === '/api/drivers' ? tAdmin : tRider;
        const body = JSON.stringify((await request.get(url).set(H(token))).body);
        expect(body).not.toMatch(/passwordHash|googleSub|fcmToken/);
      }
    });
  });

  // =========================================================================
  // Lists
  // =========================================================================
  describe('lists', () => {
    test('scope=active keeps recently finished orders, scope=history pages; the restaurant never lists unpaid orders', async () => {
      const done = await makePaidOrder('DELIVERED');
      await prisma.order.update({ where: { id: done.id }, data: { deliveredAt: new Date() } });
      const old = await makePaidOrder('DELIVERED');
      await prisma.order.update({ where: { id: old.id }, data: { deliveredAt: new Date(Date.now() - 3600_000) } });
      const unpaid = (await place()).body.data.id;
      const active = (await request.get('/api/orders?scope=active').set(H(tStudent))).body.data.map((o: any) => o.id);
      expect(active).toEqual(expect.arrayContaining([done.id, unpaid]));
      expect(active).not.toContain(old.id);
      const hist = await request.get('/api/orders?scope=history&limit=1').set(H(tStudent));
      expect(hist.body.data).toHaveLength(1);
      expect(hist.body.nextCursor).toBeTruthy();
      expect(hist.body.data.every((o: any) => ['DELIVERED', 'CANCELLED'].includes(o.status))).toBe(true);
      const vendorAll = (await request.get('/api/orders').set(H(tVendor))).body.data;
      expect(vendorAll.some((o: any) => o.id === unpaid)).toBe(false);
      expect(vendorAll.every((o: any) => o.customer.phone === null)).toBe(true);
    });
  });
});
