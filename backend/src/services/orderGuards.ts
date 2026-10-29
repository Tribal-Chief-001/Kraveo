import { Prisma } from '@prisma/client';
import { OrderFlowError, Tx } from './orderFlow';
import { blockedLogin } from './accountGuard';

/**
 * Checkout guards added by Docs/27 + Docs/28, shared by placeOrder (single) and placeGroup (combined).
 * They run twice: once on the plain read (fast refusal) and once INSIDE the checkout transaction under a row lock, so an admin
 * removing the customer / restaurant at the same moment can never end with a new order for it (the removal takes the same lock first).
 */
export const NOT_TAKING_ORDERS = 'This restaurant is not taking orders right now.';

type VendorState = { approvalStatus: string; isAcceptingOrders: boolean; userId: string | null; removedAt: Date | null };

/** Why a customer cannot order from this restaurant, or null. Same codes and messages as before; ownerless / removed are new. */
export const vendorOrderError = (v: VendorState | null | undefined, extra: Record<string, unknown> = {}): OrderFlowError | null => {
  if (!v || v.removedAt || v.approvalStatus !== 'APPROVED') return new OrderFlowError(400, 'VENDOR_UNAVAILABLE', 'This restaurant is not available right now.', extra);
  if (!v.isAcceptingOrders) return new OrderFlowError(400, 'VENDOR_CLOSED', 'This Dhaba is currently CLOSED for new orders.', extra);
  // Docs/28 decision 1: a restaurant without an owner login stays visible but can never take an order, whatever the open flag says.
  if (!v.userId) return new OrderFlowError(400, 'VENDOR_CLOSED', NOT_TAKING_ORDERS, extra);
  return null;
};

/** Locks the restaurants (shared, ascending id: no deadlock with a removal that locks one row FOR UPDATE) and re-checks them. */
export const assertVendorsOrderableInTx = async (tx: Tx, vendorIds: string[]): Promise<void> => {
  const ids = [...new Set(vendorIds)].sort();
  const rows = await tx.$queryRaw<(VendorState & { id: string })[]>`
    SELECT "id", "approvalStatus"::text AS "approvalStatus", "isAcceptingOrders", "userId", "removedAt" FROM "Vendor"
    WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const err = vendorOrderError(byId.get(id), { vendorId: id });
    if (err) throw err;
  }
};

/** A customer an admin suspended or removed cannot check out (a removed one also has deletedAt, answered by the old 401 check). */
export const customerBlockError = (u: { accountStatus?: string | null; statusReason?: string | null } | null | undefined): OrderFlowError | null => {
  const b = u ? blockedLogin(u) : null;
  return b ? new OrderFlowError(403, b.code, b.message) : null;
};
