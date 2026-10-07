import { prisma } from '../db';
import {
  ORPHAN_MAX_ROWS, RECONCILE_BATCH, RECONCILE_MAX_AGE_MS, RECONCILE_MIN_AGE_MS,
} from '../config/orderFlow';
import {
  getPaymentProvider, withProviderTimeout, toProviderError, PaymentProvider, ProviderPayment,
} from './paymentService';
import { markOrderPaid, loadOrder, PaidOutcome } from './orderFlow';
import { OrderWithRelations, PAYABLE_SELECT, payableAmount } from './orderView';
import { writeAudit } from './audit';
import { Breaker, runPool } from './providerPool';

/**
 * Asking Razorpay instead of trusting messages (pull, not only push).
 *  - confirmPayment / confirmAndMarkPaid: POST /payments/verify-signature no longer takes the app's word that the
 *    payment succeeded: the payment is fetched from Razorpay and must be captured, for this order, with the right amount.
 *  - reconcilePendingPayments: every maintenance tick, unpaid Payment rows that are a few minutes old are looked up at
 *    Razorpay; a captured payment whose webhook was lost (and whose app is closed) is marked paid, or refunded when the
 *    order is already cancelled (markOrderPaid does both).
 *  - findOrphanPayments: GET /admin/payments/reconcile, captured payments at Razorpay without a PAID/REFUNDED row here.
 */
const need = <K extends 'fetchPayment' | 'capturePayment' | 'fetchOrderPayments' | 'listPayments'>(provider: PaymentProvider, name: K): NonNullable<PaymentProvider[K]> => {
  const fn = provider[name];
  if (!fn) throw new Error(`The payment provider does not support ${name}.`);
  return fn.bind(provider) as NonNullable<PaymentProvider[K]>;
};

export type CaptureCheck =
  | { kind: 'CAPTURED'; payment: ProviderPayment }
  | { kind: 'NOT_CAPTURED'; status: string }
  | { kind: 'WRONG_ORDER'; payment: ProviderPayment }
  | { kind: 'UNAVAILABLE'; transient: boolean; message: string };

/**
 * Turns what Razorpay reports for a payment into "captured or not". An `authorized` payment (accounts with manual capture)
 * of the right amount is captured here; any other state is not money we have. Never throws.
 */
export const confirmPayment = async (p: ProviderPayment, ctx: { razorpayOrderId: string; expectedPaise: number }): Promise<CaptureCheck> => {
  if (p.orderId !== ctx.razorpayOrderId) return { kind: 'WRONG_ORDER', payment: p };
  if (p.status === 'captured') return { kind: 'CAPTURED', payment: p };
  if (p.status !== 'authorized') return { kind: 'NOT_CAPTURED', status: p.status };
  if (p.amountPaise !== ctx.expectedPaise) return { kind: 'NOT_CAPTURED', status: 'authorized with a different amount' };
  const provider = getPaymentProvider();
  try {
    const captured = await withProviderTimeout(need(provider, 'capturePayment')(p.id, p.amountPaise));
    return { kind: 'CAPTURED', payment: { ...p, ...captured, status: 'captured' } };
  } catch (err) {
    // Someone else (auto-capture, the webhook, a parallel tick) may have captured it a moment ago.
    try {
      const again = await withProviderTimeout(need(provider, 'fetchPayment')(p.id));
      if (again.status === 'captured' && again.orderId === ctx.razorpayOrderId) return { kind: 'CAPTURED', payment: again };
    } catch {
      // fall through with the capture error
    }
    const perr = toProviderError(err);
    return { kind: 'UNAVAILABLE', transient: perr.transient, message: perr.message };
  }
};

export type VerifyOutcome = PaidOutcome | 'PENDING_CONFIRMATION';

/**
 * POST /payments/verify-signature after the signature is valid: ask Razorpay, then markOrderPaid with the amount Razorpay says.
 * If Razorpay cannot be asked right now (or the payment is not captured yet) the answer is PENDING_CONFIRMATION and nothing
 * is marked paid; the webhook / the next reconcile tick finishes the job.
 */
export const confirmAndMarkPaid = async (input: { razorpayOrderId: string; razorpayPaymentId: string }): Promise<{ outcome: VerifyOutcome; order: OrderWithRelations | null }> => {
  const { razorpayOrderId, razorpayPaymentId } = input;
  const row = await prisma.payment.findUnique({ where: { razorpayOrderId }, include: { order: { select: PAYABLE_SELECT } } });
  // Unknown payment, or the same already-confirmed payment arriving again (retry of a lost response): nothing left to ask Razorpay.
  if (!row || ((row.status === 'PAID' || row.status === 'REFUNDED') && row.razorpayPaymentId === razorpayPaymentId)) {
    return markOrderPaid({ razorpayOrderId, razorpayPaymentId, source: 'VERIFY' });
  }
  const expectedPaise = Math.round(payableAmount(row.order) * 100); // the group total for the primary child of a combined order
  let fetched: ProviderPayment;
  try {
    fetched = await withProviderTimeout(need(getPaymentProvider(), 'fetchPayment')(razorpayPaymentId, { razorpayOrderId, amountPaise: expectedPaise }));
  } catch (err) {
    console.warn('verify-signature: payment could not be confirmed at the provider yet:', toProviderError(err).message);
    return { outcome: 'PENDING_CONFIRMATION', order: await loadOrder(row.orderId) };
  }
  const check = await confirmPayment(fetched, { razorpayOrderId, expectedPaise });
  if (check.kind === 'CAPTURED') {
    return markOrderPaid({ razorpayOrderId, razorpayPaymentId, amountPaise: check.payment.amountPaise, source: 'VERIFY' });
  }
  if (check.kind === 'WRONG_ORDER') {
    await writeAudit('PAYMENT_ORDER_MISMATCH', 'ORDER', row.orderId, `VERIFY: payment ${razorpayPaymentId} belongs to another Razorpay order than ${razorpayOrderId}. Not marked paid.`);
    return { outcome: 'ORDER_MISMATCH', order: null };
  }
  return { outcome: 'PENDING_CONFIRMATION', order: await loadOrder(row.orderId) };
};

// ----------------------------------------------------------------------------
// Reconcile phase of the maintenance tick
// ----------------------------------------------------------------------------
/** The newest half of the batch every tick, the rest rotates through the older candidates so nobody waits forever. */
export const pickReconcileBatch = <T>(candidatesNewestFirst: T[], nowMs: number, cap = RECONCILE_BATCH): T[] => {
  if (candidatesNewestFirst.length <= cap) return candidatesNewestFirst;
  const fixed = Math.ceil(cap / 2);
  const newest = candidatesNewestFirst.slice(0, fixed);
  const rest = candidatesNewestFirst.slice(fixed);
  const slots = cap - fixed;
  const start = (Math.floor(nowMs / 60_000) * slots) % rest.length;
  return [...newest, ...Array.from({ length: slots }, (_, i) => rest[(start + i) % rest.length])];
};

export type ReconcileSummary = { checked: number; paid: string[]; refundedLate: string[]; flagged: string[] };

export const reconcilePendingPayments = async (now: Date, breaker: Breaker): Promise<ReconcileSummary> => {
  const summary: ReconcileSummary = { checked: 0, paid: [], refundedLate: [], flagged: [] };
  const rows = await prisma.payment.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      capturedAmountPaise: null, // a captured amount on record was already handled (flagged mismatch / extra payment)
      createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS), gt: new Date(now.getTime() - RECONCILE_MAX_AGE_MS) },
      order: { paymentStatus: { in: ['PENDING', 'FAILED'] } },
    },
    select: { id: true, razorpayOrderId: true, orderId: true, order: { select: PAYABLE_SELECT } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const batch = pickReconcileBatch(rows, now.getTime());
  const provider = getPaymentProvider();

  summary.checked = await runPool(batch, breaker, async (row) => {
    let items: ProviderPayment[];
    try {
      items = await withProviderTimeout(need(provider, 'fetchOrderPayments')(row.razorpayOrderId));
    } catch (err) {
      const perr = toProviderError(err);
      console.warn(`reconcile: could not ask the provider about ${row.razorpayOrderId}:`, perr.message);
      return { transient: perr.transient };
    }
    const found = items.find((i) => i.status === 'captured') ?? items.find((i) => i.status === 'authorized');
    if (!found) return;
    const expectedPaise = Math.round(payableAmount(row.order) * 100);
    const check = await confirmPayment(found, { razorpayOrderId: row.razorpayOrderId, expectedPaise });
    if (check.kind === 'UNAVAILABLE') return { transient: check.transient };
    if (check.kind !== 'CAPTURED') return;
    const { outcome } = await markOrderPaid({
      razorpayOrderId: row.razorpayOrderId,
      razorpayPaymentId: check.payment.id,
      amountPaise: check.payment.amountPaise,
      source: 'RECONCILE',
      awaitRefund: true,
    });
    if (outcome === 'PAID') summary.paid.push(row.orderId);
    else if (outcome === 'LATE_PAYMENT_REFUND') summary.refundedLate.push(row.orderId);
    else if (outcome === 'AMOUNT_MISMATCH') summary.flagged.push(row.orderId);
    if (outcome === 'PAID' || outcome === 'LATE_PAYMENT_REFUND') {
      await writeAudit('PAYMENT_RECONCILED', 'ORDER', row.orderId, `Payment ${check.payment.id} found at the payment provider (webhook never arrived): ${outcome === 'PAID' ? 'order marked paid' : 'order was already cancelled, refunding'}.`);
    }
  });
  return summary;
};

// ----------------------------------------------------------------------------
// GET /admin/payments/reconcile
// ----------------------------------------------------------------------------
export type OrphanPayment = {
  paymentId: string;
  razorpayOrderId: string | null;
  amountPaise: number;
  createdAt: string | null;
  kraveoOrderId: string | null;
  kraveoPaymentStatus: string | null;
};

/** Captured payments in [fromSec, toSec] at Razorpay that no PAID/REFUNDED Payment row accounts for. Read-only, at most ORPHAN_MAX_ROWS payments are looked at. */
export const findOrphanPayments = async (fromSec: number, toSec: number): Promise<{ scanned: number; truncated: boolean; orphans: OrphanPayment[] }> => {
  const list = need(getPaymentProvider(), 'listPayments');
  const PAGE = 100;
  const all: ProviderPayment[] = [];
  let truncated = false;
  for (let skip = 0; skip < ORPHAN_MAX_ROWS; skip += PAGE) {
    const page = await withProviderTimeout(list({ fromSec, toSec, count: Math.min(PAGE, ORPHAN_MAX_ROWS - skip), skip }));
    all.push(...page);
    if (page.length < PAGE) break;
    if (all.length >= ORPHAN_MAX_ROWS) truncated = true;
  }
  const captured = all.filter((p) => p.status === 'captured');
  if (captured.length === 0) return { scanned: all.length, truncated, orphans: [] };
  const ids = captured.map((p) => p.id);
  const accounted = new Set(
    (await prisma.payment.findMany({ where: { razorpayPaymentId: { in: ids }, status: { in: ['PAID', 'REFUNDED'] } }, select: { razorpayPaymentId: true } })).map((r) => r.razorpayPaymentId),
  );
  const orphans = captured.filter((p) => !accounted.has(p.id));
  const rzpOrders = orphans.map((p) => p.orderId).filter((x): x is string => !!x);
  const rows = rzpOrders.length ? await prisma.payment.findMany({ where: { razorpayOrderId: { in: rzpOrders } }, select: { razorpayOrderId: true, orderId: true, status: true } }) : [];
  const byRzp = new Map(rows.map((r) => [r.razorpayOrderId, r]));
  return {
    scanned: all.length,
    truncated,
    orphans: orphans.map((p) => ({
      paymentId: p.id,
      razorpayOrderId: p.orderId,
      amountPaise: p.amountPaise,
      createdAt: p.createdAtSec ? new Date(p.createdAtSec * 1000).toISOString() : null,
      kraveoOrderId: (p.orderId && byRzp.get(p.orderId)?.orderId) || null,
      kraveoPaymentStatus: (p.orderId && byRzp.get(p.orderId)?.status) || null,
    })),
  };
};
