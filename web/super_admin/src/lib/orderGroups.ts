// Multi-restaurant orders ("order groups", Docs/22) for the dashboard: parsing of OrderView.group and the plain-language texts.
// No React and no import of ../types (types.ts imports this file). The server shape is Docs/22 section 10.4, copied from
// backend/src/services/orderView.ts (groupFull): admin, customer and rider see `{ id, index, size, primary, stops[] }`;
// a single-restaurant order has NO `group` key at all. A restaurant sees `{ size, allAccepted }` only, which has no id, so it never parses.

export interface GroupStop {
  orderId: string;
  /** 0-based position in the combined order (0 = the primary order that carries the payment). */
  index: number;
  /** That order's own status. Kept as a string so a status a newer server adds still renders. */
  status: string;
  vendorName: string;
  vendorAddress: string | null;
  /** Total quantity of items in that order. */
  itemCount: number;
}

export interface OrderGroupInfo {
  id: string;
  index: number;
  size: number;
  primary: boolean;
  stops: GroupStop[];
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const whole = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

const parseStop = (raw: any, fallbackIndex: number): GroupStop | null => {
  if (!raw || typeof raw !== 'object') return null;
  const orderId = text(raw.orderId) ?? (typeof raw.orderId === 'number' ? String(raw.orderId) : null);
  if (!orderId) return null;
  const vendor = raw.vendor && typeof raw.vendor === 'object' ? raw.vendor : {};
  return {
    orderId,
    index: whole(raw.index) ?? fallbackIndex,
    status: (text(raw.status) ?? 'PLACED').toUpperCase(),
    vendorName: text(vendor.name) ?? 'Restaurant',
    vendorAddress: text(vendor.address),
    itemCount: whole(raw.itemCount) ?? 0,
  };
};

/**
 * `OrderView.group` -> info, or undefined when the value is missing, null or not a group (no id), so a single order and a
 * restaurant-shaped `{ size, allAccepted }` both read as "not grouped". Unknown fields are ignored.
 */
export const parseGroupInfo = (raw: unknown): OrderGroupInfo | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  if (!id) return undefined;
  const stops = (Array.isArray(r.stops) ? r.stops : [])
    .map((stop, i) => parseStop(stop, i))
    .filter((stop): stop is GroupStop => stop !== null)
    .sort((a, b) => a.index - b.index);
  const size = Math.max(whole(r.size) ?? 0, stops.length) || 1;
  const index = whole(r.index) ?? 0;
  return { id, index, size, primary: typeof r.primary === 'boolean' ? r.primary : index === 0, stops };
};

type MaybeGrouped = { group?: OrderGroupInfo | null; groupId?: string | null };

export const groupIdOf = (order: MaybeGrouped | null | undefined): string | undefined => order?.group?.id ?? (order?.groupId || undefined);
export const isGrouped = (order: MaybeGrouped | null | undefined): boolean => Boolean(order?.group);

/** "Combined order · 3 restaurants". */
export const groupBadgeText = (group: Pick<OrderGroupInfo, 'size'>): string => `Combined order · ${group.size} restaurants`;
/** "1 of 3" (the first restaurant of three). */
export const groupPositionText = (group: Pick<OrderGroupInfo, 'index' | 'size'>): string => `${group.index + 1} of ${group.size}`;
export const groupBadgeLabel = (group: Pick<OrderGroupInfo, 'index' | 'size'>): string => `Combined order of ${group.size} restaurants, this is restaurant ${groupPositionText(group)}`;

/** Restaurant names in order, for a one-line summary. */
export const groupRestaurantNames = (group: OrderGroupInfo): string[] => group.stops.map((stop) => stop.vendorName);

/** Words used when searching orders: the group id and the names of every restaurant in it. */
export const groupSearchTerms = (group: OrderGroupInfo | undefined): string[] => (group ? [group.id, ...groupRestaurantNames(group)] : []);

/** What an admin must read before cancelling any part of a combined order. */
export const cancelWholeGroupText = (group: Pick<OrderGroupInfo, 'size'>, paid: boolean): string => (paid
  ? `This cancels the WHOLE combined order (all ${group.size} restaurants) and refunds the customer in full.`
  : `This cancels the WHOLE combined order (all ${group.size} restaurants). Nothing was paid, so nothing is refunded.`);

export const reassignWholeGroupText = (group: Pick<OrderGroupInfo, 'size'>): string =>
  `Combined order: this moves all ${group.size} orders to the rider (one rider carries the whole group).`;

/** Money problems of a combined order live on its primary order and cover every restaurant. */
export const GROUP_MONEY_PROBLEMS = new Set(['PAYMENT_MISMATCH', 'DUPLICATE_PAYMENT', 'REFUND_FAILED', 'REFUND_PENDING', 'PAID_AFTER_CANCEL']);
export const groupMoneyNote = (group: Pick<OrderGroupInfo, 'size'>): string =>
  `The payment and the refund belong to the whole combined order (${group.size} restaurants), not to one restaurant. Any refund is for the full group total.`;

// ───────────────────────── Admin cancel answer ─────────────────────────

/** `POST /admin/orders/:id/cancel` -> `{ success, message, groupId?, cancelledOrders?, data }`. Single orders have neither extra field. */
export interface CancelOutcome {
  groupId: string | null;
  /** How many orders the server cancelled (0 = the group was already cancelled). null for a single order or an older server. */
  cancelledOrders: number | null;
}

export const parseCancelOutcome = (body: unknown): CancelOutcome => {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return { groupId: text(b.groupId), cancelledOrders: whole(b.cancelledOrders) };
};

/** Toast title and text after an admin cancel. `size` is what the dashboard knew before (used only when the server gave no count). */
export const cancelToastText = (
  outcome: CancelOutcome,
  ctx: { size?: number; paid: boolean; refundFailed: boolean },
): { title: string; description: string } => {
  const refund = ctx.refundFailed
    ? 'The refund failed. It is listed under Needs attention and retried automatically.'
    : ctx.paid ? 'The customer is being refunded in full automatically.' : 'No payment was captured, nothing to refund.';
  if (!outcome.groupId) {
    return { title: 'Order cancelled', description: ctx.refundFailed ? refund : ctx.paid ? 'The customer is being refunded automatically.' : refund };
  }
  if (outcome.cancelledOrders === 0) return { title: 'Already cancelled', description: 'This combined order was already cancelled, so nothing changed.' };
  const count = outcome.cancelledOrders ?? ctx.size ?? null;
  const how = count === null ? 'The whole combined order was cancelled.' : `${count} ${count === 1 ? 'order was' : 'orders were'} cancelled (the whole combined order).`;
  return { title: 'Combined order cancelled', description: `${how} ${refund}` };
};
