import { prisma } from '../../db';
import { ACTIVE_RIDER_STATUSES, OrderWithRelations, isPoolEligible, isVendorVisible, vendorEarnTotal } from '../orderView';
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

/** What the customer was refunded: the captured amount of the payment that was refunded first (the original one). */
const refundedPaise = (o: OrderWithRelations): number => {
  const refunded = o.payments.filter((p) => p.status === 'REFUNDED').sort((a, b) => (a.refundedAt?.getTime() ?? 0) - (b.refundedAt?.getTime() ?? 0))[0];
  const paid = refunded ?? o.payments.find((p) => p.status === 'PAID');
  return paid ? (paid.capturedAmountPaise ?? Math.round(paid.amount * 100)) : Math.round(o.totalAmount * 100);
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
    case 'ORDER_CANCELLED_VENDOR':
      return { title: 'Order cancelled', body: `Order ${orderRef(o.id)} was cancelled.` };
    case 'NEW_DELIVERY':
      return { title: 'New delivery', body: `${vendor} to ${safeText(o.dropoffHostel, 30)}. Tap to accept.` };
    case 'DELIVERY_ASSIGNED':
      return { title: 'Delivery assigned', body: `${vendor} to ${safeText(o.dropoffHostel, 30)}.` };
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
      const reason = safeText(o.cancelReason, 80).replace(/[.\s]+$/, '') || 'Your order was cancelled';
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
