import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { checkConfirmName, id8 } from '../utils/adminInput';
import { dropFromPartnerRooms } from '../realtime';
import { writeAudit } from './audit';
import { revokeUserEverywhere } from './accountControl';
import { IN_DELIVERY_STATUSES } from './adminOrders';
import { OrderFlowError, reassignOrder } from './orderFlow';
import { ACTIVE_RIDER_STATUSES } from './orderView';
import { notDeletedBySelf } from './customerAdmin';

/**
 * Admin: suspend / remove / restore a RIDER (Docs/27 B2, Docs/28). A rider with a delivery in hand never vanishes:
 *   - food already picked up (PICKED_UP, ARRIVED_AT_GATE): always 409 FOOD_WITH_RIDER (reassign it to another rider or cancel the order first);
 *   - food not picked up yet: 409 HAS_ACTIVE_DELIVERY, or with handover RELEASE the orders go back to the pool through reassignOrder(id, null);
 *   - the final state is written under the DriverPartner row lock (the same lock claimOrder / admin reassign take FIRST), after a recount, so a claim
 *     that races the removal either lands before the recount (then it blocks the removal) or is refused afterwards (rider no longer APPROVED).
 * Payout records (RiderPayout, PayoutAccount) and reviews are never touched.
 */
export type Handover = 'REFUSE' | 'RELEASE';
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(409, code, message, undefined, extra);

type RiderRow = { id: string; userId: string | null; name: string; approvalStatus: string; user: { id: string; name: string; role: string; accountStatus: string; deletedAt: Date | null } | null };

export const loadRider = async (idOrUserId: string): Promise<RiderRow> => {
  const d = await prisma.driverPartner.findFirst({
    where: { OR: [{ id: idOrUserId }, { userId: idOrUserId }] },
    select: { id: true, userId: true, name: true, approvalStatus: true, user: { select: { id: true, name: true, role: true, accountStatus: true, deletedAt: true } } },
  });
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Rider not found.');
  return d;
};

const activeDeliveries = async (db: Prisma.TransactionClient | typeof prisma, riderUserId: string) =>
  // PLACED too: an admin may pre-assign a rider to a paid order the restaurant has not accepted yet; it must not stay on a removed rider.
  db.order.findMany({ where: { driverId: riderUserId, status: { in: ['PLACED', ...ACTIVE_RIDER_STATUSES] } }, select: { id: true, status: true, groupId: true }, orderBy: { createdAt: 'asc' } });

const assertNoDelivery = async (db: Prisma.TransactionClient | typeof prisma, riderUserId: string, handover: Handover) => {
  const active = await activeDeliveries(db, riderUserId);
  const picked = active.filter((o) => (IN_DELIVERY_STATUSES as readonly string[]).includes(o.status));
  if (picked.length) throw conflict('FOOD_WITH_RIDER', 'The rider is carrying food right now. Reassign the order to another rider or cancel it first.', { orders: picked.map((o) => ({ id: o.id, status: o.status })) });
  if (active.length && handover === 'REFUSE') throw conflict('HAS_ACTIVE_DELIVERY', `The rider has ${active.length} delivery(ies) in hand. Reassign them first, or release them back to the pool with this action.`, { orders: active.map((o) => ({ id: o.id, status: o.status })) });
  return active;
};

/** handover RELEASE: every not-yet-picked-up order goes back to the pool (the whole combined order at once) through the normal reassign code. */
const releaseDeliveries = async (riderUserId: string) => {
  const active = await activeDeliveries(prisma, riderUserId);
  const released: string[] = [];
  const failed: { orderId: string; code: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const o of active) {
    const key = o.groupId ?? o.id;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await reassignOrder(o.id, null);
      released.push(o.id);
    } catch (err) {
      failed.push({ orderId: o.id, code: err instanceof OrderFlowError ? err.code : 'RELEASE_FAILED', message: err instanceof OrderFlowError ? err.message : 'The order could not be released.' });
    }
  }
  return { released, failed };
};

const lockRider = async (tx: Prisma.TransactionClient, riderId: string) => {
  const rows = await tx.$queryRaw<{ approvalStatus: string }[]>`SELECT "approvalStatus"::text AS "approvalStatus" FROM "DriverPartner" WHERE "id" = ${riderId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Rider not found.');
  return rows[0];
};

export type RiderChange = { changed: boolean; released?: string[]; releaseFailed?: { orderId: string; code: string; message: string }[] };

/** Impact preview for the dialog: the deliveries in hand. */
export const riderImpact = async (idOrUserId: string) => {
  const d = await loadRider(idOrUserId);
  const active = d.userId ? await activeDeliveries(prisma, d.userId) : [];
  return {
    driverId: d.id, userId: d.userId, name: d.name, approvalStatus: d.approvalStatus, accountStatus: d.user?.accountStatus ?? null,
    activeDeliveries: active.map((o) => ({ id: o.id, status: o.status, ...(o.groupId ? { groupId: o.groupId } : {}) })),
    foodWithRider: active.filter((o) => (IN_DELIVERY_STATUSES as readonly string[]).includes(o.status)).map((o) => ({ id: o.id, status: o.status })),
  };
};

/** APPROVED -> SUSPENDED (the old status route and nothing else: the login stays, with the "suspended" answer). */
export const suspendRider = async (input: { driverId: string; reason: string; handover: Handover }): Promise<RiderChange & { name: string }> => {
  const d = await loadRider(input.driverId);
  const userId = d.userId;
  let rel: Awaited<ReturnType<typeof releaseDeliveries>> | null = null;
  if (userId) {
    await assertNoDelivery(prisma, userId, input.handover);
    if (input.handover === 'RELEASE') rel = await releaseDeliveries(userId);
  }
  await prisma.$transaction(async (tx) => {
    const row = await lockRider(tx, d.id);
    if (row.approvalStatus !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved partner can be suspended.');
    if (userId) await assertNoDelivery(tx, userId, 'REFUSE');
    await tx.driverPartner.update({ where: { id: d.id }, data: { approvalStatus: 'SUSPENDED', dutyStatus: 'OFFLINE', reviewedAt: new Date(), rejectionReason: input.reason } });
  }, { maxWait: 15_000, timeout: 30_000 });
  if (userId) {
    await revokeUserEverywhere(userId, 'PARTNER_SUSPENDED');
    await dropFromPartnerRooms(userId, ['drivers']);
  }
  await writeAudit('PARTNER_SUSPENDED', 'DRIVER', d.id, `SUSPENDED driver ${d.name} from APPROVED: ${input.reason}${rel?.released.length ? `; ${rel.released.length} delivery(ies) released to the pool` : ''}`, { meta: { before: { approvalStatus: 'APPROVED' }, after: { approvalStatus: 'SUSPENDED' }, handover: input.handover, released: rel?.released.length ?? 0 } });
  return { changed: true, name: d.name, ...(rel ? { released: rel.released, releaseFailed: rel.failed } : {}) };
};

export const removeRider = async (input: { driverId: string; adminId: string; reason: string; confirmName: unknown; handover: Handover }): Promise<RiderChange & { name: string }> => {
  const d = await loadRider(input.driverId);
  if (!d.userId || !d.user) throw conflict('NO_ACCOUNT', 'This rider has no login account to remove.');
  if (d.user.role !== 'DRIVER') throw conflict('NOT_A_RIDER_USER', 'The login linked to this profile is not a rider login.'); // never touches an admin / customer row
  if (!notDeletedBySelf(d.user)) throw conflict('ALREADY_DELETED', 'This rider deleted the account themselves.');
  if (d.user.accountStatus === 'REMOVED') return { changed: false, name: d.name };
  checkConfirmName(input.confirmName, d.name, d.user.name);
  const userId = d.userId;
  await assertNoDelivery(prisma, userId, input.handover);
  const rel = input.handover === 'RELEASE' ? await releaseDeliveries(userId) : null;
  const now = new Date();
  const changed = await prisma.$transaction(async (tx) => {
    const row = await lockRider(tx, d.id);
    const u = await tx.$queryRaw<{ accountStatus: string; deletedAt: Date | null }[]>`SELECT "accountStatus"::text AS "accountStatus", "deletedAt" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (u.length === 0 || !notDeletedBySelf(u[0])) throw conflict('ALREADY_DELETED', 'This rider deleted the account themselves.');
    if (u[0].accountStatus === 'REMOVED') return false;
    await assertNoDelivery(tx, userId, 'REFUSE');
    await tx.driverPartner.update({
      where: { id: d.id },
      data: { dutyStatus: 'OFFLINE', ...(row.approvalStatus === 'APPROVED' ? { approvalStatus: 'SUSPENDED', reviewedAt: now, rejectionReason: input.reason } : {}) },
    });
    await tx.user.update({ where: { id: userId }, data: { accountStatus: 'REMOVED', statusReason: input.reason, statusChangedAt: now, statusChangedBy: input.adminId, deletedAt: now } });
    return true;
  }, { maxWait: 15_000, timeout: 30_000 });
  if (changed) {
    await revokeUserEverywhere(userId, 'ACCOUNT_REMOVED');
    await dropFromPartnerRooms(userId, ['drivers']);
    // A removed person must not stay on the live map. Location is personal data without accounting value; payouts and reviews stay.
    await prisma.driverLocation.deleteMany({ where: { driverId: userId } });
    await writeAudit('DRIVER_REMOVED', 'DRIVER', d.id, `Removed rider ${d.name} (${id8(userId)}): ${input.reason}${rel?.released.length ? `; ${rel.released.length} delivery(ies) released to the pool` : ''}`, { meta: { before: { approvalStatus: d.approvalStatus, accountStatus: d.user.accountStatus }, after: { accountStatus: 'REMOVED' }, handover: input.handover, released: rel?.released.length ?? 0 } });
  }
  return { changed, name: d.name, ...(rel ? { released: rel.released, releaseFailed: rel.failed } : {}) };
};

/** Undoes the account part of a removal. The rider stays SUSPENDED (pick Reactivate on purpose), and signs in again with the same password. */
export const restoreRider = async (input: { driverId: string; adminId: string; note: string | null }): Promise<RiderChange & { name: string }> => {
  const d = await loadRider(input.driverId);
  if (!d.userId || !d.user) throw conflict('NOT_RESTORABLE', 'This rider has no login account.');
  if (d.user.role !== 'DRIVER') throw conflict('NOT_A_RIDER_USER', 'The login linked to this profile is not a rider login.');
  if (!notDeletedBySelf(d.user)) throw conflict('NOT_RESTORABLE', 'This rider deleted the account themselves. It cannot be restored.');
  const userId = d.userId;
  const changed = await prisma.$transaction(async (tx) => {
    await lockRider(tx, d.id);
    const u = await tx.$queryRaw<{ accountStatus: string; deletedAt: Date | null }[]>`SELECT "accountStatus"::text AS "accountStatus", "deletedAt" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (u.length === 0 || !notDeletedBySelf(u[0])) throw conflict('NOT_RESTORABLE', 'This rider deleted the account themselves. It cannot be restored.');
    if (u[0].accountStatus === 'ACTIVE') return false;
    await tx.user.update({ where: { id: userId }, data: { accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: new Date(), statusChangedBy: input.adminId, deletedAt: null } });
    return true;
  });
  if (changed) await writeAudit('DRIVER_RESTORED', 'DRIVER', d.id, `Restored rider ${d.name} (${id8(userId)}) from ${d.user.accountStatus}; still ${d.approvalStatus.toLowerCase()} until reactivated${input.note ? `: ${input.note}` : ''}`, { meta: { before: { accountStatus: d.user.accountStatus }, after: { accountStatus: 'ACTIVE' } } });
  return { changed, name: d.name };
};
