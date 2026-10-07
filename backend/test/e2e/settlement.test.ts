/**
 * Restaurant settlements (Docs/21 section 5, phase 2). Real PostgreSQL, real HTTP endpoints.
 * Covers: who is eligible, totals, idempotency under parallel runs, the daily job (restart / race safe), mark-paid, hold, release,
 * adjustments, cancel, CSV, what a restaurant may and may not see, settings validation, migration sanity, roles, audit, rate limits.
 */
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache } from '../../src/services/settings';
import { createSettlements, runDailySettlementJob, __resetSettlementJob } from '../../src/services/settlement';
import { runOrderMaintenance } from '../../src/services/orderMaintenance';
import { fromPaise, toPaise } from '../../src/services/pricing';
import { istDateString, istInstant, addIstDays } from '../../src/utils/time';

jest.setTimeout(90_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const S1 = { id: 'usr-st-v1', phone: '+91 9999881111', vendorId: 'st-ven-1' }; // UPI payout details
const S2 = { id: 'usr-st-v2', phone: '+91 9999882222', vendorId: 'st-ven-2' }; // bank payout details
const S3 = { id: 'usr-st-v3', phone: '+91 9999883333', vendorId: 'st-ven-3' }; // no payout details
const S4 = { id: 'usr-st-v4', phone: '+91 9999884444', vendorId: 'st-ven-4' }; // not approved
const RIDER = { id: 'usr-st-d1', phone: '+91 9999885555' };
const ALL_VENDORS = [S1, S2, S3, S4].map((v) => v.vendorId);
const H = (t: string) => getAuthHeader(t);
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tS1 = getVendorToken(S1.id, S1.phone);
const tS2 = getVendorToken(S2.id, S2.phone);
const tS4 = getVendorToken(S4.id, S4.phone);
const tRider = getDriverToken(RIDER.id, RIDER.phone);

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const sum = (xs: number[]) => fromPaise(xs.reduce((a, x) => a + toPaise(x), 0));

type Line = { name: string; menuItemId?: string | null; qty: number; price: number; vendorUnit: number; commUnit: number };
type OrderSpec = {
  vendorId?: string; status?: any; paymentStatus?: any; deliveredAt?: Date | null; lines?: Line[]; discount?: number; fee?: number;
  refundStatus?: string | null; driverId?: string | null; cancelledAt?: Date | null; legacy?: boolean;
};
const DEFAULT_LINES: Line[] = [{ name: 'Thali', qty: 1, price: 100, vendorUnit: 90, commUnit: 10 }];

const mkOrder = async (o: OrderSpec = {}) => {
  const lines = o.lines ?? DEFAULT_LINES;
  const subtotal = sum(lines.map((l) => l.price * l.qty));
  const vendorSubtotal = sum(lines.map((l) => l.vendorUnit * l.qty));
  const commissionTotal = sum(lines.map((l) => l.commUnit * l.qty));
  const fee = o.fee ?? 25;
  const discount = o.discount ?? 0;
  const status = o.status ?? 'DELIVERED';
  return prisma.order.create({
    data: {
      customerId: STUDENT.id,
      vendorId: o.vendorId ?? S1.vendorId,
      driverId: o.driverId === undefined ? null : o.driverId,
      status,
      paymentStatus: o.paymentStatus ?? 'PAID',
      dropoffHostel: 'Block 2',
      subtotal, vendorSubtotal, commissionTotal, deliveryFee: fee, discount,
      totalAmount: fromPaise(toPaise(subtotal) + toPaise(fee) - toPaise(discount)),
      deliveredAt: o.deliveredAt === undefined ? (status === 'DELIVERED' ? ago(2) : null) : o.deliveredAt,
      cancelledAt: o.cancelledAt ?? null,
      refundStatus: o.refundStatus ?? null,
      items: { create: lines.map((l) => ({ name: l.name, menuItemId: l.menuItemId ?? null, quantity: l.qty, price: l.price, vendorUnitPrice: l.vendorUnit, commissionUnit: l.commUnit })) },
    } as any,
  });
};

/** A minimal RFC 4180 parser (quotes, doubled quotes, newlines inside quotes). */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

const keysDeep = (v: unknown, acc = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

describe('Settlements (phase 2)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  const adminGet = (p: string) => request.get(p).set(H(tAdmin));
  const adminPost = (p: string, body: unknown = {}) => request.post(p).set(H(tAdmin)).send(body as any);
  const run = (body: unknown = {}) => adminPost('/api/admin/settlements/run', body);
  const setSettlement = async (v: Record<string, unknown>) => {
    const r = await request.put('/api/admin/settings/settlement').set(H(tAdmin)).send(v);
    expect(r.status).toBe(200);
  };
  const dbSettlements = (vendorId?: string) => prisma.settlement.findMany({ where: vendorId ? { vendorId } : { vendorId: { in: ALL_VENDORS } }, orderBy: { createdAt: 'asc' } });
  const audits = (action: string) => prisma.adminAuditLog.findMany({ where: { action } });
  /** One settled batch for S1 with two orders: net 180.00. */
  const makeBatch = async (vendorId = S1.vendorId) => {
    await mkOrder({ vendorId });
    await mkOrder({ vendorId });
    const r = await run({ vendorId });
    expect(r.status).toBe(200);
    expect(r.body.data.created).toHaveLength(1);
    return r.body.data.created[0] as any;
  };

  beforeAll(async () => {
    process.env.PAYOUT_ENC_KEY = randomBytes(32).toString('base64');
    await cleanTestOrders();
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    for (const u of [
      { id: S1.id, name: 'ST Owner One', phone: S1.phone, role: Role.VENDOR },
      { id: S2.id, name: 'ST Owner Two', phone: S2.phone, role: Role.VENDOR },
      { id: S3.id, name: 'ST Owner Three', phone: S3.phone, role: Role.VENDOR },
      { id: S4.id, name: 'ST Owner Four', phone: S4.phone, role: Role.VENDOR },
      { id: RIDER.id, name: 'ST Rider', phone: RIDER.phone, role: Role.DRIVER },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    for (const [v, status] of [[S1, 'APPROVED'], [S2, 'APPROVED'], [S3, 'APPROVED'], [S4, 'PENDING']] as const) {
      await prisma.vendor.upsert({
        where: { id: v.vendorId },
        update: { userId: v.id, approvalStatus: status, name: `ST Kitchen ${v.vendorId.slice(-1)}` },
        create: { id: v.vendorId, userId: v.id, name: `ST Kitchen ${v.vendorId.slice(-1)}`, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: status },
      });
    }
    server = await startTestServer(0);
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    delete process.env.SETTLEMENT_JOB_IN_TEST;
    __resetRateLimits();
    __resetSettlementJob();
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await prisma.order.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.payoutAccount.deleteMany({ where: { userId: { in: [S1.id, S2.id, S3.id, S4.id] } } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.riderPayout.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.payoutAccount.create({ data: { userId: S1.id, partnerType: 'VENDOR', method: 'UPI', upiId: 'kitchen1@upi', accountHolder: 'Kitchen One' } });
    await prisma.payoutAccount.create({ data: { userId: S2.id, partnerType: 'VENDOR', method: 'BANK', accountHolder: 'Kitchen Two', accountNumberEnc: 'v1.x.y.z', accountLast4: '4321', ifsc: 'SBIN0001234', bankName: 'SBI', verifiedAt: new Date() } });
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    delete process.env.SETTLEMENT_JOB_IN_TEST;
    delete process.env.PAYOUT_ENC_KEY;
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    await prisma.order.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: ALL_VENDORS } } });
    await prisma.vendor.deleteMany({ where: { id: { in: ALL_VENDORS } } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  describe('creation: who is eligible and what the totals are', () => {
    test('only delivered + paid + not refunded + unsettled orders are settled, grouped per restaurant, with exact totals', async () => {
      // S1: float-hostile amounts. subtotal 3 x 33.33 = 99.99 ... vendor 3 x 29.99, commission 3 x 3.34 (+ a second order)
      const ok1 = await mkOrder({ lines: [{ name: 'Dal', qty: 3, price: 33.33, vendorUnit: 29.99, commUnit: 3.34 }] });
      const ok2 = await mkOrder({ lines: [{ name: 'Roti', qty: 1, price: 0.1, vendorUnit: 0.07, commUnit: 0.03 }, { name: 'Dal', qty: 2, price: 0.2, vendorUnit: 0.14, commUnit: 0.06 }] });
      const ok3 = await mkOrder({ discount: 20 }); // a coupon: Kraveo bears it, the restaurant still earns 90
      const cancelledRefunded = await mkOrder({ status: 'CANCELLED', paymentStatus: 'REFUNDED', deliveredAt: null, cancelledAt: ago(3) });
      const deliveredThenRefunded = await mkOrder({ paymentStatus: 'REFUNDED' });
      const refundPending = await mkOrder({ refundStatus: 'PENDING' });
      const pickedUp = await mkOrder({ status: 'PICKED_UP', deliveredAt: null });
      const unpaid = await mkOrder({ status: 'PLACED', paymentStatus: 'PENDING', deliveredAt: null });
      const noDeliveredAt = await mkOrder({ deliveredAt: null });
      const already = await prisma.settlement.create({ data: { vendorId: S1.vendorId, batchKey: 'M-old', periodStart: ago(50), periodEnd: ago(49), orderCount: 1, foodGross: 100, vendorAmount: 90, commissionAmount: 10, netPayable: 90, createdBy: 'x' } });
      const settledBefore = await mkOrder({ });
      await prisma.order.update({ where: { id: settledBefore.id }, data: { settlementId: already.id } });
      const other = await mkOrder({ vendorId: S2.vendorId, lines: [{ name: 'Naan', qty: 2, price: 50, vendorUnit: 45, commUnit: 5 }] });
      await mkOrder({ vendorId: S3.vendorId, status: 'CANCELLED', paymentStatus: 'REFUNDED', deliveredAt: null }); // S3 has nothing to settle

      const before = await prisma.order.findUniqueOrThrow({ where: { id: ok1.id } });
      const r = await run();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, message: '2 settlement(s) created for 4 order(s).' });
      const data = r.body.data;
      expect(Object.keys(data).sort()).toEqual(['cutoff', 'created', 'deliveredBy', 'failed', 'holdDays', 'netPayable', 'orderCount', 'skipped'].sort());
      expect(data.created).toHaveLength(2);
      expect(data.skipped).toEqual([]);
      expect(data.failed).toEqual([]);
      expect(data.orderCount).toBe(4);

      const s1 = data.created.find((s: any) => s.vendorId === S1.vendorId);
      expect(s1).toMatchObject({
        vendorName: 'ST Kitchen 1', status: 'PENDING', orderCount: 3, adjustmentTotal: 0, createdBy: ADMIN.id, paidAt: null, paymentReference: null, hasPayoutDetails: true,
        payoutSnapshot: { method: 'UPI', destination: 'kitchen1@upi', accountHolder: 'Kitchen One', ifsc: null, bankName: null, verified: false },
      });
      expect(s1.batchKey).toMatch(/^M-\d{14}-[0-9a-f]{8}$/);
      // 99.99 + 0.5 + 100 = 200.49 ; vendor 89.97 + 0.35 + 90 = 180.32 ; commission 10.02 + 0.15 + 10 = 20.17
      expect(s1.foodGross).toBe(200.49);
      expect(s1.vendorAmount).toBe(180.32);
      expect(s1.commissionAmount).toBe(20.17);
      expect(s1.netPayable).toBe(180.32);
      expect(s1.vendorAmount + s1.commissionAmount).toBeCloseTo(s1.foodGross, 2);

      const s2 = data.created.find((s: any) => s.vendorId === S2.vendorId);
      expect(s2).toMatchObject({ orderCount: 1, foodGross: 100, vendorAmount: 90, commissionAmount: 10, netPayable: 90, payoutSnapshot: { method: 'BANK', destination: 'XXXXXX4321', accountHolder: 'Kitchen Two', ifsc: 'SBIN0001234', bankName: 'SBI', verified: true } });
      expect(JSON.stringify(s2.payoutSnapshot)).not.toContain('v1.');
      expect(data.netPayable).toBe(270.32);
      expect(data.cutoff).toEqual(expect.any(String));

      const settledIds = (await prisma.order.findMany({ where: { settlementId: { not: null }, vendorId: { in: ALL_VENDORS } }, select: { id: true, settlementId: true } }));
      const bySettlement = (id: string) => settledIds.filter((o) => o.settlementId === id).map((o) => o.id).sort();
      expect(bySettlement(s1.id)).toEqual([ok1.id, ok2.id, ok3.id].sort());
      expect(bySettlement(s2.id)).toEqual([other.id]);
      for (const o of [cancelledRefunded, deliveredThenRefunded, refundPending, pickedUp, unpaid, noDeliveredAt]) {
        expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).settlementId).toBeNull();
      }
      expect((await prisma.order.findUniqueOrThrow({ where: { id: settledBefore.id } })).settlementId).toBe(already.id);
      // claiming an order does not touch its updatedAt (no app sees it as changed)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: ok1.id } })).updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await prisma.settlement.count({ where: { vendorId: S3.vendorId } })).toBe(0);
      expect((await audits('SETTLEMENT_RUN'))).toHaveLength(1);

      // a second run finds nothing and says so
      const again = await run();
      expect(again.body).toMatchObject({ success: true, message: 'Nothing to settle: no delivered, paid order is waiting.', data: { created: [], orderCount: 0, netPayable: 0 } });
    });

    test('a restaurant without payout details still gets its settlement, flagged', async () => {
      await mkOrder({ vendorId: S3.vendorId });
      const r = await run({ vendorId: S3.vendorId });
      expect(r.body.data.created[0]).toMatchObject({ vendorId: S3.vendorId, hasPayoutDetails: false, payoutSnapshot: null, netPayable: 90 });
      expect((await dbSettlements(S3.vendorId))[0].payoutSnapshot).toBeNull();
    });

    test('vendorId and until limit a run; later orders go to the next run', async () => {
      const early = await mkOrder({ deliveredAt: ago(30) });
      const late = await mkOrder({ deliveredAt: ago(1) });
      await mkOrder({ vendorId: S2.vendorId });
      const bad = await run({ until: 'tomorrow-ish' });
      expect([bad.status, bad.body.field]).toEqual([400, 'until']);
      expect((await run({ vendorId: 'bad id' })).status).toBe(400);
      expect((await run({ nonsense: 1 })).status).toBe(400);
      const first = await run({ vendorId: S1.vendorId, until: ago(10).toISOString() });
      expect(first.body.data.created).toHaveLength(1);
      expect(first.body.data.created[0].orderCount).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: early.id } })).settlementId).toBe(first.body.data.created[0].id);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: late.id } })).settlementId).toBeNull();
      expect(await prisma.settlement.count({ where: { vendorId: S2.vendorId } })).toBe(0); // other restaurant untouched
      // a cut-off in the future is clamped to now (orders delivered "later" cannot exist yet)
      const second = await run({ vendorId: S1.vendorId, until: new Date(Date.now() + 5 * 24 * HOUR).toISOString() });
      expect(second.body.data.created[0].orderCount).toBe(1);
      expect(new Date(second.body.data.cutoff).getTime()).toBeLessThanOrEqual(Date.now());
      // a plain date means the end of that India day
      await mkOrder({ deliveredAt: ago(1) });
      const dateRun = await run({ vendorId: S1.vendorId, until: addIstDays(istDateString(new Date()), -3) });
      expect(dateRun.body.data.created).toEqual([]);
    });

    test('holdDays: orders younger than the hold are kept for a later run', async () => {
      await setSettlement({ holdDays: 2 });
      const young = await mkOrder({ deliveredAt: ago(24) });
      const old = await mkOrder({ deliveredAt: ago(60) });
      const r = await run();
      expect(r.body.data.holdDays).toBe(2);
      expect(r.body.data.created).toHaveLength(1);
      expect(r.body.data.created[0].orderCount).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: old.id } })).settlementId).toBe(r.body.data.created[0].id);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: young.id } })).settlementId).toBeNull();
      await setSettlement({ holdDays: 0 });
      expect((await run()).body.data.created[0].orderCount).toBe(1);
    });

    test('legacy rows (backfilled in phase 1: vendorSubtotal = subtotal, commission 0) settle for the full food total', async () => {
      await prisma.order.create({
        data: {
          customerId: STUDENT.id, vendorId: S1.vendorId, status: 'DELIVERED', paymentStatus: 'PAID', dropoffHostel: 'Block 2', totalAmount: 170,
          subtotal: 140, taxAndPackaging: 15, deliveryFee: 30, vendorSubtotal: 140, commissionTotal: 0, deliveredAt: ago(48),
          items: { create: [{ name: 'Old dish', quantity: 2, price: 70, vendorUnitPrice: 70, commissionUnit: 0 }] },
        },
      });
      const r = await run();
      expect(r.body.data.created[0]).toMatchObject({ orderCount: 1, foodGross: 140, vendorAmount: 140, commissionAmount: 0, netPayable: 140 });
    });
  });

  // =========================================================================================
  describe('idempotency, races and the daily job', () => {
    test('five parallel "run now" calls create each settlement once; every order is in exactly one settlement', async () => {
      for (let i = 0; i < 6; i++) await mkOrder({ vendorId: i % 2 ? S1.vendorId : S2.vendorId });
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => run()));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const created = rs.flatMap((r) => r.body.data.created as any[]);
      expect(created).toHaveLength(2);
      expect(created.map((s) => s.orderCount)).toEqual([3, 3]);
      expect(rs.flatMap((r) => r.body.data.failed)).toEqual([]);
      const settlements = await dbSettlements();
      expect(settlements).toHaveLength(2);
      const orders = await prisma.order.findMany({ where: { vendorId: { in: ALL_VENDORS } }, select: { settlementId: true } });
      expect(orders.filter((o) => o.settlementId === null)).toHaveLength(0);
      for (const s of settlements) expect(await prisma.order.count({ where: { settlementId: s.id } })).toBe(s.orderCount);
    });

    test('service level: many parallel runs with and without a batch key never double-settle an order', async () => {
      for (let i = 0; i < 8; i++) await mkOrder();
      const today = istDateString(new Date());
      const results = await Promise.all([
        createSettlements({ createdBy: 'a' }), createSettlements({ createdBy: 'b' }), createSettlements({ createdBy: 'AUTO', batchKey: today }),
        createSettlements({ createdBy: 'AUTO', batchKey: today }), createSettlements({ createdBy: 'c', vendorId: S1.vendorId }),
      ]);
      const created = results.flatMap((r) => r.created);
      expect(created).toHaveLength(1);
      expect(created[0].orderCount).toBe(8);
      expect(results.flatMap((r) => r.failed)).toEqual([]);
      expect(await prisma.order.count({ where: { vendorId: S1.vendorId, settlementId: created[0].id } })).toBe(8);
    });

    test('the unique (restaurant, batchKey) key stops a second automatic batch for the same day', async () => {
      const today = istDateString(new Date());
      await mkOrder();
      const first = await createSettlements({ createdBy: 'AUTO', batchKey: today });
      expect(first.created).toHaveLength(1);
      expect(first.created[0].batchKey).toBe(today);
      await expect(prisma.settlement.create({ data: { vendorId: S1.vendorId, batchKey: today, periodStart: new Date(), periodEnd: new Date(), orderCount: 0, foodGross: 0, vendorAmount: 0, commissionAmount: 0, netPayable: 0, createdBy: 'x' } })).rejects.toMatchObject({ code: 'P2002' });
      // the day's batch exists (here: cancelled by an admin); new orders must NOT create a second batch under the same key
      await prisma.settlement.update({ where: { id: first.created[0].id }, data: { status: 'CANCELLED' } });
      await prisma.order.updateMany({ where: { settlementId: first.created[0].id }, data: { settlementId: null } });
      await mkOrder();
      const second = await createSettlements({ createdBy: 'AUTO', batchKey: today });
      expect(second.created).toEqual([]);
      expect(second.skipped).toEqual([{ vendorId: S1.vendorId, reason: 'ALREADY_CREATED_FOR_THIS_DAY' }]);
      expect(await prisma.order.count({ where: { vendorId: S1.vendorId, settlementId: null } })).toBe(2);
      // a manual run can still settle them
      expect((await run()).body.data.created[0].orderCount).toBe(2);
    });

    test('daily job: waits for settlement.time, cuts off at that time, is restart safe, and later orders go to the next day', async () => {
      const today = istDateString(new Date());
      const tomorrow = addIstDays(today, 1);
      const before = await mkOrder({ deliveredAt: istInstant(today, '21:30') });
      const after = await mkOrder({ deliveredAt: istInstant(today, '22:10') });
      expect(await runDailySettlementJob(istInstant(today, '21:59'))).toBeNull(); // not yet 22:00
      expect(await dbSettlements()).toHaveLength(0);

      const r = await runDailySettlementJob(istInstant(today, '22:30'));
      expect(r!.created).toHaveLength(1);
      expect(r!.created[0]).toMatchObject({ vendorId: S1.vendorId, batchKey: today, createdBy: 'AUTO', orderCount: 1, status: 'PENDING' });
      expect(new Date(r!.created[0].periodEnd).toISOString()).toBe(istInstant(today, '22:00').toISOString());
      expect((await prisma.order.findUniqueOrThrow({ where: { id: before.id } })).settlementId).toBe(r!.created[0].id);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: after.id } })).settlementId).toBeNull();

      // same process, next tick: nothing. A "restart" (flag lost) and a second server racing: still one batch.
      expect(await runDailySettlementJob(istInstant(today, '22:31'))).toBeNull();
      __resetSettlementJob();
      const raced = await Promise.all([runDailySettlementJob(istInstant(today, '22:32')), runDailySettlementJob(istInstant(today, '22:32'))]);
      expect(raced.flatMap((x) => x?.created ?? [])).toHaveLength(0);
      expect(await dbSettlements()).toHaveLength(1);

      // next IST day: the 22:10 order is picked up by that day's batch
      const next = await runDailySettlementJob(istInstant(tomorrow, '22:05'));
      expect(next!.created).toHaveLength(1);
      expect(next!.created[0]).toMatchObject({ batchKey: tomorrow, orderCount: 1 });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: after.id } })).settlementId).toBe(next!.created[0].id);
      expect((await dbSettlements()).map((s) => s.batchKey)).toEqual([today, tomorrow]);
    });

    test('daily job: a restart after the cut-off still settles what was due, a later order waits, autoCreate=false and a custom time are honoured', async () => {
      const today = istDateString(new Date());
      const early = await mkOrder({ deliveredAt: istInstant(today, '17:00') });
      const late = await mkOrder({ deliveredAt: istInstant(today, '20:00') });
      await setSettlement({ autoCreate: false });
      expect(await runDailySettlementJob(istInstant(today, '23:30'))).toBeNull();
      expect(await dbSettlements()).toHaveLength(0);
      await setSettlement({ autoCreate: true, time: '18:30' });
      expect(await runDailySettlementJob(istInstant(today, '18:29'))).toBeNull();
      const r = await runDailySettlementJob(istInstant(today, '23:59')); // the server was down at 18:30 and starts at 23:59
      expect(r!.created).toHaveLength(1);
      expect(r!.created[0]).toMatchObject({ batchKey: today, orderCount: 1 });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: early.id } })).settlementId).toBe(r!.created[0].id);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: late.id } })).settlementId).toBeNull();
    });

    test('the 60 s maintenance tick runs the daily job (only when the test opts in)', async () => {
      await setSettlement({ time: '00:00' });
      await mkOrder({ deliveredAt: ago(30) });
      await runOrderMaintenance();
      expect(await dbSettlements()).toHaveLength(0); // off under NODE_ENV=test unless SETTLEMENT_JOB_IN_TEST=1
      process.env.SETTLEMENT_JOB_IN_TEST = '1';
      await runOrderMaintenance();
      const all = await dbSettlements();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ createdBy: 'AUTO', batchKey: istDateString(new Date()), orderCount: 1 });
      await runOrderMaintenance(); // a second tick the same day
      expect(await dbSettlements()).toHaveLength(1);
    });
  });

  // =========================================================================================
  describe('mark-paid', () => {
    const pay = (id: string, body: unknown) => adminPost(`/api/admin/settlements/${id}/mark-paid`, body);

    test('records the payment, is idempotent for the same reference and refuses a different one', async () => {
      const s = await makeBatch();
      const paidAt = ago(1).toISOString();
      const first = await pay(s.id, { reference: 'UTR 4021 9988', paidAt, note: 'NEFT from HDFC' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ success: true, changed: true, message: 'Marked as paid.', data: { id: s.id, status: 'PAID', paymentReference: 'UTR 4021 9988', paidAt, paidBy: ADMIN.id, note: 'NEFT from HDFC', netPayable: 180 } });
      const again = await pay(s.id, { reference: 'UTR 4021 9988' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ changed: false, message: 'Already marked as paid with this reference.', data: { status: 'PAID', paidAt } });
      const other = await pay(s.id, { reference: 'DIFFERENT-REF-1' });
      expect([other.status, other.body.code]).toEqual([409, 'ALREADY_PAID']);
      const row = await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.paymentReference).toBe('UTR 4021 9988');
      expect(await audits('SETTLEMENT_PAID')).toHaveLength(1);
    });

    test('validation, state guards and 404', async () => {
      const s = await makeBatch();
      const cases: [unknown, string][] = [
        [{}, 'reference'], [{ reference: 5 }, 'reference'], [{ reference: 'ab' }, 'reference'], [{ reference: 'x'.repeat(65) }, 'reference'],
        [{ reference: '=cmd|calc' }, 'reference'], [{ reference: 'ok-ref-1', paidAt: 'yesterday' }, 'paidAt'], [{ reference: 'ok-ref-1', paidAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString() }, 'paidAt'],
        [{ reference: 'ok-ref-1', paidAt: '1999-01-01' }, 'paidAt'], [{ reference: 'ok-ref-1', note: 'n'.repeat(301) }, 'note'],
      ];
      for (const [body, field] of cases) {
        const r = await pay(s.id, body);
        expect([r.status, r.body.code, r.body.field]).toEqual([400, 'BAD_REQUEST', field]);
      }
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('PENDING');
      expect((await pay(randomUUID(), { reference: 'ok-ref-1' })).status).toBe(404);
      expect((await pay('bad id', { reference: 'ok-ref-1' })).status).toBe(400);
      await adminPost(`/api/admin/settlements/${s.id}/hold`);
      const held = await pay(s.id, { reference: 'ok-ref-1' });
      expect([held.status, held.body.code]).toEqual([409, 'SETTLEMENT_ON_HOLD']);
      await adminPost(`/api/admin/settlements/${s.id}/cancel`);
      const cancelled = await pay(s.id, { reference: 'ok-ref-1' });
      expect([cancelled.status, cancelled.body.code]).toEqual([409, 'SETTLEMENT_CANCELLED']);
      // nothing to pay (the restaurant earned 0)
      await mkOrder({ vendorId: S2.vendorId, lines: [{ name: 'Free', qty: 1, price: 10, vendorUnit: 0, commUnit: 10 }] });
      const zero = (await run({ vendorId: S2.vendorId })).body.data.created[0];
      const nothing = await pay(zero.id, { reference: 'ok-ref-1' });
      expect([nothing.status, nothing.body.code]).toEqual([409, 'NOTHING_TO_PAY']);
    });

    test('double click: five parallel identical calls give one change; two different references give one winner', async () => {
      const s = await makeBatch();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => pay(s.id, { reference: 'UTR-PARALLEL-1' })));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(rs.filter((r) => r.body.changed)).toHaveLength(1);
      expect(await audits('SETTLEMENT_PAID')).toHaveLength(1);
      const t = await makeBatch(S2.vendorId);
      const race = await Promise.all([pay(t.id, { reference: 'REF-AAAA' }), pay(t.id, { reference: 'REF-BBBB' })]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = race.find((r) => r.status === 200)!.body.data.paymentReference;
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: t.id } })).paymentReference).toBe(winner);
    });
  });

  // =========================================================================================
  describe('hold and release', () => {
    test('hold / release are idempotent and only valid in the right states', async () => {
      const s = await makeBatch();
      const hold = await adminPost(`/api/admin/settlements/${s.id}/hold`, { note: 'checking a complaint' });
      expect(hold.body).toMatchObject({ success: true, changed: true, message: 'Put on hold.', data: { status: 'ON_HOLD', note: 'checking a complaint' } });
      expect((await adminPost(`/api/admin/settlements/${s.id}/hold`)).body).toMatchObject({ changed: false, message: 'Already on hold.' });
      const rel = await adminPost(`/api/admin/settlements/${s.id}/release`);
      expect(rel.body).toMatchObject({ changed: true, message: 'Released.', data: { status: 'PENDING' } });
      expect((await adminPost(`/api/admin/settlements/${s.id}/release`)).body).toMatchObject({ changed: false, message: 'It was not on hold.' });
      expect((await adminPost(`/api/admin/settlements/${s.id}/hold`, { note: 'x'.repeat(301) })).status).toBe(400);
      expect(await audits('SETTLEMENT_HELD')).toHaveLength(1);
      expect(await audits('SETTLEMENT_RELEASED')).toHaveLength(1);
      await adminPost(`/api/admin/settlements/${s.id}/mark-paid`, { reference: 'UTR-HOLD-1' });
      for (const action of ['hold', 'release']) {
        const r = await adminPost(`/api/admin/settlements/${s.id}/${action}`);
        expect([r.status, r.body.code]).toEqual([409, action === 'hold' ? 'NOT_PENDING' : 'NOT_ON_HOLD']);
      }
      const c = await makeBatch(S2.vendorId);
      await adminPost(`/api/admin/settlements/${c.id}/cancel`);
      expect((await adminPost(`/api/admin/settlements/${c.id}/hold`)).status).toBe(409);
      expect((await adminPost(`/api/admin/settlements/${randomUUID()}/hold`)).status).toBe(404);
    });
  });

  // =========================================================================================
  describe('adjustments', () => {
    const adj = (id: string, body: unknown) => adminPost(`/api/admin/settlements/${id}/adjustments`, body);

    test('plus and minus adjust the payable amount exactly; the detail lists them', async () => {
      const s = await makeBatch(); // vendorAmount 180
      const a = await adj(s.id, { amount: 25.5, reason: 'Packaging refund' });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ success: true, changed: true, message: 'Adjustment added.', data: { adjustmentTotal: 25.5, netPayable: 205.5, vendorAmount: 180 }, adjustment: { amount: 25.5, reason: 'Packaging refund', createdBy: ADMIN.id } });
      expect(Object.keys(a.body.adjustment).sort()).toEqual(['amount', 'createdAt', 'createdBy', 'id', 'reason']);
      const b = await adj(s.id, { amount: -10.25, reason: 'Late handover penalty' });
      expect(b.body.data).toMatchObject({ adjustmentTotal: 15.25, netPayable: 195.25 });
      const c = await adj(s.id, { amount: 0.1, reason: 'float check one' });
      const d = await adj(s.id, { amount: 0.2, reason: 'float check two' });
      expect(d.body.data).toMatchObject({ adjustmentTotal: 15.55, netPayable: 195.55 });
      expect(c.status).toBe(201);
      const detail = (await adminGet(`/api/admin/settlements/${s.id}`)).body.data;
      expect(detail.adjustments.map((x: any) => x.amount)).toEqual([25.5, -10.25, 0.1, 0.2]);
      expect(detail.settlement.netPayable).toBe(195.55);
      expect(await audits('SETTLEMENT_ADJUSTED')).toHaveLength(4);
      // allowed on hold, refused once paid or cancelled
      await adminPost(`/api/admin/settlements/${s.id}/hold`);
      expect((await adj(s.id, { amount: 1, reason: 'while on hold' })).status).toBe(201);
      await adminPost(`/api/admin/settlements/${s.id}/release`);
      await adminPost(`/api/admin/settlements/${s.id}/mark-paid`, { reference: 'UTR-ADJ-0001' });
      const paid = await adj(s.id, { amount: 1, reason: 'too late' });
      expect([paid.status, paid.body.code]).toEqual([409, 'NOT_ADJUSTABLE']);
      const t = await makeBatch(S2.vendorId);
      await adminPost(`/api/admin/settlements/${t.id}/cancel`);
      expect((await adj(t.id, { amount: 1, reason: 'cancelled one' })).status).toBe(409);
      expect((await adj(randomUUID(), { amount: 1, reason: 'no such one' })).status).toBe(404);
    });

    test('validation: amount (non-zero, +/- up to 100000, 2 decimals), reason 3-200, requestId, never a negative payable', async () => {
      const s = await makeBatch();
      const good = { amount: 5, reason: 'valid reason' };
      const cases: [unknown, string][] = [
        [{ ...good, amount: 0 }, 'amount'], [{ ...good, amount: 0.001 }, 'amount'], [{ ...good, amount: '5' }, 'amount'], [{ ...good, amount: 1.234 }, 'amount'],
        [{ ...good, amount: 100000.01 }, 'amount'], [{ ...good, amount: -100000.01 }, 'amount'], [{ ...good, amount: null }, 'amount'], [{ reason: 'valid reason' }, 'amount'],
        [{ ...good, reason: 'ab' }, 'reason'], [{ ...good, reason: 'r'.repeat(201) }, 'reason'], [{ amount: 5 }, 'reason'], [{ ...good, reason: 7 }, 'reason'],
        [{ ...good, requestId: 'bad id!' }, 'requestId'], [{ amount: -180.01, reason: 'more than the payable' }, 'amount'],
      ];
      for (const [body, field] of cases) {
        const r = await adj(s.id, body);
        expect([r.status, r.body.field]).toEqual([400, field]);
      }
      expect(await prisma.settlementAdjustment.count({ where: { settlementId: s.id } })).toBe(0);
      expect((await adj(s.id, { amount: 100000, reason: 'max amount' })).status).toBe(201);
      expect((await adj(s.id, { amount: -100000, reason: 'max deduction' })).body.data.netPayable).toBe(180);
      expect((await adj(s.id, { amount: -180, reason: 'back to zero' })).body.data.netPayable).toBe(0);
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).netPayable).toBe(0);
    });

    test('double click and parallel adjustments: the same requestId counts once, different ones add up exactly', async () => {
      const s = await makeBatch();
      const same = await Promise.all([1, 2, 3, 4, 5].map(() => adj(s.id, { amount: -7.5, reason: 'same click', requestId: 'req-double-click-1' })));
      expect(same.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await prisma.settlementAdjustment.count({ where: { settlementId: s.id } })).toBe(1);
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).netPayable).toBe(172.5);
      const many = await Promise.all([1, 2, 3, 4, 5].map((i) => adj(s.id, { amount: 10, reason: `parallel ${i}` })));
      expect(many.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const row = await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.adjustmentTotal).toBe(42.5);
      expect(row.netPayable).toBe(222.5);
      expect(await prisma.settlementAdjustment.count({ where: { settlementId: s.id } })).toBe(6);
    });
  });

  // =========================================================================================
  describe('cancel', () => {
    test('frees the orders, is idempotent, refused after payment, and the next run settles the orders again', async () => {
      const s = await makeBatch();
      const c = await adminPost(`/api/admin/settlements/${s.id}/cancel`);
      expect(c.body).toMatchObject({ success: true, changed: true, freedOrders: 2, data: { status: 'CANCELLED', id: s.id } });
      expect(c.body.message).toMatch(/2 order\(s\) will be settled again/);
      expect(await prisma.order.count({ where: { settlementId: s.id } })).toBe(0);
      expect(await prisma.order.count({ where: { vendorId: S1.vendorId, settlementId: null } })).toBe(2);
      expect((await adminPost(`/api/admin/settlements/${s.id}/cancel`)).body).toMatchObject({ changed: false, freedOrders: 0, message: 'Already cancelled.' });
      expect(await audits('SETTLEMENT_CANCELLED')).toHaveLength(1);
      const redo = (await run()).body.data.created;
      expect(redo).toHaveLength(1);
      expect(redo[0].id).not.toBe(s.id);
      expect(redo[0].orderCount).toBe(2);
      expect(await prisma.order.count({ where: { settlementId: redo[0].id } })).toBe(2);
      // paid ones can never be cancelled
      await adminPost(`/api/admin/settlements/${redo[0].id}/mark-paid`, { reference: 'UTR-CANCEL-1' });
      const paid = await adminPost(`/api/admin/settlements/${redo[0].id}/cancel`);
      expect([paid.status, paid.body.code]).toEqual([409, 'ALREADY_PAID']);
      expect(await prisma.order.count({ where: { settlementId: redo[0].id } })).toBe(2);
    });

    test('parallel cancels free the orders once; a cancel racing a mark-paid ends in exactly one outcome', async () => {
      const s = await makeBatch();
      const rs = await Promise.all([1, 2, 3].map(() => adminPost(`/api/admin/settlements/${s.id}/cancel`)));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(rs.filter((r) => r.body.changed)).toHaveLength(1);
      const t = await makeBatch(S2.vendorId);
      const [p, c] = await Promise.all([adminPost(`/api/admin/settlements/${t.id}/mark-paid`, { reference: 'UTR-RACE-1' }), adminPost(`/api/admin/settlements/${t.id}/cancel`)]);
      const row = await prisma.settlement.findUniqueOrThrow({ where: { id: t.id } });
      const attached = await prisma.order.count({ where: { settlementId: t.id } });
      if (row.status === 'PAID') { expect([p.status, c.status]).toEqual([200, 409]); expect(attached).toBe(2); }
      else { expect(row.status).toBe('CANCELLED'); expect([p.status, c.status]).toEqual([409, 200]); expect(attached).toBe(0); }
    });
  });

  // =========================================================================================
  describe('CSV exports', () => {
    test('one settlement: injection-safe, correctly escaped, right headers; the amount column adds up to the payable', async () => {
      const evilName = '=HYPERLINK("http://evil.example","pay, here")\nsecond line';
      await prisma.vendor.update({ where: { id: S1.vendorId }, data: { name: evilName } });
      try {
        const s = await makeBatch();
        await adminPost(`/api/admin/settlements/${s.id}/adjustments`, { amount: -5, reason: '+cmd, with "quotes" and a comma' });
        await adminPost(`/api/admin/settlements/${s.id}/adjustments`, { amount: 12.5, reason: '@SUM(A1:A9)' });
        await adminPost(`/api/admin/settlements/${s.id}/mark-paid`, { reference: 'UTR-CSV-0001' });
        const r = await adminGet(`/api/admin/settlements/${s.id}/export.csv`);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(r.headers['content-disposition']).toBe(`attachment; filename="kraveo-settlement-${s.id.slice(0, 8)}.csv"`);
        expect(r.headers['cache-control']).toBe('no-store');
        const rows = parseCsv(r.text);
        expect(rows[0]).toEqual(['row_type', 'settlement_id', 'restaurant', 'batch', 'status', 'payment_reference', 'order_id', 'delivered_at_ist', 'customer_food_total', 'restaurant_amount', 'commission', 'note']);
        const body = rows.slice(1).filter((x) => x.length > 1);
        expect(body.filter((x) => x[0] === 'ORDER')).toHaveLength(2);
        const adjRows = body.filter((x) => x[0] === 'ADJUSTMENT');
        expect(adjRows).toHaveLength(2);
        for (const x of body) {
          expect(x).toHaveLength(12);
          expect(x[2]).toBe(`'${evilName}`); // formula guard; the quotes inside survive CSV escaping
          expect(x[4]).toBe('PAID');
          expect(x[5]).toBe('UTR-CSV-0001');
        }
        expect(adjRows[0][11]).toBe(`'+cmd, with "quotes" and a comma`);
        expect(adjRows[0][9]).toBe('-5.00'); // numbers are not text: no quote prefix
        expect(adjRows[1][11]).toBe(`'@SUM(A1:A9)`);
        expect(body.filter((x) => x[0] === 'ORDER')[0].slice(8, 11)).toEqual(['100.00', '90.00', '10.00']);
        const total = body.reduce((a, x) => a + toPaise(Number(x[9])), 0);
        expect(fromPaise(total)).toBe(187.5);
        expect((await adminGet(`/api/admin/settlements/${s.id}`)).body.data.settlement.netPayable).toBe(187.5);
        // no raw formula can start a line or a cell
        expect(r.text).toContain('"\'=HYPERLINK(""http://evil.example"",""pay, here"")\nsecond line"'); // guarded, quotes doubled, newline kept inside the quoted cell
        expect(r.text).not.toMatch(/(^|,|\n)"?=HYPERLINK/);
        expect(r.text).not.toMatch(/(^|,|\n)"?[+@]cmd|(^|,)@SUM/);
        expect((await adminGet(`/api/admin/settlements/${randomUUID()}/export.csv`)).status).toBe(404);
      } finally {
        await prisma.vendor.update({ where: { id: S1.vendorId }, data: { name: 'ST Kitchen 1' } });
      }
    });

    test('range export: one row per settlement, validated range, admins only', async () => {
      const a = await makeBatch();
      await makeBatch(S2.vendorId);
      await adminPost(`/api/admin/settlements/${a.id}/mark-paid`, { reference: 'UTR-RANGE-01' });
      const today = istDateString(new Date());
      const r = await adminGet(`/api/admin/settlements/export.csv?from=${today}&to=${today}`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(r.headers['content-disposition']).toBe(`attachment; filename="kraveo-settlements-${today}_${today}.csv"`);
      const rows = parseCsv(r.text).filter((x) => x.length > 1);
      expect(rows[0].slice(0, 7)).toEqual(['settlement_id', 'restaurant', 'batch', 'created_at_ist', 'period_start_ist', 'period_end_ist', 'status']);
      expect(rows).toHaveLength(3);
      const first = rows.find((x) => x[0] === a.id)!;
      expect(first[1]).toBe('ST Kitchen 1');
      expect(first.slice(6)).toEqual(expect.arrayContaining(['PAID', '2', '200.00', '180.00', '20.00', '0.00', '180.00', 'UTR-RANGE-01', 'UPI', 'kitchen1@upi', ADMIN.id]));
      const bank = rows.find((x) => x[1] === 'ST Kitchen 2')!;
      expect(bank).toEqual(expect.arrayContaining(['BANK', 'XXXXXX4321']));
      const none = parseCsv((await adminGet('/api/admin/settlements/export.csv?from=2020-01-01&to=2020-01-02')).text).filter((x) => x.length > 1);
      expect(none).toHaveLength(1); // header only
      expect((await adminGet('/api/admin/settlements/export.csv')).status).toBe(200); // default: last 31 days
      for (const q of ['from=nope', 'from=2026-10-10&to=2026-10-01', 'from=2024-01-01&to=2026-10-01']) expect((await adminGet(`/api/admin/settlements/export.csv?${q}`)).status).toBe(400);
      for (const t of [tStudent, tS1, tRider]) expect((await request.get('/api/admin/settlements/export.csv').set(H(t))).status).toBe(403);
      expect((await request.get('/api/admin/settlements/export.csv')).status).toBe(401);
    });
  });

  // =========================================================================================
  describe('admin list and detail', () => {
    test('list: shape, filters, pagination and the per-status summary', async () => {
      const a = await makeBatch();
      const b = await makeBatch(S2.vendorId);
      await adminPost(`/api/admin/settlements/${b.id}/mark-paid`, { reference: 'UTR-LIST-0001' });
      const all = await adminGet('/api/admin/settlements');
      expect(all.status).toBe(200);
      expect(Object.keys(all.body).sort()).toEqual(['count', 'data', 'page', 'pageSize', 'pages', 'success', 'summary', 'total']);
      expect(all.body).toMatchObject({ success: true, total: 2, page: 1, pageSize: 25, pages: 1, count: 2 });
      expect(all.body.summary).toEqual({ PENDING: { count: 1, netPayable: 180 }, ON_HOLD: { count: 0, netPayable: 0 }, PAID: { count: 1, netPayable: 180 }, CANCELLED: { count: 0, netPayable: 0 } });
      expect(all.body.data.map((s: any) => s.id).sort()).toEqual([a.id, b.id].sort());
      expect(Object.keys(all.body.data[0]).sort()).toEqual(['batchKey', 'commissionAmount', 'createdAt', 'createdBy', 'foodGross', 'hasPayoutDetails', 'id', 'netPayable', 'note', 'orderCount', 'paidAt', 'paidBy', 'paymentReference', 'payoutSnapshot', 'periodEnd', 'periodStart', 'status', 'updatedAt', 'vendorAmount', 'vendorId', 'vendorName', 'adjustmentTotal'].sort());
      expect((await adminGet('/api/admin/settlements?status=PAID')).body.data.map((s: any) => s.id)).toEqual([b.id]);
      expect((await adminGet('/api/admin/settlements?status=paid')).body.total).toBe(1);
      expect((await adminGet(`/api/admin/settlements?vendorId=${S1.vendorId}`)).body.data.map((s: any) => s.id)).toEqual([a.id]);
      const today = istDateString(new Date());
      expect((await adminGet(`/api/admin/settlements?from=${today}&to=${today}`)).body.total).toBe(2);
      expect((await adminGet('/api/admin/settlements?from=2020-01-01&to=2020-02-01')).body.total).toBe(0);
      const p1 = await adminGet('/api/admin/settlements?pageSize=1&page=1');
      const p2 = await adminGet('/api/admin/settlements?pageSize=1&page=2');
      expect([p1.body.pages, p1.body.count, p2.body.count, p1.body.total]).toEqual([2, 1, 1, 2]);
      expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
      for (const q of ['status=NOPE', 'vendorId=bad%20id', 'from=2026-13-40', 'status[]=PAID']) expect((await adminGet(`/api/admin/settlements?${q}`)).status).toBe(400);
    });

    test('detail: settlement, restaurant, snapshot AND live masked payout account, orders, per-dish lines that add up', async () => {
      const dishA = await prisma.menuItem.create({ data: { vendorId: S1.vendorId, name: 'Paneer Thali', price: 120, vendorPrice: 100, category: 'Thali', description: 'd', imageUrl: '' } });
      const dishB = await prisma.menuItem.create({ data: { vendorId: S1.vendorId, name: 'Paratha', price: 55, vendorPrice: 50, category: 'Bread', description: 'd', imageUrl: '' } });
      await mkOrder({ lines: [{ name: 'Paneer Thali', menuItemId: dishA.id, qty: 2, price: 120, vendorUnit: 100, commUnit: 20 }, { name: 'Paratha', menuItemId: dishB.id, qty: 1, price: 55, vendorUnit: 50, commUnit: 5 }] });
      await mkOrder({ discount: 10, lines: [{ name: 'Paneer Thali', menuItemId: dishA.id, qty: 1, price: 120, vendorUnit: 100, commUnit: 20 }, { name: 'Removed dish', menuItemId: null, qty: 3, price: 33.33, vendorUnit: 30.01, commUnit: 3.32 }] });
      const s = (await run()).body.data.created[0];
      expect(s).toMatchObject({ orderCount: 2, vendorAmount: sum([250, 100, 90.03]), commissionAmount: sum([45, 20, 9.96]) });
      await prisma.payoutAccount.update({ where: { userId: S1.id }, data: { method: 'UPI', upiId: 'changed@upi' } }); // the partner edits details later
      const r = await adminGet(`/api/admin/settlements/${s.id}`);
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(Object.keys(d).sort()).toEqual(['adjustments', 'dishes', 'orders', 'ordersTruncated', 'payoutAccount', 'settlement', 'vendor']);
      expect(d.vendor).toEqual({ id: S1.vendorId, name: 'ST Kitchen 1', userId: S1.id });
      expect(d.settlement.payoutSnapshot.destination).toBe('kitchen1@upi'); // frozen at creation
      expect(d.payoutAccount).toMatchObject({ userId: S1.id, method: 'UPI', upiId: 'changed@upi' }); // live
      expect(d.orders).toHaveLength(2);
      expect(Object.keys(d.orders[0]).sort()).toEqual(['commissionTotal', 'couponCode', 'deliveredAt', 'deliveryFee', 'discount', 'id', 'subtotal', 'taxAndPackaging', 'totalAmount', 'vendorSubtotal']);
      expect(d.ordersTruncated).toBe(false);
      expect(d.dishes).toEqual([
        { menuItemId: dishA.id, name: 'Paneer Thali', units: 3, vendorRevenue: 300, commission: 60 },
        { menuItemId: null, name: 'Removed dish', units: 3, vendorRevenue: 90.03, commission: 9.96 },
        { menuItemId: dishB.id, name: 'Paratha', units: 1, vendorRevenue: 50, commission: 5 },
      ]);
      expect(sum(d.dishes.map((x: any) => x.vendorRevenue))).toBe(d.settlement.vendorAmount);
      expect(sum(d.dishes.map((x: any) => x.commission))).toBe(d.settlement.commissionAmount);
      // a bank account is shown masked, never in full
      await mkOrder({ vendorId: S2.vendorId });
      const t = (await run({ vendorId: S2.vendorId })).body.data.created[0];
      const dt = (await adminGet(`/api/admin/settlements/${t.id}`)).body.data;
      expect(dt.payoutAccount).toMatchObject({ method: 'BANK', accountLast4: '4321', accountMasked: 'XXXXXX4321', ifsc: 'SBIN0001234' });
      expect(JSON.stringify(dt)).not.toMatch(/accountNumber|v1\.x\.y\.z/);
      // a restaurant that never saved details
      await mkOrder({ vendorId: S3.vendorId });
      const u = (await run({ vendorId: S3.vendorId })).body.data.created[0];
      expect((await adminGet(`/api/admin/settlements/${u.id}`)).body.data.payoutAccount).toBeNull();
      expect((await adminGet(`/api/admin/settlements/${randomUUID()}`)).status).toBe(404);
      expect((await adminGet('/api/admin/settlements/bad%20id')).status).toBe(400);
    });
  });

  // =========================================================================================
  describe('what a restaurant can see', () => {
    const FORBIDDEN = [
      'foodGross', 'commissionAmount', 'commission', 'commissionTotal', 'commissionUnit', 'commissionType', 'commissionValue', 'subtotal', 'totalAmount', 'deliveryFee',
      'taxAndPackaging', 'discount', 'couponCode', 'payoutSnapshot', 'hasPayoutDetails', 'note', 'createdBy', 'paidBy', 'batchKey', 'vendorSubtotal', 'price', 'customerId', 'feeBreakdown',
    ];
    const LIST_KEYS = ['adjustmentTotal', 'createdAt', 'id', 'netPayable', 'orderCount', 'paidAt', 'paymentReference', 'periodEnd', 'periodStart', 'status', 'vendorAmount'];
    const vget = (p: string, t: string) => request.get(p).set(H(t));

    test('the list and the detail carry only restaurant-side amounts', async () => {
      await mkOrder({ discount: 20, fee: 25, lines: [{ name: 'Thali', qty: 2, price: 117.77, vendorUnit: 99.11, commUnit: 18.66 }] });
      const s = (await run({ vendorId: S1.vendorId })).body.data.created[0];
      await adminPost(`/api/admin/settlements/${s.id}/adjustments`, { amount: -3, reason: 'Missing item credit' });
      await adminPost(`/api/admin/settlements/${s.id}/hold`, { note: 'INTERNAL: suspected fraud' });
      const list = await vget('/api/partner/settlements', tS1);
      expect(list.status).toBe(200);
      expect(Object.keys(list.body).sort()).toEqual(['count', 'data', 'page', 'pageSize', 'pages', 'success', 'total']);
      expect(list.body).toMatchObject({ total: 1, count: 1 });
      expect(Object.keys(list.body.data[0]).sort()).toEqual(LIST_KEYS);
      expect(list.body.data[0]).toMatchObject({ id: s.id, status: 'ON_HOLD', orderCount: 1, vendorAmount: 198.22, adjustmentTotal: -3, netPayable: 195.22, paidAt: null, paymentReference: null });
      const detail = await vget(`/api/partner/settlements/${s.id}`, tS1);
      expect(detail.status).toBe(200);
      expect(Object.keys(detail.body.data).sort()).toEqual([...LIST_KEYS, 'adjustments', 'dishes', 'orders', 'ordersTruncated'].sort());
      expect(detail.body.data.dishes).toEqual([{ name: 'Thali', units: 2, amount: 198.22 }]);
      expect(detail.body.data.orders).toEqual([expect.objectContaining({ amount: 198.22 })]);
      expect(Object.keys(detail.body.data.orders[0]).sort()).toEqual(['amount', 'deliveredAt', 'id']);
      expect(detail.body.data.adjustments).toEqual([{ amount: -3, reason: 'Missing item credit', createdAt: expect.any(String) }]);
      for (const res of [list, detail]) {
        const keys = keysDeep(res.body);
        for (const f of FORBIDDEN) expect(keys.has(f)).toBe(false);
        const text = JSON.stringify(res.body);
        for (const secret of ['235.54', '37.32', 'suspected fraud', 'kitchen1@upi', 'M-20']) expect(text).not.toContain(secret); // customer food total, commission, internal note, payout id, batch key
      }
    });

    test('only the owner sees a settlement: other restaurants, cancelled ones, other roles and not-yet-approved partners are refused', async () => {
      const mine = await makeBatch();
      const theirs = await makeBatch(S2.vendorId);
      const cancelled = await makeBatch(S1.vendorId);
      await adminPost(`/api/admin/settlements/${cancelled.id}/cancel`);
      const list = await vget('/api/partner/settlements', tS1);
      expect(list.body.data.map((x: any) => x.id)).toEqual([mine.id]);
      expect((await vget('/api/partner/settlements', tS2)).body.data.map((x: any) => x.id)).toEqual([theirs.id]);
      for (const id of [theirs.id, cancelled.id, randomUUID()]) expect((await vget(`/api/partner/settlements/${id}`, tS1)).status).toBe(404);
      expect((await vget(`/api/partner/settlements/${mine.id}`, tS1)).status).toBe(200);
      expect((await vget('/api/partner/settlements/bad%20id', tS1)).status).toBe(400);
      for (const t of [tStudent, tAdmin, tRider]) {
        expect((await vget('/api/partner/settlements', t)).status).toBe(403);
        expect((await vget(`/api/partner/settlements/${mine.id}`, t)).status).toBe(403);
      }
      expect((await request.get('/api/partner/settlements')).status).toBe(401);
      const pending = await vget('/api/partner/settlements', tS4);
      expect([pending.status, pending.body.code]).toEqual([403, 'PARTNER_NOT_APPROVED']);
      // read only: the restaurant cannot write anything here
      for (const m of ['post', 'put', 'patch', 'delete'] as const) expect((await (request as any)[m]('/api/partner/settlements').set(H(tS1)).send({})).status).toBe(404);
      expect((await request.post(`/api/admin/settlements/${mine.id}/mark-paid`).set(H(tS1)).send({ reference: 'MY-OWN-REF-1' })).status).toBe(403);
      // pagination
      await mkOrder();
      await run({ vendorId: S1.vendorId });
      const page = await vget('/api/partner/settlements?pageSize=1&page=2', tS1);
      expect([page.body.total, page.body.pages, page.body.count]).toEqual([2, 2, 1]);
    });
  });

  // =========================================================================================
  describe('settings and the payout provider hook', () => {
    const put = (b: unknown) => request.put('/api/admin/settings/settlement').set(H(tAdmin)).send(b as any);

    test('the settlement group is validated: HH:MM, mode, autoCreate, holdDays 0..30, AUTO_PAYOUT refused while no provider is enabled', async () => {
      const cases: [unknown, string][] = [
        [{ time: '25:00' }, 'time'], [{ time: '9:00' }, 'time'], [{ time: '22:60' }, 'time'], [{ time: 2200 }, 'time'], [{ time: '22:00:00' }, 'time'],
        [{ mode: 'AUTO_PAYOUT' }, 'mode'], [{ mode: 'WIRE' }, 'mode'], [{ autoCreate: 'yes' }, 'autoCreate'], [{ autoCreate: 1 }, 'autoCreate'],
        [{ holdDays: -1 }, 'holdDays'], [{ holdDays: 31 }, 'holdDays'], [{ holdDays: 1.5 }, 'holdDays'], [{ holdDays: '2' }, 'holdDays'], [{ nonsense: true }, 'nonsense'],
      ];
      for (const [body, field] of cases) {
        const r = await put(body);
        expect([r.status, r.body.field]).toEqual([400, field]);
      }
      const auto = await put({ mode: 'AUTO_PAYOUT' });
      expect(auto.body.message).toMatch(/not available yet.*MANUAL_PAYOUT/);
      expect((await adminGet('/api/admin/settings/settlement')).body.data).toMatchObject({ isDefault: true, value: { time: '22:00', mode: 'MANUAL_PAYOUT', autoCreate: true, holdDays: 0 } });
      const ok = await put({ time: '21:15', holdDays: 30, autoCreate: false });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ changed: true, data: { group: 'settlement', isDefault: false, value: { time: '21:15', mode: 'MANUAL_PAYOUT', autoCreate: false, holdDays: 30 } } });
      expect((await put({ holdDays: 0, time: '00:00' })).status).toBe(200);
      expect((await audits('SETTINGS_UPDATED')).length).toBe(2);
      for (const t of [tStudent, tS1, tRider]) expect((await request.put('/api/admin/settings/settlement').set(H(t)).send({ holdDays: 1 })).status).toBe(403);
    });

    test('providers: manual always enabled, razorpayx reports "not configured"', async () => {
      const r = await adminGet('/api/admin/payout-providers');
      expect(r.body).toEqual({ success: true, data: [{ name: 'manual', enabled: true, reason: null }, { name: 'razorpayx', enabled: false, reason: 'RazorpayX payouts are not configured.' }] });
      expect((await request.get('/api/admin/payout-providers').set(H(tS1))).status).toBe(403);
      const { manualProvider, razorpayxProvider } = await import('../../src/services/payoutProvider');
      expect((await razorpayxProvider.send({ id: 'x', netPayable: 1 })).code).toBe('PROVIDER_NOT_CONFIGURED');
      expect((await manualProvider.send({ id: 'x', netPayable: 1 })).code).toBe('MANUAL_PAYOUT');
    });
  });

  // =========================================================================================
  describe('migration and schema sanity', () => {
    test('Order.settlementId is a real foreign key (ON DELETE SET NULL), batches are unique per restaurant and key', async () => {
      const fk = await prisma.$queryRaw<{ del: string; validated: boolean }[]>`SELECT confdeltype::text AS del, convalidated AS validated FROM pg_constraint WHERE conname = 'Order_settlementId_fkey'`;
      expect(fk).toEqual([{ del: 'n', validated: true }]);
      const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'Settlement_vendorId_batchKey_key'`;
      expect(idx[0].indexdef).toMatch(/UNIQUE.*\("vendorId", "batchKey"\)/);
      // an order cannot point at a settlement that does not exist
      const o = await mkOrder();
      await expect(prisma.order.update({ where: { id: o.id }, data: { settlementId: randomUUID() } })).rejects.toBeDefined();
      // deleting a settlement frees its orders instead of failing or deleting them
      const s = await makeBatch();
      await prisma.$executeRaw`DELETE FROM "Settlement" WHERE "id" = ${s.id}`;
      expect(await prisma.order.count({ where: { vendorId: S1.vendorId, settlementId: null } })).toBe(3);
    });

    test('the bank account number has no plain column; the migration file is additive', async () => {
      const cols = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'PayoutAccount'`)
        .map((c) => c.column_name);
      expect(cols).toEqual(expect.arrayContaining(['accountNumberEnc', 'accountLast4', 'verifiedAt']));
      expect(cols.filter((c) => /number/i.test(c))).toEqual(['accountNumberEnc']);
      const sql = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261010_settlements_payouts/migration.sql'), 'utf8');
      expect(sql).toMatch(/CREATE TABLE "Settlement"/);
      expect(sql).toMatch(/NOT VALID/);
      expect(sql).toMatch(/ON DELETE SET NULL/);
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|TYPE)|TRUNCATE|DELETE FROM|RENAME/i);
      const updates = code.split('\n').filter((l) => /^\s*UPDATE\s/i.test(l));
      expect(updates).toEqual(['UPDATE "Order" SET "settlementId" = NULL WHERE "settlementId" IS NOT NULL;']);
      // every earlier migration is untouched by this change (new folder only)
      const dirs = fs.readdirSync(path.join(__dirname, '../../prisma/migrations')).filter((d) => !d.endsWith('.toml'));
      expect(dirs).toContain('20261010_settlements_payouts');
      expect(dirs.sort().at(-1)).toBe('20261011_order_groups'); // Docs/22 added the next (additive) migration after this one
    });
  });

  // =========================================================================================
  describe('roles, audit and rate limits', () => {
    test('every admin settlement endpoint refuses non-admins (403) and anonymous callers (401)', async () => {
      const s = await makeBatch();
      const id = s.id;
      const calls: [string, string, unknown?][] = [
        ['get', '/api/admin/settlements'], ['get', `/api/admin/settlements/${id}`], ['get', `/api/admin/settlements/${id}/export.csv`], ['get', '/api/admin/settlements/export.csv'],
        ['post', '/api/admin/settlements/run', {}], ['post', `/api/admin/settlements/${id}/mark-paid`, { reference: 'UTR-ROLE-0001' }], ['post', `/api/admin/settlements/${id}/hold`, {}],
        ['post', `/api/admin/settlements/${id}/release`, {}], ['post', `/api/admin/settlements/${id}/adjustments`, { amount: 1, reason: 'role test' }], ['post', `/api/admin/settlements/${id}/cancel`, {}],
      ];
      for (const [m, p, b] of calls) {
        for (const t of [tStudent, tS1, tS2, tRider]) {
          const r = await (request as any)[m](p).set(H(t)).send(b ?? {});
          expect([m, p, r.status]).toEqual([m, p, 403]);
        }
        const anon = await (request as any)[m](p).send(b ?? {});
        expect([m, p, anon.status]).toEqual([m, p, 401]);
      }
      const row = await prisma.settlement.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PENDING');
      expect(await prisma.settlementAdjustment.count({ where: { settlementId: id } })).toBe(0);
    });

    test('every admin change leaves an audit row without secrets', async () => {
      const s = await makeBatch();
      await adminPost(`/api/admin/settlements/${s.id}/adjustments`, { amount: 2, reason: 'audit check' });
      await adminPost(`/api/admin/settlements/${s.id}/hold`);
      await adminPost(`/api/admin/settlements/${s.id}/release`);
      await adminPost(`/api/admin/settlements/${s.id}/mark-paid`, { reference: 'UTR-AUDIT-001' });
      const t = await makeBatch(S2.vendorId);
      await adminPost(`/api/admin/settlements/${t.id}/cancel`);
      const rows = await prisma.adminAuditLog.findMany({ where: { targetType: 'SETTLEMENT' } });
      expect(rows.map((r) => r.action).sort()).toEqual(['SETTLEMENT_ADJUSTED', 'SETTLEMENT_CANCELLED', 'SETTLEMENT_HELD', 'SETTLEMENT_PAID', 'SETTLEMENT_RELEASED', 'SETTLEMENT_RUN', 'SETTLEMENT_RUN']);
      for (const r of rows.filter((x) => x.action !== 'SETTLEMENT_RUN')) {
        expect(r.targetId).toBe(r.action === 'SETTLEMENT_CANCELLED' ? t.id : s.id);
        expect(r.summary).toContain(ADMIN.id);
      }
    });

    test('rate limits on runs and on settlement changes', async () => {
      process.env.RL_ADMIN_SETTLEMENT_RUN_MAX = '2';
      process.env.RL_ADMIN_SETTLEMENT_WRITE_MAX = '2';
      expect([(await run()).status, (await run()).status, (await run()).status]).toEqual([200, 200, 429]);
      const s = await makeBatch().catch(() => null);
      expect(s).toBeNull(); // the run endpoint is limited, so makeBatch's run was refused
      const row = await prisma.settlement.create({ data: { vendorId: S1.vendorId, batchKey: 'M-rl', periodStart: new Date(), periodEnd: new Date(), orderCount: 0, foodGross: 0, vendorAmount: 100, commissionAmount: 0, netPayable: 100, createdBy: 'x' } });
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await adminPost(`/api/admin/settlements/${row.id}/${i % 2 ? 'release' : 'hold'}`)).status);
      expect(codes).toEqual([200, 200, 429]);
      const limited = await adminPost(`/api/admin/settlements/${row.id}/hold`);
      expect(limited.body.code).toBe('RATE_LIMITED');
    });
  });
});
