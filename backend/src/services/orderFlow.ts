import { Prisma } from '@prisma/client';
import { randomInt, timingSafeEqual } from 'crypto';
import { prisma } from '../db';
import { MAX_ACTIVE_ORDERS_PER_RIDER, MAX_UNPAID_OPEN_ORDERS, OTP_MAX_ATTEMPTS, paymentWindowMin } from '../config/orderFlow';
import { ORDER_VIEW_INCLUDE, OrderWithRelations, ACTIVE_RIDER_STATUSES, isPoolEligible, isVendorVisible } from './orderView';
import { publishOrderChange, getIo } from '../realtime';
import { executeRefund, runInBackground } from './refundService';
import { writeAudit } from './audit';
import { createRazorpayOrder } from './paymentService';
import { triggerDhabaAlarmPushNotification, triggerStudentArrivalNotification } from './notificationService';
import { validateAndCalculateOrder } from '../utils/validation';

/**
 * Every order state change lives here (Docs/16_order_flow_contract.md sections 1, 2 and 4).
 *
 * Concurrency model: each change runs in a transaction that first takes a row lock on the order
 * (SELECT ... FOR UPDATE), re-reads it, decides, writes, commits. Two requests for the same order
 * (webhook + verify, two riders, job + late payment, double taps) therefore run one after the other
 * and the second one sees the first one's result. Side effects (sockets, push, refunds, audit) run
 * only after the commit and only for the caller that actually changed the row.
 */
export class OrderFlowError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type Actor = { id: string; role: 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN' | string };
export type CancelledBy = 'CUSTOMER' | 'VENDOR' | 'ADMIN' | 'SYSTEM';
type Tx = Prisma.TransactionClient;

const POOL_STATUSES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] as const;
const NEXT_STATUS: Record<string, string> = {
  PLACED: 'ACCEPTED',
  ACCEPTED: 'PREPARING',
  PREPARING: 'READY_FOR_PICKUP',
  READY_FOR_PICKUP: 'PICKED_UP',
  PICKED_UP: 'ARRIVED_AT_GATE',
  ARRIVED_AT_GATE: 'DELIVERED',
};
const VENDOR_TARGETS = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
const RIDER_TARGETS = new Set(['PICKED_UP', 'ARRIVED_AT_GATE']);
const ADMIN_TARGETS = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE']);

const notFound = () => new OrderFlowError(404, 'NOT_FOUND', 'Order not found.');
const isTerminal = (status: string) => status === 'DELIVERED' || status === 'CANCELLED';
export const secureOtp = () => randomInt(0, 10_000).toString().padStart(4, '0'); // CSPRNG, 0000-9999

export const loadOrder = (id: string) => prisma.order.findUnique({ where: { id }, include: ORDER_VIEW_INCLUDE });

/** Run `fn` with the order row locked. 404 when it does not exist. */
const withOrderLock = <T>(orderId: string, fn: (tx: Tx, order: OrderWithRelations) => Promise<T>): Promise<T> =>
  prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      if (rows.length === 0) throw notFound();
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });
      return fn(tx, order);
    },
    { maxWait: 15_000, timeout: 30_000 },
  );

const reload = (tx: Tx, id: string) => tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_VIEW_INCLUDE });

/** Result of a change: the order before and after, and which side effects the commit unlocked. */
export type ChangeResult = {
  order: OrderWithRelations;
  before: OrderWithRelations;
  changed: boolean;
  refundNeeded?: boolean;
  newOrderAlert?: boolean;
  message?: string;
};

/**
 * After-commit side effects of a change. `awaitRefund` lets user-facing endpoints answer with the
 * final refund state; the webhook runs refunds in the background so Razorpay gets its 200 quickly.
 */
export const finishChange = async (r: ChangeResult, opts: { awaitRefund?: boolean } = { awaitRefund: true }): Promise<OrderWithRelations> => {
  if (!r.changed) return r.order;
  await publishOrderChange(r.order, { wasPoolEligible: isPoolEligible(r.before), newOrderAlert: r.newOrderAlert });
  if (r.newOrderAlert) {
    triggerDhabaAlarmPushNotification(r.order.vendorId, r.order.id, r.order.totalAmount).catch((e) => console.error('vendor alarm push failed:', e.message));
  }
  const riders = new Set([r.before.driverId, r.order.driverId].filter((x): x is string => !!x));
  for (const riderId of riders) await refreshRiderDuty(riderId);
  if (r.refundNeeded) {
    if (opts.awaitRefund) {
      await executeRefund(r.order.id);
      return (await loadOrder(r.order.id)) ?? r.order;
    }
    runInBackground(executeRefund(r.order.id));
  }
  return r.order;
};

/** Keeps the dashboard's duty status honest: IN_TRANSIT while carrying an order, ONLINE again after. */
export const refreshRiderDuty = async (riderUserId: string) => {
  try {
    const active = await prisma.order.count({ where: { driverId: riderUserId, status: { in: [...ACTIVE_RIDER_STATUSES] } } });
    const res = active > 0
      ? await prisma.driverPartner.updateMany({ where: { userId: riderUserId, dutyStatus: 'ONLINE' }, data: { dutyStatus: 'IN_TRANSIT' } })
      : await prisma.driverPartner.updateMany({ where: { userId: riderUserId, dutyStatus: 'IN_TRANSIT' }, data: { dutyStatus: 'ONLINE' } });
    if (res.count > 0) {
      const d = await prisma.driverPartner.findUnique({ where: { userId: riderUserId }, select: { id: true, userId: true, dutyStatus: true } });
      if (d) getIo()?.to('admins').emit('driver_duty_update', d);
    }
  } catch (err) {
    console.error('refreshRiderDuty failed:', (err as Error).message);
  }
};

// ----------------------------------------------------------------------------
// Customer: place an order
// ----------------------------------------------------------------------------
export type PlaceOrderInput = {
  vendorId: string;
  items: { itemId: string; quantity: number }[];
  dropoffHostel: string;
  dropoffNotes: string | null;
  couponCode?: string;
  clientRequestId: string | null;
};

export const placeOrder = async (customerId: string, input: PlaceOrderInput): Promise<{ order: OrderWithRelations; replay: boolean }> => {
  const findReplay = () =>
    input.clientRequestId
      ? prisma.order.findUnique({ where: { customerId_clientRequestId: { customerId, clientRequestId: input.clientRequestId } }, include: ORDER_VIEW_INCLUDE })
      : null;

  // Same checkout attempt again (double tap, retry after a lost response): the same order, never a second one.
  const existing = await findReplay();
  if (existing) return { order: existing, replay: true };

  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor || vendor.approvalStatus !== 'APPROVED') throw new OrderFlowError(400, 'VENDOR_UNAVAILABLE', 'This restaurant is not available right now.');
  if (!vendor.isAcceptingOrders) throw new OrderFlowError(400, 'VENDOR_CLOSED', 'This Dhaba is currently CLOSED for new orders.');

  const priced = await validateAndCalculateOrder(input.vendorId, input.items, input.couponCode);
  if (!priced.isValid) throw new OrderFlowError(400, 'INVALID_ITEMS', priced.errorMessage || 'Some items are not available.', { field: 'items' });

  try {
    const created = await prisma.$transaction(
      async (tx) => {
        // One checkout at a time per customer, so the unpaid-orders limit cannot be raced.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${customerId} FOR UPDATE`;
        const unpaid = await tx.order.count({
          where: { customerId, status: { notIn: ['DELIVERED', 'CANCELLED'] }, paymentStatus: { in: ['PENDING', 'FAILED'] } },
        });
        if (unpaid >= MAX_UNPAID_OPEN_ORDERS) {
          throw new OrderFlowError(429, 'TOO_MANY_UNPAID_ORDERS', `You already have ${unpaid} unpaid orders. Pay for one or cancel it before placing another.`);
        }
        return tx.order.create({
          data: {
            customerId,
            vendorId: input.vendorId,
            clientRequestId: input.clientRequestId,
            subtotal: priced.calculatedSubtotal,
            deliveryFee: priced.calculatedDeliveryFee,
            taxAndPackaging: priced.calculatedTaxAndPackaging,
            discount: priced.calculatedDiscount,
            totalAmount: priced.calculatedTotalAmount,
            dropoffHostel: input.dropoffHostel,
            dropoffNotes: input.dropoffNotes,
            status: 'PLACED',
            paymentStatus: 'PENDING',
            items: { create: priced.verifiedItems.map((i) => ({ menuItemId: i.itemId, name: i.name, quantity: i.quantity, price: i.price })) },
          },
          include: ORDER_VIEW_INCLUDE,
        });
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
    // Unpaid: admins see it; the restaurant and riders do not (orderView filters them out anyway).
    await publishOrderChange(created);
    return { order: created, replay: false };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Two identical requests raced: the other one created the order.
      const again = await findReplay();
      if (again) return { order: again, replay: true };
    }
    throw err;
  }
};

// ----------------------------------------------------------------------------
// Payments
// ----------------------------------------------------------------------------

/** Razorpay checkout params for the owner's unpaid order. One Razorpay order per Kraveo order (reused on retry). */
export const createPaymentForOrder = async (orderId: string, actor: Actor) => {
  return withOrderLock(orderId, async (tx, order) => {
    if (actor.role !== 'STUDENT' || order.customerId !== actor.id) throw notFound();
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED') throw new OrderFlowError(409, 'ALREADY_PAID', 'This order is already paid.');
    if (order.status !== 'PLACED') throw new OrderFlowError(409, 'ORDER_CLOSED', order.status === 'CANCELLED' ? 'This order was cancelled.' : 'This order can no longer be paid.');
    if (Date.now() - order.createdAt.getTime() >= paymentWindowMin() * 60_000) {
      throw new OrderFlowError(409, 'PAYMENT_WINDOW_EXPIRED', 'The time to pay for this order is over. Please place the order again.');
    }
    const amountPaise = Math.round(order.totalAmount * 100);
    if (!Number.isFinite(order.totalAmount) || amountPaise < 100) throw new OrderFlowError(400, 'AMOUNT_TOO_SMALL', 'Payment amount must be at least ₹1.00.');

    const reusable = [...order.payments].reverse().find((p) => (p.status === 'PENDING' || p.status === 'FAILED') && Math.round(p.amount * 100) === amountPaise);
    if (reusable) return { razorpayOrderId: reusable.razorpayOrderId, amountInPaise: amountPaise, reused: true };

    // Created while holding the order lock, so a double tap on "Pay" cannot open two Razorpay orders.
    const result = await createRazorpayOrder(order.id, order.totalAmount);
    if (!result.success || !result.razorpayOrderId) throw new OrderFlowError(503, 'PROVIDER_UNAVAILABLE', result.error || 'Payment provider is unavailable.');
    await tx.payment.create({ data: { orderId: order.id, razorpayOrderId: result.razorpayOrderId, amount: order.totalAmount, status: 'PENDING' } });
    return { razorpayOrderId: result.razorpayOrderId, amountInPaise: amountPaise, reused: false };
  });
};

export type PaidOutcome = 'PAID' | 'ALREADY_PAID' | 'LATE_PAYMENT_REFUND' | 'AMOUNT_MISMATCH' | 'DUPLICATE_PAYMENT' | 'UNKNOWN_PAYMENT' | 'ORDER_MISMATCH';

/**
 * THE only place an order becomes PAID. Called by POST /payments/verify-signature and the webhook.
 * Idempotent and race-safe: the order row lock serialises callers; only the caller that flips
 * PENDING/FAILED -> PAID does the side effects (new_order_alert, push, sockets).
 * - Amount in paise must equal Math.round(totalAmount * 100); a mismatch is recorded, never marked paid.
 * - A payment for an order that is already CANCELLED is recorded and refunded; the order stays cancelled.
 * - A second, different captured payment for an already-paid order is recorded and flagged for the admin.
 */
export const markOrderPaid = async (input: {
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  amountPaise?: number | null;
  orderIdHint?: string | null;
  source: 'VERIFY' | 'WEBHOOK';
  awaitRefund?: boolean;
}): Promise<{ outcome: PaidOutcome; order: OrderWithRelations | null }> => {
  const { razorpayOrderId, razorpayPaymentId, orderIdHint, source } = input;
  const payment = razorpayOrderId
    ? await prisma.payment.findUnique({ where: { razorpayOrderId } })
    : orderIdHint
      ? await prisma.payment.findFirst({ where: { orderId: orderIdHint }, orderBy: { createdAt: 'desc' } })
      : null;
  if (!payment) {
    await writeAudit('PAYMENT_UNKNOWN', 'PAYMENT', String(razorpayOrderId || orderIdHint || 'none').slice(0, 64), `${source}: captured payment ${razorpayPaymentId ?? '?'} does not match any Kraveo payment`);
    return { outcome: 'UNKNOWN_PAYMENT', order: null };
  }
  if (orderIdHint && payment.orderId !== orderIdHint) {
    await writeAudit('PAYMENT_ORDER_MISMATCH', 'ORDER', payment.orderId, `${source}: payment ${razorpayPaymentId ?? '?'} names order ${String(orderIdHint).slice(0, 64)} but belongs to this order`);
    return { outcome: 'ORDER_MISMATCH', order: null };
  }

  const result = await withOrderLock(payment.orderId, async (tx, order): Promise<ChangeResult & { outcome: PaidOutcome; paidPaise: number; expectedPaise: number }> => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const expectedPaise = Math.round(order.totalAmount * 100);
    const paidPaise = typeof input.amountPaise === 'number' && Number.isFinite(input.amountPaise) ? Math.round(input.amountPaise) : Math.round(p.amount * 100);
    const base = { order, before: order, changed: false, paidPaise, expectedPaise };
    const paymentId = razorpayPaymentId || p.razorpayPaymentId || null;

    if (p.status === 'PAID' || p.status === 'REFUNDED') {
      if (razorpayPaymentId && p.razorpayPaymentId && p.razorpayPaymentId !== razorpayPaymentId) return { ...base, outcome: 'DUPLICATE_PAYMENT' };
      return { ...base, outcome: 'ALREADY_PAID' };
    }
    if (paidPaise !== expectedPaise) {
      await tx.payment.update({ where: { id: p.id }, data: { capturedAmountPaise: paidPaise, razorpayPaymentId: paymentId } });
      return { ...base, outcome: 'AMOUNT_MISMATCH' };
    }
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED') {
      // Paid already through another Razorpay order: keep the evidence, the admin refunds it.
      await tx.payment.update({ where: { id: p.id }, data: { capturedAmountPaise: paidPaise, razorpayPaymentId: paymentId } });
      return { ...base, outcome: 'DUPLICATE_PAYMENT' };
    }

    await tx.payment.update({ where: { id: p.id }, data: { status: 'PAID', razorpayPaymentId: paymentId, capturedAmountPaise: paidPaise } });
    if (order.status === 'CANCELLED') {
      // Customer gave up / order expired / restaurant rejected before the money arrived: refund it.
      // paidAt stays null so the restaurant never sees this order.
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID', refundStatus: 'PENDING', refundError: null } });
      return { ...base, order: await reload(tx, order.id), changed: true, refundNeeded: true, outcome: 'LATE_PAYMENT_REFUND' };
    }
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID', paidAt: new Date() } });
    return { ...base, order: await reload(tx, order.id), changed: true, newOrderAlert: true, outcome: 'PAID' };
  });

  const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
  if (result.outcome === 'AMOUNT_MISMATCH') {
    await writeAudit('PAYMENT_AMOUNT_MISMATCH', 'ORDER', result.order.id, `${source}: payment ${razorpayPaymentId ?? '?'} captured ${rupees(result.paidPaise)} but the order total is ${rupees(result.expectedPaise)}. Not marked paid.`);
  } else if (result.outcome === 'DUPLICATE_PAYMENT') {
    await writeAudit('PAYMENT_DUPLICATE', 'ORDER', result.order.id, `${source}: second captured payment ${razorpayPaymentId ?? '?'} (${rupees(result.paidPaise)}) for an order that is already paid. Refund it in Razorpay.`);
  } else if (result.outcome === 'LATE_PAYMENT_REFUND') {
    await writeAudit('PAYMENT_AFTER_CANCEL', 'ORDER', result.order.id, `${source}: payment ${razorpayPaymentId ?? '?'} arrived after the order was cancelled; refunding automatically.`);
  }
  const order = await finishChange(result, { awaitRefund: input.awaitRefund ?? true });
  return { outcome: result.outcome, order };
};

/** Webhook payment.failed: PENDING -> FAILED (the customer may retry; a later success still flips to PAID). */
export const markPaymentFailed = async (razorpayOrderId: string) => {
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId } });
  if (!payment) return false;
  const result = await withOrderLock(payment.orderId, async (tx, order): Promise<ChangeResult> => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (p.status === 'PENDING') await tx.payment.update({ where: { id: p.id }, data: { status: 'FAILED' } });
    if (order.paymentStatus !== 'PENDING') return { order, before: order, changed: false };
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'FAILED' } });
    return { order: await reload(tx, order.id), before: order, changed: true };
  });
  await finishChange(result);
  return result.changed;
};

// ----------------------------------------------------------------------------
// Status changes (vendor kitchen states, rider pickup/arrival, admin)
// ----------------------------------------------------------------------------
export const advanceStatus = async (orderId: string, actor: Actor, target: string): Promise<{ order: OrderWithRelations; idempotent: boolean }> => {
  const result = await withOrderLock(orderId, async (tx, order): Promise<ChangeResult> => {
    if (actor.role === 'VENDOR') {
      if (order.vendor.userId !== actor.id || !isVendorVisible(order)) throw notFound();
      if (!VENDOR_TARGETS.has(target)) throw new OrderFlowError(403, 'ROLE_NOT_ALLOWED', 'Restaurants can only move an order to ACCEPTED, PREPARING or READY_FOR_PICKUP.');
    } else if (actor.role === 'DRIVER') {
      if (order.driverId !== actor.id) throw notFound();
      if (!RIDER_TARGETS.has(target)) throw new OrderFlowError(403, 'ROLE_NOT_ALLOWED', 'Riders can only mark an order PICKED_UP or ARRIVED_AT_GATE (delivery needs the gate OTP).');
    } else if (actor.role === 'ADMIN') {
      if (!ADMIN_TARGETS.has(target)) throw new OrderFlowError(400, 'INVALID_STATUS', 'Use the cancel or gate OTP endpoints for that.');
    } else {
      throw new OrderFlowError(403, 'ROLE_NOT_ALLOWED', 'You cannot change this order.');
    }

    if (order.status === target) return { order, before: order, changed: false }; // repeat = idempotent success
    if (isTerminal(order.status)) throw new OrderFlowError(409, 'ORDER_CLOSED', `This order is already ${order.status}.`);
    if (NEXT_STATUS[order.status] !== target) {
      throw new OrderFlowError(409, 'INVALID_TRANSITION', `Invalid order state transition from '${order.status}' to '${target}'. Allowed next state: ${NEXT_STATUS[order.status]}.`);
    }
    if (order.paymentStatus !== 'PAID') throw new OrderFlowError(409, 'PAYMENT_NOT_CONFIRMED', 'This order is not paid yet.');
    if (target === 'PICKED_UP' && !order.driverId) throw new OrderFlowError(409, 'NO_RIDER', 'Assign a rider before marking the order picked up.');

    const now = new Date();
    const data: Prisma.OrderUpdateInput = { status: target as any };
    if (target === 'ACCEPTED') data.acceptedAt = now;
    if (target === 'PICKED_UP') data.pickedUpAt = now;
    if (target === 'ARRIVED_AT_GATE') Object.assign(data, { otpCode: secureOtp(), otpAttempts: 0, otpLocked: false });
    await tx.order.update({ where: { id: order.id }, data });
    return { order: await reload(tx, order.id), before: order, changed: true };
  });

  if (result.changed && target === 'ARRIVED_AT_GATE' && result.order.otpCode) {
    triggerStudentArrivalNotification(result.order.customer.fcmToken || undefined, result.order.id, result.order.otpCode)
      .catch((err) => console.error('arrival push failed:', err.message));
  }
  return { order: await finishChange(result), idempotent: !result.changed };
};

// ----------------------------------------------------------------------------
// Cancellation (customer, restaurant reject, admin, system job)
// ----------------------------------------------------------------------------
export const cancelOrder = async (
  orderId: string,
  actor: Actor,
  by: CancelledBy,
  reason: string,
  opts: { guard?: (o: OrderWithRelations) => boolean; awaitRefund?: boolean } = {},
): Promise<{ order: OrderWithRelations; idempotent: boolean } | null> => {
  let skipped = false;
  const result = await withOrderLock(orderId, async (tx, order): Promise<ChangeResult> => {
    if (by === 'CUSTOMER') {
      if (actor.role !== 'STUDENT' || order.customerId !== actor.id) throw notFound();
      if (order.status === 'CANCELLED') return { order, before: order, changed: false };
      if (order.status !== 'PLACED') throw new OrderFlowError(409, 'CANNOT_CANCEL', 'The restaurant has already accepted this order, so it can no longer be cancelled in the app. Please contact Kraveo support.');
    } else if (by === 'VENDOR') {
      if (order.vendor.userId !== actor.id || !isVendorVisible(order)) throw notFound();
      if (order.status === 'CANCELLED') return { order, before: order, changed: false };
      if (order.status !== 'PLACED') throw new OrderFlowError(409, 'CANNOT_REJECT', 'An accepted order cannot be rejected. Ask Kraveo support to cancel it.');
      if (order.paymentStatus !== 'PAID') throw new OrderFlowError(409, 'PAYMENT_NOT_CONFIRMED', 'This order is not paid yet.');
    } else if (by === 'ADMIN') {
      if (order.status === 'CANCELLED') return { order, before: order, changed: false };
      if (order.status === 'DELIVERED') throw new OrderFlowError(409, 'ORDER_CLOSED', 'A delivered order cannot be cancelled.');
    } else {
      // SYSTEM (maintenance job): re-check the condition under the lock; anything else changed it first.
      if (isTerminal(order.status) || (opts.guard && !opts.guard(order))) {
        skipped = true;
        return { order, before: order, changed: false };
      }
    }

    const paid = order.paymentStatus === 'PAID';
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: by,
        cancelReason: reason.slice(0, 200),
        otpCode: null,
        ...(paid ? { refundStatus: 'PENDING', refundError: null } : {}),
      },
    });
    return { order: await reload(tx, order.id), before: order, changed: true, refundNeeded: paid };
  });
  if (skipped) return null;

  if (result.changed && by !== 'CUSTOMER') {
    await writeAudit('ORDER_CANCELLED', 'ORDER', orderId, `${by} cancelled the order (${result.before.status}, payment ${result.before.paymentStatus})${reason ? `: ${reason}` : ''}`);
  }
  return { order: await finishChange(result, { awaitRefund: opts.awaitRefund ?? true }), idempotent: !result.changed };
};

// ----------------------------------------------------------------------------
// Riders: claim from the pool, give back before pickup
// ----------------------------------------------------------------------------
export const claimOrder = async (orderId: string, riderUserId: string): Promise<{ order: OrderWithRelations; idempotent: boolean }> => {
  const outcome = await prisma.$transaction(
    async (tx) => {
      // Lock the rider first: their claims run one at a time, so MAX_ACTIVE_ORDERS_PER_RIDER holds.
      const riders = await tx.$queryRaw<{ dutyStatus: string; approvalStatus: string }[]>`
        SELECT "dutyStatus"::text AS "dutyStatus", "approvalStatus"::text AS "approvalStatus" FROM "DriverPartner" WHERE "userId" = ${riderUserId} FOR UPDATE`;
      const rider = riders[0];
      if (!rider) throw new OrderFlowError(403, 'RIDER_PROFILE_MISSING', 'No rider profile is linked to this account.');
      if (rider.approvalStatus !== 'APPROVED') throw new OrderFlowError(403, 'PARTNER_NOT_APPROVED', 'Your account is not active.', { approvalStatus: rider.approvalStatus });

      const current = await tx.order.findUnique({ where: { id: orderId }, select: { driverId: true, status: true, paymentStatus: true } });
      if (!current) throw notFound();
      if (current.driverId === riderUserId) return { changed: false };
      if (rider.dutyStatus === 'OFFLINE') throw new OrderFlowError(409, 'RIDER_OFFLINE', 'Go on duty to accept orders.');

      const active = await tx.order.count({ where: { driverId: riderUserId, status: { in: [...ACTIVE_RIDER_STATUSES] } } });
      if (active >= MAX_ACTIVE_ORDERS_PER_RIDER) throw new OrderFlowError(409, 'RIDER_BUSY', 'Finish your current delivery before accepting another order.');

      // The atomic claim: only succeeds while the order is still unassigned, paid and in a pool state.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, driverId: null, paymentStatus: 'PAID', status: { in: [...POOL_STATUSES] } },
        data: { driverId: riderUserId },
      });
      if (claimed.count === 1) return { changed: true };
      const now = await tx.order.findUnique({ where: { id: orderId }, select: { driverId: true } });
      if (now?.driverId && now.driverId !== riderUserId) throw new OrderFlowError(409, 'ALREADY_TAKEN', 'Another rider has already taken this order.');
      // Unpaid, cancelled, not accepted yet, already delivered: one code for "not in the pool".
      throw new OrderFlowError(409, 'ORDER_NOT_AVAILABLE', 'This order is not available for pickup.');
    },
    { maxWait: 15_000, timeout: 30_000 },
  );

  const order = (await loadOrder(orderId))!;
  if (!outcome.changed) return { order, idempotent: true };
  const before = { ...order, driverId: null, driver: null } as OrderWithRelations;
  return { order: await finishChange({ order, before, changed: true }), idempotent: false };
};

export const releaseOrder = async (orderId: string, riderUserId: string) => {
  const result = await withOrderLock(orderId, async (tx, order): Promise<ChangeResult> => {
    if (order.driverId !== riderUserId) throw notFound();
    if (!(POOL_STATUSES as readonly string[]).includes(order.status)) {
      throw new OrderFlowError(409, 'CANNOT_RELEASE', 'You can only give an order back before pickup. Contact Kraveo support.');
    }
    await tx.order.update({ where: { id: order.id }, data: { driverId: null } });
    return { order: await reload(tx, order.id), before: order, changed: true };
  });
  await writeAudit('ORDER_RELEASED', 'ORDER', orderId, `Rider ${result.before.driver?.name ?? riderUserId} gave the order back to the pool (${result.before.status}).`);
  return finishChange(result);
};

/** Admin assigns, moves or removes the rider (PATCH /orders/:id/reassign). */
export const reassignOrder = async (orderId: string, driverIdOrProfileId: string | null) => {
  let resolved: string | null = null;
  if (driverIdOrProfileId) {
    const driver = await prisma.driverPartner.findFirst({ where: { OR: [{ id: driverIdOrProfileId }, { userId: driverIdOrProfileId }] } });
    if (!driver?.userId) throw new OrderFlowError(400, 'RIDER_NOT_FOUND', 'Selected runner is not linked to an active user account.');
    if (driver.approvalStatus !== 'APPROVED') throw new OrderFlowError(400, 'RIDER_NOT_APPROVED', 'Only an approved rider can be assigned to an order.');
    resolved = driver.userId;
  }
  const result = await withOrderLock(orderId, async (tx, order): Promise<ChangeResult> => {
    if (isTerminal(order.status)) throw new OrderFlowError(409, 'ORDER_CLOSED', 'Completed or cancelled orders cannot be reassigned.');
    if (resolved && order.paymentStatus !== 'PAID') throw new OrderFlowError(409, 'PAYMENT_NOT_CONFIRMED', 'An unpaid order cannot be given to a rider.');
    if (order.driverId === resolved) return { order, before: order, changed: false };
    await tx.order.update({ where: { id: order.id }, data: { driverId: resolved } });
    return { order: await reload(tx, order.id), before: order, changed: true };
  });
  if (result.changed) {
    await writeAudit('ORDER_REASSIGNED', 'ORDER', orderId, `Rider changed from ${result.before.driver?.name ?? 'none'} to ${result.order.driver?.name ?? 'none'} (${result.order.status}).`);
  }
  return finishChange(result);
};

// ----------------------------------------------------------------------------
// Gate OTP (section 4)
// ----------------------------------------------------------------------------
/** Normalises what the app sent: "0421", 421 (number) -> "0421"; anything else -> null. */
export const normaliseOtp = (raw: unknown): string | null => {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 9999) return String(raw).padStart(4, '0');
  if (typeof raw === 'string' && /^\d{4}$/.test(raw.trim())) return raw.trim();
  return null;
};

const sameOtp = (given: string, stored: string | null) => {
  if (!stored || !/^\d{4}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(stored, 'utf8'));
};

export const verifyGateOtp = async (orderId: string, actor: Actor, rawOtp: unknown): Promise<{ order: OrderWithRelations; alreadyDelivered: boolean }> => {
  type Outcome = ChangeResult & { kind: 'DELIVERED' | 'ALREADY' | 'WRONG'; attempts?: number; locked?: boolean };
  const result = await withOrderLock(orderId, async (tx, order): Promise<Outcome> => {
    if (actor.role === 'DRIVER' && order.driverId !== actor.id) throw notFound();
    if (actor.role !== 'DRIVER' && actor.role !== 'ADMIN') throw notFound();
    if (order.status === 'DELIVERED') return { order, before: order, changed: false, kind: 'ALREADY' };
    if (order.otpLocked) throw new OrderFlowError(423, 'OTP_LOCKED', 'Too many wrong codes. Kraveo support has to unlock this delivery.');
    if (order.status !== 'ARRIVED_AT_GATE') throw new OrderFlowError(409, 'NOT_AT_GATE', 'Gate OTP can only be verified after the runner arrives at the gate.');
    if (order.paymentStatus !== 'PAID') throw new OrderFlowError(409, 'PAYMENT_NOT_CONFIRMED', 'This order is not paid.');

    const otp = normaliseOtp(rawOtp);
    if (!otp) {
      // A missing or malformed code is a client mistake, not a guess: it does not count as an attempt.
      throw new OrderFlowError(400, 'OTP_INVALID', 'Invalid or expired 4-digit Gate Handshake OTP code.', { error: 'Invalid Gate OTP', attemptsLeft: OTP_MAX_ATTEMPTS - order.otpAttempts });
    }
    if (!sameOtp(otp, order.otpCode)) {
      const attempts = order.otpAttempts + 1;
      const locked = attempts >= OTP_MAX_ATTEMPTS;
      await tx.order.update({ where: { id: order.id }, data: { otpAttempts: attempts, otpLocked: locked } });
      // Committed (the attempt counts even though the caller gets an error).
      return { order: await reload(tx, order.id), before: order, changed: locked, kind: 'WRONG', attempts, locked };
    }
    await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED', deliveredAt: new Date(), otpCode: 'USED' } });
    return { order: await reload(tx, order.id), before: order, changed: true, kind: 'DELIVERED' };
  });

  if (result.kind === 'WRONG') {
    if (result.locked) {
      await writeAudit('OTP_LOCKED', 'ORDER', orderId, `Gate OTP locked after ${result.attempts} wrong attempts (last by ${actor.role} ${actor.id}).`);
      await finishChange(result); // admins see otpLocked at once
      throw new OrderFlowError(423, 'OTP_LOCKED', 'Too many wrong codes. Kraveo support has to unlock this delivery.');
    }
    throw new OrderFlowError(400, 'OTP_INVALID', 'Invalid or expired 4-digit Gate Handshake OTP code.', {
      error: 'Invalid Gate OTP',
      attemptsLeft: OTP_MAX_ATTEMPTS - (result.attempts ?? 0),
    });
  }
  return { order: await finishChange(result), alreadyDelivered: result.kind === 'ALREADY' };
};

/** Admin: unlock after 5 wrong codes. A fresh code is issued (the old one may be partly guessed). */
export const resetOtpLock = async (orderId: string) => {
  const result = await withOrderLock(orderId, async (tx, order): Promise<ChangeResult> => {
    if (order.status !== 'ARRIVED_AT_GATE') throw new OrderFlowError(409, 'NOT_AT_GATE', 'Only an order waiting at the gate has a gate OTP.');
    await tx.order.update({ where: { id: order.id }, data: { otpLocked: false, otpAttempts: 0, otpCode: secureOtp() } });
    return { order: await reload(tx, order.id), before: order, changed: true };
  });
  await writeAudit('OTP_UNLOCKED', 'ORDER', orderId, `Admin unlocked the gate OTP (was ${result.before.otpLocked ? 'locked' : 'not locked'}, ${result.before.otpAttempts} wrong attempts). A new code was sent to the customer.`);
  if (result.order.otpCode) {
    triggerStudentArrivalNotification(result.order.customer.fcmToken || undefined, result.order.id, result.order.otpCode).catch((e) => console.error('arrival push failed:', e.message));
  }
  return finishChange(result);
};
