import { prisma } from '../db';
import { REFUND_LEASE_MS, REFUND_BACKOFF_BASE_MS, REFUND_BACKOFF_MAX_MS, MAX_REFUND_ATTEMPTS } from '../config/orderFlow';
import { getPaymentProvider, withProviderTimeout, toProviderError, PaymentProviderError, ProviderRefund } from './paymentService';
import { ORDER_VIEW_INCLUDE } from './orderView';
import { publishOrderChange } from '../realtime';
import { writeAudit } from './audit';

/**
 * Full refund of the captured payment of a cancelled order (contract 1.3).
 *
 * Never twice:
 *  1. A lease (refundLeaseUntil) is taken with a guarded update; only the lease holder talks to Razorpay.
 *  2. Before refunding, the refunds that already exist for the payment are listed at the provider, so a
 *     crash after Razorpay accepted a refund but before we saved it never leads to a second refund.
 *  3. Razorpay itself refuses to refund more than was captured; such a 4xx answer is resolved by listing
 *     the refunds again (an "already refunded" answer ends as REFUNDED, not as a loop).
 * Never lost: a provider error leaves refundStatus=FAILED (+ refundError) and the maintenance job retries:
 *  - transient errors (no HTTP answer / timeout / 5xx / 429) do NOT count towards MAX_REFUND_ATTEMPTS; the next
 *    automatic try waits 30 s, 1, 2, 4 ... minutes (max 1 h), kept in refundLeaseUntil as a "not before" time;
 *  - permanent errors (other 4xx, local problems) count and stop the automatic retries after MAX_REFUND_ATTEMPTS.
 * GET /admin/orders/needs-attention shows every FAILED refund; POST /admin/orders/:id/retry-refund starts over.
 */
const inFlight = new Set<Promise<unknown>>();

/** Fire-and-forget work that tests can still wait for (webhook refunds). */
export const runInBackground = (p: Promise<unknown>) => {
  const tracked = p.catch((err) => console.error('background task failed:', err?.message ?? err)).finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
};

export const __waitForBackgroundWork = async () => {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
};

const CLAIMABLE = ['PENDING', 'FAILED'];

const publish = async (orderId: string) => {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });
  if (order) await publishOrderChange(order);
};

/** 30 s, 1, 2, 4 ... minutes for the 1st, 2nd, 3rd ... failure in a row, never more than an hour. */
export const backoffMs = (failuresInARow: number) =>
  Math.min(REFUND_BACKOFF_MAX_MS, REFUND_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(failuresInARow, 30) - 1));

/** Failures recorded for this order since the admin last asked for a retry (the audit log is the counter, no extra column). */
const failuresSinceReset = async (orderId: string, action: string): Promise<number> => {
  const reset = await prisma.adminAuditLog.findFirst({ where: { action: 'REFUND_RETRY_REQUESTED', targetType: 'ORDER', targetId: orderId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return prisma.adminAuditLog.count({ where: { action, targetType: 'ORDER', targetId: orderId, ...(reset ? { createdAt: { gt: reset.createdAt } } : {}) } });
};

const recordFailure = async (orderId: string, message: string, opts: { transient: boolean; now: Date }) => {
  if (opts.transient) {
    const delay = backoffMs((await failuresSinceReset(orderId, 'REFUND_FAILED')) + 1);
    const res = await prisma.order.updateMany({
      where: { id: orderId, refundStatus: { in: CLAIMABLE } },
      // The attempt taken with the lease is given back: an outage must not use up the permanent-failure budget.
      data: { refundStatus: 'FAILED', refundError: message.slice(0, 300), refundLeaseUntil: new Date(opts.now.getTime() + delay), refundAttempts: { decrement: 1 } },
    });
    if (res.count > 0) {
      await writeAudit('REFUND_FAILED', 'ORDER', orderId, `Refund could not be completed (temporary, next automatic try in ${Math.max(1, Math.ceil(delay / 60_000))} min): ${message}`);
      await publish(orderId);
    }
    return;
  }
  const res = await prisma.order.updateMany({
    where: { id: orderId, refundStatus: { in: CLAIMABLE } },
    data: { refundStatus: 'FAILED', refundError: message.slice(0, 300), refundLeaseUntil: null },
  });
  if (res.count > 0) {
    await writeAudit('REFUND_FAILED', 'ORDER', orderId, `Refund failed: ${message}`);
    await publish(orderId);
  }
};

export const recordSuccess = async (orderId: string, paymentRowId: string, refundId: string, amountPaise: number) => {
  const done = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: { id: orderId, refundStatus: { in: CLAIMABLE } },
      data: { paymentStatus: 'REFUNDED', refundStatus: 'DONE', refundError: null, refundLeaseUntil: null },
    });
    if (res.count === 0) return false;
    await tx.payment.update({ where: { id: paymentRowId }, data: { status: 'REFUNDED', razorpayRefundId: refundId, refundedAt: new Date() } });
    return true;
  });
  if (done) {
    await writeAudit('REFUND_DONE', 'ORDER', orderId, `Refunded ₹${(amountPaise / 100).toFixed(2)} (refund ${refundId}).`);
    await publish(orderId);
  }
};

/** Refunds Razorpay already holds for this payment (failed ones do not count). */
const refundState = async (paymentId: string) => {
  const list = (await withProviderTimeout(getPaymentProvider().listRefunds(paymentId))).filter((r) => r.status !== 'failed');
  return { list, paise: list.reduce((sum, r) => sum + r.amountPaise, 0) };
};

/**
 * Asks Razorpay for a refund of `amountPaise` of the payment, unless it was already refunded (then returns that refund).
 * A permanent (4xx) answer is double-checked against the provider's refund list: "already refunded" ends as success.
 */
const refundAtProvider = async (input: { paymentId: string; amountPaise: number; receipt: string; reason: string; orderId: string }): Promise<ProviderRefund> => {
  const before = await refundState(input.paymentId);
  if (before.paise >= input.amountPaise && before.list.length > 0) return before.list[0]; // refunded earlier (e.g. we crashed before saving it)
  try {
    const refund = await withProviderTimeout(getPaymentProvider().refundPayment({
      paymentId: input.paymentId,
      amountPaise: input.amountPaise - before.paise,
      receipt: input.receipt.slice(0, 40),
      notes: { orderId: input.orderId, reason: input.reason.slice(0, 200) },
    }));
    if (refund.status === 'failed') throw new PaymentProviderError('The payment provider declined the refund.', 400, false);
    return refund;
  } catch (err) {
    const perr = toProviderError(err);
    if (!perr.transient && perr.statusCode !== null) {
      try {
        const after = await refundState(input.paymentId);
        if (after.paise >= input.amountPaise && after.list.length > 0) return after.list[0];
      } catch {
        // could not confirm: report the original answer
      }
    }
    throw perr;
  }
};

export type RefundOutcome = 'DONE' | 'FAILED' | 'SKIPPED';
export type RefundResult = { outcome: RefundOutcome; transient: boolean };

/** Same as executeRefund, but also says whether a FAILED outcome was transient (the maintenance circuit breaker needs that). */
export const runRefund = async (orderId: string, now: Date = new Date()): Promise<RefundResult> => {
  try {
    const lease = await prisma.order.updateMany({
      where: { id: orderId, refundStatus: { in: CLAIMABLE }, OR: [{ refundLeaseUntil: null }, { refundLeaseUntil: { lt: now } }] },
      data: { refundLeaseUntil: new Date(now.getTime() + REFUND_LEASE_MS), refundAttempts: { increment: 1 } },
    });
    if (lease.count === 0) return { outcome: 'SKIPPED', transient: false }; // nothing to do, or another worker holds it

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: { orderBy: { createdAt: 'desc' } } } });
    if (!order) return { outcome: 'SKIPPED', transient: false };
    // The payment that made the order PAID. A duplicate payment that was refunded on its own (status REFUNDED) must never be mistaken for it.
    const refundedRows = order.payments.filter((p) => p.status === 'REFUNDED').sort((a, b) => (a.refundedAt?.getTime() ?? 0) - (b.refundedAt?.getTime() ?? 0));
    const payment = order.payments.find((p) => p.status === 'PAID') ?? refundedRows[0];
    if (!payment) {
      await recordFailure(orderId, 'No captured payment is recorded for this order. Refund it by hand in Razorpay if money was taken.', { transient: false, now });
      return { outcome: 'FAILED', transient: false };
    }
    const amountPaise = payment.capturedAmountPaise ?? Math.round(payment.amount * 100);
    if (payment.status === 'REFUNDED' && payment.razorpayRefundId) {
      await recordSuccess(orderId, payment.id, payment.razorpayRefundId, amountPaise);
      return { outcome: 'DONE', transient: false };
    }
    if (!payment.razorpayPaymentId) {
      await recordFailure(orderId, 'The captured payment has no Razorpay payment id.', { transient: false, now });
      return { outcome: 'FAILED', transient: false };
    }

    const refund = await refundAtProvider({
      paymentId: payment.razorpayPaymentId,
      amountPaise,
      receipt: `rf_${orderId}`,
      reason: order.cancelReason ?? 'Order cancelled',
      orderId,
    });
    await recordSuccess(orderId, payment.id, refund.id, amountPaise);
    return { outcome: 'DONE', transient: false };
  } catch (err) {
    const perr = toProviderError(err);
    console.error(`refund for order ${orderId} failed (${perr.transient ? 'temporary' : 'permanent'}):`, perr.message);
    try {
      await recordFailure(orderId, perr.message, { transient: perr.transient, now });
    } catch (inner) {
      console.error('could not record the refund failure:', (inner as Error).message);
    }
    return { outcome: 'FAILED', transient: perr.transient };
  }
};

export const executeRefund = async (orderId: string, now: Date = new Date()): Promise<RefundOutcome> => (await runRefund(orderId, now)).outcome;

// ----------------------------------------------------------------------------
// Extra (duplicate) payments: money taken a second time for an order that is already paid / refunded.
// The extra payment is refunded by its own Razorpay payment id; the order and its original payment are not touched.
// ----------------------------------------------------------------------------
export type ExtraRefundInput = {
  orderId: string;
  providerPaymentId: string;
  amountPaise: number;
  /** The Payment row that recorded the extra payment (null when the extra payment shares the row of the original one). */
  paymentRowId: string | null;
};

/**
 * Payment.refundedAt on a row that is still PENDING/FAILED means "an extra-payment refund owns this row until then"
 * (a lease while it runs, a "not before" time after a failure). On success the row becomes REFUNDED and refundedAt the real time.
 */
export const refundExtraPayment = async (input: ExtraRefundInput, now: Date = new Date()): Promise<RefundResult> => {
  const { orderId, providerPaymentId, amountPaise, paymentRowId } = input;
  try {
    if (paymentRowId) {
      const claim = await prisma.payment.updateMany({
        where: { id: paymentRowId, status: { in: ['PENDING', 'FAILED'] }, OR: [{ refundedAt: null }, { refundedAt: { lt: now } }] },
        data: { refundedAt: new Date(now.getTime() + REFUND_LEASE_MS) },
      });
      if (claim.count === 0) return { outcome: 'SKIPPED', transient: false };
    }
    if (!(amountPaise > 0)) throw new PaymentProviderError('The extra payment has no recorded amount.', 400, false);
    const refund = await refundAtProvider({ paymentId: providerPaymentId, amountPaise, receipt: `rx_${providerPaymentId}`, reason: 'Duplicate payment for an order that was already paid', orderId });
    if (paymentRowId) {
      await prisma.payment.updateMany({
        where: { id: paymentRowId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'REFUNDED', razorpayRefundId: refund.id, refundedAt: new Date() },
      });
    }
    await writeAudit('PAYMENT_DUPLICATE_REFUNDED', 'ORDER', orderId, `Extra payment ${providerPaymentId} refunded automatically: ₹${(amountPaise / 100).toFixed(2)} (refund ${refund.id}). The order and its original payment were not changed.`);
    await publish(orderId);
    return { outcome: 'DONE', transient: false };
  } catch (err) {
    const perr = toProviderError(err);
    console.error(`refund of extra payment ${providerPaymentId} failed (${perr.transient ? 'temporary' : 'permanent'}):`, perr.message);
    try {
      const delay = backoffMs((await failuresSinceReset(orderId, 'PAYMENT_DUPLICATE_REFUND_FAILED')) + 1);
      if (paymentRowId) {
        await prisma.payment.updateMany({ where: { id: paymentRowId, status: { in: ['PENDING', 'FAILED'] } }, data: { refundedAt: new Date(now.getTime() + delay) } });
      }
      await writeAudit('PAYMENT_DUPLICATE_REFUND_FAILED', 'ORDER', orderId, `Refund of extra payment ${providerPaymentId} failed (${perr.transient ? 'temporary' : 'permanent'}, next automatic try in ${Math.max(1, Math.ceil(delay / 60_000))} min): ${perr.message}`);
    } catch (inner) {
      console.error('could not record the extra refund failure:', (inner as Error).message);
    }
    return { outcome: 'FAILED', transient: perr.transient };
  }
};

// ----------------------------------------------------------------------------
// Razorpay webhook events refund.processed / refund.failed
// ----------------------------------------------------------------------------
export type RefundEventResult = 'CONFIRMED' | 'FAILED_RECORDED' | 'IGNORED' | 'UNKNOWN_PAYMENT';

/**
 * refund.processed: the refund exists at Razorpay and is complete. An order whose refund is still PENDING (or FAILED, e.g. the
 * answer was lost) and whose full captured amount was refunded becomes REFUNDED.
 * refund.failed: the bank rejected the refund. The order gets refundStatus FAILED with the provider's reason (needs-attention
 * shows it; the job does not repeat it blindly, the admin retries with POST /admin/orders/:id/retry-refund). A refund that we
 * had already booked as DONE is taken back (the customer did not get the money). Idempotent: guarded updates only.
 */
export const applyRefundEvent = async (
  event: 'refund.processed' | 'refund.failed',
  e: { refundId: string | null; paymentId: string | null; amountPaise: number | null; reason: string | null },
): Promise<RefundEventResult> => {
  if (!e.paymentId) return 'IGNORED';
  const payment = await prisma.payment.findFirst({ where: { razorpayPaymentId: e.paymentId }, include: { order: true } });
  if (!payment) {
    await writeAudit('REFUND_EVENT_UNKNOWN', 'PAYMENT', e.paymentId.slice(0, 64), `${event}: refund ${e.refundId ?? '?'} does not match any Kraveo payment`);
    return 'UNKNOWN_PAYMENT';
  }
  const order = payment.order;
  const capturedPaise = payment.capturedAmountPaise ?? Math.round(payment.amount * 100);

  if (event === 'refund.processed') {
    if (!e.refundId || payment.status !== 'PAID' || order.paymentStatus !== 'PAID' || !order.refundStatus || !CLAIMABLE.includes(order.refundStatus)) return 'IGNORED';
    if (e.amountPaise === null || e.amountPaise < capturedPaise) return 'IGNORED'; // a partial refund made by hand is not "the order is refunded"
    await recordSuccess(order.id, payment.id, e.refundId, capturedPaise);
    return 'CONFIRMED';
  }

  const reason = (e.reason || 'The payment provider reported that the refund failed.').slice(0, 280);
  const message = `Refund failed at the payment provider: ${reason}`;
  // The original payment is the one that made the order PAID; if both it and an extra payment are REFUNDED, the one refunded first.
  let isOriginal = payment.status === 'PAID';
  if (payment.status === 'REFUNDED' && order.paymentStatus === 'REFUNDED') {
    const refunded = await prisma.payment.findMany({ where: { orderId: order.id, status: 'REFUNDED' }, orderBy: { refundedAt: 'asc' }, select: { id: true } });
    isOriginal = refunded[0]?.id === payment.id;
  }
  if (isOriginal) {
    const flipped = await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        // PENDING = refund asked, DONE = we booked it as done but the money bounced.
        where: { id: order.id, refundStatus: { in: ['PENDING', 'DONE'] } },
        data: { refundStatus: 'FAILED', refundError: message.slice(0, 300), refundLeaseUntil: null, refundAttempts: MAX_REFUND_ATTEMPTS, paymentStatus: 'PAID' },
      });
      if (res.count === 0) return false;
      await tx.payment.updateMany({ where: { id: payment.id, status: 'REFUNDED', ...(e.refundId ? { razorpayRefundId: e.refundId } : {}) }, data: { status: 'PAID', razorpayRefundId: null, refundedAt: null } });
      return true;
    });
    if (!flipped) return 'IGNORED';
    await writeAudit('REFUND_PROVIDER_FAILED', 'ORDER', order.id, `${event}: ${message}`);
    await publish(order.id);
    return 'FAILED_RECORDED';
  }
  // An extra payment whose refund bounced: it needs a refund again (the retry loop picks it up after an hour).
  const reverted = await prisma.payment.updateMany({
    where: { id: payment.id, status: 'REFUNDED', ...(e.refundId ? { razorpayRefundId: e.refundId } : {}) },
    data: { status: 'PENDING', razorpayRefundId: null, refundedAt: new Date(Date.now() + REFUND_BACKOFF_MAX_MS) },
  });
  if (reverted.count === 0) return 'IGNORED';
  await writeAudit('REFUND_PROVIDER_FAILED', 'ORDER', order.id, `${event}: extra payment ${e.paymentId}: ${message}`);
  await publish(order.id);
  return 'FAILED_RECORDED';
};
