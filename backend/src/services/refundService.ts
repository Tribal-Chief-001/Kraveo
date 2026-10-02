import { prisma } from '../db';
import { REFUND_LEASE_MS } from '../config/orderFlow';
import { getPaymentProvider, withProviderTimeout, providerErrorMessage } from './paymentService';
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
 *  3. Razorpay itself refuses to refund more than was captured.
 * Never lost: a provider error leaves refundStatus=FAILED (+ refundError); the maintenance job retries
 * and GET /admin/orders/needs-attention shows it.
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

const recordFailure = async (orderId: string, message: string) => {
  const res = await prisma.order.updateMany({
    where: { id: orderId, refundStatus: { in: CLAIMABLE } },
    data: { refundStatus: 'FAILED', refundError: message.slice(0, 300), refundLeaseUntil: null },
  });
  if (res.count > 0) {
    await writeAudit('REFUND_FAILED', 'ORDER', orderId, `Refund failed: ${message}`);
    await publish(orderId);
  }
};

const recordSuccess = async (orderId: string, paymentRowId: string, refundId: string, amountPaise: number) => {
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

export type RefundOutcome = 'DONE' | 'FAILED' | 'SKIPPED';

export const executeRefund = async (orderId: string, now: Date = new Date()): Promise<RefundOutcome> => {
  try {
    const lease = await prisma.order.updateMany({
      where: { id: orderId, refundStatus: { in: CLAIMABLE }, OR: [{ refundLeaseUntil: null }, { refundLeaseUntil: { lt: now } }] },
      data: { refundLeaseUntil: new Date(now.getTime() + REFUND_LEASE_MS), refundAttempts: { increment: 1 } },
    });
    if (lease.count === 0) return 'SKIPPED'; // nothing to do, or another worker holds it

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: { orderBy: { createdAt: 'desc' } } } });
    if (!order) return 'SKIPPED';
    const payment = order.payments.find((p) => p.status === 'PAID' || p.status === 'REFUNDED');
    if (!payment) {
      await recordFailure(orderId, 'No captured payment is recorded for this order. Refund it by hand in Razorpay if money was taken.');
      return 'FAILED';
    }
    const amountPaise = payment.capturedAmountPaise ?? Math.round(payment.amount * 100);
    if (payment.status === 'REFUNDED' && payment.razorpayRefundId) {
      await recordSuccess(orderId, payment.id, payment.razorpayRefundId, amountPaise);
      return 'DONE';
    }
    if (!payment.razorpayPaymentId) {
      await recordFailure(orderId, 'The captured payment has no Razorpay payment id.');
      return 'FAILED';
    }

    const provider = getPaymentProvider();
    const existing = (await withProviderTimeout(provider.listRefunds(payment.razorpayPaymentId))).filter((r) => r.status !== 'failed');
    const alreadyPaise = existing.reduce((sum, r) => sum + r.amountPaise, 0);
    let refundId: string;
    if (alreadyPaise >= amountPaise && existing.length > 0) {
      refundId = existing[0].id; // refunded earlier (e.g. we crashed before saving it)
    } else {
      const refund = await withProviderTimeout(provider.refundPayment({
        paymentId: payment.razorpayPaymentId,
        amountPaise: amountPaise - alreadyPaise,
        receipt: `rf_${orderId}`.slice(0, 40),
        notes: { orderId, reason: (order.cancelReason ?? 'Order cancelled').slice(0, 200) },
      }));
      if (refund.status === 'failed') throw new Error('The payment provider declined the refund.');
      refundId = refund.id;
    }
    await recordSuccess(orderId, payment.id, refundId, amountPaise);
    return 'DONE';
  } catch (err) {
    const message = providerErrorMessage(err);
    console.error(`refund for order ${orderId} failed:`, message);
    try {
      await recordFailure(orderId, message);
    } catch (inner) {
      console.error('could not record the refund failure:', (inner as Error).message);
    }
    return 'FAILED';
  }
};
