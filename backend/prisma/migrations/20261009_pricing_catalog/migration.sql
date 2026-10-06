-- Pricing, catalog approval and fees, phase 1 (Docs/21_pricing_catalog_settlement_contract.md, 2026-10-06).
-- ADDITIVE with backfill: new columns, one enum, one table (AppSetting), two indexes. Nothing is dropped or renamed, and no existing
-- value changes, so the live app behaves exactly as before until an admin uses the new features:
--   MenuItem.vendorPrice = price, approvalStatus = APPROVED (set by the column default), commission = null (inherit), createdBy = VENDOR
--   OrderItem.vendorUnitPrice = price, commissionUnit = 0
--   Order.vendorSubtotal = subtotal, commissionTotal = 0
-- "updatedAt" of orders is NOT touched (raw SQL does not move it), so no client sees an order as changed.
-- Old orders keep their old deliveryFee / taxAndPackaging values.
-- Order.settlementId is a plain nullable column for phase 2 (settlements); its table and foreign key come with phase 2.
BEGIN;

-- Short and safe on a live database: give up quickly instead of queueing behind a long lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "MenuApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable: MenuItem. vendorPrice gets a temporary default so existing rows can be added, is backfilled, then loses the default
-- (the schema has none on purpose: a writer that forgets it must fail, not pay a restaurant Rs 0).
ALTER TABLE "MenuItem" ADD COLUMN     "approvalStatus" "MenuApprovalStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "commissionType" TEXT,
ADD COLUMN     "commissionValue" DOUBLE PRECISION,
ADD COLUMN     "createdBy" TEXT NOT NULL DEFAULT 'VENDOR',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "pendingVendorPrice" DOUBLE PRECISION,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "vendorPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "MenuItem" SET "vendorPrice" = "price";

ALTER TABLE "MenuItem" ALTER COLUMN "vendorPrice" DROP DEFAULT;

-- AlterTable: Order
ALTER TABLE "Order" ADD COLUMN     "commissionTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "feeBreakdown" JSONB,
ADD COLUMN     "settlementId" TEXT,
ADD COLUMN     "vendorSubtotal" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "Order" SET "vendorSubtotal" = "subtotal";

-- AlterTable: OrderItem
ALTER TABLE "OrderItem" ADD COLUMN     "commissionUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "vendorUnitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "OrderItem" SET "vendorUnitPrice" = "price";

-- AlterTable: Vendor
ALTER TABLE "Vendor" ADD COLUMN     "commissionType" TEXT,
ADD COLUMN     "commissionValue" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "MenuItem_vendorId_approvalStatus_deletedAt_idx" ON "MenuItem"("vendorId", "approvalStatus", "deletedAt");

-- CreateIndex
CREATE INDEX "MenuItem_approvalStatus_deletedAt_idx" ON "MenuItem"("approvalStatus", "deletedAt");

COMMIT;
