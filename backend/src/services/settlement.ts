import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { errSummary } from '../utils/log';
import { istDateString, istInstant } from '../utils/time';
import { IstRange } from '../utils/range';
import { writeAudit } from './audit';
import { getSettingGroup } from './settings';
import { fromPaise, hasAtMostTwoDecimals, toPaise } from './pricing';
import { adminAccountView, payoutSnapshotOf } from './payoutAccount';

/**
 * Restaurant settlements (Docs/21 section 5).
 *
 * WHAT IS SETTLED. A delivered, paid, not refunded order with `settlementId IS NULL`, delivered at or before the cut-off and at least
 * `holdDays` days ago. One Settlement per restaurant and run groups them: orderCount, foodGross (customer food total, analytics),
 * vendorAmount (sum of Order.vendorSubtotal = what the restaurant earns), commissionAmount, adjustmentTotal (manual +/-) and
 * netPayable = vendorAmount + adjustmentTotal. All sums are done in integer paise.
 *
 * AN ORDER IS IN AT MOST ONE SETTLEMENT. Creating a settlement runs in ONE transaction per restaurant: the eligible rows are read with
 * `FOR UPDATE` (a parallel run waits, then re-checks the condition and finds them taken), the Settlement is inserted, and a conditional
 * `UPDATE ... WHERE settlementId IS NULL` claims the orders; if it claims fewer than were selected the transaction rolls back.
 *
 * NO DOUBLE DAILY BATCH. The automatic batch of an IST day has batchKey = that date, and (vendorId, batchKey) is unique: a restart, a
 * second server or two overlapping ticks cannot create it twice. A manual "run now" gets a unique key (M-...) and only ever sees orders
 * that are still unsettled.
 *
 * STATUS. PENDING -> (ON_HOLD <-> PENDING) -> PAID, or CANCELLED (not after PAID: the orders are freed for the next run). Every status
 * change takes the row lock first and re-reads, so a double click or two admins at once give one change and one "changed: false".
 */
type Tx = Prisma.TransactionClient;
export type Actor = { id: string; role: string };

export const MAX_ADJUSTMENT = 100_000;
export const MAX_ADJUSTMENTS_PER_SETTLEMENT = 100;
export const MAX_ORDERS_LISTED = 2000;
const HOUR_MS = 3_600_000;

class Rollback extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------
type SettlementRow = Prisma.SettlementGetPayload<{}>;

/** Admin view: everything, money in rupees. */
export const adminSettlementView = (s: SettlementRow, vendorName?: string) => ({
  id: s.id,
  vendorId: s.vendorId,
  ...(vendorName !== undefined ? { vendorName } : {}),
  batchKey: s.batchKey,
  periodStart: s.periodStart.toISOString(),
  periodEnd: s.periodEnd.toISOString(),
  status: s.status,
  orderCount: s.orderCount,
  foodGross: s.foodGross,
  vendorAmount: s.vendorAmount,
  commissionAmount: s.commissionAmount,
  adjustmentTotal: s.adjustmentTotal,
  netPayable: s.netPayable,
  payoutSnapshot: s.payoutSnapshot ?? null,
  hasPayoutDetails: s.payoutSnapshot !== null && s.payoutSnapshot !== undefined,
  paidAt: iso(s.paidAt),
  paymentReference: s.paymentReference,
  paidBy: s.paidBy,
  note: s.note,
  createdBy: s.createdBy,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * Restaurant view: ONLY what the restaurant earned. No foodGross, commissionAmount, customer prices, order totals, payout snapshot,
 * internal note or who created it. (Docs/21 decision 1.)
 */
export const vendorSettlementView = (s: SettlementRow) => ({
  id: s.id,
  periodStart: s.periodStart.toISOString(),
  periodEnd: s.periodEnd.toISOString(),
  status: s.status,
  orderCount: s.orderCount,
  vendorAmount: s.vendorAmount,
  adjustmentTotal: s.adjustmentTotal,
  netPayable: s.netPayable,
  paidAt: iso(s.paidAt),
  paymentReference: s.paymentReference,
  createdAt: s.createdAt.toISOString(),
});

// ---------------------------------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------------------------------
type EligibleRow = { id: string; subtotal: number; vendorSubtotal: number; commissionTotal: number; deliveredAt: Date };

/** Prisma filter of the orders a run may settle (used to find the restaurants; the transaction re-reads with the same rule under lock). */
const eligibleWhere = (cutoff: Date, vendorId?: string): Prisma.OrderWhereInput => ({
  status: 'DELIVERED',
  paymentStatus: 'PAID',
  settlementId: null,
  deliveredAt: { not: null, lte: cutoff },
  OR: [{ refundStatus: null }, { refundStatus: 'NONE' }],
  ...(vendorId ? { vendorId } : {}),
});

export type RunResult = {
  cutoff: string;
  holdDays: number;
  /** The instant the orders had to be delivered by (cut-off, and older than holdDays). */
  deliveredBy: string;
  created: ReturnType<typeof adminSettlementView>[];
  skipped: { vendorId: string; reason: string }[];
  failed: { vendorId: string }[];
  orderCount: number;
  netPayable: number;
};

/** One restaurant, one transaction. Returns null when it has nothing to settle (nothing is written). */
const createForVendor = async (vendorId: string, deliveredBy: Date, batchKey: string, createdBy: string): Promise<SettlementRow | null> => {
  return prisma.$transaction(
    async (tx: Tx) => {
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { id: true, userId: true } });
      if (!vendor) return null;
      // `AT TIME ZONE 'UTC'` makes the bound independent of the database session time zone ("deliveredAt" is a UTC timestamp).
      const rows = await tx.$queryRaw<EligibleRow[]>`
        SELECT "id", "subtotal", "vendorSubtotal", "commissionTotal", "deliveredAt" FROM "Order"
        WHERE "vendorId" = ${vendorId} AND "status" = 'DELIVERED' AND "paymentStatus" = 'PAID' AND "settlementId" IS NULL
          AND ("refundStatus" IS NULL OR "refundStatus" = 'NONE')
          AND "deliveredAt" IS NOT NULL AND "deliveredAt" <= (${deliveredBy.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "deliveredAt" ASC, "id" ASC
        FOR UPDATE`;
      if (rows.length === 0) return null;
      let gross = 0, earn = 0, commission = 0;
      for (const r of rows) {
        gross += toPaise(r.subtotal);
        earn += toPaise(r.vendorSubtotal);
        commission += toPaise(r.commissionTotal);
      }
      const account = vendor.userId ? await tx.payoutAccount.findUnique({ where: { userId: vendor.userId } }) : null;
      const settlement = await tx.settlement.create({
        data: {
          vendorId,
          batchKey,
          periodStart: rows[0].deliveredAt,
          periodEnd: deliveredBy,
          status: 'PENDING',
          orderCount: rows.length,
          foodGross: fromPaise(gross),
          vendorAmount: fromPaise(earn),
          commissionAmount: fromPaise(commission),
          adjustmentTotal: 0,
          netPayable: fromPaise(earn),
          payoutSnapshot: (payoutSnapshotOf(account) ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
          createdBy,
        },
      });
      // Claim the orders. updatedAt is not touched (raw SQL), so no app sees these orders as changed.
      const ids = rows.map((r) => r.id);
      const claimed = await tx.$executeRaw`UPDATE "Order" SET "settlementId" = ${settlement.id} WHERE "id" = ANY(${ids}) AND "settlementId" IS NULL`;
      if (claimed !== ids.length) throw new Rollback(`claimed ${claimed} of ${ids.length}`);
      return settlement;
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
};

/**
 * Create the settlements that are due now. `until` (default: now, never in the future) is the cut-off; orders must also be at least
 * `settlement.holdDays` days old. `batchKey` is only passed by the daily job (the IST date); manual runs get a unique key.
 * Idempotent and safe to call in parallel: see the header comment.
 */
export const createSettlements = async (opts: { until?: Date; vendorId?: string; createdBy: string; batchKey?: string; now?: Date }): Promise<RunResult> => {
  const now = opts.now ?? new Date();
  const { value: settings } = await getSettingGroup('settlement');
  const cutoff = opts.until && opts.until.getTime() < now.getTime() ? opts.until : now;
  const holdCutoff = new Date(now.getTime() - settings.holdDays * 24 * HOUR_MS);
  const deliveredBy = cutoff.getTime() <= holdCutoff.getTime() ? cutoff : holdCutoff;

  const groups = await prisma.order.groupBy({ by: ['vendorId'], where: eligibleWhere(deliveredBy, opts.vendorId), orderBy: { vendorId: 'asc' } });
  const result: RunResult = { cutoff: cutoff.toISOString(), holdDays: settings.holdDays, deliveredBy: deliveredBy.toISOString(), created: [], skipped: [], failed: [], orderCount: 0, netPayable: 0 };
  let netPaise = 0;
  for (const { vendorId } of groups) {
    const batchKey = opts.batchKey ?? `M-${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    try {
      const s = await createForVendor(vendorId, deliveredBy, batchKey, opts.createdBy);
      if (!s) continue;
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
      result.created.push(adminSettlementView(s, vendor?.name ?? ''));
      result.orderCount += s.orderCount;
      netPaise += toPaise(s.netPayable);
    } catch (err: any) {
      if (err?.code === 'P2002') result.skipped.push({ vendorId, reason: 'ALREADY_CREATED_FOR_THIS_DAY' }); // another run made today's automatic batch first
      else {
        console.error(`settlement for restaurant ${vendorId} failed:`, errSummary(err));
        result.failed.push({ vendorId });
      }
    }
  }
  result.netPayable = fromPaise(netPaise);
  if (result.created.length > 0) {
    await writeAudit(
      'SETTLEMENT_RUN',
      'SETTLEMENT',
      opts.batchKey ?? 'manual',
      `${opts.createdBy === 'AUTO' ? 'Automatic' : `Admin ${opts.createdBy}`} settlement run: ${result.created.length} settlement(s), ${result.orderCount} order(s), Rs ${result.netPayable.toFixed(2)} payable, delivered by ${result.deliveredBy}.`,
    );
  }
  return result;
};

let lastAutoDate: string | null = null;
/** Tests only: forget that today's automatic run was done. */
export const __resetSettlementJob = () => { lastAutoDate = null; };

/**
 * The daily job, called by every 60 s maintenance tick. Once per IST day, after `settlement.time`, when `autoCreate` is on: settle
 * everything delivered up to that day's settlement time. Orders delivered later belong to the next day's batch. Restart-safe and
 * race-safe through the unique (restaurant, IST date) key; the in-memory flag only saves the database from being asked every minute.
 * A catch-up after downtime is automatic (the next run takes every still-unsettled order up to its cut-off).
 */
export const runDailySettlementJob = async (now: Date = new Date()): Promise<RunResult | null> => {
  const { value: settings } = await getSettingGroup('settlement');
  if (!settings.autoCreate) return null;
  const today = istDateString(now);
  if (lastAutoDate === today) return null;
  const cutoff = istInstant(today, settings.time);
  if (now.getTime() < cutoff.getTime()) return null;
  const result = await createSettlements({ until: cutoff, createdBy: 'AUTO', batchKey: today, now });
  if (result.failed.length === 0) lastAutoDate = today; // a failed restaurant is retried by the next tick
  return result;
};

// ---------------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------------
const STATUSES = ['PENDING', 'ON_HOLD', 'PAID', 'CANCELLED'] as const;
export type SettlementStatusName = (typeof STATUSES)[number];
export const isSettlementStatus = (s: unknown): s is SettlementStatusName => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

export const listSettlements = async (q: { status?: string; vendorId?: string; range?: IstRange; page: number; pageSize: number }) => {
  const status = q.status ? q.status.toUpperCase() : undefined;
  if (status && !isSettlementStatus(status)) throw new AppError(400, 'BAD_REQUEST', `status must be one of ${STATUSES.join(', ')}.`, 'status');
  const where: Prisma.SettlementWhereInput = {
    ...(status ? { status: status as SettlementStatusName } : {}),
    ...(q.vendorId ? { vendorId: q.vendorId } : {}),
    ...(q.range ? { createdAt: { gte: q.range.start, lt: q.range.end } } : {}),
  };
  const [total, rows, byStatus] = await Promise.all([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({ where, include: { vendor: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.settlement.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { netPayable: true } }),
  ]);
  const summary: Record<string, { count: number; netPayable: number }> = {};
  for (const s of STATUSES) summary[s] = { count: 0, netPayable: 0 };
  for (const g of byStatus) summary[g.status] = { count: g._count._all, netPayable: round2(g._sum.netPayable ?? 0) };
  return { total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)), summary, data: rows.map((r) => adminSettlementView(r, r.vendor.name)) };
};

export type DishLine = { menuItemId: string | null; name: string; units: number; vendorRevenue: number; commission: number };

/** Per-dish lines of one settlement, aggregated in SQL from OrderItem (integer paise, so the sums are exact). */
export const dishLines = async (settlementId: string): Promise<DishLine[]> => {
  const rows = await prisma.$queryRaw<{ menuItemId: string | null; name: string; units: number; vendorPaise: number; commissionPaise: number }[]>`
    SELECT oi."menuItemId", oi."name", SUM(oi."quantity")::int AS "units",
           SUM(ROUND(oi."vendorUnitPrice"::numeric * 100) * oi."quantity")::float8 AS "vendorPaise",
           SUM(ROUND(oi."commissionUnit"::numeric * 100) * oi."quantity")::float8 AS "commissionPaise"
    FROM "OrderItem" oi JOIN "Order" o ON o."id" = oi."orderId"
    WHERE o."settlementId" = ${settlementId}
    GROUP BY oi."menuItemId", oi."name"
    ORDER BY "vendorPaise" DESC, oi."name" ASC
    LIMIT 500`;
  return rows.map((r) => ({ menuItemId: r.menuItemId, name: r.name, units: r.units, vendorRevenue: fromPaise(r.vendorPaise), commission: fromPaise(r.commissionPaise) }));
};

export const getSettlement = async (id: string) => {
  const s = await prisma.settlement.findUnique({ where: { id }, include: { vendor: { select: { id: true, name: true, userId: true } } } });
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Settlement not found.');
  return s;
};

/** Admin detail: the settlement, the restaurant, the snapshot AND the live (masked) payout account, orders, adjustments, dish lines. */
export const settlementDetail = async (id: string) => {
  const s = await getSettlement(id);
  const [account, orders, adjustments, dishes] = await Promise.all([
    s.vendor.userId ? prisma.payoutAccount.findUnique({ where: { userId: s.vendor.userId } }) : null,
    prisma.order.findMany({
      where: { settlementId: id },
      select: { id: true, deliveredAt: true, subtotal: true, vendorSubtotal: true, commissionTotal: true, deliveryFee: true, taxAndPackaging: true, discount: true, totalAmount: true, couponCode: true },
      orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
      take: MAX_ORDERS_LISTED,
    }),
    prisma.settlementAdjustment.findMany({ where: { settlementId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    dishLines(id),
  ]);
  return {
    settlement: adminSettlementView(s, s.vendor.name),
    vendor: { id: s.vendor.id, name: s.vendor.name, userId: s.vendor.userId },
    payoutAccount: account ? adminAccountView(account) : null,
    orders: orders.map((o) => ({ ...o, deliveredAt: iso(o.deliveredAt) })),
    ordersTruncated: s.orderCount > orders.length,
    adjustments: adjustments.map((a) => ({ id: a.id, amount: a.amount, reason: a.reason, createdBy: a.createdBy, createdAt: a.createdAt.toISOString() })),
    dishes,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Changing a settlement (all under the row lock)
// ---------------------------------------------------------------------------------------------------------------------
const lockSettlement = async (tx: Tx, id: string): Promise<SettlementRow> => {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Settlement" WHERE "id" = ${id} FOR UPDATE`;
  const row = locked.length > 0 ? await tx.settlement.findUnique({ where: { id } }) : null;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Settlement not found.');
  return row;
};

const changeUnderLock = async <T extends { changed: boolean; row: SettlementRow }>(id: string, fn: (tx: Tx, row: SettlementRow) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => fn(tx, await lockSettlement(tx, id)), { maxWait: 10_000, timeout: 20_000 });

const conflict = (code: string, message: string) => new AppError(409, code, message);

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\/:#-]{2,63}$/;

export const markPaid = async (id: string, raw: unknown, actor: Actor) => {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (typeof b.reference !== 'string') throw new AppError(400, 'BAD_REQUEST', 'reference (the bank or UPI transaction id, 3 to 64 characters) is required.', 'reference');
  const reference = b.reference.trim().replace(/\s+/g, ' ');
  if (!REFERENCE_RE.test(reference)) throw new AppError(400, 'BAD_REQUEST', 'reference must be 3 to 64 characters: letters, digits, space and _ . / : # -', 'reference');
  let paidAt = new Date();
  if (b.paidAt !== undefined && b.paidAt !== null && b.paidAt !== '') {
    const d = typeof b.paidAt === 'string' ? new Date(b.paidAt) : new Date(NaN);
    if (!Number.isFinite(d.getTime()) || d.getFullYear() < 2020) throw new AppError(400, 'BAD_REQUEST', 'paidAt must be a date and time (ISO 8601).', 'paidAt');
    if (d.getTime() > Date.now() + 5 * 60_000) throw new AppError(400, 'BAD_REQUEST', 'paidAt cannot be in the future.', 'paidAt');
    paidAt = d;
  }
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && b.note !== '') {
    if (typeof b.note !== 'string' || b.note.trim().length > 300) throw new AppError(400, 'BAD_REQUEST', 'note can be at most 300 characters.', 'note');
    note = b.note.trim();
  }
  const out = await changeUnderLock(id, async (tx, s) => {
    if (s.status === 'PAID') {
      if (s.paymentReference === reference) return { row: s, changed: false };
      throw conflict('ALREADY_PAID', 'This settlement was already paid with a different reference. Nothing was changed.');
    }
    if (s.status === 'CANCELLED') throw conflict('SETTLEMENT_CANCELLED', 'This settlement was cancelled.');
    if (s.status === 'ON_HOLD') throw conflict('SETTLEMENT_ON_HOLD', 'This settlement is on hold. Release it before marking it paid.');
    if (s.netPayable <= 0) throw conflict('NOTHING_TO_PAY', 'The payable amount is not above 0, so there is nothing to pay.');
    const row = await tx.settlement.update({ where: { id }, data: { status: 'PAID', paidAt, paymentReference: reference, paidBy: actor.id, ...(note !== null ? { note } : {}) } });
    return { row, changed: true };
  });
  if (out.changed) await writeAudit('SETTLEMENT_PAID', 'SETTLEMENT', id, `Admin ${actor.id} marked the settlement of restaurant ${out.row.vendorId} paid: Rs ${out.row.netPayable.toFixed(2)}, reference ${reference}.`);
  return out;
};

const cleanReason = (raw: unknown, field: string, min: number, max: number, label: string): string => {
  if (typeof raw !== 'string') throw new AppError(400, 'BAD_REQUEST', `${label} is required (${min} to ${max} characters).`, field);
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) throw new AppError(400, 'BAD_REQUEST', `${label} must be ${min} to ${max} characters.`, field);
  return s;
};

export const holdSettlement = async (id: string, raw: unknown, actor: Actor) => {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const note = b.note === undefined || b.note === null || b.note === '' ? null : cleanReason(b.note, 'note', 1, 300, 'note');
  const out = await changeUnderLock(id, async (tx, s) => {
    if (s.status === 'ON_HOLD') return { row: s, changed: false };
    if (s.status !== 'PENDING') throw conflict('NOT_PENDING', `A ${s.status === 'PAID' ? 'paid' : 'cancelled'} settlement cannot be put on hold.`);
    return { row: await tx.settlement.update({ where: { id }, data: { status: 'ON_HOLD', ...(note ? { note } : {}) } }), changed: true };
  });
  if (out.changed) await writeAudit('SETTLEMENT_HELD', 'SETTLEMENT', id, `Admin ${actor.id} put the settlement of restaurant ${out.row.vendorId} on hold${note ? `: ${note}` : ''}.`);
  return out;
};

export const releaseSettlement = async (id: string, actor: Actor) => {
  const out = await changeUnderLock(id, async (tx, s) => {
    if (s.status === 'PENDING') return { row: s, changed: false };
    if (s.status !== 'ON_HOLD') throw conflict('NOT_ON_HOLD', `A ${s.status === 'PAID' ? 'paid' : 'cancelled'} settlement is not on hold.`);
    return { row: await tx.settlement.update({ where: { id }, data: { status: 'PENDING' } }), changed: true };
  });
  if (out.changed) await writeAudit('SETTLEMENT_RELEASED', 'SETTLEMENT', id, `Admin ${actor.id} released the settlement of restaurant ${out.row.vendorId}.`);
  return out;
};

export const addAdjustment = async (id: string, raw: unknown, actor: Actor) => {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const amount = b.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new AppError(400, 'BAD_REQUEST', 'amount must be a number (+ pays the restaurant more, - deducts).', 'amount');
  if (amount === 0 || Math.round(amount * 100) === 0) throw new AppError(400, 'BAD_REQUEST', 'amount cannot be 0.', 'amount');
  if (!hasAtMostTwoDecimals(amount)) throw new AppError(400, 'BAD_REQUEST', 'amount can have at most 2 decimals.', 'amount');
  if (Math.abs(amount) > MAX_ADJUSTMENT) throw new AppError(400, 'BAD_REQUEST', `amount must be between -${MAX_ADJUSTMENT} and ${MAX_ADJUSTMENT}.`, 'amount');
  const reason = cleanReason(b.reason, 'reason', 3, 200, 'reason');
  let requestId: string | null = null;
  if (b.requestId !== undefined && b.requestId !== null && b.requestId !== '') {
    if (typeof b.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.requestId)) throw new AppError(400, 'BAD_REQUEST', 'requestId must be 8 to 64 letters, digits, _ or -.', 'requestId');
    requestId = b.requestId;
  }
  const out = await changeUnderLock(id, async (tx, s) => {
    if (s.status !== 'PENDING' && s.status !== 'ON_HOLD') throw conflict('NOT_ADJUSTABLE', `Adjustments can only be added while the settlement is pending or on hold (this one is ${s.status === 'PAID' ? 'paid' : 'cancelled'}).`);
    if (requestId) {
      const dup = await tx.settlementAdjustment.findUnique({ where: { settlementId_requestId: { settlementId: id, requestId } } });
      if (dup) return { row: s, changed: false, adjustment: dup };
    }
    const count = await tx.settlementAdjustment.count({ where: { settlementId: id } });
    if (count >= MAX_ADJUSTMENTS_PER_SETTLEMENT) throw conflict('TOO_MANY_ADJUSTMENTS', `At most ${MAX_ADJUSTMENTS_PER_SETTLEMENT} adjustments per settlement.`);
    const total = toPaise(s.adjustmentTotal) + toPaise(amount);
    const net = toPaise(s.vendorAmount) + total;
    if (net < 0) throw new AppError(400, 'BAD_REQUEST', `This would make the payable amount negative (Rs ${fromPaise(net).toFixed(2)}). Deduct less, or cancel the settlement.`, 'amount');
    const adjustment = await tx.settlementAdjustment.create({ data: { settlementId: id, amount, reason, requestId, createdBy: actor.id } });
    const row = await tx.settlement.update({ where: { id }, data: { adjustmentTotal: fromPaise(total), netPayable: fromPaise(net) } });
    return { row, changed: true, adjustment };
  });
  if (out.changed) await writeAudit('SETTLEMENT_ADJUSTED', 'SETTLEMENT', id, `Admin ${actor.id} adjusted the settlement of restaurant ${out.row.vendorId} by Rs ${amount.toFixed(2)} (${reason.slice(0, 120)}). Payable now Rs ${out.row.netPayable.toFixed(2)}.`);
  return out;
};

export const cancelSettlement = async (id: string, actor: Actor) => {
  const out = await changeUnderLock(id, async (tx, s) => {
    if (s.status === 'CANCELLED') return { row: s, changed: false, freed: 0 };
    if (s.status === 'PAID') throw conflict('ALREADY_PAID', 'A paid settlement cannot be cancelled.');
    const freed = await tx.$executeRaw`UPDATE "Order" SET "settlementId" = NULL WHERE "settlementId" = ${id}`;
    const row = await tx.settlement.update({ where: { id }, data: { status: 'CANCELLED' } });
    return { row, changed: true, freed };
  });
  if (out.changed) await writeAudit('SETTLEMENT_CANCELLED', 'SETTLEMENT', id, `Admin ${actor.id} cancelled the settlement of restaurant ${out.row.vendorId}; ${out.freed} order(s) are unsettled again.`);
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// CSV (admin exports). Cells that a spreadsheet could read as a formula (= + - @, tab, carriage return) get a leading quote.
// Only TEXT cells are guarded: numbers are produced by us (toFixed) and must stay numbers.
// ---------------------------------------------------------------------------------------------------------------------
export const csvText = (value: unknown): string => {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvNum = (n: number | null | undefined): string => (n === null || n === undefined ? '' : n.toFixed(2));
export const csvLine = (cells: string[]): string => cells.join(',');

const istStamp = (d: Date | null | undefined): string => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19) : '');

/** One row per order and per adjustment: the "restaurant_amount" column adds up to the settlement's netPayable. */
export const settlementCsv = async (id: string): Promise<{ filename: string; body: string }> => {
  const s = await getSettlement(id);
  const [orders, adjustments] = await Promise.all([
    prisma.order.findMany({ where: { settlementId: id }, select: { id: true, deliveredAt: true, subtotal: true, vendorSubtotal: true, commissionTotal: true }, orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }], take: 20_000 }),
    prisma.settlementAdjustment.findMany({ where: { settlementId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  const head = ['row_type', 'settlement_id', 'restaurant', 'batch', 'status', 'payment_reference', 'order_id', 'delivered_at_ist', 'customer_food_total', 'restaurant_amount', 'commission', 'note'];
  const lines = [csvLine(head)];
  const common = (): string[] => [csvText(s.id), csvText(s.vendor.name), csvText(s.batchKey), csvText(s.status), csvText(s.paymentReference)];
  for (const o of orders) lines.push(csvLine(['ORDER', ...common(), csvText(o.id), csvText(istStamp(o.deliveredAt)), csvNum(o.subtotal), csvNum(o.vendorSubtotal), csvNum(o.commissionTotal), '']));
  for (const a of adjustments) lines.push(csvLine(['ADJUSTMENT', ...common(), '', csvText(istStamp(a.createdAt)), '', csvNum(a.amount), '', csvText(a.reason)]));
  return { filename: `kraveo-settlement-${s.id.slice(0, 8)}.csv`, body: lines.join('\r\n') + '\r\n' };
};

/** One row per settlement created in the range (IST days). */
export const settlementsCsv = async (range: IstRange): Promise<{ filename: string; body: string }> => {
  const rows = await prisma.settlement.findMany({ where: { createdAt: { gte: range.start, lt: range.end } }, include: { vendor: { select: { name: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10_000 });
  const head = ['settlement_id', 'restaurant', 'batch', 'created_at_ist', 'period_start_ist', 'period_end_ist', 'status', 'orders', 'customer_food_total', 'restaurant_amount', 'commission', 'adjustments', 'net_payable', 'paid_at_ist', 'payment_reference', 'payout_method', 'payout_destination', 'created_by'];
  const lines = [csvLine(head)];
  for (const s of rows) {
    const snap = (s.payoutSnapshot ?? null) as { method?: string; destination?: string | null } | null;
    lines.push(csvLine([
      csvText(s.id), csvText(s.vendor.name), csvText(s.batchKey), csvText(istStamp(s.createdAt)), csvText(istStamp(s.periodStart)), csvText(istStamp(s.periodEnd)), csvText(s.status),
      String(s.orderCount), csvNum(s.foodGross), csvNum(s.vendorAmount), csvNum(s.commissionAmount), csvNum(s.adjustmentTotal), csvNum(s.netPayable),
      csvText(istStamp(s.paidAt)), csvText(s.paymentReference), csvText(snap?.method ?? ''), csvText(snap?.destination ?? ''), csvText(s.createdBy),
    ]));
  }
  return { filename: `kraveo-settlements-${range.from}_${range.to}.csv`, body: lines.join('\r\n') + '\r\n' };
};

// ---------------------------------------------------------------------------------------------------------------------
// Restaurant side (read only)
// ---------------------------------------------------------------------------------------------------------------------
export const vendorIdsOf = async (userId: string): Promise<string[]> => (await prisma.vendor.findMany({ where: { userId }, select: { id: true } })).map((v) => v.id);

export const listVendorSettlements = async (userId: string, q: { page: number; pageSize: number }) => {
  const vendorIds = await vendorIdsOf(userId);
  const where: Prisma.SettlementWhereInput = { vendorId: { in: vendorIds }, status: { not: 'CANCELLED' } };
  const [total, rows] = await Promise.all([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)), data: rows.map(vendorSettlementView) };
};

/** A restaurant's own settlement with its orders (restaurant amount only) and dishes (units and restaurant revenue only). 404 for anyone else's. */
export const vendorSettlementDetail = async (userId: string, id: string) => {
  const vendorIds = await vendorIdsOf(userId);
  const s = await prisma.settlement.findFirst({ where: { id, vendorId: { in: vendorIds }, status: { not: 'CANCELLED' } } });
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Settlement not found.');
  const [orders, adjustments, dishes] = await Promise.all([
    prisma.order.findMany({ where: { settlementId: id }, select: { id: true, deliveredAt: true, vendorSubtotal: true }, orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }], take: MAX_ORDERS_LISTED }),
    prisma.settlementAdjustment.findMany({ where: { settlementId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    dishLines(id),
  ]);
  return {
    ...vendorSettlementView(s),
    orders: orders.map((o) => ({ id: o.id, deliveredAt: iso(o.deliveredAt), amount: o.vendorSubtotal })),
    ordersTruncated: s.orderCount > orders.length,
    adjustments: adjustments.map((a) => ({ amount: a.amount, reason: a.reason, createdAt: a.createdAt.toISOString() })),
    dishes: dishes.map((d) => ({ name: d.name, units: d.units, amount: d.vendorRevenue })),
  };
};
