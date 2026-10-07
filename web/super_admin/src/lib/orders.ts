// Pure order rules for the dashboard (no React). Mirrors Docs/16_order_flow_contract.md sections 1-4.
// The server stays authoritative: these helpers only decide what to show and which buttons make sense.
import { DriverPartner, Order, OrderStatus, PaymentStatus, orderFromPartial } from '../types';

/** Contract 1.3 defaults. The server may run with other values; these only drive hints, never decisions. */
export const SLA = { PAYMENT_WINDOW_MIN: 15, VENDOR_ACCEPT_WINDOW_MIN: 10, PICKUP_WAIT_MIN: 15 } as const;

export const isTerminal = (status: string): boolean => status === 'DELIVERED' || status === 'CANCELLED';
export const isUnpaid = (order: Pick<Order, 'paymentStatus'>): boolean => order.paymentStatus === 'PENDING' || order.paymentStatus === 'FAILED';
/** Open order that the customer has not paid for yet (the restaurant and riders cannot see it). */
export const isUnpaidOpen = (order: Pick<Order, 'paymentStatus' | 'status'>): boolean => isUnpaid(order) && !isTerminal(order.status);

const ts = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export const minutesSince = (iso: string | null | undefined, now: number): number | null => {
  const t = ts(iso);
  return t === null ? null : (now - t) / 60000;
};

// ───────────────────────── Live merge (contract 3: merge by updatedAt) ─────────────────────────

/**
 * True when `incoming` must not overwrite `current`:
 * - it carries an older `updatedAt`, or
 * - it would move a finished order (DELIVERED / CANCELLED, which are final) back to a live status without being newer.
 */
export const isOlder = (current: Pick<Order, 'updatedAt' | 'status'>, incoming: Partial<Pick<Order, 'updatedAt' | 'status'>>): boolean => {
  const a = ts(current.updatedAt);
  const b = ts(incoming.updatedAt);
  if (a !== null && b !== null) {
    if (b < a) return true;
    if (b > a) return false;
  }
  return isTerminal(current.status) && incoming.status !== undefined && !isTerminal(incoming.status);
};

/** Inserts or merges a live order event. Returns the same array when nothing changed (so React can skip a render). */
export const upsertOrder = (list: Order[], incoming: Partial<Order> & { id: string }): Order[] => {
  if (!incoming.id) return list;
  const index = list.findIndex((order) => order.id === incoming.id);
  if (index === -1) return [orderFromPartial(incoming), ...list];
  const current = list[index];
  if (isOlder(current, incoming)) return list;
  const next = list.slice();
  next[index] = { ...current, ...incoming };
  return next;
};

/** Merges one order into a single optional slot (the detail drawer's fallback copy). */
export const mergeInto = (current: Order | null, incoming: Partial<Order> & { id: string }): Order | null => {
  if (!current || current.id !== incoming.id) return current;
  return isOlder(current, incoming) ? current : { ...current, ...incoming };
};

/**
 * Replaces the list with a fresh REST page without losing newer live data:
 * - for an order in both, the copy with the newer `updatedAt` wins;
 * - an order only known locally is kept when it is newer than everything on the page (it arrived over the socket
 *   while the request was in flight); older local-only orders have simply scrolled out of the page and are dropped.
 */
export const mergeOrderLists = (local: Order[], fetched: Order[], opts: { keepOlder?: boolean } = {}): Order[] => {
  const localById = new Map(local.map((order) => [order.id, order]));
  const fetchedIds = new Set(fetched.map((order) => order.id));
  const merged = fetched.map((order) => {
    const mine = localById.get(order.id);
    return mine && isOlder(mine, order) ? mine : order;
  });
  const newestFetched = fetched.reduce((max, order) => Math.max(max, ts(order.createdAt) ?? 0), 0);
  const arrivedMeanwhile = local.filter((order) => !fetchedIds.has(order.id) && (fetched.length === 0 || (ts(order.createdAt) ?? 0) > newestFetched));
  if (!opts.keepOlder || fetched.length === 0) return [...arrivedMeanwhile, ...merged];
  // The admin loaded older pages ("Load older"): orders older than this page stay, otherwise the next poll would drop them again.
  const oldestFetched = fetched.reduce((min, order) => Math.min(min, ts(order.createdAt) ?? Infinity), Infinity);
  const olderKept = local.filter((order) => !fetchedIds.has(order.id) && (ts(order.createdAt) ?? 0) <= oldestFetched);
  return [...arrivedMeanwhile, ...merged, ...olderKept];
};

/** Adds an older page (from "Load older") below the loaded list; an order already loaded keeps its newer copy. Same array when nothing was added. */
export const appendOlderPage = (local: Order[], page: Order[]): Order[] => {
  const known = new Set(local.map((order) => order.id));
  const added = page.filter((order) => !known.has(order.id));
  return added.length ? [...local, ...added] : local;
};

/** The id to continue from when loading older orders: the oldest loaded one (the server lists newest first). */
export const oldestOrderId = (orders: Order[]): string | null => {
  let oldest: Order | null = null;
  for (const order of orders) {
    if (!oldest || (ts(order.createdAt) ?? Infinity) < (ts(oldest.createdAt) ?? Infinity)) oldest = order;
  }
  return oldest?.id ?? null;
};

/**
 * Optimistic rollback for one order: put the snapshot back only if the server has not sent anything newer in the
 * meantime (an optimistic patch never touches `updatedAt`, so an unchanged `updatedAt` means "still our guess").
 */
export const restoreIfUntouched = (list: Order[], snapshot: Order): Order[] => list.map((order) => (
  order.id === snapshot.id && (order.updatedAt ?? '') === (snapshot.updatedAt ?? '') ? snapshot : order
));

export const patchOrder = (list: Order[], id: string, patch: Partial<Order>): Order[] => list.map((order) => (order.id === id ? { ...order, ...patch } : order));

// ───────────────────────── What an admin may do right now ─────────────────────────

const FORWARD: Record<OrderStatus, OrderStatus | null> = {
  PLACED: 'ACCEPTED',
  ACCEPTED: 'PREPARING',
  PREPARING: 'READY_FOR_PICKUP',
  READY_FOR_PICKUP: 'PICKED_UP',
  PICKED_UP: 'ARRIVED_AT_GATE',
  ARRIVED_AT_GATE: 'DELIVERED',
  DELIVERED: null,
  CANCELLED: null,
};

export interface NextStep {
  status: OrderStatus;
  /** Why the step is blocked right now, or null when it can be taken. */
  blockedReason: string | null;
}

/** The single next status (the server refuses skipped states, contract 1.1). Cancelling is a separate action. */
export const nextStep = (order: Order, otp = ''): NextStep | null => {
  const status = FORWARD[order.status as OrderStatus];
  if (!status) return null;
  let blockedReason: string | null = null;
  if (status === 'ACCEPTED' && order.paymentStatus !== 'PAID') blockedReason = 'Not paid yet';
  else if (status === 'PICKED_UP' && !order.driverId) blockedReason = 'Assign a rider first';
  else if (status === 'DELIVERED' && order.otpLocked) blockedReason = 'OTP locked: reset it first';
  else if (status === 'DELIVERED' && !/^\d{4}$/.test(otp)) blockedReason = 'Enter the 4-digit gate OTP';
  return { status, blockedReason };
};

const RIDER_PROGRESS: Record<string, number> = { ACCEPTED: 1, PREPARING: 2, READY_FOR_PICKUP: 3, PICKED_UP: 4, ARRIVED_AT_GATE: 5 };

/**
 * One rider can hold several orders: the parts of a combined order (Docs/22) or, if the server allows it, separate orders.
 * When a rider has two parts of the SAME combined order, the map and the runner list show one entry: the most advanced part
 * (the rider is already delivering once any part is picked up), the primary part on a tie. Otherwise the later order wins, as before.
 */
export const preferRiderOrder = (candidate: Order, current: Order): boolean => {
  const sameGroup = Boolean(candidate.group && current.group && candidate.group.id === current.group.id);
  if (!sameGroup) return true;
  const a = RIDER_PROGRESS[candidate.status] ?? 0;
  const b = RIDER_PROGRESS[current.status] ?? 0;
  if (a !== b) return a > b;
  return Boolean(candidate.group!.primary) && !current.group!.primary;
};

/** "#ABC123 to BH2", or "Combined order (3 restaurants) to BH2" for a part of a combined order. */
export const riderOrderLabel = (order: Order): string => (order.group
  ? `Combined order (${order.group.size} restaurants) to ${order.dropoffHostel}`
  : `${orderCode(order.id)} to ${order.dropoffHostel}`);

export const canCancel = (order: Order): boolean => !isTerminal(order.status);
/** Order display code used everywhere (same as the apps): '#' + last 6 characters of the id, uppercased. */
export const orderCode = (id: string): string => `#${id.slice(-6).toUpperCase()}`;

export const canResetOtpLock = (order: Order): boolean => order.otpLocked === true && !isTerminal(order.status);
/** Riders never see unpaid orders (contract 1.2), so an admin must not hand one to a rider either. */
export const reassignBlockedReason = (order: Order): string | null => {
  if (isTerminal(order.status)) return 'Order is finished';
  if (order.paymentStatus !== 'PAID') return 'Waiting for payment';
  return null;
};

/** What the cancel confirmation must say about money. */
export const cancelMoneyNote = (order: Order): { refunds: boolean; text: string } => {
  if (order.paymentStatus === 'PAID') return { refunds: true, text: 'The customer has paid, so Kraveo refunds the full amount to their original payment method automatically.' };
  if (order.paymentStatus === 'REFUNDED') return { refunds: false, text: 'This order was already refunded. Nothing more is refunded.' };
  return { refunds: false, text: 'No payment has been captured, so nothing is refunded. If a payment still arrives later, the server refunds it automatically.' };
};

// ───────────────────────── Labels ─────────────────────────

export const PAYMENT_META: Record<PaymentStatus, { label: string; cls: string }> = {
  PAID: { label: 'Paid', cls: 'bg-kraveo-g400/15 text-kraveo-g300' },
  PENDING: { label: 'Unpaid', cls: 'bg-kraveo-status-placed/15 text-kraveo-status-placed' },
  FAILED: { label: 'Payment failed', cls: 'bg-kraveo-danger/15 text-kraveo-danger' },
  REFUNDED: { label: 'Refunded', cls: 'bg-kraveo-status-pickedUp/15 text-kraveo-status-pickedUp' },
};

export const paymentMeta = (status: string): { label: string; cls: string } =>
  PAYMENT_META[status as PaymentStatus] ?? { label: humanize(status || 'Unknown'), cls: 'bg-kraveo-surface2 text-kraveo-ink2' };

export const CANCELLED_BY_LABEL: Record<string, string> = {
  CUSTOMER: 'Customer',
  VENDOR: 'Restaurant',
  ADMIN: 'Admin',
  SYSTEM: 'Automatic',
};

export const cancelledByLabel = (value?: string | null): string => (value ? CANCELLED_BY_LABEL[value] ?? humanize(value) : 'Unknown');

export type Tone = 'danger' | 'warning' | 'info' | 'neutral';

/** Refund state worth showing, or null when there is nothing to say. */
export const refundInfo = (order: Order): { label: string; tone: Tone; detail?: string } | null => {
  const r = order.refundStatus ?? undefined;
  if (r === 'FAILED') return { label: 'Refund failed', tone: 'danger', detail: order.refundError ?? 'The payment provider refused the refund. The server retries every minute (up to 10 times).' };
  if (r === 'PENDING') return { label: 'Refund in progress', tone: 'warning' };
  if (r === 'DONE' || order.paymentStatus === 'REFUNDED') return { label: 'Refunded', tone: 'info' };
  // Docs/22: one payment, one refund, and both live on the PRIMARY order. A cancelled sibling still reads PAID until the primary's refund completes: not a problem.
  if (order.status === 'CANCELLED' && order.paymentStatus === 'PAID' && order.group && !order.group.primary) {
    return { label: 'Refund is on the combined order', tone: 'info', detail: 'A combined order has one payment and one refund. They are recorded on its first order, not on this one.' };
  }
  if (order.status === 'CANCELLED' && order.paymentStatus === 'PAID') return { label: 'Paid, no refund recorded', tone: 'warning', detail: 'This cancelled order still shows as paid. Check the payment in Razorpay.' };
  return null;
};

export const humanize = (code: string): string => {
  const words = code.replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
};

// ───────────────────────── Problems the dashboard can see on its own ─────────────────────────

export interface LocalFlag {
  code: string;
  label: string;
  tone: Tone;
}

/**
 * Problems visible from the order alone. Used for row badges and, only when the server's
 * needs-attention endpoint is unavailable, as a clearly-labelled fallback list.
 */
export const orderFlags = (order: Order, now: number): LocalFlag[] => {
  const flags: LocalFlag[] = [];
  if (order.refundStatus === 'FAILED') flags.push({ code: 'REFUND_FAILED', label: 'Refund failed', tone: 'danger' });
  if (order.otpLocked && !isTerminal(order.status)) flags.push({ code: 'OTP_LOCKED', label: 'OTP locked', tone: 'danger' });
  if (order.refundStatus === 'PENDING') flags.push({ code: 'REFUND_PENDING', label: 'Refund pending', tone: 'warning' });
  if (order.status === 'PLACED' && order.paymentStatus === 'PAID') {
    // Prefer the server's deadline; fall back to the contract's 10-minute window for orders without one.
    const overdue = order.acceptBy ? minutesSince(order.acceptBy, now) : (minutesSince(order.paidAt, now) ?? -Infinity) - SLA.VENDOR_ACCEPT_WINDOW_MIN;
    if (overdue !== null && overdue > 0) flags.push({ code: 'STUCK_UNACCEPTED', label: 'Not accepted', tone: 'warning' });
  }
  return flags;
};

/** Codes that always deserve the "Needs attention" filter, even without the server list. */
export const isCriticalFlag = (flag: LocalFlag): boolean => flag.tone === 'danger';

// ───────────────────────── Riders ─────────────────────────

/** Only approved riders can be given an order (contract 2.5). Accounts from before approval existed have no status and count as approved. */
export const assignableRiders = (riders: DriverPartner[]): DriverPartner[] =>
  riders.filter((rider) => !rider.approvalStatus || rider.approvalStatus === 'APPROVED');

/** `Order.driverId` is the rider's user id; older payloads may carry the DriverPartner id instead. */
export const riderForOrder = (riders: DriverPartner[], order: Pick<Order, 'driverId'>): DriverPartner | undefined =>
  order.driverId ? riders.find((rider) => rider.userId === order.driverId || rider.id === order.driverId) : undefined;
