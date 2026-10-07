import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { addIstDays, isIstDateString, istDayStartOf } from '../utils/time';
import { IstRange } from '../utils/range';
import { writeAudit } from './audit';
import { fromPaise, hasAtMostTwoDecimals } from './pricing';

/**
 * Finance analytics for the admin (Docs/21 section 5). Every number is summed in integer paise in SQL (ROUND(x * 100) per row, then SUM)
 * and divided by 100 once, so a total never carries float noise, and every query is one aggregate with a bounded result (no N+1).
 *
 * Definitions (all on the Asia/Kolkata calendar):
 *  - REVENUE ORDERS: status DELIVERED and paymentStatus PAID, dated by `deliveredAt`. Cancelled orders never count as revenue.
 *  - REFUNDS: orders with paymentStatus REFUNDED, dated by `cancelledAt` (else `deliveredAt`, else `updatedAt`); counted only as refunds.
 *    Docs/22: a combined order is ONE payment and ONE refund (count = distinct groups); its amount is the sum of the children's totals = the group total.
 *    Rider deliveries are counted per delivery (one per combined order); everything else is per restaurant order.
 *  - foodGross = sum of Order.subtotal (customer food), vendorAmount = sum of vendorSubtotal, commission = sum of commissionTotal,
 *    feesCollected = deliveryFee + taxAndPackaging (the all-in fee; old orders keep their separate tax column), discounts = coupons
 *    (paid by Kraveo), platformRevenue = commission + feesCollected - discounts.
 *  - settledAmount = vendorAmount of revenue orders that belong to a settlement; unsettledAmount = those that do not;
 *    paidOutAmount = the part of settledAmount whose settlement is PAID.
 */
const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const p = (col: string) => Prisma.raw(`ROUND(${col}::numeric * 100)`);
const IST_SHIFT = Prisma.raw(`interval '330 minutes'`);
/** Revenue orders delivered inside the range. */
const revenueWhere = (r: IstRange) => Prisma.sql`o."status" = 'DELIVERED' AND o."paymentStatus" = 'PAID' AND o."deliveredAt" >= ${ts(r.start)} AND o."deliveredAt" < ${ts(r.end)}`;
const refundWhere = (r: IstRange) =>
  Prisma.sql`o."paymentStatus" = 'REFUNDED' AND COALESCE(o."cancelledAt", o."deliveredAt", o."updatedAt") >= ${ts(r.start)} AND COALESCE(o."cancelledAt", o."deliveredAt", o."updatedAt") < ${ts(r.end)}`;

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const money = (paise: unknown): number => fromPaise(n(paise));

type MoneyCols = { orders: number; foodP: number; vendorP: number; commP: number; feesP: number; discP: number };
const moneyOf = (r: MoneyCols) => {
  const platformP = n(r.commP) + n(r.feesP) - n(r.discP);
  return { orders: n(r.orders), foodGross: money(r.foodP), vendorAmount: money(r.vendorP), commission: money(r.commP), feesCollected: money(r.feesP), discounts: money(r.discP), platformRevenue: money(platformP) };
};
const MONEY_SQL = Prisma.sql`COUNT(*)::int AS "orders",
  COALESCE(SUM(${p('o."subtotal"')}), 0)::float8 AS "foodP", COALESCE(SUM(${p('o."vendorSubtotal"')}), 0)::float8 AS "vendorP",
  COALESCE(SUM(${p('o."commissionTotal"')}), 0)::float8 AS "commP",
  COALESCE(SUM(${p('o."deliveryFee"')} + ${p('o."taxAndPackaging"')}), 0)::float8 AS "feesP", COALESCE(SUM(${p('o."discount"')}), 0)::float8 AS "discP"`;

export const financeSummary = async (r: IstRange) => {
  const [rows, refunds] = await Promise.all([
    prisma.$queryRaw<(MoneyCols & { customerP: number; settledP: number; unsettledP: number; paidOutP: number })[]>`
      SELECT ${MONEY_SQL},
        COALESCE(SUM(${p('o."totalAmount"')}), 0)::float8 AS "customerP",
        COALESCE(SUM(CASE WHEN o."settlementId" IS NOT NULL THEN ${p('o."vendorSubtotal"')} ELSE 0 END), 0)::float8 AS "settledP",
        COALESCE(SUM(CASE WHEN o."settlementId" IS NULL THEN ${p('o."vendorSubtotal"')} ELSE 0 END), 0)::float8 AS "unsettledP",
        COALESCE(SUM(CASE WHEN st."status" = 'PAID' THEN ${p('o."vendorSubtotal"')} ELSE 0 END), 0)::float8 AS "paidOutP"
      FROM "Order" o LEFT JOIN "Settlement" st ON st."id" = o."settlementId"
      WHERE ${revenueWhere(r)}`,
    prisma.$queryRaw<{ count: number; amountP: number }[]>`
      SELECT COUNT(DISTINCT COALESCE(o."groupId", o."id"))::int AS "count", COALESCE(SUM(${p('o."totalAmount"')}), 0)::float8 AS "amountP" FROM "Order" o WHERE ${refundWhere(r)}`,
  ]);
  const m = rows[0];
  return {
    range: { from: r.from, to: r.to, days: r.days },
    ...moneyOf(m),
    customerPaid: money(m.customerP),
    refunds: { count: n(refunds[0].count), amount: money(refunds[0].amountP) },
    settledAmount: money(m.settledP),
    unsettledAmount: money(m.unsettledP),
    paidOutAmount: money(m.paidOutP),
  };
};

export const financeByRestaurant = async (r: IstRange, limit: number) => {
  const rows = await prisma.$queryRaw<(MoneyCols & { vendorId: string; vendorName: string; unsettledP: number })[]>`
    SELECT o."vendorId", v."name" AS "vendorName", ${MONEY_SQL},
      COALESCE(SUM(CASE WHEN o."settlementId" IS NULL THEN ${p('o."vendorSubtotal"')} ELSE 0 END), 0)::float8 AS "unsettledP"
    FROM "Order" o JOIN "Vendor" v ON v."id" = o."vendorId"
    WHERE ${revenueWhere(r)}
    GROUP BY o."vendorId", v."name"
    ORDER BY "vendorP" DESC, o."vendorId" ASC
    LIMIT ${limit}`;
  const refunds = await prisma.$queryRaw<{ vendorId: string; count: number; amountP: number }[]>`
    SELECT o."vendorId", COUNT(*)::int AS "count", COALESCE(SUM(${p('o."totalAmount"')}), 0)::float8 AS "amountP"
    FROM "Order" o WHERE ${refundWhere(r)} GROUP BY o."vendorId"`;
  const byVendor = new Map(refunds.map((x) => [x.vendorId, x]));
  return {
    range: { from: r.from, to: r.to, days: r.days },
    limit,
    data: rows.map((x) => ({ vendorId: x.vendorId, vendorName: x.vendorName, ...moneyOf(x), unsettledAmount: money(x.unsettledP), refunds: { count: n(byVendor.get(x.vendorId)?.count), amount: money(byVendor.get(x.vendorId)?.amountP) } })),
  };
};

export const DISH_SORTS = ['units', 'vendorRevenue', 'commission'] as const;
export const financeByDish = async (r: IstRange, opts: { top: number; sort: (typeof DISH_SORTS)[number]; vendorId?: string }) => {
  const order = opts.sort === 'vendorRevenue' ? Prisma.raw('"vendorP" DESC, "units" DESC') : opts.sort === 'commission' ? Prisma.raw('"commP" DESC, "units" DESC') : Prisma.raw('"units" DESC, "vendorP" DESC');
  const vendorFilter = opts.vendorId ? Prisma.sql`AND o."vendorId" = ${opts.vendorId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ menuItemId: string | null; name: string; vendorId: string; vendorName: string; units: number; customerP: number; vendorP: number; commP: number }[]>`
    SELECT oi."menuItemId", oi."name", o."vendorId", v."name" AS "vendorName", SUM(oi."quantity")::int AS "units",
      COALESCE(SUM(${p('oi."price"')} * oi."quantity"), 0)::float8 AS "customerP",
      COALESCE(SUM(${p('oi."vendorUnitPrice"')} * oi."quantity"), 0)::float8 AS "vendorP",
      COALESCE(SUM(${p('oi."commissionUnit"')} * oi."quantity"), 0)::float8 AS "commP"
    FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId" JOIN "Vendor" v ON v."id" = o."vendorId"
    WHERE ${revenueWhere(r)} ${vendorFilter}
    GROUP BY oi."menuItemId", oi."name", o."vendorId", v."name"
    ORDER BY ${order}, oi."name" ASC
    LIMIT ${opts.top}`;
  return {
    range: { from: r.from, to: r.to, days: r.days },
    top: opts.top,
    sort: opts.sort,
    data: rows.map((x) => ({ menuItemId: x.menuItemId, name: x.name, vendorId: x.vendorId, vendorName: x.vendorName, units: n(x.units), customerRevenue: money(x.customerP), vendorRevenue: money(x.vendorP), commission: money(x.commP) })),
  };
};

export const financeByDay = async (r: IstRange) => {
  const [rows, refunds] = await Promise.all([
    prisma.$queryRaw<(MoneyCols & { day: string })[]>`
      SELECT to_char(o."deliveredAt" + ${IST_SHIFT}, 'YYYY-MM-DD') AS "day", ${MONEY_SQL}
      FROM "Order" o WHERE ${revenueWhere(r)} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ day: string; count: number; amountP: number }[]>`
      SELECT to_char(COALESCE(o."cancelledAt", o."deliveredAt", o."updatedAt") + ${IST_SHIFT}, 'YYYY-MM-DD') AS "day", COUNT(DISTINCT COALESCE(o."groupId", o."id"))::int AS "count",
        COALESCE(SUM(${p('o."totalAmount"')}), 0)::float8 AS "amountP"
      FROM "Order" o WHERE ${refundWhere(r)} GROUP BY 1`,
  ]);
  const byDay = new Map(rows.map((x) => [x.day, x]));
  const refundByDay = new Map(refunds.map((x) => [x.day, x]));
  const data: unknown[] = [];
  for (let i = 0; i < r.days; i++) {
    const date = addIstDays(r.from, i);
    const row = byDay.get(date);
    const ref = refundByDay.get(date);
    data.push({ date, ...(row ? moneyOf(row) : moneyOf({ orders: 0, foodP: 0, vendorP: 0, commP: 0, feesP: 0, discP: 0 })), refunds: { count: n(ref?.count), amount: money(ref?.amountP) } });
  }
  return { range: { from: r.from, to: r.to, days: r.days }, data };
};

export const financeRiders = async (r: IstRange, limit: number) => {
  const totals = await prisma.$queryRaw<{ driverId: string; deliveries: number }[]>`
    SELECT o."driverId", COUNT(DISTINCT COALESCE(o."groupId", o."id"))::int AS "deliveries" FROM "Order" o
    WHERE ${revenueWhere(r)} AND o."driverId" IS NOT NULL GROUP BY o."driverId" ORDER BY "deliveries" DESC, o."driverId" ASC LIMIT ${limit}`;
  const ledger = await prisma.riderPayout.groupBy({
    by: ['driverUserId'],
    where: { createdAt: { gte: r.start, lt: r.end } },
    _count: { _all: true },
    _sum: { amount: true },
    _max: { createdAt: true },
  });
  const ids = [...new Set([...totals.map((t) => t.driverId), ...ledger.map((l) => l.driverUserId)])].slice(0, limit + 200);
  const [perDay, drivers] = await Promise.all([
    totals.length === 0
      ? []
      : prisma.$queryRaw<{ driverId: string; day: string; deliveries: number }[]>`
          SELECT o."driverId", to_char(o."deliveredAt" + ${IST_SHIFT}, 'YYYY-MM-DD') AS "day", COUNT(DISTINCT COALESCE(o."groupId", o."id"))::int AS "deliveries" FROM "Order" o
          WHERE ${revenueWhere(r)} AND o."driverId" = ANY(${totals.map((t) => t.driverId)}) GROUP BY 1, 2 ORDER BY 2, 1 LIMIT 20000`,
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, driverProfile: { select: { runnerCode: true } } } }),
  ]);
  const names = new Map(drivers.map((d) => [d.id, { name: d.name, runnerCode: d.driverProfile?.runnerCode ?? null }]));
  const daysByRider = new Map<string, { date: string; deliveries: number }[]>();
  for (const row of perDay) {
    const list = daysByRider.get(row.driverId) ?? [];
    list.push({ date: row.day, deliveries: n(row.deliveries) });
    daysByRider.set(row.driverId, list);
  }
  const ledgerBy = new Map(ledger.map((l) => [l.driverUserId, l]));
  const delivered = new Map(totals.map((t) => [t.driverId, n(t.deliveries)]));
  const riderIds = [...new Set([...totals.map((t) => t.driverId), ...ledger.map((l) => l.driverUserId)])].slice(0, limit);
  const data = riderIds.map((id) => {
    const l = ledgerBy.get(id);
    return {
      driverUserId: id,
      name: names.get(id)?.name ?? null,
      runnerCode: names.get(id)?.runnerCode ?? null,
      deliveries: delivered.get(id) ?? 0,
      byDay: daysByRider.get(id) ?? [],
      payouts: { count: l?._count._all ?? 0, total: Math.round((l?._sum.amount ?? 0) * 100) / 100, lastAt: l?._max.createdAt ? l._max.createdAt.toISOString() : null },
    };
  });
  return {
    range: { from: r.from, to: r.to, days: r.days },
    limit,
    totals: { riders: data.length, deliveries: data.reduce((a, x) => a + x.deliveries, 0), payoutTotal: Math.round(data.reduce((a, x) => a + Math.round(x.payouts.total * 100), 0)) / 100 },
    data,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Rider payout ledger (records only: Kraveo does not pay riders through the app)
// ---------------------------------------------------------------------------------------------------------------------
export const RIDER_PAYOUT_METHODS = ['UPI', 'BANK', 'CASH'] as const;
export const MAX_RIDER_PAYOUT = 100_000;
type Actor = { id: string; role: string };
const bad = (field: string, message: string) => new AppError(400, 'BAD_REQUEST', message, field);

const periodBound = (raw: unknown, field: string, end: boolean): Date | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw bad(field, `${field} must be a date (YYYY-MM-DD or ISO 8601).`);
  if (isIstDateString(raw)) return end ? new Date(istDayStartOf(addIstDays(raw, 1)).getTime() - 1) : istDayStartOf(raw);
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) throw bad(field, `${field} must be a date (YYYY-MM-DD or ISO 8601).`);
  return d;
};

export const riderPayoutView = (r: Prisma.RiderPayoutGetPayload<{}>, driverName?: string | null) => ({
  id: r.id,
  driverUserId: r.driverUserId,
  ...(driverName !== undefined ? { driverName } : {}),
  amount: r.amount,
  method: r.method as 'UPI' | 'BANK' | 'CASH',
  reference: r.reference,
  periodStart: r.periodStart ? r.periodStart.toISOString() : null,
  periodEnd: r.periodEnd ? r.periodEnd.toISOString() : null,
  note: r.note,
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

export const createRiderPayout = async (raw: unknown, actor: Actor) => {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const extra = Object.keys(b).find((k) => !['driverUserId', 'amount', 'method', 'reference', 'periodStart', 'periodEnd', 'note'].includes(k));
  if (extra) throw bad(extra, `Unknown field '${extra.slice(0, 40)}'.`);
  if (typeof b.driverUserId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.driverUserId)) throw bad('driverUserId', 'driverUserId (the rider\'s user id) is required.');
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount <= 0) throw bad('amount', 'amount must be a number above 0.');
  if (!hasAtMostTwoDecimals(b.amount)) throw bad('amount', 'amount can have at most 2 decimals.');
  if (b.amount > MAX_RIDER_PAYOUT) throw bad('amount', `amount cannot be more than ${MAX_RIDER_PAYOUT}.`);
  if (typeof b.method !== 'string' || !(RIDER_PAYOUT_METHODS as readonly string[]).includes(b.method)) throw bad('method', 'method must be UPI, BANK or CASH.');
  let reference: string | null = null;
  if (b.reference !== undefined && b.reference !== null && b.reference !== '') {
    if (typeof b.reference !== 'string') throw bad('reference', 'reference must be text (3 to 64 characters).');
    reference = b.reference.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.\/:#-]{2,63}$/.test(reference)) throw bad('reference', 'reference must be 3 to 64 characters: letters, digits, space and _ . / : # -');
  }
  const periodStart = periodBound(b.periodStart, 'periodStart', false);
  const periodEnd = periodBound(b.periodEnd, 'periodEnd', true);
  if (periodStart && periodEnd && periodEnd < periodStart) throw bad('periodEnd', 'periodEnd cannot be before periodStart.');
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && b.note !== '') {
    if (typeof b.note !== 'string' || b.note.trim().length > 300) throw bad('note', 'note can be at most 300 characters.');
    note = b.note.trim();
  }
  const rider = await prisma.user.findUnique({ where: { id: b.driverUserId }, select: { id: true, name: true, role: true, deletedAt: true } });
  if (!rider || rider.deletedAt || rider.role !== 'DRIVER') throw new AppError(404, 'NOT_FOUND', 'No rider account with this driverUserId.', 'driverUserId');
  const data = { driverUserId: rider.id, amount: b.amount, method: b.method, reference, periodStart, periodEnd, note, createdBy: actor.id };
  try {
    const row = await prisma.riderPayout.create({ data });
    await writeAudit('RIDER_PAYOUT_RECORDED', 'USER', rider.id, `Admin ${actor.id} recorded a rider payout of Rs ${b.amount.toFixed(2)} by ${b.method}${reference ? ` (reference ${reference})` : ''} to ${rider.id}.`);
    return { row, changed: true, driverName: rider.name };
  } catch (err: any) {
    // The same reference for the same rider again is the same payment (double click / retry).
    if (err?.code === 'P2002' && reference) {
      const existing = await prisma.riderPayout.findUnique({ where: { driverUserId_reference: { driverUserId: rider.id, reference } } });
      if (existing && existing.amount === b.amount && existing.method === b.method) return { row: existing, changed: false, driverName: rider.name };
      throw new AppError(409, 'REFERENCE_USED', 'A payout with this reference was already recorded for this rider with different details.', 'reference');
    }
    throw err;
  }
};

export const listRiderPayouts = async (q: { driverUserId?: string; range?: IstRange; page: number; pageSize: number }) => {
  const where: Prisma.RiderPayoutWhereInput = { ...(q.driverUserId ? { driverUserId: q.driverUserId } : {}), ...(q.range ? { createdAt: { gte: q.range.start, lt: q.range.end } } : {}) };
  const [total, rows, sum] = await Promise.all([
    prisma.riderPayout.count({ where }),
    prisma.riderPayout.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.riderPayout.aggregate({ where, _sum: { amount: true } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.driverUserId))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)),
    totalAmount: Math.round((sum._sum.amount ?? 0) * 100) / 100,
    data: rows.map((r) => riderPayoutView(r, names.get(r.driverUserId) ?? null)),
  };
};
