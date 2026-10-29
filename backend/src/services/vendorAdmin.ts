import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { checkConfirmName, id8 } from '../utils/adminInput';
import { dropFromPartnerRooms } from '../realtime';
import { writeAudit } from './audit';
import { revokeUserEverywhere } from './accountControl';
import { CancelFailure, CancelOutcome, cancelOrdersGuarded, findOpenOrders, openOrderInfo } from './adminOrders';
import { OpenOrdersMode } from './customerAdmin';

/**
 * Admin: suspend / reinstate / remove / restore a RESTAURANT (Docs/27 B3, Docs/28). Same shape as customerAdmin: pre-check, one
 * transaction that takes the Vendor row lock (checkout holds a SHARED lock on the same row, so an order is either committed before
 * we look or refused after we wrote), then sessions, then (only when asked) cancels through the normal cancel code.
 * Removal never deletes anything: dishes, orders, settlements and category links stay; the restaurant is only hidden and closed.
 */
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(409, code, message, undefined, extra);
const IN_DELIVERY_TEXT = 'An order is with a rider right now, so it cannot be cancelled. Wait until it is delivered, then try again.';
export const REMOVED_OWNER_REASON = 'Restaurant removed';
const CANCEL_REASON = 'Restaurant is no longer available';

type VendorState = { approvalStatus: string; removedAt: Date | null; userId: string | null; name: string };

/** NO KEY UPDATE: conflicts with checkout's FOR SHARE (what we want) but not with the plain foreign-key checks of unrelated inserts. */
const lockVendor = async (tx: Prisma.TransactionClient, id: string): Promise<VendorState> => {
  const rows = await tx.$queryRaw<VendorState[]>`SELECT "approvalStatus"::text AS "approvalStatus", "removedAt", "userId", "name" FROM "Vendor" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  return rows[0];
};

export const loadVendorState = async (id: string): Promise<VendorState & { id: string }> => {
  const v = await prisma.vendor.findUnique({ where: { id }, select: { id: true, name: true, approvalStatus: true, removedAt: true, userId: true } });
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  return v;
};

/** The 409s of suspend / remove / detach: orders of this restaurant that are still running. */
export const assertVendorOrdersResolved = async (db: Prisma.TransactionClient | typeof prisma, vendorId: string, mode: OpenOrdersMode) => {
  const { open, inDelivery } = await findOpenOrders(db, { vendorId });
  if (inDelivery.length) throw conflict('ORDER_IN_DELIVERY', IN_DELIVERY_TEXT, { orders: inDelivery.map(openOrderInfo) });
  if (open.length && mode === 'REFUSE') throw conflict('HAS_OPEN_ORDERS', `This restaurant has ${open.length} order(s) in progress. Cancel them first, or choose to cancel them with this action.`, { orders: open.map(openOrderInfo) });
  return open;
};

/** Read-only: what a suspend / remove / detach would run into (the dashboard shows it in the confirmation dialog). */
export const vendorImpact = async (vendorId: string) => {
  const v = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true, approvalStatus: true, removedAt: true, isAcceptingOrders: true, userId: true } });
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Restaurant not found.');
  const { open, inDelivery } = await findOpenOrders(prisma, { vendorId });
  const unpaid = await prisma.settlement.aggregate({ where: { vendorId, status: { in: ['PENDING', 'ON_HOLD'] } }, _count: { _all: true }, _sum: { netPayable: true } });
  return {
    vendorId: v.id, name: v.name, approvalStatus: v.approvalStatus, removed: !!v.removedAt, isAcceptingOrders: v.isAcceptingOrders, hasOwner: !!v.userId,
    openOrders: open.map(openOrderInfo),
    inDelivery: inDelivery.map(openOrderInfo),
    unpaidSettlements: { count: unpaid._count._all, amount: Math.round((unpaid._sum.netPayable ?? 0) * 100) / 100 },
  };
};

export type VendorChange = { changed: boolean; cancelled?: CancelOutcome[]; failed?: CancelFailure[]; ownerDisabled?: boolean; ownerRestored?: boolean; warning?: string };

const cancelOpen = async (vendorId: string, adminId: string) => {
  const { open } = await findOpenOrders(prisma, { vendorId });
  return cancelOrdersGuarded(open, { id: adminId }, CANCEL_REASON);
};

const endOwnerSessions = async (ownerId: string | null, vendorId: string, reason: string) => {
  if (!ownerId) return;
  await revokeUserEverywhere(ownerId, reason);
  await dropFromPartnerRooms(ownerId, [`vendor_${vendorId}`]);
};

/** APPROVED -> SUSPENDED (hidden from customers, closed). Used by POST /admin/vendors/:id/suspend and the old partner status route. */
export const suspendVendor = async (input: { vendorId: string; adminId: string; reason: string; openOrders: OpenOrdersMode }): Promise<VendorChange & { name: string }> => {
  const { vendorId, adminId, reason, openOrders } = input;
  const v = await loadVendorState(vendorId);
  if (v.removedAt) throw conflict('VENDOR_REMOVED', 'This restaurant was removed. Restore it first.');
  if (v.approvalStatus === 'SUSPENDED') return { changed: false, name: v.name, ...(openOrders === 'CANCEL' ? await cancelOpen(vendorId, adminId) : {}) };
  if (v.approvalStatus !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved restaurant can be suspended.');
  await assertVendorOrdersResolved(prisma, vendorId, openOrders);
  const changed = await prisma.$transaction(async (tx) => {
    const row = await lockVendor(tx, vendorId);
    if (row.removedAt) throw conflict('VENDOR_REMOVED', 'This restaurant was removed. Restore it first.');
    if (row.approvalStatus === 'SUSPENDED') return false;
    if (row.approvalStatus !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved restaurant can be suspended.');
    await assertVendorOrdersResolved(tx, vendorId, openOrders);
    await tx.vendor.update({ where: { id: vendorId }, data: { approvalStatus: 'SUSPENDED', isAcceptingOrders: false, reviewedAt: new Date(), rejectionReason: reason } });
    return true;
  }, { maxWait: 15_000, timeout: 30_000 });
  if (changed) await endOwnerSessions(v.userId, vendorId, 'PARTNER_SUSPENDED');
  const out = openOrders === 'CANCEL' ? await cancelOpen(vendorId, adminId) : {};
  if (changed) {
    const n = (out as { cancelled?: CancelOutcome[] }).cancelled?.reduce((a, c) => a + c.cancelledOrders, 0) ?? 0;
    await writeAudit('PARTNER_SUSPENDED', 'VENDOR', vendorId, `SUSPENDED vendor ${v.name} from APPROVED: ${reason}; ${n} open order(s) cancelled`, { meta: { before: { approvalStatus: 'APPROVED' }, after: { approvalStatus: 'SUSPENDED' }, openOrders: { mode: openOrders, cancelled: n } } });
  }
  return { changed, name: v.name, ...out };
};

/** SUSPENDED -> APPROVED for a restaurant that was not removed. It stays CLOSED: the owner (or an admin) opens it on purpose. */
export const reinstateVendor = async (input: { vendorId: string }): Promise<VendorChange & { name: string }> => {
  const v = await loadVendorState(input.vendorId);
  if (v.removedAt) throw conflict('VENDOR_REMOVED', 'This restaurant was removed. Restore it first.');
  if (v.approvalStatus === 'APPROVED') return { changed: false, name: v.name };
  if (v.approvalStatus !== 'SUSPENDED') throw conflict('INVALID_STATE', 'Only a suspended restaurant can be reinstated. Use the applications list for pending or rejected ones.');
  const changed = await prisma.$transaction(async (tx) => {
    const row = await lockVendor(tx, input.vendorId);
    if (row.removedAt) throw conflict('VENDOR_REMOVED', 'This restaurant was removed. Restore it first.');
    if (row.approvalStatus === 'APPROVED') return false;
    if (row.approvalStatus !== 'SUSPENDED') throw conflict('INVALID_STATE', 'Only a suspended restaurant can be reinstated.');
    await tx.vendor.update({ where: { id: input.vendorId }, data: { approvalStatus: 'APPROVED', reviewedAt: new Date(), rejectionReason: null } });
    return true;
  });
  let warning: string | undefined;
  if (v.userId) {
    const owner = await prisma.user.findUnique({ where: { id: v.userId }, select: { accountStatus: true } });
    if (owner && owner.accountStatus !== 'ACTIVE') warning = 'The owner login is disabled, so nobody can run this restaurant until you enable it.';
  } else warning = 'This restaurant has no owner login, so it cannot take orders until you add one.';
  if (changed) await writeAudit('PARTNER_APPROVED', 'VENDOR', input.vendorId, `APPROVED vendor ${v.name} from SUSPENDED (reinstated; it stays closed until opened)`, { meta: { before: { approvalStatus: 'SUSPENDED' }, after: { approvalStatus: 'APPROVED' } } });
  return { changed, name: v.name, ...(warning ? { warning } : {}) };
};

export const removeVendor = async (input: { vendorId: string; adminId: string; reason: string; confirmName: unknown; openOrders: OpenOrdersMode; disableOwner: boolean }): Promise<VendorChange & { name: string }> => {
  const { vendorId, adminId, reason, openOrders, disableOwner } = input;
  const v = await loadVendorState(vendorId);
  if (v.removedAt) return { changed: false, name: v.name, ...(openOrders === 'CANCEL' ? await cancelOpen(vendorId, adminId) : {}) };
  checkConfirmName(input.confirmName, v.name);
  await assertVendorOrdersResolved(prisma, vendorId, openOrders);
  const res = await prisma.$transaction(async (tx) => {
    const row = await lockVendor(tx, vendorId);
    if (row.removedAt) return { changed: false, ownerDisabled: false, wasApproved: false };
    await assertVendorOrdersResolved(tx, vendorId, openOrders);
    const now = new Date();
    const wasApproved = row.approvalStatus === 'APPROVED';
    let ownerDisabled = false;
    if (disableOwner && row.userId) {
      const o = await tx.user.updateMany({ where: { id: row.userId, accountStatus: 'ACTIVE' }, data: { accountStatus: 'SUSPENDED', statusReason: REMOVED_OWNER_REASON, statusChangedAt: now, statusChangedBy: adminId } });
      ownerDisabled = o.count === 1;
    }
    await tx.vendor.update({
      where: { id: vendorId },
      data: {
        removedAt: now, removedReason: reason, isAcceptingOrders: false, ownerDisabledByRemoval: ownerDisabled,
        // Only a live restaurant needs its status changed to disappear; a pending / rejected one keeps its own state.
        ...(wasApproved ? { approvalStatus: 'SUSPENDED', reviewedAt: now, rejectionReason: reason } : {}),
      },
    });
    return { changed: true, ownerDisabled, wasApproved };
  }, { maxWait: 15_000, timeout: 30_000 });
  if (res.changed) await endOwnerSessions(v.userId, vendorId, 'VENDOR_REMOVED'); // the vendor is suspended / removed: the owner's old sessions end either way
  const out = openOrders === 'CANCEL' ? await cancelOpen(vendorId, adminId) : {};
  if (res.changed) {
    const n = (out as { cancelled?: CancelOutcome[] }).cancelled?.reduce((a, c) => a + c.cancelledOrders, 0) ?? 0;
    await writeAudit('VENDOR_REMOVED', 'VENDOR', vendorId, `Removed restaurant ${v.name} (${id8(vendorId)}): ${reason}; ${n} open order(s) cancelled${res.ownerDisabled ? '; owner login disabled' : ''}`, {
      meta: { before: { approvalStatus: v.approvalStatus }, after: { removed: true }, openOrders: { mode: openOrders, cancelled: n }, ownerDisabled: res.ownerDisabled },
    });
  }
  return { changed: res.changed, name: v.name, ownerDisabled: res.ownerDisabled, ...out };
};

/** Brings back exactly what the removal changed: the removal mark and (only if the removal disabled it) the owner login. Stays suspended and closed. */
export const restoreVendor = async (input: { vendorId: string; adminId: string }): Promise<VendorChange & { name: string }> => {
  const v = await loadVendorState(input.vendorId);
  if (!v.removedAt) return { changed: false, name: v.name };
  const res = await prisma.$transaction(async (tx) => {
    const row = await lockVendor(tx, input.vendorId);
    if (!row.removedAt) return { changed: false, ownerRestored: false };
    const cur = await tx.vendor.findUniqueOrThrow({ where: { id: input.vendorId }, select: { ownerDisabledByRemoval: true, userId: true } });
    let ownerRestored = false;
    if (cur.ownerDisabledByRemoval && cur.userId) {
      const o = await tx.user.updateMany({ where: { id: cur.userId, accountStatus: 'SUSPENDED', statusReason: REMOVED_OWNER_REASON }, data: { accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: new Date(), statusChangedBy: input.adminId } });
      ownerRestored = o.count === 1;
    }
    await tx.vendor.update({ where: { id: input.vendorId }, data: { removedAt: null, removedReason: null, ownerDisabledByRemoval: false } });
    return { changed: true, ownerRestored };
  });
  if (res.changed) await writeAudit('VENDOR_RESTORED', 'VENDOR', input.vendorId, `Restored restaurant ${v.name} (${id8(input.vendorId)}); it stays closed${res.ownerRestored ? '; owner login enabled again' : ''} until it is reinstated and opened`, { meta: { before: { removed: true }, after: { removed: false }, ownerRestored: res.ownerRestored } });
  return { changed: res.changed, name: v.name, ownerRestored: res.ownerRestored };
};
