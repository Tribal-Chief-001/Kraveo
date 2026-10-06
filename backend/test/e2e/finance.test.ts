/**
 * Finance analytics and the rider payout ledger (Docs/21 section 5, phase 2). Real PostgreSQL, real HTTP endpoints.
 * Every number below is computed by hand from the fixture (see the table in `beforeAll`), including a coupon order, a refunded order,
 * a delivered-then-refunded order and orders that fall on the other side of the India midnight.
 */
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { Role } from '@prisma/client';
import { startTestServer, stopTestServer, TestServerInstance } from '../harness/app';
import { prisma, seedTestDatabase, cleanTestOrders, cleanTestUsers } from '../harness/db';
import { getStudentToken, getVendorToken, getDriverToken, getAdminToken, getAuthHeader } from '../harness/auth';
import { __resetRateLimits } from '../../src/middleware/rateLimit';
import { invalidateSettingsCache } from '../../src/services/settings';
import { createSettlements } from '../../src/services/settlement';
import { fromPaise, toPaise } from '../../src/services/pricing';
import { addIstDays, istDateString, istInstant } from '../../src/utils/time';

jest.setTimeout(90_000);

const STUDENT = { id: 'usr-1', phone: '+91 9876543210' };
const ADMIN = { id: 'usr-5', phone: '+91 9876543214' };
const F1 = { id: 'usr-fn-v1', phone: '+91 9999891111', vendorId: 'fn-ven-1' };
const F2 = { id: 'usr-fn-v2', phone: '+91 9999892222', vendorId: 'fn-ven-2' };
const R1 = { id: 'usr-fn-d1', phone: '+91 9999893333' };
const R2 = { id: 'usr-fn-d2', phone: '+91 9999894444' };
const VENDORS = [F1.vendorId, F2.vendorId];
const H = (t: string) => getAuthHeader(t);
const tAdmin = getAdminToken(ADMIN.id, ADMIN.phone);
const tStudent = getStudentToken(STUDENT.id, STUDENT.phone);
const tF1 = getVendorToken(F1.id, F1.phone);
const tR1 = getDriverToken(R1.id, R1.phone);

const TODAY = istDateString(new Date());
const D1 = addIstDays(TODAY, -1); // yesterday
const D2 = addIstDays(TODAY, -2);
const D3 = addIstDays(TODAY, -3);
const D10 = addIstDays(TODAY, -10);
const sum = (xs: number[]) => fromPaise(xs.reduce((a, x) => a + toPaise(x), 0));

describe('Finance analytics and rider payouts (phase 2)', () => {
  let server: TestServerInstance;
  let request: ReturnType<typeof supertest>;
  const get = (p: string, t = tAdmin) => request.get(p).set(H(t));
  const q = (from = D3, to = TODAY) => `from=${from}&to=${to}`;
  let thali: string, paratha: string, naan: string;
  let o: Record<string, string> = {};
  let settlementId = '';

  type Line = { name: string; id: string | null; qty: number; price: number; vendorUnit: number; commUnit: number };
  const mk = async (key: string, spec: { vendorId: string; status?: any; paymentStatus?: any; at: Date | null; driverId?: string | null; discount?: number; lines: Line[]; cancelledAt?: Date | null; coupon?: string }) => {
    const subtotal = sum(spec.lines.map((l) => l.price * l.qty));
    const vendorSubtotal = sum(spec.lines.map((l) => l.vendorUnit * l.qty));
    const commissionTotal = sum(spec.lines.map((l) => l.commUnit * l.qty));
    const discount = spec.discount ?? 0;
    const order = await prisma.order.create({
      data: {
        customerId: STUDENT.id, vendorId: spec.vendorId, driverId: spec.driverId ?? null, status: spec.status ?? 'DELIVERED', paymentStatus: spec.paymentStatus ?? 'PAID',
        dropoffHostel: 'Block 2', subtotal, vendorSubtotal, commissionTotal, deliveryFee: 25, discount, couponCode: spec.coupon ?? null,
        totalAmount: fromPaise(toPaise(subtotal) + 2500 - toPaise(discount)), deliveredAt: spec.status === 'CANCELLED' || spec.status === 'PICKED_UP' ? null : spec.at, cancelledAt: spec.cancelledAt ?? null,
        items: { create: spec.lines.map((l) => ({ name: l.name, menuItemId: l.id, quantity: l.qty, price: l.price, vendorUnitPrice: l.vendorUnit, commissionUnit: l.commUnit })) },
      } as any,
    });
    o[key] = order.id;
    return order;
  };

  beforeAll(async () => {
    await cleanTestOrders();
    await prisma.settlement.deleteMany({});
    await prisma.riderPayout.deleteMany({});
    await cleanTestUsers();
    await seedTestDatabase();
    await prisma.appSetting.deleteMany({});
    invalidateSettingsCache();
    for (const u of [
      { id: F1.id, name: 'FN Owner One', phone: F1.phone, role: Role.VENDOR }, { id: F2.id, name: 'FN Owner Two', phone: F2.phone, role: Role.VENDOR },
      { id: R1.id, name: 'FN Rider One', phone: R1.phone, role: Role.DRIVER }, { id: R2.id, name: 'FN Rider Two', phone: R2.phone, role: Role.DRIVER },
    ]) await prisma.user.upsert({ where: { id: u.id }, update: u, create: u });
    await prisma.driverPartner.upsert({ where: { userId: R1.id }, update: {}, create: { userId: R1.id, name: 'FN Rider One', phone: R1.phone, runnerCode: 'RUN-FN01', vehicleType: 'Bike' } });
    for (const [v, n] of [[F1, 'Alpha Kitchen'], [F2, 'Beta Kitchen']] as const) {
      await prisma.vendor.upsert({
        where: { id: v.vendorId }, update: { userId: v.id, name: n, approvalStatus: 'APPROVED' },
        create: { id: v.vendorId, userId: v.id, name: n, category: 'Test', address: 'Gate', bannerImage: '', approvalStatus: 'APPROVED' },
      });
    }
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: VENDORS } } });
    const dish = (vendorId: string, name: string, price: number, vendorPrice: number) =>
      prisma.menuItem.create({ data: { vendorId, name, price, vendorPrice, category: 'T', description: 'd', imageUrl: '' } });
    thali = (await dish(F1.vendorId, 'Thali', 120, 100)).id;
    paratha = (await dish(F1.vendorId, 'Paratha', 55, 50)).id;
    naan = (await dish(F2.vendorId, 'Naan', 50, 45)).id;
    const T: Line = { name: 'Thali', id: thali, qty: 1, price: 120, vendorUnit: 100, commUnit: 20 };
    const P: Line = { name: 'Paratha', id: paratha, qty: 1, price: 55, vendorUnit: 50, commUnit: 5 };
    const N: Line = { name: 'Naan', id: naan, qty: 1, price: 50, vendorUnit: 45, commUnit: 5 };
    /*
     *  key  restaurant  delivered (IST)    rider  lines            subtotal vendor comm fee disc  total
     *  O1   F1          D2 10:00           R1     2 Thali + 1 Par  295      250    45   25  0     320
     *  O2   F1          D2 23:30           R2     1 Thali          120      100    20   25  20    125   (coupon)
     *  O3   F2          D1 00:15 (IST)     R1     3 Naan           150      135    15   25  0     175   (UTC date is still D2)
     *  O4   F2          D1 12:00           R2     1 Naan           50       45     5    25  10    65    (coupon)
     *  O5   F1          TODAY 09:00        R1     2 Paratha        110      100    10   25  0     135
     *  O6   F1          cancelled D1 15:00 -      1 Thali          120      100    20   25  0     145   REFUNDED (cancelled)
     *  O7   F2          delivered D1 13:00 -      1 Naan(x3)       150      135    15   25  0     175   REFUNDED after delivery
     *  O8   F1          cancelled unpaid   -      1 Thali          -        -      -    -   -     -     never paid: ignored
     *  O9   F1          D10 10:00          R1     1 Thali          120      100    20   25  0     145   outside the range
     *  O10  F2          picked up, paid    -      1 Naan           -        -      -    -   -     -     not delivered: not revenue
     */
    await mk('O1', { vendorId: F1.vendorId, at: istInstant(D2, '10:00'), driverId: R1.id, lines: [{ ...T, qty: 2 }, P] });
    await mk('O2', { vendorId: F1.vendorId, at: istInstant(D2, '23:30'), driverId: R2.id, discount: 20, coupon: 'KRAVEO20', lines: [T] });
    await mk('O3', { vendorId: F2.vendorId, at: istInstant(D1, '00:15'), driverId: R1.id, lines: [{ ...N, qty: 3 }] });
    await mk('O4', { vendorId: F2.vendorId, at: istInstant(D1, '12:00'), driverId: R2.id, discount: 10, coupon: 'WELCOME10', lines: [N] });
    await mk('O5', { vendorId: F1.vendorId, at: istInstant(TODAY, '09:00'), driverId: R1.id, lines: [{ ...P, qty: 2 }] });
    await mk('O6', { vendorId: F1.vendorId, status: 'CANCELLED', paymentStatus: 'REFUNDED', at: null, cancelledAt: istInstant(D1, '15:00'), lines: [T] });
    await mk('O7', { vendorId: F2.vendorId, paymentStatus: 'REFUNDED', at: istInstant(D1, '13:00'), driverId: R1.id, lines: [{ ...N, qty: 3 }] });
    await mk('O8', { vendorId: F1.vendorId, status: 'CANCELLED', paymentStatus: 'PENDING', at: null, cancelledAt: istInstant(D1, '16:00'), lines: [T] });
    await mk('O9', { vendorId: F1.vendorId, at: istInstant(D10, '10:00'), driverId: R1.id, lines: [T] });
    await mk('O10', { vendorId: F2.vendorId, status: 'PICKED_UP', at: null, lines: [N] });
    // F1's orders up to the end of D2 are settled (O1, O2 and the older O9); O5 (today) is not.
    server = await startTestServer(0);
    request = supertest(server.app);
    const made = await createSettlements({ vendorId: F1.vendorId, until: istInstant(D2, '23:59'), createdBy: 'test' });
    expect(made.created).toHaveLength(1);
    settlementId = made.created[0].id;
    expect(made.created[0]).toMatchObject({ orderCount: 3, vendorAmount: 450 }); // O1 + O2 + the older O9 (everything due up to D2 23:59)
  });

  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    __resetRateLimits();
  });

  afterAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('RL_')) delete process.env[k];
    await prisma.riderPayout.deleteMany({});
    await prisma.order.deleteMany({ where: { vendorId: { in: VENDORS } } });
    await prisma.settlement.deleteMany({ where: { vendorId: { in: VENDORS } } });
    await prisma.menuItem.deleteMany({ where: { vendorId: { in: VENDORS } } });
    await prisma.driverPartner.deleteMany({ where: { userId: R1.id } });
    await prisma.vendor.deleteMany({ where: { id: { in: VENDORS } } });
    await cleanTestOrders();
    await cleanTestUsers();
    await stopTestServer(server);
    await prisma.$disconnect();
  });

  // =========================================================================================
  test('summary: hand-computed totals; coupons reduce platform revenue only; refunds counted apart; the identity customerPaid = vendor + platform holds', async () => {
    const r = await get(`/api/admin/finance/summary?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Object.keys(r.body.data).sort()).toEqual(['commission', 'customerPaid', 'discounts', 'feesCollected', 'foodGross', 'orders', 'paidOutAmount', 'platformRevenue', 'range', 'refunds', 'settledAmount', 'unsettledAmount', 'vendorAmount']);
    expect(r.body.data).toEqual({
      range: { from: D3, to: TODAY, days: 4 },
      orders: 5,
      foodGross: 725,
      vendorAmount: 630,
      commission: 95,
      feesCollected: 125,
      discounts: 30,
      platformRevenue: 190, // 95 + 125 - 30
      customerPaid: 820,
      refunds: { count: 2, amount: 320 }, // O6 145 (cancelled) + O7 175 (delivered, then refunded)
      settledAmount: 350, // O1 250 + O2 100 (the settlement of D2)
      unsettledAmount: 280, // O3 135 + O4 45 + O5 100
      paidOutAmount: 0,
    });
    expect(r.body.data.vendorAmount + r.body.data.platformRevenue).toBe(r.body.data.customerPaid);
    expect(r.body.data.vendorAmount + r.body.data.commission).toBe(r.body.data.foodGross);
  });

  test('summary follows the settlement: marking it paid moves its amount to paidOutAmount', async () => {
    const detail = (await get(`/api/admin/settlements/${settlementId}`)).body.data;
    expect(detail.settlement).toMatchObject({ orderCount: 3, vendorAmount: 450 }); // O9 is outside the report window below
    const paid = await request.post(`/api/admin/settlements/${settlementId}/mark-paid`).set(H(tAdmin)).send({ reference: 'UTR-FIN-0001' });
    expect(paid.status).toBe(200);
    const s = (await get(`/api/admin/finance/summary?${q()}`)).body.data;
    expect([s.settledAmount, s.unsettledAmount, s.paidOutAmount]).toEqual([350, 280, 350]);
    // a window that only has the unsettled day
    const today = (await get(`/api/admin/finance/summary?${q(TODAY, TODAY)}`)).body.data;
    expect(today).toMatchObject({ orders: 1, foodGross: 110, vendorAmount: 100, commission: 10, feesCollected: 25, discounts: 0, platformRevenue: 35, customerPaid: 135, refunds: { count: 0, amount: 0 }, settledAmount: 0, unsettledAmount: 100 });
  });

  test('India days: an order at 00:15 IST belongs to the IST day, not the UTC day; the range ends at the end of the IST day', async () => {
    // O3 was delivered at 00:15 IST of D1 = 18:45 UTC of D2. A UTC-based report would put it in D2.
    const d1 = (await get(`/api/admin/finance/summary?${q(D1, D1)}`)).body.data;
    expect(d1).toMatchObject({ orders: 2, foodGross: 200, vendorAmount: 180, commission: 20, feesCollected: 50, discounts: 10, platformRevenue: 60, refunds: { count: 2, amount: 320 } });
    const d2 = (await get(`/api/admin/finance/summary?${q(D2, D2)}`)).body.data;
    expect(d2).toMatchObject({ orders: 2, foodGross: 415, vendorAmount: 350, commission: 65, feesCollected: 50, discounts: 20, platformRevenue: 95, refunds: { count: 0, amount: 0 } }); // O2 at 23:30 IST stays on D2
    expect((await get(`/api/admin/finance/summary?${q(D3, D3)}`)).body.data).toMatchObject({ orders: 0, foodGross: 0, platformRevenue: 0, refunds: { count: 0, amount: 0 } });
    const wide = (await get(`/api/admin/finance/summary?${q(D10, TODAY)}`)).body.data;
    expect(wide).toMatchObject({ orders: 6, foodGross: 845, vendorAmount: 730, platformRevenue: 190 + 45 }); // O9 (D10) joins: commission 20, fee 25
  });

  test('by-day: one row per IST day (zero filled), refunds on the day they happened, rows add up to the summary', async () => {
    const r = await get(`/api/admin/finance/by-day?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body.range).toEqual({ from: D3, to: TODAY, days: 4 });
    expect(r.body.data.map((d: any) => d.date)).toEqual([D3, D2, D1, TODAY]);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['commission', 'date', 'discounts', 'feesCollected', 'foodGross', 'orders', 'platformRevenue', 'refunds', 'vendorAmount']);
    const [a, b, c, d] = r.body.data;
    expect(a).toMatchObject({ orders: 0, foodGross: 0, platformRevenue: 0, refunds: { count: 0, amount: 0 } });
    expect(b).toMatchObject({ date: D2, orders: 2, foodGross: 415, vendorAmount: 350, commission: 65, feesCollected: 50, discounts: 20, platformRevenue: 95, refunds: { count: 0, amount: 0 } });
    expect(c).toMatchObject({ date: D1, orders: 2, foodGross: 200, vendorAmount: 180, commission: 20, feesCollected: 50, discounts: 10, platformRevenue: 60, refunds: { count: 2, amount: 320 } });
    expect(d).toMatchObject({ date: TODAY, orders: 1, foodGross: 110, vendorAmount: 100, commission: 10, feesCollected: 25, discounts: 0, platformRevenue: 35 });
    expect(sum(r.body.data.map((x: any) => x.platformRevenue))).toBe(190);
    expect(r.body.data.reduce((n: number, x: any) => n + x.orders, 0)).toBe(5);
  });

  test('by-restaurant: per restaurant, ordered by what it earned, with unsettled amount and refunds', async () => {
    const r = await get(`/api/admin/finance/by-restaurant?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(100);
    expect(r.body.data).toEqual([
      { vendorId: F1.vendorId, vendorName: 'Alpha Kitchen', orders: 3, foodGross: 525, vendorAmount: 450, commission: 75, feesCollected: 75, discounts: 20, platformRevenue: 130, unsettledAmount: 100, refunds: { count: 1, amount: 145 } },
      { vendorId: F2.vendorId, vendorName: 'Beta Kitchen', orders: 2, foodGross: 200, vendorAmount: 180, commission: 20, feesCollected: 50, discounts: 10, platformRevenue: 60, unsettledAmount: 180, refunds: { count: 1, amount: 175 } },
    ]);
    expect((await get(`/api/admin/finance/by-restaurant?${q()}&limit=1`)).body.data).toHaveLength(1);
    for (const bad of ['limit=0', 'limit=201', 'limit=abc']) expect((await get(`/api/admin/finance/by-restaurant?${q()}&${bad}`)).status).toBe(400);
  });

  test('by-dish: units, restaurant revenue and commission per dish and restaurant; top N and sort; adds up to the summary', async () => {
    const r = await get(`/api/admin/finance/by-dish?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ top: 20, sort: 'units' });
    expect(r.body.data).toEqual([
      { menuItemId: naan, name: 'Naan', vendorId: F2.vendorId, vendorName: 'Beta Kitchen', units: 4, customerRevenue: 200, vendorRevenue: 180, commission: 20 },
      { menuItemId: thali, name: 'Thali', vendorId: F1.vendorId, vendorName: 'Alpha Kitchen', units: 3, customerRevenue: 360, vendorRevenue: 300, commission: 60 },
      { menuItemId: paratha, name: 'Paratha', vendorId: F1.vendorId, vendorName: 'Alpha Kitchen', units: 3, customerRevenue: 165, vendorRevenue: 150, commission: 15 },
    ]);
    expect(sum(r.body.data.map((x: any) => x.vendorRevenue))).toBe(630);
    expect(sum(r.body.data.map((x: any) => x.commission))).toBe(95);
    expect((await get(`/api/admin/finance/by-dish?${q()}&sort=vendorRevenue`)).body.data.map((x: any) => x.name)).toEqual(['Thali', 'Naan', 'Paratha']);
    expect((await get(`/api/admin/finance/by-dish?${q()}&sort=commission&top=2`)).body.data.map((x: any) => x.name)).toEqual(['Thali', 'Naan']);
    expect((await get(`/api/admin/finance/by-dish?${q()}&vendorId=${F1.vendorId}`)).body.data.map((x: any) => x.name)).toEqual(['Thali', 'Paratha']);
    for (const bad of ['sort=price', 'top=0', 'top=201', 'vendorId=bad%20id']) expect((await get(`/api/admin/finance/by-dish?${q()}&${bad}`)).status).toBe(400);
  });

  test('riders: deliveries per rider per IST day, payout ledger totals', async () => {
    const before = await get(`/api/admin/finance/riders?${q()}`);
    expect(before.status).toBe(200);
    expect(before.body.data.map((x: any) => [x.driverUserId, x.deliveries])).toEqual([[R1.id, 3], [R2.id, 2]]);
    expect(before.body.data[0]).toEqual({
      driverUserId: R1.id, name: 'FN Rider One', runnerCode: 'RUN-FN01', deliveries: 3,
      byDay: [{ date: D2, deliveries: 1 }, { date: D1, deliveries: 1 }, { date: TODAY, deliveries: 1 }],
      payouts: { count: 0, total: 0, lastAt: null },
    });
    expect(before.body.data[1]).toMatchObject({ name: 'FN Rider Two', runnerCode: null, byDay: [{ date: D2, deliveries: 1 }, { date: D1, deliveries: 1 }] });
    expect(before.body.totals).toEqual({ riders: 2, deliveries: 5, payoutTotal: 0 });
    const p1 = await request.post('/api/admin/rider-payouts').set(H(tAdmin)).send({ driverUserId: R1.id, amount: 500.5, method: 'UPI', reference: 'UPI-RIDER-01', periodStart: D2, periodEnd: D1, note: 'weekly' });
    const p2 = await request.post('/api/admin/rider-payouts').set(H(tAdmin)).send({ driverUserId: R1.id, amount: 200, method: 'CASH' });
    expect([p1.status, p2.status]).toEqual([201, 201]);
    const after = await get(`/api/admin/finance/riders?${q()}`);
    expect(after.body.data[0].payouts).toMatchObject({ count: 2, total: 700.5, lastAt: expect.any(String) });
    expect(after.body.totals).toEqual({ riders: 2, deliveries: 5, payoutTotal: 700.5 });
    // a rider paid in the window but with no delivery in it still shows up
    await request.post('/api/admin/rider-payouts').set(H(tAdmin)).send({ driverUserId: R2.id, amount: 50, method: 'BANK', reference: 'BANK-R2-01' });
    expect((await get(`/api/admin/finance/riders?${q(TODAY, TODAY)}`)).body.data.map((x: any) => [x.driverUserId, x.deliveries, x.payouts.count])).toEqual([[R1.id, 1, 2], [R2.id, 0, 1]]);
    expect((await get(`/api/admin/finance/riders?${q()}&limit=1`)).body.data).toHaveLength(1);
  });

  test('date range rules: default last 7 India days, at most 366, valid dates only, admins only', async () => {
    const def = await get('/api/admin/finance/summary');
    expect(def.body.data.range).toEqual({ from: addIstDays(TODAY, -6), to: TODAY, days: 7 });
    expect(def.body.data.orders).toBe(5);
    expect((await get(`/api/admin/finance/by-day?from=${addIstDays(TODAY, -365)}&to=${TODAY}`)).body.data).toHaveLength(366);
    for (const bad of [`from=${addIstDays(TODAY, -366)}&to=${TODAY}`, `from=${TODAY}&to=${D3}`, 'from=2026-02-30', 'to=yesterday', 'from=2026-1-1', `from[]=${D3}`]) {
      for (const ep of ['summary', 'by-restaurant', 'by-dish', 'by-day', 'riders']) {
        const r = await get(`/api/admin/finance/${ep}?${bad}`);
        expect([ep, bad, r.status]).toEqual([ep, bad, 400]);
      }
    }
    for (const ep of ['summary', 'by-restaurant', 'by-dish', 'by-day', 'riders']) {
      for (const t of [tStudent, tF1, tR1]) expect((await get(`/api/admin/finance/${ep}`, t)).status).toBe(403);
      expect((await request.get(`/api/admin/finance/${ep}`)).status).toBe(401);
    }
  });

  test('a restaurant can never read finance numbers', async () => {
    for (const p of ['/api/admin/finance/summary', '/api/admin/finance/by-dish', '/api/admin/rider-payouts']) expect((await get(p, tF1)).status).toBe(403);
  });

  // =========================================================================================
  describe('rider payout ledger', () => {
    const post = (b: unknown) => request.post('/api/admin/rider-payouts').set(H(tAdmin)).send(b as any);
    const good = { driverUserId: R2.id, amount: 120.25, method: 'UPI', reference: 'REF-LEDGER-1' };
    beforeEach(async () => { await prisma.riderPayout.deleteMany({}); await prisma.adminAuditLog.deleteMany({}); });

    test('records a payout and answers the exact shape; lists with filters and a total', async () => {
      const r = await post({ ...good, periodStart: D3, periodEnd: D1, note: 'Week 41' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ success: true, changed: true, message: 'Payout recorded.' });
      expect(Object.keys(r.body.data).sort()).toEqual(['amount', 'createdAt', 'createdBy', 'driverName', 'driverUserId', 'id', 'method', 'note', 'periodEnd', 'periodStart', 'reference']);
      expect(r.body.data).toMatchObject({ driverUserId: R2.id, driverName: 'FN Rider Two', amount: 120.25, method: 'UPI', reference: 'REF-LEDGER-1', note: 'Week 41', createdBy: ADMIN.id });
      expect(r.body.data.periodStart).toBe(istInstant(D3, '00:00').toISOString());
      expect(r.body.data.periodEnd).toBe(new Date(istInstant(addIstDays(D1, 1), '00:00').getTime() - 1).toISOString()); // the end of the IST day D1
      await post({ driverUserId: R1.id, amount: 80, method: 'CASH' });
      const list = await get('/api/admin/rider-payouts');
      expect(Object.keys(list.body).sort()).toEqual(['count', 'data', 'page', 'pageSize', 'pages', 'success', 'total', 'totalAmount']);
      expect(list.body).toMatchObject({ total: 2, totalAmount: 200.25, count: 2, page: 1, pages: 1 });
      expect((await get(`/api/admin/rider-payouts?driverUserId=${R1.id}`)).body.data.map((x: any) => x.amount)).toEqual([80]);
      expect((await get(`/api/admin/rider-payouts?from=${TODAY}&to=${TODAY}`)).body.total).toBe(2);
      expect((await get('/api/admin/rider-payouts?from=2020-01-01&to=2020-01-31')).body.total).toBe(0);
      expect((await get('/api/admin/rider-payouts?pageSize=1&page=2')).body).toMatchObject({ count: 1, pages: 2, total: 2 });
      expect(await prisma.adminAuditLog.count({ where: { action: 'RIDER_PAYOUT_RECORDED' } })).toBe(2);
      for (const t of [tStudent, tF1, tR1]) {
        expect((await get('/api/admin/rider-payouts', t)).status).toBe(403);
        expect((await request.post('/api/admin/rider-payouts').set(H(t)).send(good)).status).toBe(403);
      }
      expect((await request.post('/api/admin/rider-payouts').send(good)).status).toBe(401);
    });

    test('validation and unknown riders', async () => {
      const cases: [unknown, string][] = [
        [{ ...good, amount: 0 }, 'amount'], [{ ...good, amount: -5 }, 'amount'], [{ ...good, amount: '5' }, 'amount'], [{ ...good, amount: 1.005 }, 'amount'], [{ ...good, amount: 100000.01 }, 'amount'],
        [{ ...good, method: 'WIRE' }, 'method'], [{ ...good, method: undefined }, 'method'], [{ ...good, reference: 'ab' }, 'reference'], [{ ...good, reference: '=cmd' }, 'reference'],
        [{ ...good, driverUserId: undefined }, 'driverUserId'], [{ ...good, driverUserId: 'bad id' }, 'driverUserId'], [{ ...good, periodStart: 'soon' }, 'periodStart'],
        [{ ...good, periodStart: D1, periodEnd: D3 }, 'periodEnd'], [{ ...good, note: 'n'.repeat(301) }, 'note'], [{ ...good, extra: 1 }, 'extra'],
      ];
      for (const [body, field] of cases) {
        const r = await post(body);
        expect([r.status, r.body.field]).toEqual([400, field]);
      }
      for (const id of [F1.id, STUDENT.id, randomUUID()]) expect((await post({ ...good, driverUserId: id })).status).toBe(404); // not a rider
      expect(await prisma.riderPayout.count()).toBe(0);
    });

    test('the same reference for the same rider is the same payment (double click); a conflicting one is refused; parallel calls give one row', async () => {
      const a = await post(good);
      const b = await post(good);
      expect([a.status, a.body.changed, b.status, b.body.changed, b.body.data.id]).toEqual([201, true, 200, false, a.body.data.id]);
      const diff = await post({ ...good, amount: 999 });
      expect([diff.status, diff.body.code]).toEqual([409, 'REFERENCE_USED']);
      const same = await Promise.all([1, 2, 3, 4, 5].map(() => post({ ...good, reference: 'REF-PAR-0001' })));
      expect(same.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await prisma.riderPayout.count({ where: { reference: 'REF-PAR-0001' } })).toBe(1);
      // the same reference for ANOTHER rider is a different payment
      expect((await post({ ...good, driverUserId: R1.id })).status).toBe(201);
      // cash entries without a reference are separate records
      await post({ driverUserId: R2.id, amount: 10, method: 'CASH' });
      await post({ driverUserId: R2.id, amount: 10, method: 'CASH' });
      expect(await prisma.riderPayout.count({ where: { driverUserId: R2.id, method: 'CASH' } })).toBe(2);
    });

    test('rate limit on ledger writes', async () => {
      process.env.RL_ADMIN_SETTLEMENT_WRITE_MAX = '2';
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await post({ ...good, reference: `REF-RL-000${i}` })).status);
      expect(codes).toEqual([201, 201, 429]);
    });
  });
});
