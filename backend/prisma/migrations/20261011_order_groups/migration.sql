-- Multi-restaurant orders ("order groups"), Docs/22_multi_restaurant_orders_contract.md section 1.
-- ADDITIVE: one new table (OrderGroup), two NULLABLE columns on "Order" (groupId, groupIndex), three indexes and two foreign keys.
-- No existing row changes and nothing needs a backfill: every existing order has groupId NULL = a normal single-restaurant order.
-- The unique index ("groupId", "groupIndex") never conflicts with existing rows (Postgres treats NULLs as distinct).
-- Order.groupId -> OrderGroup is ON DELETE RESTRICT: groups are never deleted.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupIndex" INTEGER;

-- CreateTable
CREATE TABLE "OrderGroup" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "dropoffHostel" TEXT NOT NULL,
    "dropoffNotes" TEXT,
    "couponCode" TEXT,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "feeTotal" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "restaurantCount" INTEGER NOT NULL,
    "feeBreakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderGroup_customerId_createdAt_idx" ON "OrderGroup"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderGroup_customerId_clientRequestId_key" ON "OrderGroup"("customerId", "clientRequestId");

-- CreateIndex
CREATE INDEX "Order_groupId_idx" ON "Order"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_groupId_groupIndex_key" ON "Order"("groupId", "groupIndex");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OrderGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderGroup" ADD CONSTRAINT "OrderGroup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
