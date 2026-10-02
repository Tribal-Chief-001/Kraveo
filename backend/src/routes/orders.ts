import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { requireApprovedPartner } from './partners';
import {
  DROP_POINT_RE, POOL_LIMIT, RECENTLY_FINISHED_MIN, vendorAcceptWindowMin, READY_NO_RIDER_ALERT_MIN, DELIVERY_STUCK_ALERT_MIN, MAX_REFUND_ATTEMPTS,
  RIDER_PICKUP_ALERT_MIN, REFUND_PENDING_ALERT_MIN,
} from '../config/orderFlow';
import { orderView, ORDER_VIEW_INCLUDE, OrderWithRelations } from '../services/orderView';
import {
  OrderFlowError, placeOrder, cancelOrder, advanceStatus, claimOrder, releaseOrder, reassignOrder, verifyGateOtp, resetOtpLock,
  markOrderPaid, markPaymentFailed, createPaymentForOrder, loadOrder,
} from '../services/orderFlow';
import { executeRefund } from '../services/refundService';
import { verifyRazorpayPaymentSignature, verifyRazorpayWebhookSignature, razorpayPublicKeyId } from '../services/paymentService';
import { recordRiderLocation } from '../realtime';
import { writeAudit } from '../services/audit';
import { fail } from '../utils/http';

/**
 * Order lifecycle and payment endpoints (Docs/16_order_flow_contract.md section 2).
 * Every order in a response is orderView(order, role, id). Errors: { success:false, message, code?, field? }.
 */
export const orderRouter = Router();

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STATUSES = new Set(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED', 'CANCELLED']);

const bad = (res: Response, message: string, field?: string, code = 'BAD_REQUEST') =>
  res.status(400).json({ success: false, code, message, ...(field ? { field } : {}) });

/** 400 for an order id that cannot exist (runs after auth, so unauthenticated callers still get 401). */
const validId = (req: Request, res: Response, next: NextFunction) => (ID_RE.test(req.params.id) ? next() : bad(res, 'Invalid order id.', 'id'));

const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role });
const viewFor = (req: AuthenticatedRequest, order: OrderWithRelations) => orderView(order, req.user!.role, req.user!.id);
const optionalReason = (raw: unknown, max = 200): string | null | false => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return false;
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : false;
};
const requiredReason = (raw: unknown): string | null => {
  const s = optionalReason(raw);
  return typeof s === 'string' && s.length >= 3 ? s : null;
};

// ----------------------------------------------------------------------------
// Customer: place an order
// ----------------------------------------------------------------------------
orderRouter.post('/orders', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof b.vendorId !== 'string' || !ID_RE.test(b.vendorId)) return bad(res, 'vendorId is required.', 'vendorId');
    if (!Array.isArray(b.items) || b.items.length === 0) return bad(res, 'Cart items must be a non-empty array.', 'items');

    let dropoffHostel = typeof b.dropoffHostel === 'string' ? b.dropoffHostel.trim() : '';
    if (!dropoffHostel && b.dropoffHostel === undefined) {
      const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { hostelBlock: true } });
      dropoffHostel = me?.hostelBlock ?? '';
    }
    if (!DROP_POINT_RE.test(dropoffHostel)) return bad(res, 'Choose one of the campus drop points.', 'dropoffHostel');

    const dropoffNotes = optionalReason(b.dropoffNotes, 300);
    if (dropoffNotes === false) return bad(res, 'Delivery notes can be at most 300 characters.', 'dropoffNotes');
    if (b.couponCode !== undefined && b.couponCode !== null && (typeof b.couponCode !== 'string' || b.couponCode.length > 30)) return bad(res, 'Invalid coupon code.', 'couponCode');
    let clientRequestId: string | null = null;
    if (b.clientRequestId !== undefined && b.clientRequestId !== null) {
      if (typeof b.clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(b.clientRequestId)) return bad(res, 'clientRequestId must be 8-64 letters, digits, - or _ (use a UUID).', 'clientRequestId');
      clientRequestId = b.clientRequestId;
    }

    const { order, replay } = await placeOrder(req.user!.id, {
      vendorId: b.vendorId,
      items: b.items,
      dropoffHostel,
      dropoffNotes,
      couponCode: b.couponCode ?? undefined,
      clientRequestId,
    });
    return res.status(replay ? 200 : 201).json({
      success: true,
      message: replay ? 'This order was already placed.' : 'Order placed. Complete the payment to send it to the restaurant.',
      idempotentReplay: replay,
      data: viewFor(req, order),
    });
  } catch (err) {
    return fail(res, err, 'create order');
  }
});

// ----------------------------------------------------------------------------
// Lists and detail (all roles)
// ----------------------------------------------------------------------------
const vendorVisibleWhere: Prisma.OrderWhereInput = { OR: [{ paidAt: { not: null } }, { paymentStatus: 'PAID', status: { not: 'CANCELLED' } }] };

orderRouter.get('/orders', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const scope = req.query.scope;
    if (scope !== undefined && scope !== 'active' && scope !== 'history') return bad(res, "scope must be 'active' or 'history'.", 'scope');
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
    if (cursor && !ID_RE.test(cursor)) return bad(res, 'Invalid cursor.', 'cursor');

    const and: Prisma.OrderWhereInput[] = [];
    const str = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : undefined);
    if (user.role === 'ADMIN') {
      const f: Prisma.OrderWhereInput = {};
      if (str(req.query.vendorId)) f.vendorId = str(req.query.vendorId);
      if (str(req.query.driverId)) f.driverId = str(req.query.driverId);
      if (str(req.query.customerId)) f.customerId = str(req.query.customerId);
      if (typeof req.query.status === 'string' && STATUSES.has(req.query.status)) f.status = req.query.status as any;
      if (typeof req.query.paymentStatus === 'string' && ['PENDING', 'PAID', 'FAILED', 'REFUNDED'].includes(req.query.paymentStatus)) f.paymentStatus = req.query.paymentStatus as any;
      and.push(f);
    } else if (user.role === 'STUDENT') {
      and.push({ customerId: user.id });
    } else if (user.role === 'DRIVER') {
      and.push({ driverId: user.id });
    } else if (user.role === 'VENDOR') {
      and.push({ vendor: { userId: user.id } }, vendorVisibleWhere); // the restaurant never sees unpaid orders
    } else {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    if (scope === 'active') {
      const recent = new Date(Date.now() - RECENTLY_FINISHED_MIN * 60_000);
      and.push({ OR: [{ status: { notIn: ['DELIVERED', 'CANCELLED'] } }, { status: 'DELIVERED', deliveredAt: { gte: recent } }, { status: 'CANCELLED', cancelledAt: { gte: recent } }] });
    } else if (scope === 'history') {
      and.push({ status: { in: ['DELIVERED', 'CANCELLED'] } });
    }

    const isAdmin = user.role === 'ADMIN';
    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : isAdmin ? 100 : 50, 200);
    const page = await prisma.order.findMany({
      where: { AND: and },
      include: ORDER_VIEW_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    const data = rows.map((o) => viewFor(req, o)).filter((v) => v !== null);
    return res.json({ success: true, count: data.length, nextCursor: hasMore ? rows[rows.length - 1].id : null, data });
  } catch (err) {
    return fail(res, err, 'list orders');
  }
});

// Rider offers: paid, cooking or ready, unassigned. Offline riders get an empty list.
orderRouter.get('/orders/available', requireAuth, requireRole('DRIVER'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rider = await prisma.driverPartner.findUnique({ where: { userId: req.user!.id }, select: { dutyStatus: true, approvalStatus: true } });
    if (!rider || rider.approvalStatus !== 'APPROVED' || rider.dutyStatus === 'OFFLINE') return res.json({ success: true, count: 0, data: [] });
    const orders = await prisma.order.findMany({
      where: { paymentStatus: 'PAID', driverId: null, status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] } },
      include: ORDER_VIEW_INCLUDE,
      // Enum order is ACCEPTED < PREPARING < READY_FOR_PICKUP, so desc puts ready food first.
      orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }],
      take: POOL_LIMIT,
    });
    const data = orders.map((o) => viewFor(req, o)).filter((v) => v !== null);
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'rider pool');
  }
});

orderRouter.get('/orders/:id', requireAuth, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await loadOrder(req.params.id);
    let view = order ? viewFor(req, order) : null;
    if (view && order && req.user!.role === 'DRIVER' && order.driverId !== req.user!.id) {
      // Pool details only for approved riders.
      const rider = await prisma.driverPartner.findUnique({ where: { userId: req.user!.id }, select: { approvalStatus: true } });
      if (rider?.approvalStatus !== 'APPROVED') view = null;
    }
    // Someone else's order and a missing order look the same (no existence leak).
    if (!view) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Order not found' });
    return res.json({ success: true, data: view });
  } catch (err) {
    return fail(res, err, 'get order');
  }
});

// ----------------------------------------------------------------------------
// Cancel / reject / status
// ----------------------------------------------------------------------------
orderRouter.post('/orders/:id/cancel', requireAuth, requireRole('STUDENT'), validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = optionalReason(req.body?.reason);
    if (reason === false) return bad(res, 'The reason can be at most 200 characters.', 'reason');
    const r = await cancelOrder(req.params.id, actorOf(req), 'CUSTOMER', reason || 'Cancelled by customer');
    return res.json({ success: true, message: r!.idempotent ? 'This order was already cancelled.' : 'Order cancelled.', data: viewFor(req, r!.order) });
  } catch (err) {
    return fail(res, err, 'customer cancel');
  }
});

orderRouter.post('/orders/:id/reject', requireAuth, requireRole('VENDOR'), requireApprovedPartner, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = requiredReason(req.body?.reason);
    if (!reason) return bad(res, 'Tell the customer why (3-200 characters).', 'reason');
    const r = await cancelOrder(req.params.id, actorOf(req), 'VENDOR', reason);
    return res.json({ success: true, message: r!.idempotent ? 'This order was already cancelled.' : 'Order rejected. The customer will be refunded.', data: viewFor(req, r!.order) });
  } catch (err) {
    return fail(res, err, 'vendor reject');
  }
});

const deliverResponse = (req: AuthenticatedRequest, res: Response, r: { order: OrderWithRelations; alreadyDelivered: boolean }) =>
  res.json({
    success: true,
    message: r.alreadyDelivered ? 'Order is already DELIVERED.' : 'Gate Handshake OTP verified successfully. Order DELIVERED!',
    data: viewFor(req, r.order),
  });

orderRouter.patch('/orders/:id/status', requireAuth, requireApprovedPartner, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = req.body?.status;
    if (typeof status !== 'string' || !STATUSES.has(status)) return bad(res, 'status must be a valid order status.', 'status');
    const role = req.user!.role;

    if (status === 'CANCELLED') {
      if (role === 'STUDENT') {
        const reason = optionalReason(req.body?.reason);
        const r = await cancelOrder(req.params.id, actorOf(req), 'CUSTOMER', (typeof reason === 'string' && reason) || 'Cancelled by customer');
        return res.json({ success: true, data: viewFor(req, r!.order) });
      }
      if (role === 'ADMIN') {
        const reason = optionalReason(req.body?.reason);
        const r = await cancelOrder(req.params.id, actorOf(req), 'ADMIN', (typeof reason === 'string' && reason) || 'Cancelled by Kraveo support');
        return res.json({ success: true, data: viewFor(req, r!.order) });
      }
      return res.status(403).json({ success: false, code: 'ROLE_NOT_ALLOWED', message: role === 'VENDOR' ? 'Use Reject (with a reason) to decline a new order.' : 'Riders cannot cancel orders. Release it or contact support.' });
    }
    if (status === 'DELIVERED') {
      if (role !== 'DRIVER' && role !== 'ADMIN') return res.status(403).json({ success: false, code: 'ROLE_NOT_ALLOWED', message: 'Only the rider can complete a delivery.' });
      // Exactly the same checks as POST /orders/:id/verify-gate-otp.
      return deliverResponse(req, res, await verifyGateOtp(req.params.id, actorOf(req), req.body?.otpCode ?? req.body?.otp));
    }
    if (role === 'STUDENT') return res.status(403).json({ success: false, code: 'ROLE_NOT_ALLOWED', message: 'Students can only cancel orders.' });

    const r = await advanceStatus(req.params.id, actorOf(req), status);
    return res.json({ success: true, ...(r.idempotent ? { message: `Order is already ${status}.` } : {}), data: viewFor(req, r.order) });
  } catch (err) {
    return fail(res, err, 'update order status');
  }
});

orderRouter.post('/orders/:id/verify-gate-otp', requireAuth, requireRole('DRIVER', 'ADMIN'), requireApprovedPartner, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return deliverResponse(req, res, await verifyGateOtp(req.params.id, actorOf(req), req.body?.otpCode ?? req.body?.otp));
  } catch (err) {
    return fail(res, err, 'verify gate otp');
  }
});

// ----------------------------------------------------------------------------
// Riders
// ----------------------------------------------------------------------------
orderRouter.post('/orders/:id/accept-driver', requireAuth, requireRole('DRIVER'), requireApprovedPartner, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const r = await claimOrder(req.params.id, req.user!.id);
    return res.json({ success: true, ...(r.idempotent ? { message: 'You already have this order.' } : {}), data: viewFor(req, r.order) });
  } catch (err) {
    return fail(res, err, 'accept order');
  }
});

orderRouter.post('/orders/:id/release', requireAuth, requireRole('DRIVER'), requireApprovedPartner, validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await releaseOrder(req.params.id, req.user!.id);
    return res.json({ success: true, message: 'The order is back in the pool.', data: { id: order.id, status: order.status } });
  } catch (err) {
    return fail(res, err, 'release order');
  }
});

orderRouter.post('/drivers/location', requireAuth, requireRole('DRIVER', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { lat, lng, heading, driverId: requested } = req.body ?? {};
    let riderUserId = req.user!.id;
    if (req.user!.role === 'ADMIN') {
      if (typeof requested !== 'string' || !ID_RE.test(requested)) return bad(res, 'driverId is required.', 'driverId');
      const d = await prisma.driverPartner.findFirst({ where: { OR: [{ id: requested }, { userId: requested }] }, select: { userId: true } });
      if (!d?.userId) return bad(res, 'A linked driver profile is required.', 'driverId');
      riderUserId = d.userId;
    }
    const loc = await recordRiderLocation(riderUserId, lat, lng, heading);
    return res.json({ success: true, data: loc });
  } catch (err: any) {
    if (err?.status && err?.code) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return fail(res, err, 'driver location');
  }
});

// ----------------------------------------------------------------------------
// Admin
// ----------------------------------------------------------------------------
orderRouter.patch('/orders/:id/reassign', requireAuth, requireRole('ADMIN'), validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driverId = req.body?.driverId;
    if (driverId !== null && driverId !== undefined && (typeof driverId !== 'string' || !ID_RE.test(driverId))) return bad(res, 'driverId must be a rider id or null.', 'driverId');
    const force = req.body?.force;
    if (force !== undefined && typeof force !== 'boolean') return bad(res, 'force must be true or false.', 'force');
    const order = await reassignOrder(req.params.id, driverId || null, { force: force === true });
    return res.json({ success: true, data: viewFor(req, order) });
  } catch (err) {
    return fail(res, err, 'reassign order');
  }
});

orderRouter.post('/admin/orders/:id/cancel', requireAuth, requireRole('ADMIN'), validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reason = requiredReason(req.body?.reason);
    if (!reason) return bad(res, 'A reason (3-200 characters) is required; the customer sees it.', 'reason');
    const r = await cancelOrder(req.params.id, actorOf(req), 'ADMIN', reason);
    return res.json({ success: true, message: r!.idempotent ? 'This order was already cancelled.' : 'Order cancelled.', data: viewFor(req, r!.order) });
  } catch (err) {
    return fail(res, err, 'admin cancel');
  }
});

orderRouter.post('/admin/orders/:id/reset-otp-lock', requireAuth, requireRole('ADMIN'), validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await resetOtpLock(req.params.id);
    return res.json({ success: true, message: 'Unlocked. A new gate code was sent to the customer.', data: viewFor(req, order) });
  } catch (err) {
    return fail(res, err, 'reset otp lock');
  }
});

// Extra (not in the contract): try a failed refund again now, e.g. after automatic retries gave up.
orderRouter.post('/admin/orders/:id/retry-refund', requireAuth, requireRole('ADMIN'), validId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reset = await prisma.order.updateMany({ where: { id: req.params.id, refundStatus: 'FAILED' }, data: { refundAttempts: 0, refundLeaseUntil: null } });
    if (reset.count === 0) return res.status(409).json({ success: false, code: 'NO_FAILED_REFUND', message: 'This order has no failed refund.' });
    await writeAudit('REFUND_RETRY_REQUESTED', 'ORDER', req.params.id, 'Admin asked to retry the refund.');
    await executeRefund(req.params.id);
    const order = await loadOrder(req.params.id);
    return res.json({ success: true, data: viewFor(req, order!) });
  } catch (err) {
    return fail(res, err, 'retry refund');
  }
});

/**
 * needs-attention problem codes, most urgent first. One entry per order:
 * { problem, problems[], detail, since, hint, order: OrderView(admin) }  (problem = problems[0]).
 */
const PROBLEM_ORDER = [
  'PAYMENT_MISMATCH', 'DUPLICATE_PAYMENT', 'REFUND_FAILED', 'PAID_AFTER_CANCEL', 'REFUND_PENDING', 'OTP_LOCKED', 'STUCK_UNACCEPTED',
  'RIDER_NOT_APPROVED', 'VENDOR_NOT_APPROVED', 'DELIVERY_OVERDUE', 'RIDER_NOT_PICKED_UP', 'NO_RIDER', 'UNPAID_IN_PROGRESS', 'PAYMENT_FAILED',
] as const;
type Problem = (typeof PROBLEM_ORDER)[number];

const PROBLEM_HINTS: Record<Problem, string> = {
  PAYMENT_MISMATCH: 'Razorpay captured a different amount than the order total; it was not marked paid. Refund it in the Razorpay dashboard and cancel the order.',
  DUPLICATE_PAYMENT: 'A second payment was captured for an order that was already paid. Refund the extra payment in the Razorpay dashboard.',
  REFUND_FAILED: 'Razorpay refused or did not answer. The job retries every minute (up to 10 times). Check the payment in Razorpay; use retry-refund once fixed, or refund by hand there.',
  PAID_AFTER_CANCEL: 'Money arrived after the order was cancelled. The automatic refund is still running; it should clear within a minute.',
  REFUND_PENDING: 'A refund started but did not finish. The job retries it; if it stays, check the payment in Razorpay before refunding by hand.',
  OTP_LOCKED: 'Five wrong gate codes. Call the customer, then reset the OTP lock (a new code is sent to the customer) or cancel the order.',
  STUCK_UNACCEPTED: 'Paid but the restaurant has not accepted. Call the restaurant; otherwise cancel (the refund is automatic).',
  RIDER_NOT_APPROVED: 'The assigned rider is suspended. Reassign the order or cancel it.',
  VENDOR_NOT_APPROVED: 'The restaurant was suspended while this order is open. Cancel (refund) or let it finish.',
  DELIVERY_OVERDUE: 'Picked up long ago and still not delivered. Call the rider and the customer.',
  RIDER_NOT_PICKED_UP: 'Food is ready and a rider has it, but has not picked it up. Call the rider or reassign.',
  NO_RIDER: 'Food is ready and no rider has taken it. Reassign a rider or call riders on duty.',
  UNPAID_IN_PROGRESS: 'Moving without a confirmed payment (older app version?). Check Razorpay; cancel if nothing was paid.',
  PAYMENT_FAILED: 'The customer\'s payment failed. Nothing to do unless they call; the order expires on its own.',
};

orderRouter.get('/admin/orders/needs-attention', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);
    const open = { notIn: ['DELIVERED', 'CANCELLED'] as any[] };
    const acceptLate = ago(vendorAcceptWindowMin() + 5); // the job should have handled it by then
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { payments: { some: { capturedAmountPaise: { not: null }, status: { in: ['PENDING', 'FAILED'] } } } },
          { refundStatus: 'FAILED' },
          { status: 'CANCELLED', paymentStatus: 'PAID' },
          { refundStatus: 'PENDING', updatedAt: { lt: ago(REFUND_PENDING_ALERT_MIN) } },
          { otpLocked: true, status: 'ARRIVED_AT_GATE' },
          { status: 'PLACED', paymentStatus: 'PAID', OR: [{ paidAt: null }, { paidAt: { lt: acceptLate } }] },
          { status: open, vendor: { approvalStatus: { not: 'APPROVED' } } },
          { status: open, driver: { driverProfile: { is: { approvalStatus: { not: 'APPROVED' } } } } },
          { status: { in: ['PICKED_UP', 'ARRIVED_AT_GATE'] }, OR: [{ pickedUpAt: { lt: ago(DELIVERY_STUCK_ALERT_MIN) } }, { pickedUpAt: null, updatedAt: { lt: ago(DELIVERY_STUCK_ALERT_MIN) } }] },
          { status: 'READY_FOR_PICKUP', paymentStatus: 'PAID', updatedAt: { lt: ago(Math.min(READY_NO_RIDER_ALERT_MIN, RIDER_PICKUP_ALERT_MIN)) } },
          { status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] }, paymentStatus: { not: 'PAID' } },
          { status: 'PLACED', paymentStatus: 'FAILED' },
        ],
      },
      include: ORDER_VIEW_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const riderIds = [...new Set(orders.map((o) => o.driverId).filter((x): x is string => !!x))];
    const riders = new Map((await prisma.driverPartner.findMany({ where: { userId: { in: riderIds } }, select: { userId: true, approvalStatus: true } })).map((d) => [d.userId, d.approvalStatus]));
    const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

    const data = orders.map((o) => {
      const found = new Map<Problem, { detail: string; since: string | null }>();
      const add = (p: Problem, detail: string, since: Date | null | undefined) => { if (!found.has(p)) found.set(p, { detail, since: iso(since) }); };
      const t = (d: Date | null | undefined) => (d ? d.getTime() : 0);
      const isOpen = o.status !== 'DELIVERED' && o.status !== 'CANCELLED';
      for (const p of o.payments) {
        if (p.capturedAmountPaise === null || (p.status !== 'PENDING' && p.status !== 'FAILED')) continue;
        const expected = Math.round(o.totalAmount * 100);
        if (p.capturedAmountPaise !== expected) add('PAYMENT_MISMATCH', `Captured ${rupees(p.capturedAmountPaise)} (payment ${p.razorpayPaymentId ?? '?'}) but the order total is ${rupees(expected)}.`, p.createdAt);
        else add('DUPLICATE_PAYMENT', `Extra payment ${p.razorpayPaymentId ?? '?'} of ${rupees(p.capturedAmountPaise)} on an order that was already paid.`, p.createdAt);
      }
      if (o.refundStatus === 'FAILED') add('REFUND_FAILED', `Refund failed after ${o.refundAttempts} attempt(s): ${o.refundError ?? 'unknown error'}`, o.updatedAt);
      if (o.status === 'CANCELLED' && o.paymentStatus === 'PAID' && (!o.paidAt || !o.refundStatus)) {
        add('PAID_AFTER_CANCEL', o.refundStatus ? 'Payment captured after the order was cancelled; refund in progress.' : 'Cancelled while paid and never refunded (order from before automatic refunds). Refund it in Razorpay.', o.cancelledAt ?? o.updatedAt);
      }
      if (o.refundStatus === 'PENDING' && t(o.updatedAt) < ago(REFUND_PENDING_ALERT_MIN).getTime()) add('REFUND_PENDING', 'Refund started but not finished.', o.updatedAt);
      if (o.otpLocked && o.status === 'ARRIVED_AT_GATE') add('OTP_LOCKED', `${o.otpAttempts} wrong gate codes.`, o.updatedAt);
      if (o.status === 'PLACED' && o.paymentStatus === 'PAID' && (!o.paidAt || t(o.paidAt) < acceptLate.getTime())) {
        add('STUCK_UNACCEPTED', o.paidAt ? `Paid at ${iso(o.paidAt)}, not accepted by the restaurant.` : 'Paid (before payment times were recorded) and never accepted.', o.paidAt ?? o.createdAt);
      }
      if (isOpen && o.driverId && riders.get(o.driverId) && riders.get(o.driverId) !== 'APPROVED') add('RIDER_NOT_APPROVED', `Assigned rider ${o.driver?.name ?? o.driverId} is ${riders.get(o.driverId)}.`, o.updatedAt);
      if (isOpen && o.vendor.approvalStatus !== 'APPROVED') add('VENDOR_NOT_APPROVED', `Restaurant ${o.vendor.name} is ${o.vendor.approvalStatus}.`, o.updatedAt);
      if ((o.status === 'PICKED_UP' || o.status === 'ARRIVED_AT_GATE') && t(o.pickedUpAt ?? o.updatedAt) < ago(DELIVERY_STUCK_ALERT_MIN).getTime()) add('DELIVERY_OVERDUE', `Picked up more than ${DELIVERY_STUCK_ALERT_MIN} minutes ago.`, o.pickedUpAt ?? o.updatedAt);
      if (o.status === 'READY_FOR_PICKUP' && o.paymentStatus === 'PAID') {
        if (o.driverId && t(o.updatedAt) < ago(RIDER_PICKUP_ALERT_MIN).getTime()) add('RIDER_NOT_PICKED_UP', `Ready, rider ${o.driver?.name ?? o.driverId} has not picked it up.`, o.updatedAt);
        if (!o.driverId && t(o.updatedAt) < ago(READY_NO_RIDER_ALERT_MIN).getTime()) add('NO_RIDER', 'Ready and no rider has taken it.', o.updatedAt);
      }
      if (!['PLACED', 'DELIVERED', 'CANCELLED'].includes(o.status) && o.paymentStatus !== 'PAID') add('UNPAID_IN_PROGRESS', `Status ${o.status} with payment ${o.paymentStatus}.`, o.updatedAt);
      if (o.status === 'PLACED' && o.paymentStatus === 'FAILED') add('PAYMENT_FAILED', 'The last payment attempt failed.', o.updatedAt);

      const problems = PROBLEM_ORDER.filter((p) => found.has(p));
      const top = problems[0];
      return top ? { problem: top, problems, detail: found.get(top)!.detail, since: found.get(top)!.since, hint: PROBLEM_HINTS[top], order: viewFor(req, o) } : null;
    }).filter((row): row is NonNullable<typeof row> => row !== null);

    return res.json({ success: true, count: data.length, maxRefundAttempts: MAX_REFUND_ATTEMPTS, data });
  } catch (err) {
    return fail(res, err, 'needs-attention');
  }
});

// ----------------------------------------------------------------------------
// Payments (Razorpay)
// ----------------------------------------------------------------------------
orderRouter.post('/payments/create-order', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orderId = req.body?.orderId;
    if (typeof orderId !== 'string' || !orderId) return bad(res, 'orderId is required.', 'orderId');
    if (!ID_RE.test(orderId)) return bad(res, 'Invalid order id.', 'orderId');
    // The amount always comes from the order on the server; any amount in the body is ignored.
    const r = await createPaymentForOrder(orderId, actorOf(req));
    return res.json({
      success: true,
      razorpayOrderId: r.razorpayOrderId,
      amountInPaise: r.amountInPaise,
      currency: 'INR',
      keyId: razorpayPublicKeyId(),
      // Standard Checkout names these fields order_id, key_id and amount (paise).
      amount: r.amountInPaise,
      order_id: r.razorpayOrderId,
      key_id: razorpayPublicKeyId(),
    });
  } catch (err) {
    return fail(res, err, 'create payment');
  }
});

orderRouter.post('/payments/verify-signature', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {};
    const ok = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
    if (!ok(razorpayOrderId) || !ok(razorpayPaymentId) || !ok(razorpaySignature)) {
      return bad(res, 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.');
    }
    const payment = await prisma.payment.findUnique({ where: { razorpayOrderId }, select: { order: { select: { customerId: true } } } });
    if (!payment || payment.order.customerId !== req.user!.id) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Payment order not found.' });
    if (!verifyRazorpayPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      return res.status(400).json({ success: false, code: 'BAD_SIGNATURE', message: 'Invalid payment signature. Verification failed.' });
    }

    const { outcome, order } = await markOrderPaid({ razorpayOrderId, razorpayPaymentId, source: 'VERIFY' });
    const data = order ? viewFor(req, order) : null;
    if (outcome === 'PAID' || outcome === 'ALREADY_PAID') {
      if (order?.status === 'CANCELLED') {
        return res.status(409).json({ success: false, code: 'ORDER_CANCELLED', message: 'This order was cancelled before the payment arrived. The money is refunded automatically.', data });
      }
      return res.json({ success: true, message: outcome === 'PAID' ? 'UPI Payment signature verified successfully.' : 'Payment was already verified.', data });
    }
    if (outcome === 'LATE_PAYMENT_REFUND') {
      return res.status(409).json({ success: false, code: 'ORDER_CANCELLED', message: 'This order was cancelled before the payment arrived. The money is refunded automatically.', data });
    }
    if (outcome === 'AMOUNT_MISMATCH') {
      return res.status(409).json({ success: false, code: 'PAYMENT_AMOUNT_MISMATCH', message: 'The amount paid does not match the order. Kraveo support will contact you.', data });
    }
    if (outcome === 'DUPLICATE_PAYMENT') {
      return res.status(409).json({ success: false, code: 'DUPLICATE_PAYMENT', message: 'This order was already paid. The extra payment will be refunded by Kraveo support.', data });
    }
    return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Payment order not found.' });
  } catch (err) {
    return fail(res, err, 'verify payment');
  }
});

/**
 * Razorpay webhook. 400 only for a bad signature. Anything signed but unusable (unknown order, wrong
 * amount, other events) gets 200 so Razorpay does not retry it forever; the reason is in `code` and
 * in the admin audit log. 500 only for a real server problem (database down) so Razorpay retries.
 */
orderRouter.post('/payments/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = (req as any).rawBody || JSON.stringify(req.body ?? {});
    if (typeof signature !== 'string' || !verifyRazorpayWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ success: false, message: 'Invalid payment webhook signature' });
    }
    const body: any = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const entity: any = body.payload?.payment?.entity && typeof body.payload.payment.entity === 'object' ? body.payload.payment.entity : {};
    const s = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null);
    const event = s(body.event) ?? '';
    const razorpayOrderId = s(entity.order_id) ?? s(body.razorpayOrderId);
    const razorpayPaymentId = s(entity.id);
    const orderIdHint = s(entity.notes?.orderId) ?? s(body.orderId);
    const amountPaise = typeof entity.amount === 'number' && Number.isFinite(entity.amount) ? entity.amount : null;

    if (event === 'payment.failed') {
      if (razorpayOrderId) await markPaymentFailed(razorpayOrderId);
      return res.json({ success: true, status: 'processed', message: 'Payment failure recorded.' });
    }
    if (event !== 'payment.captured' && event !== 'order.paid') {
      return res.json({ success: true, status: 'ignored', message: 'Webhook event is not a captured payment.' });
    }
    if (!razorpayOrderId && !orderIdHint) {
      return res.json({ success: true, status: 'ignored', code: 'MISSING_REFERENCE', message: 'The webhook names no order.' });
    }
    const { outcome } = await markOrderPaid({ razorpayOrderId, razorpayPaymentId, amountPaise, orderIdHint, source: 'WEBHOOK', awaitRefund: false });
    const processed = outcome === 'PAID' || outcome === 'ALREADY_PAID' || outcome === 'LATE_PAYMENT_REFUND';
    return res.json({
      success: true,
      status: processed ? 'processed' : 'rejected',
      ...(processed ? {} : { code: outcome }),
      message: processed ? 'Razorpay webhook processed successfully.' : 'Webhook received but not applied (see the admin audit log).',
    });
  } catch (err) {
    console.error('payment webhook failed:', (err as Error)?.message);
    return res.status(500).json({ success: false, message: 'Webhook could not be processed right now.' });
  }
});
