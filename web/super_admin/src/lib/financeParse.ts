// ONE place that turns the backend's finance / settlement / payout responses into the shapes the dashboard uses (Docs/21 section 5).
// Real shapes: backend/src/routes/finance.ts, services/{settlement,finance,payoutAccount,payoutProvider}.ts.
// Parsers never throw. Unknown fields are ignored, a missing or non-numeric money field becomes 0 (never NaN), and an answer that is
// not even the right kind of object returns null so the caller can say so plainly.

import { asNum, unwrap } from './catalogParse';
import { rupees } from './pricing';

type Raw = Record<string, any>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => asNum(value) ?? 0;
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isObject) : []);
/** Money from the server is already rupees with at most 2 decimals; this only removes float noise. */
const money = (value: unknown): number => Math.round(num(value) * 100) / 100;

/** Rupees where the amount can be below 0 (adjustments, platform revenue): `-₹10.50`, not `₹-10.50`. */
export const rupeesSigned = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return rupees(value);
  const paise = Math.round(value * 100) + 0; // + 0 turns -0 into 0
  return paise < 0 ? `-${rupees(-paise / 100)}` : rupees(paise === 0 ? 0 : paise / 100);
};

// ───────────────────────────── India dates ─────────────────────────────

export interface DateRange { from: string; to: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const isDateString = (value: string): boolean => {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** Today's date on the India (Asia/Kolkata, UTC+5:30, no daylight saving) calendar. */
export const istToday = (nowMs: number = Date.now()): string => new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/** Number of days from..to inclusive. */
export const daysInRange = (range: DateRange): number => Math.round((new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / DAY_MS) + 1;

export type RangePreset = 'today' | '7d' | '30d';

export const presetRange = (preset: RangePreset, nowMs: number = Date.now()): DateRange => {
  const to = istToday(nowMs);
  return { from: preset === 'today' ? to : addDays(to, preset === '7d' ? -6 : -29), to };
};

/** Which preset (if any) a range equals, so the chip can show as pressed. */
export const presetOf = (range: DateRange, nowMs: number = Date.now()): RangePreset | null => {
  for (const preset of ['today', '7d', '30d'] as const) {
    const candidate = presetRange(preset, nowMs);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return null;
};

export type RangeCheck = { ok: true; range: DateRange } | { ok: false; message: string };

/** The server refuses a bad date, a reversed range and one that is too long; say it before the request. */
export const checkRange = (from: string, to: string, maxDays: number): RangeCheck => {
  if (!isDateString(from)) return { ok: false, message: 'Pick a valid start date (YYYY-MM-DD).' };
  if (!isDateString(to)) return { ok: false, message: 'Pick a valid end date (YYYY-MM-DD).' };
  if (from > to) return { ok: false, message: 'The start date cannot be after the end date.' };
  if (daysInRange({ from, to }) > maxDays) return { ok: false, message: `The range cannot be longer than ${maxDays} days.` };
  return { ok: true, range: { from, to } };
};

/** `2026-10-07` -> `7 Oct 2026` (no time zone shifts: the date is shown as written). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateLabel = (date: string): string => {
  if (!isDateString(date)) return date;
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
};

/** An ISO instant as an India date and time, `7 Oct 2026, 10:30 pm`. Empty text for a missing or broken value. */
export const istDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const shifted = new Date(t + 330 * 60_000);
  const hour24 = shifted.getUTCHours();
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dateLabel(shifted.toISOString().slice(0, 10))}, ${hour}:${minute} ${hour24 < 12 ? 'am' : 'pm'}`;
};

// ───────────────────────────── Finance analytics ─────────────────────────────

export interface RangeInfo { from: string; to: string; days: number }
export interface Refunds { count: number; amount: number }

export interface MoneyCols {
  orders: number;
  foodGross: number;
  /** What the restaurants earn (`vendorAmount` on the server). */
  vendorAmount: number;
  commission: number;
  feesCollected: number;
  discounts: number;
  platformRevenue: number;
}

const moneyCols = (r: Raw): MoneyCols => ({
  orders: Math.max(0, Math.round(num(r.orders))),
  foodGross: money(r.foodGross), vendorAmount: money(r.vendorAmount), commission: money(r.commission),
  feesCollected: money(r.feesCollected), discounts: money(r.discounts), platformRevenue: money(r.platformRevenue),
});
const refundsOf = (raw: unknown): Refunds => (isObject(raw) ? { count: Math.max(0, Math.round(num(raw.count))), amount: money(raw.amount) } : { count: 0, amount: 0 });
const rangeOf = (raw: unknown, fallback?: DateRange): RangeInfo => {
  const r = isObject(raw) ? raw : {};
  const from = str(r.from) ?? fallback?.from ?? '';
  const to = str(r.to) ?? fallback?.to ?? '';
  return { from, to, days: Math.round(num(r.days)) || (from && to && isDateString(from) && isDateString(to) ? daysInRange({ from, to }) : 0) };
};

export interface FinanceSummary extends MoneyCols {
  range: RangeInfo;
  customerPaid: number;
  refunds: Refunds;
  settledAmount: number;
  unsettledAmount: number;
  paidOutAmount: number;
}

/** `GET /admin/finance/summary`: `{ data: { range, orders, foodGross, ..., refunds: {count, amount}, settledAmount, unsettledAmount, paidOutAmount } }` */
export const parseFinanceSummary = (body: unknown, requested?: DateRange): FinanceSummary | null => {
  const data = unwrap(body);
  // `{ success: true }` alone is not a summary: showing zeros there would be an invented number.
  if (!isObject(data) || !['orders', 'foodGross', 'vendorAmount', 'platformRevenue', 'range'].some((key) => key in data)) return null;
  return {
    range: rangeOf(data.range, requested), ...moneyCols(data), customerPaid: money(data.customerPaid), refunds: refundsOf(data.refunds),
    settledAmount: money(data.settledAmount), unsettledAmount: money(data.unsettledAmount), paidOutAmount: money(data.paidOutAmount),
  };
};

export interface DayRow extends MoneyCols { date: string; refunds: Refunds }

/** `GET /admin/finance/by-day`: `{ range, data: [{ date, ...money, refunds }] }` (one row per India day, zeros included). */
export const parseByDay = (body: unknown, requested?: DateRange): { range: RangeInfo; rows: DayRow[] } | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  return {
    range: rangeOf(body.range, requested),
    rows: list(body.data).map((r) => ({ date: str(r.date) ?? '', ...moneyCols(r), refunds: refundsOf(r.refunds) })).filter((r) => r.date !== ''),
  };
};

export interface RestaurantRow extends MoneyCols { vendorId: string; vendorName: string; unsettledAmount: number; refunds: Refunds }

/** `GET /admin/finance/by-restaurant`: `{ range, limit, data: [{ vendorId, vendorName, ...money, unsettledAmount, refunds }] }` */
export const parseByRestaurant = (body: unknown, requested?: DateRange): { range: RangeInfo; rows: RestaurantRow[] } | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  return {
    range: rangeOf(body.range, requested),
    rows: list(body.data).map((r) => ({
      vendorId: String(r.vendorId ?? ''), vendorName: str(r.vendorName) ?? 'Unknown restaurant', ...moneyCols(r), unsettledAmount: money(r.unsettledAmount), refunds: refundsOf(r.refunds),
    })),
  };
};

export const DISH_SORTS = ['units', 'vendorRevenue', 'commission'] as const;
export type DishSort = (typeof DISH_SORTS)[number];

export interface FinanceDish {
  menuItemId: string | null;
  name: string;
  vendorId: string;
  vendorName: string;
  units: number;
  customerRevenue: number;
  vendorRevenue: number;
  commission: number;
}

/** `GET /admin/finance/by-dish`: `{ range, top, sort, data: [{ menuItemId, name, vendorId, vendorName, units, customerRevenue, vendorRevenue, commission }] }` */
export const parseByDish = (body: unknown, requested?: DateRange): { range: RangeInfo; sort: string; rows: FinanceDish[] } | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  return {
    range: rangeOf(body.range, requested),
    sort: str(body.sort) ?? 'units',
    rows: list(body.data).map((r) => ({
      menuItemId: str(r.menuItemId), name: str(r.name) ?? 'Dish', vendorId: String(r.vendorId ?? ''), vendorName: str(r.vendorName) ?? '',
      units: Math.max(0, Math.round(num(r.units))), customerRevenue: money(r.customerRevenue), vendorRevenue: money(r.vendorRevenue), commission: money(r.commission),
    })),
  };
};

export interface FinanceRider {
  driverUserId: string;
  name: string | null;
  runnerCode: string | null;
  deliveries: number;
  byDay: { date: string; deliveries: number }[];
  payouts: { count: number; total: number; lastAt: string | null };
}

export interface FinanceRiders {
  range: RangeInfo;
  totals: { riders: number; deliveries: number; payoutTotal: number };
  rows: FinanceRider[];
}

/** `GET /admin/finance/riders`: `{ range, limit, totals: { riders, deliveries, payoutTotal }, data: [{ driverUserId, name, runnerCode, deliveries, byDay, payouts }] }` */
export const parseRiders = (body: unknown, requested?: DateRange): FinanceRiders | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const rows = list(body.data).map((r): FinanceRider => ({
    driverUserId: String(r.driverUserId ?? ''), name: str(r.name), runnerCode: str(r.runnerCode), deliveries: Math.max(0, Math.round(num(r.deliveries))),
    byDay: list(r.byDay).map((d) => ({ date: str(d.date) ?? '', deliveries: Math.max(0, Math.round(num(d.deliveries))) })).filter((d) => d.date !== ''),
    payouts: { count: Math.max(0, Math.round(num(r.payouts?.count))), total: money(r.payouts?.total), lastAt: str(r.payouts?.lastAt) },
  })).filter((r) => r.driverUserId !== '');
  const t = isObject(body.totals) ? body.totals : {};
  return {
    range: rangeOf(body.range, requested),
    // the totals are the server's; if it did not send them, add up the rows we have
    totals: {
      riders: t.riders !== undefined ? Math.round(num(t.riders)) : rows.length,
      deliveries: t.deliveries !== undefined ? Math.round(num(t.deliveries)) : rows.reduce((a, r) => a + r.deliveries, 0),
      payoutTotal: t.payoutTotal !== undefined ? money(t.payoutTotal) : money(rows.reduce((a, r) => a + r.payouts.total, 0)),
    },
    rows,
  };
};

// ───────────────────────────── Payout accounts ─────────────────────────────

export interface PayoutAccount {
  userId: string;
  partnerType: string;
  method: string;
  upiId: string | null;
  accountHolder: string | null;
  accountLast4: string | null;
  /** `XXXXXX7890` as the server masks it. The full number never appears in this object. */
  accountMasked: string | null;
  ifsc: string | null;
  bankName: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  updatedAt: string | null;
}

/** The admin view (`adminAccountView`): masked, never the full number. */
export const parsePayoutAccount = (raw: unknown, fallbackUserId = ''): PayoutAccount | null => {
  if (!isObject(raw)) return null;
  const method = str(raw.method);
  if (!method) return null;
  const last4 = str(raw.accountLast4);
  return {
    userId: str(raw.userId) ?? fallbackUserId, partnerType: str(raw.partnerType) ?? '', method,
    upiId: str(raw.upiId), accountHolder: str(raw.accountHolder), accountLast4: last4, accountMasked: str(raw.accountMasked) ?? (last4 ? `XXXXXX${last4}` : null),
    ifsc: str(raw.ifsc), bankName: str(raw.bankName), verified: str(raw.verifiedAt) !== null, verifiedAt: str(raw.verifiedAt), verifiedBy: str(raw.verifiedBy), updatedAt: str(raw.updatedAt),
  };
};

export interface PartnerRef { userId: string; name: string; role: string }

export interface PayoutAccountResult {
  partner: PartnerRef | null;
  /** null = the partner has not saved payout details. */
  account: PayoutAccount | null;
  changed: boolean | null;
  message: string;
}

/** GET / PUT / PATCH verify: `{ success, changed?, message?, partner?, data: <admin view> | null }`. */
export const parsePayoutAccountResult = (body: unknown, userId = ''): PayoutAccountResult | null => {
  if (!isObject(body)) return null;
  const p = isObject(body.partner) ? body.partner : null;
  return {
    partner: p ? { userId: str(p.userId) ?? userId, name: str(p.name) ?? '', role: str(p.role) ?? '' } : null,
    account: parsePayoutAccount(body.data, userId),
    changed: typeof body.changed === 'boolean' ? body.changed : null,
    message: str(body.message) ?? '',
  };
};

export interface RevealedAccount {
  method: string;
  upiId: string | null;
  accountHolder: string | null;
  /** The full bank account number, or null for UPI. Keep it only while the dialog is open. */
  accountNumber: string | null;
  ifsc: string | null;
  bankName: string | null;
}

export const parseReveal = (body: unknown): RevealedAccount | null => {
  const data = unwrap(body);
  if (!isObject(data) || !str(data.method)) return null;
  return { method: String(data.method), upiId: str(data.upiId), accountHolder: str(data.accountHolder), accountNumber: str(data.accountNumber), ifsc: str(data.ifsc), bankName: str(data.bankName) };
};

/** What to show instead of the full number: the masked value, the UPI id, or nothing. */
export const accountSummary = (account: PayoutAccount | null): string => {
  if (!account) return '';
  if (account.method === 'UPI') return account.upiId ?? '';
  return account.accountMasked ?? '';
};

// ───────────────────────────── Settlements ─────────────────────────────

export const SETTLEMENT_STATUSES = ['PENDING', 'ON_HOLD', 'PAID', 'CANCELLED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const STATUS_LABEL: Record<SettlementStatus, string> = { PENDING: 'Pending', ON_HOLD: 'On hold', PAID: 'Paid', CANCELLED: 'Cancelled' };
export const isSettlementStatus = (value: unknown): value is SettlementStatus => typeof value === 'string' && (SETTLEMENT_STATUSES as readonly string[]).includes(value);

/** The masked payout destination copied onto a settlement when it was created (`payoutSnapshotOf`). */
export interface PayoutSnapshot {
  method: string;
  /** The UPI id, or the masked bank account (`XXXXXX4321`). */
  destination: string | null;
  accountHolder: string | null;
  ifsc: string | null;
  bankName: string | null;
  verified: boolean;
}

export interface Settlement {
  id: string;
  vendorId: string;
  vendorName: string;
  batchKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** One of SETTLEMENT_STATUSES; kept as text so a status added later still lists. */
  status: string;
  orderCount: number;
  foodGross: number;
  vendorAmount: number;
  commissionAmount: number;
  adjustmentTotal: number;
  netPayable: number;
  payoutSnapshot: PayoutSnapshot | null;
  hasPayoutDetails: boolean;
  paidAt: string | null;
  paymentReference: string | null;
  paidBy: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

const parseSnapshot = (raw: unknown): PayoutSnapshot | null => {
  if (!isObject(raw) || !str(raw.method)) return null;
  return { method: String(raw.method), destination: str(raw.destination), accountHolder: str(raw.accountHolder), ifsc: str(raw.ifsc), bankName: str(raw.bankName), verified: raw.verified === true };
};

export const parseSettlement = (raw: unknown): Settlement | null => {
  if (!isObject(raw) || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) return null;
  const snapshot = parseSnapshot(raw.payoutSnapshot);
  return {
    id: String(raw.id), vendorId: String(raw.vendorId ?? ''), vendorName: str(raw.vendorName) ?? 'Restaurant', batchKey: str(raw.batchKey) ?? '',
    periodStart: str(raw.periodStart), periodEnd: str(raw.periodEnd), status: str(raw.status)?.toUpperCase() ?? 'PENDING',
    orderCount: Math.max(0, Math.round(num(raw.orderCount))), foodGross: money(raw.foodGross), vendorAmount: money(raw.vendorAmount),
    commissionAmount: money(raw.commissionAmount), adjustmentTotal: money(raw.adjustmentTotal), netPayable: money(raw.netPayable),
    payoutSnapshot: snapshot, hasPayoutDetails: typeof raw.hasPayoutDetails === 'boolean' ? raw.hasPayoutDetails : snapshot !== null,
    paidAt: str(raw.paidAt), paymentReference: str(raw.paymentReference), paidBy: str(raw.paidBy), note: str(raw.note), createdBy: str(raw.createdBy), createdAt: str(raw.createdAt),
  };
};

export type StatusSummary = Record<SettlementStatus, { count: number; netPayable: number }>;

export interface SettlementPage {
  items: Settlement[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Counts and payable totals per status, for the CURRENT filter (a status filter leaves the other statuses at 0). */
  summary: StatusSummary;
}

export const emptySummary = (): StatusSummary => ({ PENDING: { count: 0, netPayable: 0 }, ON_HOLD: { count: 0, netPayable: 0 }, PAID: { count: 0, netPayable: 0 }, CANCELLED: { count: 0, netPayable: 0 } });

/** `GET /admin/settlements`: `{ total, page, pageSize, pages, summary: { PENDING: { count, netPayable }, ... }, data: [...], count }` */
export const parseSettlementPage = (body: unknown, requestedPage = 1): SettlementPage | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const items = body.data.map(parseSettlement).filter((s): s is Settlement => s !== null);
  const summary = emptySummary();
  if (isObject(body.summary)) for (const status of SETTLEMENT_STATUSES) {
    const s = body.summary[status];
    if (isObject(s)) summary[status] = { count: Math.max(0, Math.round(num(s.count))), netPayable: money(s.netPayable) };
  }
  const pageSize = Math.max(1, Math.round(num(body.pageSize)) || 25);
  const total = body.total !== undefined ? Math.max(0, Math.round(num(body.total))) : items.length;
  return { items, total, page: Math.max(1, Math.round(num(body.page)) || requestedPage), pageSize, pages: Math.max(1, Math.round(num(body.pages)) || Math.ceil(total / pageSize) || 1), summary };
};

/** The sidebar badge: how many settlements are PENDING (from the summary, else the filtered total). */
export const parsePendingSettlementCount = (body: unknown): number | null => {
  const page = parseSettlementPage(body);
  if (!page) return null;
  return page.summary.PENDING.count > 0 ? page.summary.PENDING.count : page.total;
};

export interface SettlementOrder {
  id: string;
  deliveredAt: string | null;
  subtotal: number;
  vendorSubtotal: number;
  commissionTotal: number;
  deliveryFee: number;
  taxAndPackaging: number;
  discount: number;
  totalAmount: number;
  couponCode: string | null;
}

export interface SettlementAdjustment { id: string; amount: number; reason: string; createdBy: string | null; createdAt: string | null }
export interface SettlementDish { menuItemId: string | null; name: string; units: number; vendorRevenue: number; commission: number }

export interface SettlementDetail {
  settlement: Settlement;
  vendor: { id: string; name: string; userId: string | null };
  /** The restaurant owner's CURRENT payout details (masked); null = none saved. */
  payoutAccount: PayoutAccount | null;
  orders: SettlementOrder[];
  ordersTruncated: boolean;
  adjustments: SettlementAdjustment[];
  dishes: SettlementDish[];
}

const parseAdjustment = (r: Raw): SettlementAdjustment => ({ id: String(r.id ?? ''), amount: money(r.amount), reason: str(r.reason) ?? '', createdBy: str(r.createdBy), createdAt: str(r.createdAt) });

/** `GET /admin/settlements/:id`: `{ data: { settlement, vendor: {id,name,userId}, payoutAccount, orders, ordersTruncated, adjustments, dishes } }` */
export const parseSettlementDetail = (body: unknown): SettlementDetail | null => {
  const data = unwrap(body);
  if (!isObject(data)) return null;
  const settlement = parseSettlement(data.settlement);
  if (!settlement) return null;
  const v = isObject(data.vendor) ? data.vendor : {};
  return {
    settlement,
    vendor: { id: str(v.id) ?? settlement.vendorId, name: str(v.name) ?? settlement.vendorName, userId: str(v.userId) },
    payoutAccount: parsePayoutAccount(data.payoutAccount, str(v.userId) ?? ''),
    orders: list(data.orders).map((o) => ({
      id: String(o.id ?? ''), deliveredAt: str(o.deliveredAt), subtotal: money(o.subtotal), vendorSubtotal: money(o.vendorSubtotal), commissionTotal: money(o.commissionTotal),
      deliveryFee: money(o.deliveryFee), taxAndPackaging: money(o.taxAndPackaging), discount: money(o.discount), totalAmount: money(o.totalAmount), couponCode: str(o.couponCode),
    })),
    ordersTruncated: data.ordersTruncated === true,
    adjustments: list(data.adjustments).map(parseAdjustment),
    dishes: list(data.dishes).map((d) => ({ menuItemId: str(d.menuItemId), name: str(d.name) ?? 'Dish', units: Math.max(0, Math.round(num(d.units))), vendorRevenue: money(d.vendorRevenue), commission: money(d.commission) })),
  };
};

export interface SettlementAction {
  /** The settlement after the action (null if the server answered without one). */
  settlement: Settlement | null;
  /** false = nothing changed (a double click, or already in that state). */
  changed: boolean;
  message: string;
  freedOrders: number | null;
  adjustment: SettlementAdjustment | null;
}

/** mark-paid / hold / release / adjustments / cancel: `{ success, changed, message, data: <settlement>, freedOrders?, adjustment? }` */
export const parseSettlementAction = (body: unknown): SettlementAction => {
  const b = isObject(body) ? body : {};
  return {
    settlement: parseSettlement(b.data),
    changed: b.changed !== false,
    message: str(b.message) ?? '',
    freedOrders: b.freedOrders !== undefined ? Math.max(0, Math.round(num(b.freedOrders))) : null,
    adjustment: isObject(b.adjustment) ? parseAdjustment(b.adjustment) : null,
  };
};

export interface RunResult {
  message: string;
  created: Settlement[];
  skipped: { vendorId: string; reason: string }[];
  failed: { vendorId: string }[];
  orderCount: number;
  netPayable: number;
  holdDays: number | null;
  deliveredBy: string | null;
}

/** `POST /admin/settlements/run`: `{ message, data: { cutoff, holdDays, deliveredBy, created: [...], skipped, failed, orderCount, netPayable } }` */
export const parseRunResult = (body: unknown): RunResult => {
  const b = isObject(body) ? body : {};
  const d = isObject(b.data) ? b.data : {};
  const created = Array.isArray(d.created) ? d.created.map(parseSettlement).filter((s): s is Settlement => s !== null) : [];
  return {
    message: str(b.message) ?? '',
    created,
    skipped: list(d.skipped).map((s) => ({ vendorId: String(s.vendorId ?? ''), reason: str(s.reason) ?? '' })),
    failed: list(d.failed).map((s) => ({ vendorId: String(s.vendorId ?? '') })),
    orderCount: Math.max(0, Math.round(num(d.orderCount))),
    netPayable: money(d.netPayable),
    holdDays: d.holdDays !== undefined ? Math.round(num(d.holdDays)) : null,
    deliveredBy: str(d.deliveredBy),
  };
};

// ───────────────────────────── Rider payout ledger ─────────────────────────────

export const RIDER_PAYOUT_METHODS = ['UPI', 'BANK', 'CASH'] as const;
export type RiderPayoutMethod = (typeof RIDER_PAYOUT_METHODS)[number];

export interface RiderPayout {
  id: string;
  driverUserId: string;
  driverName: string | null;
  amount: number;
  method: string;
  reference: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export const parseRiderPayout = (raw: unknown): RiderPayout | null => {
  if (!isObject(raw) || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) return null;
  return {
    id: String(raw.id), driverUserId: String(raw.driverUserId ?? ''), driverName: str(raw.driverName), amount: money(raw.amount), method: str(raw.method) ?? '',
    reference: str(raw.reference), periodStart: str(raw.periodStart), periodEnd: str(raw.periodEnd), note: str(raw.note), createdBy: str(raw.createdBy), createdAt: str(raw.createdAt),
  };
};

export interface RiderPayoutPage { items: RiderPayout[]; total: number; page: number; pages: number; pageSize: number; totalAmount: number }

/** `GET /admin/rider-payouts`: `{ total, page, pageSize, pages, totalAmount, data: [...] }` */
export const parseRiderPayoutPage = (body: unknown, requestedPage = 1): RiderPayoutPage | null => {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const items = body.data.map(parseRiderPayout).filter((p): p is RiderPayout => p !== null);
  const pageSize = Math.max(1, Math.round(num(body.pageSize)) || 25);
  const total = body.total !== undefined ? Math.max(0, Math.round(num(body.total))) : items.length;
  return {
    items, total, pageSize, page: Math.max(1, Math.round(num(body.page)) || requestedPage),
    pages: Math.max(1, Math.round(num(body.pages)) || Math.ceil(total / pageSize) || 1),
    totalAmount: body.totalAmount !== undefined ? money(body.totalAmount) : money(items.reduce((a, p) => a + p.amount, 0)),
  };
};

/** `POST /admin/rider-payouts`: `{ changed, message, data: <payout> }` (201 when new, 200 when the same reference was recorded already). */
export const parseRiderPayoutResult = (body: unknown): { payout: RiderPayout | null; changed: boolean; message: string } => {
  const b = isObject(body) ? body : {};
  return { payout: parseRiderPayout(b.data), changed: b.changed !== false, message: str(b.message) ?? '' };
};

// ───────────────────────────── Payout providers ─────────────────────────────

export interface PayoutProvider { name: string; enabled: boolean; reason: string | null }

/** `GET /admin/payout-providers`: `{ data: [{ name: 'manual', enabled: true, reason: null }, { name: 'razorpayx', enabled: false, reason }] }` */
export const parseProviders = (body: unknown): PayoutProvider[] | null => {
  const data = unwrap(body);
  if (!Array.isArray(data)) return null;
  return list(data).filter((p) => str(p.name)).map((p) => ({ name: String(p.name), enabled: p.enabled === true, reason: str(p.reason) }));
};

// ───────────────────────────── Settlement settings ─────────────────────────────

export interface SettlementSettings {
  /** HH:MM India time; null when the server did not report it. */
  time: string | null;
  mode: 'MANUAL_PAYOUT' | 'AUTO_PAYOUT' | null;
  autoCreate: boolean | null;
  holdDays: number | null;
}

/** The `value` of `GET /admin/settings/settlement`: `{ time, mode, autoCreate, holdDays }`. */
export const parseSettlementSettings = (raw: unknown): SettlementSettings => {
  const r = isObject(raw) ? raw : {};
  const hold = asNum(r.holdDays);
  return {
    time: typeof r.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : null,
    mode: r.mode === 'MANUAL_PAYOUT' || r.mode === 'AUTO_PAYOUT' ? r.mode : null,
    autoCreate: typeof r.autoCreate === 'boolean' ? r.autoCreate : null,
    holdDays: hold !== null && Number.isInteger(hold) ? hold : null,
  };
};
