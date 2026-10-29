import { Prisma, Role } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/appError';
import { checkConfirmName, id8 } from '../utils/adminInput';
import { writeAudit } from './audit';
import { revokeUserEverywhere } from './accountControl';
import { CancelFailure, CancelOutcome, cancelOrdersGuarded, findOpenOrders, openOrderInfo } from './adminOrders';

/**
 * Admin: suspend / restore / remove a CUSTOMER (Docs/27 B1, Docs/28). The order of work is what makes it race-free:
 *   1. read-only pre-check (cheap 409s with the exact blocking orders);
 *   2. ONE transaction: lock the User row (the SAME lock checkout and delete-account take), re-check, write the new state;
 *   3. after the commit: end every session / push token / socket;
 *   4. only if the admin asked for it: cancel the open orders through the normal cancel code (refunds start there, once).
 * After step 2 commits no new checkout can start, so step 4 sees a final list of orders.
 */
export type Target = 'SUSPENDED' | 'REMOVED';
export type OpenOrdersMode = 'REFUSE' | 'CANCEL';

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(409, code, message, undefined, extra);
const IN_DELIVERY_TEXT = 'An order is with a rider right now. Wait until it is delivered, or have the rider return it, then try again.';

export const notDeletedBySelf = (u: { deletedAt: Date | null; accountStatus: string }) => !(u.deletedAt && u.accountStatus === 'ACTIVE');

export const customerBase = (u: any) => ({
  id: u.id,
  name: u.name,
  email: u.email ?? null,
  phone: u.phone ?? null,
  isStudent: u.isStudent ?? null,
  hostelBlock: u.hostelBlock ?? null,
  avatarId: u.avatarId ?? null,
  kraveoCoins: u.kraveoCoins,
  createdAt: u.createdAt,
  // True for an account the customer deleted themselves (anonymised, not restorable). An admin removal is accountStatus REMOVED instead.
  deleted: (!u.email && !u.googleSub && !u.phone && u.name === 'Deleted user') || (!!u.deletedAt && u.accountStatus === 'ACTIVE'),
  accountStatus: u.accountStatus ?? 'ACTIVE',
  statusReason: u.statusReason ?? null,
  statusChangedAt: u.statusChangedAt ?? null,
  lastLoginAt: u.lastLoginAt ?? null,
});

const OPEN = { notIn: ['DELIVERED', 'CANCELLED'] } as const;

/** Orders whose refund has not reached the customer yet (PENDING, FAILED): what an admin still owes this person. */
export const refundsOwed = async (customerId: string) => {
  const rows = await prisma.order.findMany({
    where: { customerId, refundStatus: { in: ['PENDING', 'FAILED'] } },
    select: { id: true, refundStatus: true, totalAmount: true, groupIndex: true, group: { select: { totalAmount: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map((r) => ({ orderId: r.id, refundStatus: r.refundStatus as string, amount: r.groupIndex === 0 && r.group ? r.group.totalAmount : r.totalAmount }));
};

/** The customer as the detail drawer shows it (also the `data` of suspend / restore / remove). null when it is not a customer. */
export const loadCustomerDetail = async (id: string) => {
  const user = await prisma.user.findFirst({ where: { id, role: Role.STUDENT } });
  if (!user) return null;
  const [orders, grouped, paidSum, first, openRows, owed] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { items: true, vendor: { select: { id: true, name: true } }, driver: { select: { id: true, name: true, phone: true } }, payments: true },
    }),
    prisma.order.groupBy({ by: ['status'], where: { customerId: user.id }, _count: { _all: true } }),
    prisma.order.aggregate({ where: { customerId: user.id, paymentStatus: 'PAID' }, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.order.findFirst({ where: { customerId: user.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    findOpenOrders(prisma, { customerId: user.id }),
    refundsOwed(user.id),
  ]);
  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;
  const ordersCount = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    ...customerBase(user),
    statusChangedBy: user.statusChangedBy ?? null,
    openOrders: openRows.open.map(openOrderInfo),
    refundsOwed: owed,
    stats: {
      ordersCount,
      deliveredCount: byStatus.DELIVERED ?? 0,
      cancelledCount: byStatus.CANCELLED ?? 0,
      activeCount: ordersCount - (byStatus.DELIVERED ?? 0) - (byStatus.CANCELLED ?? 0),
      paidOrdersCount: paidSum._count._all,
      totalSpent: paidSum._sum.totalAmount ?? 0,
      firstOrderAt: first?.createdAt ?? null,
      lastOrderAt: orders[0]?.createdAt ?? null,
    },
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      paymentStatus: o.paymentStatus,
      totalAmount: o.totalAmount,
      deliveryFee: o.deliveryFee,
      dropoffHostel: o.dropoffHostel,
      dropoffNotes: o.dropoffNotes,
      createdAt: o.createdAt,
      vendor: o.vendor,
      driver: o.driver,
      items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      payments: o.payments.map((p) => ({ id: p.id, razorpayPaymentId: p.razorpayPaymentId, amount: p.amount, status: p.status, createdAt: p.createdAt })),
    })),
  };
};

type StateRow = { accountStatus: string; deletedAt: Date | null; name: string };

const lockCustomer = async (tx: Prisma.TransactionClient, id: string): Promise<StateRow> => {
  const rows = await tx.$queryRaw<StateRow[]>`SELECT "accountStatus"::text AS "accountStatus", "deletedAt", "name" FROM "User" WHERE "id" = ${id} AND "role"::text = 'STUDENT' FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Customer not found.');
  return rows[0];
};

/** The blocking orders (the 409s of suspend / remove), judged on `db` (the pre-check) or on the locked transaction. */
const assertCanBlock = async (db: Prisma.TransactionClient | typeof prisma, customerId: string, mode: OpenOrdersMode, scrub: boolean) => {
  const { open, inDelivery } = await findOpenOrders(db, { customerId });
  if (inDelivery.length) throw conflict('ORDER_IN_DELIVERY', IN_DELIVERY_TEXT, { orders: inDelivery.map(openOrderInfo) });
  if (open.length && mode === 'REFUSE') throw conflict('HAS_OPEN_ORDERS', `This customer has ${open.length} order(s) in progress. Cancel them first, or choose to cancel them with this action.`, { openOrders: open.map(openOrderInfo) });
  if (scrub) {
    const stuck = await db.order.findMany({ where: { customerId, refundStatus: { in: ['PENDING', 'FAILED'] } }, select: { id: true }, take: 20 });
    if (stuck.length) throw conflict('REFUND_NOT_SETTLED', 'A refund for this customer has not reached them yet. Settle it before erasing their details.', { orders: stuck.map((s) => s.id) });
  }
};

export type BlockResult = { changed: boolean; cancelled?: CancelOutcome[]; failed?: CancelFailure[]; remaining?: string[] };

export const blockCustomer = async (input: { userId: string; adminId: string; target: Target; reason: string; confirmName?: unknown; scrub: boolean; openOrders: OpenOrdersMode }): Promise<BlockResult> => {
  const { userId, adminId, target, reason, scrub, openOrders } = input;
  const user = await prisma.user.findFirst({ where: { id: userId, role: Role.STUDENT }, select: { name: true, accountStatus: true, deletedAt: true } });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'Customer not found.');
  if (!notDeletedBySelf(user)) throw conflict('ALREADY_DELETED', 'The customer deleted this account themselves.');
  const label = `customer ${user.name} (${id8(userId)})`;

  const already = user.accountStatus === target;
  if (user.accountStatus === 'REMOVED' && target === 'SUSPENDED') throw conflict('INVALID_STATE', 'A removed customer cannot be suspended. Restore the account first.');

  let changed = false;
  if (!already) {
    if (target === 'REMOVED') checkConfirmName(input.confirmName, user.name);
    await assertCanBlock(prisma, userId, openOrders, scrub && target === 'REMOVED');
    const now = new Date();
    changed = await prisma.$transaction(async (tx) => {
      const row = await lockCustomer(tx, userId);
      if (!notDeletedBySelf(row)) throw conflict('ALREADY_DELETED', 'The customer deleted this account themselves.');
      if (row.accountStatus === target) return false; // another admin got there first
      if (row.accountStatus === 'REMOVED') throw conflict('INVALID_STATE', 'A removed customer cannot be suspended. Restore the account first.');
      await assertCanBlock(tx, userId, openOrders, scrub && target === 'REMOVED');
      await tx.user.update({
        where: { id: userId },
        data: {
          accountStatus: target,
          statusReason: reason,
          statusChangedAt: now,
          statusChangedBy: adminId,
          ...(target === 'REMOVED' ? { deletedAt: now } : {}),
          // Erase only the harmless profile; email + googleSub stay as the block key (Docs/28 decision 2).
          ...(target === 'REMOVED' && scrub ? { name: 'Removed user', phone: null, avatarId: null, isStudent: null, hostelBlock: null, upiId: null, fcmToken: null, kraveoCoins: 0 } : {}),
        },
      });
      return true;
    }, { maxWait: 15_000, timeout: 30_000 });
    if (changed) await revokeUserEverywhere(userId, target === 'REMOVED' ? 'ACCOUNT_REMOVED' : 'ACCOUNT_SUSPENDED');
  }

  let cancelled: CancelOutcome[] | undefined;
  let failed: CancelFailure[] | undefined;
  let remaining: string[] | undefined;
  if (openOrders === 'CANCEL') {
    // The account is blocked now (or was), so no new order can appear: this list is final. Refunds start inside the normal cancel path.
    const { open } = await findOpenOrders(prisma, { customerId: userId });
    ({ cancelled, failed, remaining } = await cancelOrdersGuarded(open, { id: adminId }, target === 'REMOVED' ? 'Account removed by Kraveo' : 'Account suspended by Kraveo'));
  }

  if (changed) {
    const n = cancelled?.reduce((a, c) => a + c.cancelledOrders, 0) ?? 0;
    await writeAudit(
      target === 'REMOVED' ? 'CUSTOMER_REMOVED' : 'CUSTOMER_SUSPENDED', 'USER', userId,
      `${target === 'REMOVED' ? 'Removed' : 'Suspended'} ${label}: ${reason}; ${n} open order(s) cancelled${failed?.length ? `, ${failed.length} could not be cancelled` : ''}${remaining?.length ? `, ${remaining.length} left for the next call` : ''}${target === 'REMOVED' && scrub ? '; profile erased' : ''}`,
      { meta: { before: { accountStatus: user.accountStatus }, after: { accountStatus: target, scrub: target === 'REMOVED' ? scrub : undefined }, openOrders: { mode: openOrders, cancelled: n, failed: failed?.length ?? 0, remaining: remaining?.length ?? 0 } } },
    );
  }
  return { changed, ...(cancelled ? { cancelled } : {}), ...(failed ? { failed } : {}), ...(remaining ? { remaining } : {}) };
};

export const restoreCustomer = async (input: { userId: string; adminId: string; note: string | null }): Promise<{ changed: boolean }> => {
  const { userId, adminId, note } = input;
  const user = await prisma.user.findFirst({ where: { id: userId, role: Role.STUDENT }, select: { name: true, accountStatus: true, deletedAt: true } });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'Customer not found.');
  if (!notDeletedBySelf(user)) throw conflict('NOT_RESTORABLE', 'The customer deleted this account themselves. It cannot be restored.');
  if (user.accountStatus === 'ACTIVE') return { changed: false };
  const changed = await prisma.$transaction(async (tx) => {
    const row = await lockCustomer(tx, userId);
    if (!notDeletedBySelf(row)) throw conflict('NOT_RESTORABLE', 'The customer deleted this account themselves. It cannot be restored.');
    if (row.accountStatus === 'ACTIVE') return false;
    // Exactly what the block changed comes back: the state and the removal mark. Old sessions stay dead (tokenVersion was bumped), push
    // tokens stay off until the person signs in again on a device, and orders cancelled by the block stay cancelled.
    await tx.user.update({ where: { id: userId }, data: { accountStatus: 'ACTIVE', statusReason: null, statusChangedAt: new Date(), statusChangedBy: adminId, deletedAt: null } });
    return true;
  });
  if (changed) {
    await writeAudit('CUSTOMER_RESTORED', 'USER', userId, `Restored customer ${user.name} (${id8(userId)}) from ${user.accountStatus}${note ? `: ${note}` : ''}`, { meta: { before: { accountStatus: user.accountStatus }, after: { accountStatus: 'ACTIVE' } } });
  }
  return { changed };
};
