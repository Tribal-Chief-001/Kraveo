import { prisma } from '../../db';
import { ACTIVE_RIDER_STATUSES, OrderWithRelations, isPoolEligible, isVendorVisible, vendorEarnTotal, payableAmount, groupAllAccepted } from '../orderView';
import { PushApp, PushEvent, PushOptions } from './types';

/**
 * Event table of Docs/18_push_notifications_contract.md section 4: who gets what, with which channel, priority and TTL.
 * The server decides everything here; a client never chooses a recipient or a text.
 * No OTP, phone number or address is ever put into a title or body (and `data` is only { event, orderId, v }).
 */
type Def = { app: PushApp; channelId: string; priority: 'high' | 'normal'; ttlSeconds: number; usefulMinutes: number };

const URGENT = { ttlSeconds: 120, usefulMinutes: 10 };
const STATUS = { ttlSeconds: 3600, usefulMinutes: 30 };

const DEFS: Record<PushEvent, Def> = {
  NEW_ORDER: { app: 'VENDOR', channelId: 'new_orders', priority: 'high', ...URGENT },
  // Sent by the sweep once a minute while a paid order is still unanswered (the phone alarm only rings for a moment per push).
  NEW_ORDER_REMINDER: { app: 'VENDOR', channelId: 'new_orders', priority: 'high', ...URGENT },
  ORDER_CANCELLED_VENDOR: { app: 'VENDOR', channelId: 'order_updates', priority: 'high', ...STATUS },
  // Docs/22: the last restaurant of a combined order accepted; the ones that accepted earlier may start cooking now.
  GROUP_READY_TO_COOK: { app: 'VENDOR', channelId: 'order_updates', priority: 'high', ttlSeconds: 600, usefulMinutes: 10 },
  NEW_DELIVERY: { app: 'DRIVER', channelId: 'new_deliveries', priority: 'high', ...URGENT },
  DELIVERY_ASSIGNED: { app: 'DRIVER', channelId: 'new_deliveries', priority: 'high', ...STATUS },
  DELIVERY_CANCELLED: { app: 'DRIVER', channelId: 'order_updates', priority: 'high', ...STATUS },
  ORDER_ACCEPTED: { app: 'CUSTOMER', channelId: 'order_updates', priority: 'normal', ...STATUS },
  ORDER_READY: { app: 'CUSTOMER', channelId: 'order_updates', priority: 'normal', ...STATUS },
  ORDER_PICKED_UP: { app: 'CUSTOMER', channelId: 'order_attention', priority: 'high', ...STATUS },
  RIDER_AT_GATE: { app: 'CUSTOMER', channelId: 'order_attention', priority: 'high', ...STATUS },
  ORDER_DELIVERED: { app: 'CUSTOMER', channelId: 'order_updates', priority: 'normal', ...STATUS },
  ORDER_CANCELLED: { app: 'CUSTOMER', channelId: 'order_attention', priority: 'high', ...STATUS },
  REFUND_PROCESSED: { app: 'CUSTOMER', channelId: 'order_updates', priority: 'normal', ...STATUS },
};

export const eventDef = (event: PushEvent): Def => DEFS[event];
export const MAX_PUSH_ATTEMPTS = 5;

// ----------------------------------------------------------------------------
// Copy
// ----------------------------------------------------------------------------
/** Free text typed by people (restaurant names, cancel reasons, rider names): digit runs of 4+ (OTPs, phones, room numbers) are dropped. */
const DIGIT_RUN = /[+(]?\d(?:[\s().-]?\d){3,}\)?/g;
export const safeText = (raw: unknown, max: number): string =>
  String(raw ?? '').replace(DIGIT_RUN, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();

const rupees = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
export const orderRef = (id: string) => `#${id.slice(-6).toUpperCase()}`;
const firstName = (name: string | null | undefined) => safeText((name ?? '').trim().split(/\s+/)[0], 24);
/** The text a cascaded sibling of a cancelled group carries (orderFlow.ts groupSiblingReason). */
export const GROUP_CANCEL_PREFIX = 'Another restaurant in your order could not take it';
/** The real reason of a cancelled combined order: a cascaded sibling carries only the fixed text, the triggering child (or the group) the real one. */
const realCancelReason = (o: OrderWithRelations): string => {
  const own = o.cancelReason ?? '';
  if (!o.group || !own.startsWith(GROUP_CANCEL_PREFIX)) return own;
  return o.group.orders.find((s) => s.cancelReason && !s.cancelReason.startsWith(GROUP_CANCEL_PREFIX))?.cancelReason ?? own;
};
/** Riders: "Kitchen A" for a single order, "2 restaurants" for a combined one. */
const placeLabel = (o: OrderWithRelations, vendor: string) => (o.group && o.group.orders.length > 1 ? `${o.group.orders.length} restaurants` : vendor);

/** What the customer was refunded: the captured amount of the payment that was refunded first (the original one). */
const refundedPaise = (o: OrderWithRelations): number => {
  const refunded = o.payments.filter((p) => p.status === 'REFUNDED').sort((a, b) => (a.refundedAt?.getTime() ?? 0) - (b.refundedAt?.getTime() ?? 0))[0];
  const paid = refunded ?? o.payments.find((p) => p.status === 'PAID');
  // payableAmount: for a combined (multi-restaurant) order the refund is the whole group payment, held by the primary child.
  return paid ? (paid.capturedAmountPaise ?? Math.round(paid.amount * 100)) : Math.round(payableAmount(o) * 100);
};

export const buildCopy = (event: PushEvent, o: OrderWithRelations): { title: string; body: string } => {
  const vendor = safeText(o.vendor.name, 40) || 'The restaurant';
  switch (event) {
    case 'NEW_ORDER': {
      const n = o.items.reduce((sum, i) => sum + i.quantity, 0);
      // Docs/21: the restaurant is told what it earns, never the customer's total.
      return { title: 'New order', body: `${n} item${n === 1 ? '' : 's'} - You earn Rs ${rupees(vendorEarnTotal(o))}. Tap to accept.` };
    }
    case 'NEW_ORDER_REMINDER': {
      const n = o.items.reduce((sum, i) => sum + i.quantity, 0);
      return { title: 'Order waiting - accept it now', body: `${n} item${n === 1 ? '' : 's'} - You earn Rs ${rupees(vendorEarnTotal(o))}. The customer is waiting.` };
    }
    case 'GROUP_READY_TO_COOK':
      return { title: 'Start cooking', body: 'All restaurants accepted - you can start cooking.' };
    case 'ORDER_CANCELLED_VENDOR':
      // Docs/22: a restaurant whose part of a combined order was cancelled because ANOTHER restaurant could not take its part.
      if (o.groupId && o.cancelledBy === 'SYSTEM' && (o.cancelReason ?? '').startsWith(GROUP_CANCEL_PREFIX)) {
        return { title: 'Order cancelled', body: `Order ${orderRef(o.id)} was cancelled: another restaurant could not take this combined order.` };
      }
      return { title: 'Order cancelled', body: `Order ${orderRef(o.id)} was cancelled.` };
    case 'NEW_DELIVERY':
      return { title: 'New delivery', body: `${placeLabel(o, vendor)} to ${safeText(o.dropoffHostel, 30)}. Tap to accept.` };
    case 'DELIVERY_ASSIGNED':
      return { title: 'Delivery assigned', body: `${placeLabel(o, vendor)} to ${safeText(o.dropoffHostel, 30)}.` };
    case 'DELIVERY_CANCELLED':
      return { title: 'Delivery cancelled', body: `Order ${orderRef(o.id)} was cancelled.` };
    case 'ORDER_ACCEPTED':
      return { title: 'Order accepted', body: `${vendor} is preparing your food.` };
    case 'ORDER_READY':
      return { title: 'Food is ready', body: 'Waiting for a rider.' };
    case 'ORDER_PICKED_UP':
      return { title: 'On the way', body: `${firstName(o.driver?.name) || 'Your rider'} picked up your order.` };
    case 'RIDER_AT_GATE':
      return { title: 'Your rider is at the gate', body: 'Open Kraveo to see your code.' };
    case 'ORDER_DELIVERED':
      return { title: 'Delivered', body: 'Enjoy your meal! Rate your order.' };
    case 'ORDER_CANCELLED': {
      const reason = safeText(realCancelReason(o), 80).replace(/[.\s]+$/, '') || 'Your order was cancelled';
      const paid = o.paymentStatus === 'PAID' || o.paymentStatus === 'REFUNDED';
      return { title: 'Order cancelled', body: `${reason}.${paid ? ' Your refund is on its way.' : ''}` };
    }
    case 'REFUND_PROCESSED':
      return { title: 'Refund processed', body: `Rs ${rupees(refundedPaise(o) / 100)} is on its way to your account (5-7 working days).` };
  }
};

// ----------------------------------------------------------------------------
// Recipients (user ids, decided at send time; the user's devices are looked up afterwards)
// ----------------------------------------------------------------------------
/** Approved, ONLINE riders without an active order: the same pool rule as claimOrder (one active order per rider). */
const idleRiders = async (): Promise<string[]> => {
  const riders = await prisma.driverPartner.findMany({
    where: { approvalStatus: 'APPROVED', dutyStatus: 'ONLINE', userId: { not: null }, user: { deletedAt: null } },
    select: { userId: true },
  });
  const ids = riders.map((r) => r.userId!).filter(Boolean);
  if (ids.length === 0) return [];
  const busy = await prisma.order.groupBy({ by: ['driverId'], where: { driverId: { in: ids }, status: { in: [...ACTIVE_RIDER_STATUSES] } } });
  const busyIds = new Set(busy.map((b) => b.driverId));
  return ids.filter((id) => !busyIds.has(id));
};

const approvedRider = async (userId: string): Promise<string[]> => {
  const d = await prisma.driverPartner.findUnique({ where: { userId }, select: { approvalStatus: true, user: { select: { deletedAt: true } } } });
  return d && d.approvalStatus === 'APPROVED' && !d.user?.deletedAt ? [userId] : [];
};

export const resolveRecipients = async (event: PushEvent, o: OrderWithRelations, opts: PushOptions = {}): Promise<string[]> => {
  switch (event) {
    case 'NEW_ORDER':
    case 'NEW_ORDER_REMINDER':
    case 'ORDER_CANCELLED_VENDOR':
    case 'GROUP_READY_TO_COOK':
      return o.vendor.userId && o.vendor.approvalStatus === 'APPROVED' ? [o.vendor.userId] : [];
    case 'NEW_DELIVERY':
      return idleRiders();
    case 'DELIVERY_ASSIGNED':
    case 'DELIVERY_CANCELLED':
      return opts.userId ? approvedRider(opts.userId) : [];
    default:
      return o.customer.deletedAt ? [] : [o.customerId];
  }
};

/** Retries only make sense while the news is still true (a vendor is not alarmed about an order someone else already handled). */
export const stillUseful = (event: PushEvent, o: OrderWithRelations): boolean => {
  if (event === 'NEW_ORDER' || event === 'NEW_ORDER_REMINDER') return o.status === 'PLACED' && o.paymentStatus === 'PAID';
  if (event === 'NEW_DELIVERY') return isPoolEligible(o);
  if (event === 'GROUP_READY_TO_COOK') return o.status === 'ACCEPTED';
  // A late retry must not announce a step the order has already moved past ("accepted" after "delivered").
  switch (event) {
    case 'ORDER_ACCEPTED': return o.status === 'ACCEPTED' || o.status === 'PREPARING';
    case 'ORDER_READY': return o.status === 'READY_FOR_PICKUP';
    case 'ORDER_PICKED_UP': return o.status === 'PICKED_UP';
    case 'RIDER_AT_GATE': return o.status === 'ARRIVED_AT_GATE';
    default: return true;
  }
};

// ----------------------------------------------------------------------------
// Which events does an order change unlock? (called by finishChange after the commit)
// ----------------------------------------------------------------------------
export type PushSpec = { event: PushEvent; opts?: PushOptions };

export const pushEventsForChange = (
  before: OrderWithRelations,
  after: OrderWithRelations,
  flags: { newOrderAlert?: boolean; assignedByAdmin?: boolean },
): PushSpec[] => {
  const out: PushSpec[] = [];
  if (flags.newOrderAlert) out.push({ event: 'NEW_ORDER' });
  if (before.status !== after.status) {
    switch (after.status) {
      case 'ACCEPTED': out.push({ event: 'ORDER_ACCEPTED' }); break;
      case 'READY_FOR_PICKUP':
        out.push({ event: 'ORDER_READY' });
        if (!after.driverId) out.push({ event: 'NEW_DELIVERY' });
        break;
      case 'PICKED_UP': out.push({ event: 'ORDER_PICKED_UP' }); break;
      case 'ARRIVED_AT_GATE': out.push({ event: 'RIDER_AT_GATE' }); break;
      case 'DELIVERED': out.push({ event: 'ORDER_DELIVERED' }); break;
      case 'CANCELLED':
        // The customer who pressed Cancel knows already; everyone else (restaurant, admin, system expiry) gets told.
        if (after.cancelledBy !== 'CUSTOMER') out.push({ event: 'ORDER_CANCELLED' });
        // The restaurant only knows orders that were paid while live; it already knows about its own rejection.
        if (before.paymentStatus === 'PAID' && isVendorVisible(before) && after.cancelledBy !== 'VENDOR') out.push({ event: 'ORDER_CANCELLED_VENDOR' });
        if (before.driverId) out.push({ event: 'DELIVERY_CANCELLED', opts: { userId: before.driverId } });
        break;
      default: break;
    }
  }
  if (flags.assignedByAdmin && after.driverId && after.driverId !== before.driverId && after.status !== 'CANCELLED' && after.status !== 'DELIVERED') {
    out.push({ event: 'DELIVERY_ASSIGNED', opts: { userId: after.driverId } });
  }
  return out;
};

// ----------------------------------------------------------------------------
// Docs/22 section 4.8: pushes of a change that touched a combined (multi-restaurant) order.
// Restaurants hear about THEIR child only. The customer and the rider hear about the group once: those events are always addressed
// to the PRIMARY child, so the unique PushLog key (order, event, user) makes "once per group" a database guarantee, not a hope.
// ----------------------------------------------------------------------------
export type GroupPushSpec = { orderId: string; event: PushEvent; opts?: PushOptions };

const allAre = (orders: { status: string }[], status: string) => orders.length > 0 && orders.every((c) => c.status === status);

export const pushEventsForGroupChange = (
  before: OrderWithRelations[],
  after: OrderWithRelations[],
  touched: Set<string>,
  triggerId: string,
  flags: { newOrderAlert?: boolean; assignedByAdmin?: boolean },
): GroupPushSpec[] => {
  const out: GroupPushSpec[] = [];
  const beforeById = new Map(before.map((c) => [c.id, c]));
  const primary = after[0];
  const primaryBefore = before[0];
  // 1. Per child: the restaurant's own events, and "restaurant X accepted" for the customer. Everything else is a group event (below).
  const PER_CHILD = new Set<PushEvent>(['NEW_ORDER', 'ORDER_CANCELLED_VENDOR', 'ORDER_ACCEPTED']);
  for (const a of after) {
    if (!touched.has(a.id)) continue;
    const b = beforeById.get(a.id);
    if (!b) continue;
    for (const spec of pushEventsForChange(b, a, { newOrderAlert: flags.newOrderAlert })) {
      if (PER_CHILD.has(spec.event)) out.push({ orderId: a.id, event: spec.event, opts: spec.opts });
    }
  }
  // 1b. The last restaurant accepted: the ones that accepted earlier (not moved by this change) may start cooking. One push per child (idempotent per order + event).
  if (!groupAllAccepted(before) && groupAllAccepted(after)) {
    for (const a of after) if (!touched.has(a.id) && a.status === 'ACCEPTED') out.push({ orderId: a.id, event: 'GROUP_READY_TO_COOK' });
  }
  // 2. The group as a whole, once, from the primary.
  const became = (status: string) => allAre(after, status) && !allAre(before, status);
  if (became('PICKED_UP')) out.push({ orderId: primary.id, event: 'ORDER_PICKED_UP' });
  if (became('ARRIVED_AT_GATE')) out.push({ orderId: primary.id, event: 'RIDER_AT_GATE' });
  if (became('DELIVERED')) out.push({ orderId: primary.id, event: 'ORDER_DELIVERED' });
  if (became('CANCELLED')) {
    const trigger = after.find((c) => c.id === triggerId) ?? primary;
    // The customer who pressed Cancel knows already; everyone else (restaurant, admin, system expiry) gets told.
    if (trigger.cancelledBy !== 'CUSTOMER') out.push({ orderId: primary.id, event: 'ORDER_CANCELLED' });
    if (primaryBefore.driverId) out.push({ orderId: primary.id, event: 'DELIVERY_CANCELLED', opts: { userId: primaryBefore.driverId } });
  }
  // A new delivery for riders: the group became claimable and a kitchen has the food ready (same trigger as a single order: READY and nobody carrying it).
  const justReady = after.some((a) => touched.has(a.id) && a.status === 'READY_FOR_PICKUP' && beforeById.get(a.id)?.status !== 'READY_FOR_PICKUP');
  if (justReady && isPoolEligible(primary)) out.push({ orderId: primary.id, event: 'NEW_DELIVERY' });
  if (flags.assignedByAdmin && primary.driverId && primary.driverId !== primaryBefore.driverId && !isTerminalStatus(primary.status)) {
    out.push({ orderId: primary.id, event: 'DELIVERY_ASSIGNED', opts: { userId: primary.driverId } });
  }
  return out;
};

const isTerminalStatus = (status: string) => status === 'DELIVERED' || status === 'CANCELLED';
