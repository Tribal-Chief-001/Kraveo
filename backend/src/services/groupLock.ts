import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Docs/22 section 3: THE locking rule for multi-restaurant orders (deadlock freedom).
 *
 * Every transaction that changes a grouped order locks, in this order and nothing else first:
 *   1. the rider row (only claim / reassign), then
 *   2. the OrderGroup row  (SELECT ... FOR UPDATE), then
 *   3. ALL child order rows of that group in ASCENDING id order.
 * Because the group row is taken first, two operations on the same group queue up on it and never meet on a child row; the ascending
 * id order makes the child locks identical for every caller. Single-restaurant orders keep their one row lock (no group).
 * No code path may lock a child row before its group row. (A plain single-statement UPDATE of one order row, such as the refund
 * lease, holds one row only and cannot take part in a cycle.)
 *
 * `groupId` of an order is immutable, so it can be read without a lock before the group is locked.
 */
export const lockGroupRows = async (tx: Tx, groupId: string): Promise<void> => {
  await tx.$queryRaw`SELECT "id" FROM "OrderGroup" WHERE "id" = ${groupId} FOR UPDATE`;
  // The sort happens before the row locks are taken (LockRows sits above Sort), so the locks are taken in ascending id order.
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "groupId" = ${groupId} ORDER BY "id" FOR UPDATE`;
};
