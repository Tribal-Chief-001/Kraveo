import { Prisma } from '@prisma/client';
import { dropoffView, vendorHasLocation } from '../config/campus';
import { paymentWindowMin, vendorAcceptWindowMin } from '../config/orderFlow';

/**
 * The ONLY shape an order leaves the server in (REST and sockets): Docs/16_order_flow_contract.md 2.1.
 * Built per viewer. Returns null when this viewer must not see the order at all, so callers can 404
 * (REST) or skip the socket (realtime) without a second access check that could drift from this one.
 *
 * Visibility (contract table):
 *   otpCode        owner customer only while ARRIVED_AT_GATE; admin; never vendor or rider
 *   customer.phone owner customer (self), assigned rider, admin; never vendor or pool
 *   customer.name  self; vendor first name only; assigned rider; admin; never pool
 *   driver.phone   customer and vendor once assigned; rider self; admin
 *   payment ids    admin only
 *   money          Docs/21: the restaurant sees ONLY what it earns (its own prices; `subtotal` and `totalAmount` both = vendorSubtotal) and
 *                  no fee, discount, tax, commission, coupon or customer price. The admin also gets vendorSubtotal, commissionTotal,
 *                  feeBreakdown and per-item vendorUnitPrice / commissionUnit. Customer and rider views are unchanged.
 */
export const ORDER_VIEW_INCLUDE = {
  items: true,
  vendor: { include: { user: { select: { phone: true } } } },
  customer: true,
  driver: true,
  payments: { orderBy: { createdAt: 'asc' } },
  // Docs/22: a grouped order carries its group (total) and the light state of every sibling, so orderView, isPoolEligible and
  // payableAmount are self-sufficient (no second query, no way to forget the siblings). null for a single-restaurant order.
  group: {
    select: {
      id: true,
      totalAmount: true,
      orders: {
        select: {
          id: true,
          groupIndex: true,
          status: true,
          paymentStatus: true,
          driverId: true,
          paidAt: true,
          refundStatus: true,
          cancelReason: true,
          pickedUpAt: true,
          vendor: { select: { id: true, name: true, address: true, lat: true, lng: true } },
          items: { select: { quantity: true } },
        },
        orderBy: { groupIndex: 'asc' },
      },
    },
  },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_VIEW_INCLUDE }>;
export type ViewerRole = 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN';

const POOL_STATUSES = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
export const ACTIVE_RIDER_STATUSES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] as const;
export const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'] as const;

type OrderCore = Pick<OrderWithRelations, 'status' | 'paymentStatus' | 'driverId' | 'paidAt'> & Partial<Pick<OrderWithRelations, 'groupId' | 'groupIndex' | 'group'>>;
type GroupSibling = NonNullable<OrderWithRelations['group']>['orders'][number];

const childPoolReady = (o: { status: string; paymentStatus: string; driverId: string | null }) =>
  o.paymentStatus === 'PAID' && o.driverId === null && POOL_STATUSES.has(o.status);

/**
 * In the rider pool: paid, cooking or ready, nobody assigned.
 * Docs/22: a child of a group is never pooled on its own. The group is ONE pool entry, carried by its primary child (groupIndex 0),
 * and only when EVERY child is paid, in a pool state and unassigned (a cancelled child is not, so a cancelled group leaves the pool).
 */
export const isPoolEligible = (o: OrderCore): boolean => {
  if (o.groupId) return o.groupIndex === 0 && !!o.group && o.group.orders.length > 0 && o.group.orders.every(childPoolReady);
  return childPoolReady(o);
};

/** Docs/22 section 2: what the customer pays through THIS order's payment: the group total for the primary child, else the order total. */
export const payableAmount = (o: { totalAmount: number; groupId?: string | null; groupIndex?: number | null; group?: { totalAmount: number } | null }): number => {
  if (o.groupId && o.groupIndex === 0) {
    if (!o.group) throw new Error('payableAmount: the group of a primary order was not loaded');
    return o.group.totalAmount;
  }
  return o.totalAmount;
};
/** Prisma select for code that only needs `payableAmount` of an order. */
export const PAYABLE_SELECT = { totalAmount: true, groupId: true, groupIndex: true, group: { select: { totalAmount: true } } } as const;

const AT_LEAST_ACCEPTED = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED']);
/** Every restaurant of the group has accepted its part and none is cancelled (the restaurants may start cooking). */
export const groupAllAccepted = (siblings: { status: string }[]): boolean => siblings.every((s) => AT_LEAST_ACCEPTED.has(s.status));

const stopOf = (s: GroupSibling) => ({
  orderId: s.id,
  index: s.groupIndex ?? 0,
  status: s.status as string,
  vendor: { name: s.vendor.name, address: s.vendor.address, lat: s.vendor.lat, lng: s.vendor.lng },
  itemCount: s.items.reduce((sum, i) => sum + i.quantity, 0),
});

/** OrderView.group for the customer, the assigned rider (and the pool entry) and the admin. Undefined for a single-restaurant order. */
const groupFull = (o: OrderWithRelations) =>
  o.group
    ? { id: o.group.id, index: o.groupIndex ?? 0, size: o.group.orders.length, primary: (o.groupIndex ?? 0) === 0, stops: o.group.orders.map(stopOf) }
    : undefined;
/** OrderView.group for a restaurant: no other restaurant's name or data, no money. */
const groupForVendor = (o: OrderWithRelations) => (o.group ? { size: o.group.orders.length, allAccepted: groupAllAccepted(o.group.orders) } : undefined);
const withGroup = (g: object | undefined) => (g ? { group: g } : {});

/**
 * The restaurant only ever sees orders that were paid while live. `paidAt` is set when a payment made
 * the order live; legacy rows (before paidAt existed) count when they are PAID and not cancelled.
 * A payment that arrived after the order was already cancelled (auto-refunded) never reaches the restaurant.
 */
export const isVendorVisible = (o: OrderCore) => o.paidAt !== null || (o.paymentStatus === 'PAID' && o.status !== 'CANCELLED');

/**
 * What the restaurant earns per unit / for the order. Orders created before Docs/21 were backfilled (vendorUnitPrice = price,
 * vendorSubtotal = subtotal); a row that still has 0 there (written by older code or a hand-made fixture) is read as "no commission".
 * A real order never has vendorSubtotal 0 with a positive subtotal (dish prices are above 0).
 */
export const vendorEarnUnit = (i: { vendorUnitPrice: number; price: number }) => (i.vendorUnitPrice > 0 ? i.vendorUnitPrice : i.price);
export const vendorEarnTotal = (o: { vendorSubtotal: number; subtotal: number }) => (o.vendorSubtotal > 0 ? o.vendorSubtotal : o.subtotal);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || null;
const realOtp = (code: string | null) => (code && /^\d{4}$/.test(code) ? code : null);
const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

export type OrderView = ReturnType<typeof buildView>;

const buildView = (o: OrderWithRelations) => ({
  id: o.id,
  status: o.status,
  paymentStatus: o.paymentStatus,
  totalAmount: o.totalAmount,
  deliveryFee: o.deliveryFee,
  subtotal: o.subtotal,
  taxAndPackaging: o.taxAndPackaging,
  discount: o.discount,
  dropoffHostel: o.dropoffHostel,
  // Docs/19: the canonical drop point with its pin; null for stored text that is not a drop point (very old data). Same visibility as dropoffHostel.
  dropoff: dropoffView(o.dropoffHostel),
  dropoffNotes: (o.dropoffNotes ?? null) as string | null,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
  paidAt: iso(o.paidAt),
  acceptedAt: iso(o.acceptedAt),
  pickedUpAt: iso(o.pickedUpAt),
  deliveredAt: iso(o.deliveredAt),
  cancelledAt: iso(o.cancelledAt),
  cancelledBy: (o.cancelledBy ?? null) as string | null,
  cancelReason: (o.cancelReason ?? null) as string | null,
  items: o.items.map((i) => ({ id: i.id, menuItemId: i.menuItemId ?? null, name: i.name, quantity: i.quantity, price: i.price })),
  vendorId: o.vendorId,
  vendor: { id: o.vendor.id, name: o.vendor.name, address: o.vendor.address, lat: o.vendor.lat, lng: o.vendor.lng, hasLocation: vendorHasLocation(o.vendor.lat, o.vendor.lng) },
  customer: null as null | { id: string; name: string | null; phone: string | null; hostelBlock: string | null },
  driver: null as null | { id: string; name: string; phone: string | null },
  otpCode: null as string | null,
  // Server-computed deadlines (UTC) so apps never derive SLAs from the phone clock.
  payBy: null as string | null,
  acceptBy: null as string | null,
});

const driverOf = (o: OrderWithRelations) => (o.driver ? { id: o.driver.id, name: o.driver.name, phone: o.driver.phone ?? null } : null);
const payByOf = (o: OrderWithRelations) =>
  o.status === 'PLACED' && o.paymentStatus !== 'PAID' && o.paymentStatus !== 'REFUNDED' ? addMinutes(o.createdAt, paymentWindowMin()).toISOString() : null;
const acceptByOf = (o: OrderWithRelations) =>
  o.status === 'PLACED' && o.paymentStatus === 'PAID' && o.paidAt ? addMinutes(o.paidAt, vendorAcceptWindowMin()).toISOString() : null;

export function orderView(o: OrderWithRelations, viewerRole: ViewerRole | string, viewerId: string): Record<string, unknown> | null {
  switch (viewerRole) {
    case 'ADMIN': {
      return {
        ...buildView(o),
        vendor: { id: o.vendor.id, name: o.vendor.name, address: o.vendor.address, lat: o.vendor.lat, lng: o.vendor.lng, hasLocation: vendorHasLocation(o.vendor.lat, o.vendor.lng), phone: o.vendor.user?.phone ?? null },
        customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone ?? null, hostelBlock: o.customer.hostelBlock ?? null },
        driver: driverOf(o),
        otpCode: realOtp(o.otpCode),
        payBy: payByOf(o),
        acceptBy: acceptByOf(o),
        ...withGroup(groupFull(o)),
        ...(o.groupId ? { groupId: o.groupId } : {}),
        // Admin-only extras.
        items: o.items.map((i) => ({ id: i.id, menuItemId: i.menuItemId ?? null, name: i.name, quantity: i.quantity, price: i.price, vendorUnitPrice: vendorEarnUnit(i), commissionUnit: i.commissionUnit })),
        vendorSubtotal: vendorEarnTotal(o),
        commissionTotal: o.commissionTotal,
        feeBreakdown: o.feeBreakdown ?? null,
        couponCode: o.couponCode ?? null,
        customerId: o.customerId,
        driverId: o.driverId,
        isReviewed: o.isReviewed,
        otpAttempts: o.otpAttempts,
        otpLocked: o.otpLocked,
        refundStatus: o.refundStatus ?? 'NONE',
        refundError: o.refundError ?? null,
        refundAttempts: o.refundAttempts,
        payments: o.payments.map((p) => ({
          id: p.id,
          razorpayOrderId: p.razorpayOrderId,
          razorpayPaymentId: p.razorpayPaymentId ?? null,
          razorpayRefundId: p.razorpayRefundId ?? null,
          amount: p.amount,
          capturedAmountPaise: p.capturedAmountPaise ?? null,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          refundedAt: iso(p.refundedAt),
        })),
      };
    }
    case 'STUDENT': {
      if (o.customerId !== viewerId) return null;
      return {
        ...buildView(o),
        customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone ?? null, hostelBlock: o.customer.hostelBlock ?? null },
        driver: driverOf(o),
        otpCode: o.status === 'ARRIVED_AT_GATE' ? realOtp(o.otpCode) : null,
        payBy: payByOf(o),
        acceptBy: acceptByOf(o),
        // Only the primary child carries the group's refund; the customer sees it on every part of the combined order.
        refundStatus: (o.groupId && o.groupIndex !== 0 ? o.group?.orders.find((s) => s.groupIndex === 0)?.refundStatus : o.refundStatus) ?? 'NONE',
        isReviewed: o.isReviewed,
        ...withGroup(groupFull(o)),
      };
    }
    case 'VENDOR': {
      if (o.vendor.userId !== viewerId || !isVendorVisible(o)) return null;
      // Docs/21: no fee, tax, discount, commission, coupon or customer price in ANY field. `totalAmount` and `subtotal` are what the restaurant earns.
      const { deliveryFee: _fee, taxAndPackaging: _tax, discount: _discount, ...base } = buildView(o);
      const earn = vendorEarnTotal(o);
      return {
        ...base,
        totalAmount: earn,
        subtotal: earn,
        items: o.items.map((i) => ({ id: i.id, menuItemId: i.menuItemId ?? null, name: i.name, quantity: i.quantity, price: vendorEarnUnit(i) })),
        customer: { id: o.customer.id, name: firstName(o.customer.name), phone: null, hostelBlock: null },
        driver: driverOf(o),
        acceptBy: acceptByOf(o),
        ...withGroup(groupForVendor(o)),
      };
    }
    case 'DRIVER': {
      if (o.driverId === viewerId) {
        return {
          ...buildView(o),
          customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone ?? null, hostelBlock: o.customer.hostelBlock ?? null },
          driver: driverOf(o),
          ...withGroup(groupFull(o)),
        };
      }
      if (isPoolEligible(o)) {
        // Pool: enough to decide (restaurant, drop point, money) and nothing about the person.
        // dropoffNotes are hidden too: customers write room numbers and phone numbers there.
        // A group is ONE pool entry (its primary child) with its stops.
        return { ...buildView(o), dropoffNotes: null, ...withGroup(groupFull(o)) };
      }
      return null;
    }
    default:
      return null;
  }
}
