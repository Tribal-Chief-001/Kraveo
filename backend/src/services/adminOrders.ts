import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { errSummary } from '../utils/log';
import { OrderFlowError, Tx, auditCancel, cancelInTx, finishChange, withOrderLock } from './orderFlow';

/**
 * What an account / restaurant / rider removal does with the orders that are still running (Docs/27 B1-B3, Docs/28 rules).
 * Cancelling is NEVER written by hand here: every cancel goes through orderFlow's withOrderLock + cancelInTx (the one path that decides,
 * locks the whole combined order, starts the one refund) + auditCancel + finishChange, exactly like POST /admin/orders/:id/cancel.
 * The only addition is a guard INSIDE the lock: food that already left the restaurant (PICKED_UP, ARRIVED_AT_GATE) is never cancelled.
 */
export const IN_DELIVERY_STATUSES = ['PICKED_UP', 'ARRIVED_AT_GATE'] as const;
const TERMINAL = ['DELIVERED', 'CANCELLED'] as const;

export type OpenOrderRow = { id: string; status: string; paymentStatus: string; totalAmount: number; groupId: string | null; vendorId: string; customerId: string; driverId: string | null };
export type OpenOrderInfo = { id: string; status: string; paymentStatus: string; totalAmount: number; groupId?: string };

export const openOrderInfo = (o: OpenOrderRow): OpenOrderInfo => ({ id: o.id, status: o.status, paymentStatus: o.paymentStatus, totalAmount: o.totalAmount, ...(o.groupId ? { groupId: o.groupId } : {}) });

const SELECT = { id: true, status: true, paymentStatus: true, totalAmount: true, groupId: true, vendorId: true, customerId: true, driverId: true } as const;

/**
 * Non-terminal orders matching `where`, plus `inDelivery`: those among them (or among the other children of their combined order,
 * which would be cancelled with them) that are already with a rider. Reads only; safe on a transaction client.
 */
export const findOpenOrders = async (db: Tx | typeof prisma, where: Prisma.OrderWhereInput): Promise<{ open: OpenOrderRow[]; inDelivery: OpenOrderRow[] }> => {
  const open = await db.order.findMany({ where: { AND: [where, { status: { notIn: [...TERMINAL] } }] }, select: SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const groupIds = [...new Set(open.map((o) => o.groupId).filter((x): x is string => !!x))];
  const siblings = groupIds.length ? await db.order.findMany({ where: { groupId: { in: groupIds }, status: { notIn: [...TERMINAL] } }, select: SELECT }) : [];
  const all = new Map([...open, ...siblings].map((o) => [o.id, o]));
  return { open, inDelivery: [...all.values()].filter((o) => (IN_DELIVERY_STATUSES as readonly string[]).includes(o.status)) };
};

/**
 * refund: NONE (unpaid, nothing to give back) | DONE (the money is back with the customer) | STARTED (recorded, the automatic retry
 * finishes it: provider slow, or the time budget of this request ran out) | FAILED (the provider refused; `refundMessage`; the
 * automatic retry and the admin retry-refund button still apply). It is the REAL state read after the refund attempt, never a promise.
 */
export type CancelOutcome = { orderId: string; groupId: string | null; cancelledOrders: number; refund: 'NONE' | 'DONE' | 'STARTED' | 'FAILED'; refundMessage?: string };
export type CancelFailure = { orderId: string; code: string; message: string };

/** One request cancels at most this many orders (a combined order counts once) and stays well below a proxy timeout. */
export const MAX_CANCELS_PER_REQUEST = 25;
const REQUEST_BUDGET_MS = 20_000; // after this no new order is started
const AWAIT_REFUND_BUDGET_MS = 8_000; // after this refunds are left to the automatic retry (refundStatus PENDING) instead of waited for

/** One cancel by ADMIN with the in-delivery guard under the lock. Throws OrderFlowError (409 ORDER_IN_DELIVERY, 404, ...). */
export const cancelOneGuarded = async (
  orderId: string,
  actor: { id: string },
  reason: string,
  opts: { deferRefund?: boolean } = {},
): Promise<{ changed: boolean; cancelledOrders: number; refund: CancelOutcome['refund']; refundMessage?: string }> => {
  const result = await withOrderLock(orderId, async (tx, order, group) => {
    if ((group ?? [order]).some((c) => (IN_DELIVERY_STATUSES as readonly string[]).includes(c.status))) {
      throw new OrderFlowError(409, 'ORDER_IN_DELIVERY', 'An order is with a rider right now, so it cannot be cancelled. Wait until it is delivered.', { orderId });
    }
    return cancelInTx(tx, order, { id: actor.id, role: 'ADMIN' }, 'ADMIN', reason, {}, group);
  });
  if (!result.changed) return { changed: false, cancelledOrders: 0, refund: 'NONE' };
  await auditCancel(result, 'ADMIN', reason);
  await finishChange(result, { awaitRefund: true, deferRefund: opts.deferRefund });
  const cancelledOrders = result.group ? result.group.touched.length : 1;
  if (!result.refundNeeded) return { changed: true, cancelledOrders, refund: 'NONE' };
  const carrier = await prisma.order.findUnique({ where: { id: result.refundOrderId ?? result.order.id }, select: { refundStatus: true, refundError: true } });
  const st = carrier?.refundStatus ?? null;
  if (st === 'DONE') return { changed: true, cancelledOrders, refund: 'DONE' };
  if (st === 'FAILED') return { changed: true, cancelledOrders, refund: 'FAILED', refundMessage: (carrier?.refundError ?? 'The payment provider did not accept the refund yet.').slice(0, 160) };
  return { changed: true, cancelledOrders, refund: 'STARTED' };
};

/**
 * Cancels the given orders (a combined order once, through any of its children), at most MAX_CANCELS_PER_REQUEST and within the request time
 * budget. What is left is returned in `remaining` (order ids, untouched): calling again continues. A failure never stops the others and never
 * undoes the block that was already written: it is returned so the admin can repeat the call (already-cancelled orders are skipped).
 */
export const cancelOrdersGuarded = async (orders: { id: string; groupId: string | null }[], actor: { id: string }, reason: string) => {
  const cancelled: CancelOutcome[] = [];
  const failed: CancelFailure[] = [];
  const remaining: string[] = [];
  const seen = new Set<string>();
  const t0 = Date.now();
  let started = 0;
  for (const o of orders) {
    const key = o.groupId ?? o.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (started >= MAX_CANCELS_PER_REQUEST || Date.now() - t0 > REQUEST_BUDGET_MS) {
      remaining.push(o.id);
      continue;
    }
    started += 1;
    try {
      const r = await cancelOneGuarded(o.id, actor, reason, { deferRefund: Date.now() - t0 > AWAIT_REFUND_BUDGET_MS });
      if (r.changed) cancelled.push({ orderId: o.id, groupId: o.groupId, cancelledOrders: r.cancelledOrders, refund: r.refund, ...(r.refundMessage ? { refundMessage: r.refundMessage } : {}) });
    } catch (err) {
      if (err instanceof OrderFlowError) failed.push({ orderId: o.id, code: err.code, message: err.message });
      else {
        console.error('admin cancel failed:', errSummary(err));
        failed.push({ orderId: o.id, code: 'CANCEL_FAILED', message: 'The order could not be cancelled. Try again.' });
      }
    }
  }
  return { cancelled, failed, remaining };
};
