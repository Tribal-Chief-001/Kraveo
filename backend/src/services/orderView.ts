import { Prisma } from '@prisma/client';
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
 */
export const ORDER_VIEW_INCLUDE = {
  items: true,
  vendor: { include: { user: { select: { phone: true } } } },
  customer: true,
  driver: true,
  payments: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_VIEW_INCLUDE }>;
export type ViewerRole = 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN';

const POOL_STATUSES = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
export const ACTIVE_RIDER_STATUSES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] as const;
export const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'] as const;

type OrderCore = Pick<OrderWithRelations, 'status' | 'paymentStatus' | 'driverId' | 'paidAt'>;

/** In the rider pool: paid, cooking or ready, nobody assigned. */
export const isPoolEligible = (o: OrderCore) => o.paymentStatus === 'PAID' && o.driverId === null && POOL_STATUSES.has(o.status);

/**
 * The restaurant only ever sees orders that were paid while live. `paidAt` is set when a payment made
 * the order live; legacy rows (before paidAt existed) count when they are PAID and not cancelled.
 * A payment that arrived after the order was already cancelled (auto-refunded) never reaches the restaurant.
 */
export const isVendorVisible = (o: OrderCore) => o.paidAt !== null || (o.paymentStatus === 'PAID' && o.status !== 'CANCELLED');

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
  vendor: { id: o.vendor.id, name: o.vendor.name, address: o.vendor.address, lat: o.vendor.lat, lng: o.vendor.lng },
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
        vendor: { id: o.vendor.id, name: o.vendor.name, address: o.vendor.address, lat: o.vendor.lat, lng: o.vendor.lng, phone: o.vendor.user?.phone ?? null },
        customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone ?? null, hostelBlock: o.customer.hostelBlock ?? null },
        driver: driverOf(o),
        otpCode: realOtp(o.otpCode),
        payBy: payByOf(o),
        acceptBy: acceptByOf(o),
        // Admin-only extras.
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
        refundStatus: o.refundStatus ?? 'NONE',
        isReviewed: o.isReviewed,
      };
    }
    case 'VENDOR': {
      if (o.vendor.userId !== viewerId || !isVendorVisible(o)) return null;
      return {
        ...buildView(o),
        customer: { id: o.customer.id, name: firstName(o.customer.name), phone: null, hostelBlock: null },
        driver: driverOf(o),
        acceptBy: acceptByOf(o),
      };
    }
    case 'DRIVER': {
      if (o.driverId === viewerId) {
        return {
          ...buildView(o),
          customer: { id: o.customer.id, name: o.customer.name, phone: o.customer.phone ?? null, hostelBlock: o.customer.hostelBlock ?? null },
          driver: driverOf(o),
        };
      }
      if (isPoolEligible(o)) {
        // Pool: enough to decide (restaurant, drop point, money) and nothing about the person.
        // dropoffNotes are hidden too: customers write room numbers and phone numbers there.
        return { ...buildView(o), dropoffNotes: null };
      }
      return null;
    }
    default:
      return null;
  }
}
