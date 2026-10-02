import { prisma } from '../db';
import { paymentWindowMin, vendorAcceptWindowMin, MAX_REFUND_ATTEMPTS, REFUND_LEASE_MS, MAINTENANCE_INTERVAL_MS } from '../config/orderFlow';
import { cancelOrder } from './orderFlow';
import { executeRefund } from './refundService';

const SYSTEM = { id: 'system', role: 'SYSTEM' };
const BATCH = 100;

/**
 * One pass of the order housekeeping (contract 1.3). Deterministic for a given `now`, and safe to run
 * twice at the same time: every cancel re-checks its condition under the order row lock and refunds
 * use a lease, so a second runner finds nothing left to do.
 *  1. Unpaid orders older than PAYMENT_WINDOW_MIN -> CANCELLED by SYSTEM ('Payment not completed').
 *  2. Paid orders the restaurant has not accepted within VENDOR_ACCEPT_WINDOW_MIN of payment ->
 *     CANCELLED by SYSTEM ('Restaurant did not respond') + refund.
 *  3. Failed refunds (and refunds left PENDING by a crash) are retried, up to MAX_REFUND_ATTEMPTS.
 */
export const runOrderMaintenance = async (now: Date = new Date()) => {
  const payCutoff = new Date(now.getTime() - paymentWindowMin() * 60_000);
  const acceptCutoff = new Date(now.getTime() - vendorAcceptWindowMin() * 60_000);
  const summary = { expired: [] as string[], autoCancelled: [] as string[], refundsRetried: [] as string[], refundsDone: [] as string[] };

  const unpaid = await prisma.order.findMany({
    where: { status: 'PLACED', paymentStatus: { in: ['PENDING', 'FAILED'] }, createdAt: { lt: payCutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });
  for (const { id } of unpaid) {
    try {
      const r = await cancelOrder(id, SYSTEM, 'SYSTEM', 'Payment not completed', {
        guard: (o) => o.status === 'PLACED' && (o.paymentStatus === 'PENDING' || o.paymentStatus === 'FAILED') && o.createdAt < payCutoff,
      });
      if (r && !r.idempotent) summary.expired.push(id);
    } catch (err) {
      console.error(`maintenance: expiring ${id} failed:`, (err as Error).message);
    }
  }

  // paidAt is only set by markOrderPaid, so legacy rows without it are never auto-refunded (they show in needs-attention).
  const unaccepted = await prisma.order.findMany({
    where: { status: 'PLACED', paymentStatus: 'PAID', paidAt: { lt: acceptCutoff } },
    select: { id: true },
    orderBy: { paidAt: 'asc' },
    take: BATCH,
  });
  for (const { id } of unaccepted) {
    try {
      const r = await cancelOrder(id, SYSTEM, 'SYSTEM', 'Restaurant did not respond', {
        guard: (o) => o.status === 'PLACED' && o.paymentStatus === 'PAID' && !!o.paidAt && o.paidAt < acceptCutoff,
      });
      if (r && !r.idempotent) summary.autoCancelled.push(id);
    } catch (err) {
      console.error(`maintenance: auto-cancelling ${id} failed:`, (err as Error).message);
    }
  }

  const refunds = await prisma.order.findMany({
    where: {
      OR: [
        { refundStatus: 'FAILED', refundAttempts: { lt: MAX_REFUND_ATTEMPTS } },
        { refundStatus: 'PENDING', refundLeaseUntil: { lt: now } },
        // Left PENDING without a lease: the process stopped between the cancel and the refund call.
        { refundStatus: 'PENDING', refundLeaseUntil: null, updatedAt: { lt: new Date(now.getTime() - REFUND_LEASE_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: BATCH,
  });
  for (const { id } of refunds) {
    const outcome = await executeRefund(id, now);
    if (outcome !== 'SKIPPED') summary.refundsRetried.push(id);
    if (outcome === 'DONE') summary.refundsDone.push(id);
  }

  const touched = summary.expired.length + summary.autoCancelled.length + summary.refundsRetried.length;
  if (touched > 0) {
    console.log(`order maintenance: expired ${summary.expired.length}, auto-cancelled ${summary.autoCancelled.length}, refunds retried ${summary.refundsRetried.length} (${summary.refundsDone.length} done)`);
  }
  return summary;
};

/** Started from index.ts (not in tests). Overlapping ticks are skipped, never stacked. */
export const startOrderMaintenance = () => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runOrderMaintenance()
      .catch((err) => console.error('order maintenance failed:', err?.message ?? err))
      .finally(() => { running = false; });
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return timer;
};
