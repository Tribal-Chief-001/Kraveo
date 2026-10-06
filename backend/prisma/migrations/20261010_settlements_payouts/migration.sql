-- Settlements, payout details and rider payout ledger, phase 2 (Docs/21_pricing_catalog_settlement_contract.md sections 2 and 5).
-- ADDITIVE: one enum, four tables (PayoutAccount, Settlement, SettlementAdjustment, RiderPayout), three indexes on "Order" and one
-- foreign key (Order.settlementId -> Settlement, ON DELETE SET NULL). No existing row changes: every order starts unsettled
-- (settlementId stays NULL) and nothing is dropped or renamed. Old orders are picked up by the first settlement run like any other
-- delivered order (their vendorSubtotal was backfilled = subtotal in phase 1, so the restaurant gets the full food total).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'ON_HOLD', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partnerType" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "upiId" TEXT,
    "accountHolder" TEXT,
    "accountNumberEnc" TEXT,
    "accountLast4" TEXT,
    "ifsc" TEXT,
    "bankName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "orderCount" INTEGER NOT NULL,
    "foodGross" DOUBLE PRECISION NOT NULL,
    "vendorAmount" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DOUBLE PRECISION NOT NULL,
    "adjustmentTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPayable" DOUBLE PRECISION NOT NULL,
    "payoutSnapshot" JSONB,
    "paidAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "paidBy" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAdjustment" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "requestId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderPayout" (
    "id" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccount_userId_key" ON "PayoutAccount"("userId");

-- CreateIndex
CREATE INDEX "Settlement_status_createdAt_idx" ON "Settlement"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Settlement_vendorId_createdAt_idx" ON "Settlement"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "Settlement_createdAt_idx" ON "Settlement"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_vendorId_batchKey_key" ON "Settlement"("vendorId", "batchKey");

-- CreateIndex
CREATE INDEX "SettlementAdjustment_settlementId_idx" ON "SettlementAdjustment"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_settlementId_requestId_key" ON "SettlementAdjustment"("settlementId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "RiderPayout_driverUserId_reference_key" ON "RiderPayout"("driverUserId", "reference");

-- CreateIndex
CREATE INDEX "RiderPayout_driverUserId_createdAt_idx" ON "RiderPayout"("driverUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RiderPayout_createdAt_idx" ON "RiderPayout"("createdAt");

-- CreateIndex
CREATE INDEX "Order_settlementId_idx" ON "Order"("settlementId");

-- CreateIndex
CREATE INDEX "Order_status_deliveredAt_idx" ON "Order"("status", "deliveredAt");

-- AddForeignKey
-- Order.settlementId has been a plain nullable text column since phase 1 and nothing ever wrote to it, so no value can point at a
-- missing settlement; the UPDATE makes that certain before the constraint is added. NOT VALID + VALIDATE keeps the lock on "Order" short.
UPDATE "Order" SET "settlementId" = NULL WHERE "settlementId" IS NOT NULL;
ALTER TABLE "Order" ADD CONSTRAINT "Order_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_settlementId_fkey";

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
