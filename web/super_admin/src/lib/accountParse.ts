// Docs/28 "Implementation notes": parsers for the admin user-management answers (customers, riders, restaurants, owner logins).
// Defensive on purpose: unknown fields are ignored, a missing or bad number becomes 0 (never NaN), a missing list becomes [].
// No React in here, so the wording and the decisions are unit-tested with real server JSON (src/test/adminFixtures.ts).
import type { CustomerDetail, CustomerOrder, CustomerRow } from '../types';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'REMOVED';

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
export const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
export const num = (v: unknown, fallback = 0): number => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const iso = (v: unknown): string | null => {
  const t = text(v);
  return t && Number.isFinite(Date.parse(t)) ? t : null;
};
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export const accountStatus = (v: unknown): AccountStatus => (v === 'SUSPENDED' || v === 'REMOVED' ? v : 'ACTIVE');

// ───────────────────────── blocking orders and action outcomes ─────────────────────────
export interface BlockOrder { id: string; status: string | null; paymentStatus: string | null; totalAmount: number | null; groupId: string | null }

/** The `openOrders` / `orders` / `activeDeliveries` lists of the 409 answers: objects, or (REFUND_NOT_SETTLED) plain order ids. */
export const parseBlockOrders = (raw: unknown): BlockOrder[] => list(raw).flatMap((item) => {
  if (typeof item === 'string' && item) return [{ id: item, status: null, paymentStatus: null, totalAmount: null, groupId: null }];
  const o = obj(item);
  const id = text(o?.id) ?? text(o?.orderId);
  if (!o || !id) return [];
  return [{ id, status: text(o.status), paymentStatus: text(o.paymentStatus), totalAmount: o.totalAmount === undefined || o.totalAmount === null ? null : num(o.totalAmount), groupId: text(o.groupId) }];
});

/** NONE = unpaid, DONE = money is back, STARTED = recorded, the automatic retry finishes it, FAILED = see refundMessage. UNKNOWN = a value this dashboard does not know. */
export type RefundState = 'NONE' | 'DONE' | 'STARTED' | 'FAILED' | 'UNKNOWN';
export interface CancelResult { orderId: string; groupId: string | null; cancelledOrders: number; refund: RefundState; refundMessage: string | null }
export interface CancelFailure { orderId: string; code: string; message: string }

export interface Outcome {
  /** false = the server found nothing to change (already in that state). */
  changed: boolean;
  cancelled: CancelResult[];
  failed: CancelFailure[];
  released: string[];
  releaseFailed: CancelFailure[];
  /** Orders the server did not start (it cancels at most 25 per request): call the same action again to continue. */
  remaining: string[];
  warning: string | null;
}

const parseFailures = (raw: unknown): CancelFailure[] => list(raw).flatMap((item) => {
  if (typeof item === 'string') return [{ orderId: item, code: '', message: '' }];
  const o = obj(item);
  const orderId = text(o?.orderId) ?? text(o?.id);
  return o && orderId ? [{ orderId, code: text(o.code) ?? '', message: text(o.message) ?? '' }] : [];
});

/** What the suspend / remove / restore answers carry besides `data`. */
export const parseOutcome = (raw: unknown): Outcome => {
  const b = obj(raw) ?? {};
  return {
    changed: b.changed !== false,
    cancelled: list(b.cancelled).flatMap((item) => {
      const o = obj(item);
      const orderId = text(o?.orderId);
      const refund: RefundState = o?.refund === 'NONE' || o?.refund === 'DONE' || o?.refund === 'STARTED' || o?.refund === 'FAILED' ? o.refund : 'UNKNOWN';
      return o && orderId ? [{ orderId, groupId: text(o.groupId), cancelledOrders: Math.max(1, num(o.cancelledOrders, 1)), refund, refundMessage: text(o.refundMessage) }] : [];
    }),
    failed: parseFailures(b.failed),
    released: list(b.released).filter((x): x is string => typeof x === 'string'),
    releaseFailed: parseFailures(b.releaseFailed),
    remaining: list(b.remaining).filter((x): x is string => typeof x === 'string' && x.length > 0),
    warning: text(b.warning),
  };
};

/** Adds the next batch to what was already done: cancelled orders add up, `failed` / `remaining` are the newest answer's. */
export const mergeOutcome = (before: Outcome, next: Outcome): Outcome => ({
  changed: before.changed || next.changed,
  cancelled: [...before.cancelled, ...next.cancelled.filter((c) => !before.cancelled.some((b) => b.orderId === c.orderId))],
  failed: next.failed,
  released: [...new Set([...before.released, ...next.released])],
  releaseFailed: next.releaseFailed,
  remaining: next.remaining,
  warning: next.warning ?? before.warning,
});

/** Wording of one refund result, in plain words. */
export const refundText = (c: Pick<CancelResult, 'refund' | 'refundMessage'>): string => {
  switch (c.refund) {
    case 'NONE': return 'nothing to refund';
    case 'DONE': return 'refund done, the money is back';
    case 'STARTED': return 'refund queued, will retry automatically';
    case 'FAILED': return `refund failed${c.refundMessage ? `: ${c.refundMessage}` : ''}. The order stays cancelled; the admin can retry it from Needs attention`;
    default: return 'refund state not known, check Needs attention';
  }
};

/** Something happened beyond "it worked": orders were cancelled or handed back, or some of that failed. */
export const outcomeNeedsNotice = (o: Outcome): boolean => o.cancelled.length > 0 || o.failed.length > 0 || o.released.length > 0 || o.releaseFailed.length > 0 || o.remaining.length > 0;

// ───────────────────────── customers ─────────────────────────
export type CustomerStatusFilter = 'ACTIVE' | 'SUSPENDED' | 'REMOVED' | 'ALL';
/** Row/drawer state: DELETED = the customer deleted the account themselves (never restorable). */
export type CustomerState = 'ACTIVE' | 'SUSPENDED' | 'REMOVED' | 'DELETED';
export const customerState = (c: { accountStatus: AccountStatus; deleted: boolean }): CustomerState => (c.deleted && c.accountStatus !== 'REMOVED' ? 'DELETED' : c.accountStatus);

const customerBase = (o: Record<string, any>) => ({
  id: text(o.id) ?? '',
  name: text(o.name) ?? 'Unnamed customer',
  email: text(o.email),
  phone: text(o.phone),
  isStudent: typeof o.isStudent === 'boolean' ? o.isStudent : null,
  hostelBlock: text(o.hostelBlock),
  avatarId: o.avatarId === null || o.avatarId === undefined ? null : num(o.avatarId, 0),
  kraveoCoins: num(o.kraveoCoins),
  createdAt: iso(o.createdAt) ?? '',
  deleted: o.deleted === true,
  accountStatus: accountStatus(o.accountStatus),
  statusReason: text(o.statusReason),
  statusChangedAt: iso(o.statusChangedAt),
  lastLoginAt: iso(o.lastLoginAt),
});

export const parseCustomerRow = (raw: unknown): CustomerRow | null => {
  const o = obj(raw);
  if (!o || !text(o.id)) return null;
  return {
    ...customerBase(o),
    ordersCount: num(o.ordersCount),
    totalSpent: num(o.totalSpent),
    lastOrderAt: iso(o.lastOrderAt),
    // On the row `openOrders` is a COUNT; an older server sends none.
    openOrders: Array.isArray(o.openOrders) ? o.openOrders.length : Math.max(0, num(o.openOrders)),
  };
};

export const parseCustomerList = (raw: unknown): { total: number; nextCursor: string | null; data: CustomerRow[] } | null => {
  const o = obj(raw);
  if (!o || !Array.isArray(o.data)) return null;
  const data = o.data.map(parseCustomerRow).filter((r: CustomerRow | null): r is CustomerRow => r !== null);
  return { total: Math.max(num(o.total, data.length), 0), nextCursor: text(o.nextCursor), data };
};

const parseCustomerOrder = (raw: unknown): CustomerOrder | null => {
  const o = obj(raw);
  const id = text(o?.id);
  if (!o || !id) return null;
  const vendor = obj(o.vendor);
  const driver = obj(o.driver);
  return {
    id,
    status: (text(o.status) ?? 'PLACED') as CustomerOrder['status'],
    paymentStatus: (text(o.paymentStatus) ?? 'PENDING') as CustomerOrder['paymentStatus'],
    totalAmount: num(o.totalAmount),
    deliveryFee: num(o.deliveryFee),
    dropoffHostel: text(o.dropoffHostel) ?? '',
    dropoffNotes: text(o.dropoffNotes),
    createdAt: iso(o.createdAt) ?? '',
    vendor: vendor && text(vendor.id) ? { id: text(vendor.id)!, name: text(vendor.name) ?? 'Restaurant' } : null,
    driver: driver && text(driver.id) ? { id: text(driver.id)!, name: text(driver.name) ?? 'Rider', phone: text(driver.phone) } : null,
    items: list(o.items).flatMap((i) => { const it = obj(i); return it ? [{ name: text(it.name) ?? 'Item', quantity: num(it.quantity, 1), price: num(it.price) }] : []; }),
    payments: list(o.payments).flatMap((p) => {
      const pay = obj(p);
      return pay ? [{ id: text(pay.id) ?? '', razorpayPaymentId: text(pay.razorpayPaymentId), amount: num(pay.amount), status: (text(pay.status) ?? 'PENDING') as CustomerOrder['payments'][number]['status'], createdAt: iso(pay.createdAt) ?? '' }] : [];
    }),
  };
};

export const parseCustomerDetail = (raw: unknown): CustomerDetail | null => {
  const o = obj(raw);
  if (!o || !text(o.id)) return null;
  const s = obj(o.stats) ?? {};
  const orders = list(o.orders).map(parseCustomerOrder).filter((x): x is CustomerOrder => x !== null);
  return {
    ...customerBase(o),
    statusChangedBy: text(o.statusChangedBy),
    openOrders: parseBlockOrders(o.openOrders),
    refundsOwed: list(o.refundsOwed).flatMap((r) => {
      const x = obj(r);
      const orderId = text(x?.orderId);
      return x && orderId ? [{ orderId, refundStatus: text(x.refundStatus) ?? 'PENDING', amount: num(x.amount) }] : [];
    }),
    stats: {
      ordersCount: num(s.ordersCount, orders.length),
      deliveredCount: num(s.deliveredCount),
      cancelledCount: num(s.cancelledCount),
      activeCount: num(s.activeCount),
      paidOrdersCount: num(s.paidOrdersCount),
      totalSpent: num(s.totalSpent),
      firstOrderAt: iso(s.firstOrderAt),
      lastOrderAt: iso(s.lastOrderAt),
    },
    orders,
  };
};

// ───────────────────────── riders ─────────────────────────
export interface RiderImpact {
  driverId: string;
  userId: string | null;
  name: string;
  approvalStatus: string;
  accountStatus: AccountStatus | null;
  activeDeliveries: BlockOrder[];
  foodWithRider: BlockOrder[];
}

export const parseRiderImpact = (raw: unknown): RiderImpact | null => {
  const o = obj(raw);
  if (!o || !text(o.driverId)) return null;
  return {
    driverId: text(o.driverId)!,
    userId: text(o.userId),
    name: text(o.name) ?? 'Rider',
    approvalStatus: text(o.approvalStatus) ?? 'APPROVED',
    accountStatus: o.accountStatus === null || o.accountStatus === undefined ? null : accountStatus(o.accountStatus),
    activeDeliveries: parseBlockOrders(o.activeDeliveries),
    foodWithRider: parseBlockOrders(o.foodWithRider),
  };
};

// ───────────────────────── restaurants and their owner login ─────────────────────────
export interface VendorImpact {
  vendorId: string;
  name: string;
  approvalStatus: string;
  removed: boolean;
  isAcceptingOrders: boolean;
  hasOwner: boolean;
  openOrders: BlockOrder[];
  inDelivery: BlockOrder[];
  unpaidSettlements: { count: number; amount: number };
}

export const parseVendorImpact = (raw: unknown): VendorImpact | null => {
  const o = obj(raw);
  if (!o || !text(o.vendorId)) return null;
  const u = obj(o.unpaidSettlements) ?? {};
  return {
    vendorId: text(o.vendorId)!,
    name: text(o.name) ?? 'Restaurant',
    approvalStatus: text(o.approvalStatus) ?? 'APPROVED',
    removed: o.removed === true,
    isAcceptingOrders: o.isAcceptingOrders === true,
    hasOwner: o.hasOwner === true,
    openOrders: parseBlockOrders(o.openOrders),
    inDelivery: parseBlockOrders(o.inDelivery),
    unpaidSettlements: { count: Math.max(0, num(u.count)), amount: Math.max(0, num(u.amount)) },
  };
};

export interface OwnerInfo {
  id: string;
  name: string;
  phone: string | null;
  accountStatus: AccountStatus;
  statusReason: string | null;
  lastLoginAt: string | null;
}

/** The `owner` block of an admin restaurant row (`id`) or of the owner endpoints (`userId`). null = no owner. */
export const parseOwner = (raw: unknown): OwnerInfo | null => {
  const o = obj(raw);
  const id = text(o?.userId) ?? text(o?.id);
  if (!o || !id) return null;
  return { id, name: text(o.name) ?? 'Owner', phone: text(o.phone), accountStatus: accountStatus(o.accountStatus), statusReason: text(o.statusReason), lastLoginAt: iso(o.lastLoginAt) };
};

export interface OwnerResult {
  owner: OwnerInfo | null;
  changed: boolean;
  /** Only when the server made the password. Hand it to the credential dialog and drop it: nothing else may keep it. */
  generatedPassword: string | null;
  /** When the server made the password (reset answers). The newest one is the one that works. */
  issuedAt: string | null;
  restaurantClosed: boolean;
  payoutAccountMoved: boolean;
  openOrders: number;
  warning: string | null;
  detachedUser: { id: string; name: string } | null;
  outcome: Outcome;
}

export const parseOwnerResult = (raw: unknown): OwnerResult => {
  const b = obj(raw) ?? {};
  const d = obj(b.detachedUser);
  return {
    owner: parseOwner(b.owner),
    changed: b.changed !== false,
    generatedPassword: text(b.generatedPassword),
    issuedAt: iso(b.issuedAt),
    restaurantClosed: b.restaurantClosed === true,
    payoutAccountMoved: b.payoutAccountMoved === true,
    openOrders: Math.max(0, num(b.openOrders)),
    warning: text(b.warning),
    detachedUser: d && text(d.id) ? { id: text(d.id)!, name: text(d.name) ?? 'Owner' } : null,
    outcome: parseOutcome(b),
  };
};

// ───────────────────────── the 409 answers as dialog content ─────────────────────────
export interface BlockChoice { label: string; detail?: string; submitLabel: string }
export interface BlockInfo {
  code: string;
  message: string;
  orders: BlockOrder[];
  /** Present = the admin may resolve the block with this action. Absent = nothing to choose: wait, or fix it elsewhere. */
  choice?: BlockChoice;
}

export type BlockKind = 'customer' | 'rider' | 'vendor';

/**
 * The 409 codes that name blocking orders, as dialog content. null for any other error.
 * `verb` is the action in the button ("suspend", "remove"): the explicit choice reads "Cancel the orders, refund, then <verb>".
 */
export const blockFromError = (error: unknown, kind: BlockKind, verb: string): BlockInfo | null => {
  const e = error as { status?: number; code?: string; message?: string; extra?: Record<string, unknown> } | null;
  if (!e || e.status !== 409 || !e.code) return null;
  const ex = e.extra ?? {};
  const message = e.message || 'This cannot be done while orders are in progress.';
  switch (e.code) {
    case 'HAS_OPEN_ORDERS': {
      const orders = parseBlockOrders(ex.openOrders ?? ex.orders);
      return {
        code: e.code, message, orders,
        choice: {
          label: kind === 'customer' ? 'Cancel these orders and refund the customer' : 'Cancel these orders and refund the customers',
          detail: `Paid orders are refunded to the original payment method. Orders that are already with a rider are never cancelled.${kind === 'vendor' ? " A combined order is cancelled as a whole, including the other restaurants' parts." : ''}`,
          submitLabel: `Cancel the orders and refund, then ${verb}`,
        },
      };
    }
    case 'HAS_ACTIVE_DELIVERY':
      return {
        code: e.code, message, orders: parseBlockOrders(ex.orders),
        choice: { label: 'Hand the deliveries back to the pool', detail: 'Another rider can pick them up. The orders are not cancelled. Food that is already picked up is never handed back.', submitLabel: `Hand the deliveries back, then ${verb}` },
      };
    case 'ORDER_IN_DELIVERY':
    case 'FOOD_WITH_RIDER':
    case 'REFUND_NOT_SETTLED':
      return { code: e.code, message, orders: parseBlockOrders(ex.orders ?? ex.openOrders) };
    default:
      return null;
  }
};

const ON_THE_WAY = ['PICKED_UP', 'ARRIVED_AT_GATE'];

/**
 * The block we already know about before sending (the person's open orders from the detail / impact answer), as the same panel the
 * 409 shows. Food that is already with a rider can never be cancelled, so then there is no choice, only "wait". null = nothing in the way.
 * The server still checks again and may answer 409 with its own list.
 */
export const knownBlock = (orders: BlockOrder[], kind: 'customer' | 'vendor', verb: string): BlockInfo | null => {
  if (orders.length === 0) return null;
  const onTheWay = orders.filter((o) => o.status !== null && ON_THE_WAY.includes(o.status));
  const code = onTheWay.length ? 'ORDER_IN_DELIVERY' : 'HAS_OPEN_ORDERS';
  const message = onTheWay.length
    ? `An order is with a rider right now (${onTheWay.map((o) => `#${o.id.slice(-6).toUpperCase()}`).join(', ')}). Wait until it is delivered${kind === 'customer' ? ', or have the rider return it,' : ','} then try again.`
    : `${kind === 'customer' ? 'They have' : 'This restaurant has'} ${orders.length} order${orders.length === 1 ? '' : 's'} in progress.`;
  return blockFromError({ status: 409, code, message, extra: { orders } }, kind, verb) ?? { code, message, orders };
};

/** The rider's deliveries (from the impact answer) as the same panel the 409 shows. Food already picked up can only be reassigned or cancelled elsewhere. */
export const riderKnownBlock = (impact: RiderImpact, verb: string): BlockInfo | null => {
  if (impact.foodWithRider.length > 0) {
    return blockFromError({ status: 409, code: 'FOOD_WITH_RIDER', message: `${impact.name} is carrying food right now. Reassign the order to another rider or cancel it first.`, extra: { orders: impact.foodWithRider } }, 'rider', verb);
  }
  if (impact.activeDeliveries.length > 0) {
    const n = impact.activeDeliveries.length;
    return blockFromError({ status: 409, code: 'HAS_ACTIVE_DELIVERY', message: `${impact.name} has ${n} delivery${n === 1 ? '' : 'ies'} in hand. Reassign ${n === 1 ? 'it' : 'them'} first, or hand ${n === 1 ? 'it' : 'them'} back to the pool with this action.`, extra: { orders: impact.activeDeliveries } }, 'rider', verb);
  }
  return null;
};

/** The restaurant's orders (from the impact answer) as the same panel the 409 shows. Orders already with a rider are never cancelled: then there is only "wait". */
export const vendorKnownBlock = (impact: VendorImpact, verb: string): BlockInfo | null => {
  if (impact.inDelivery.length > 0) {
    return blockFromError({ status: 409, code: 'ORDER_IN_DELIVERY', message: 'An order is with a rider right now, so it cannot be cancelled. Wait until it is delivered, then try again.', extra: { orders: impact.inDelivery } }, 'vendor', verb);
  }
  return knownBlock(impact.openOrders, 'vendor', verb);
};

/** true when `incoming` was issued BEFORE `shown`: an answer that arrived out of order must not replace the newer password. Unknown times count as not older. */
export const isOlderIssue = (incoming: string | null, shown: string | null): boolean => {
  const a = incoming ? Date.parse(incoming) : NaN;
  const b = shown ? Date.parse(shown) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
};
