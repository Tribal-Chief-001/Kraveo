-- Order flow v1 (Docs/16_order_flow_contract.md section 5). Additive only:
-- every new column is nullable or has a default, so existing rows and the running app keep working.
BEGIN;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "otpAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "refundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundError" TEXT,
ADD COLUMN     "refundLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "refundStatus" TEXT,
ADD COLUMN     "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "taxAndPackaging" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "capturedAmountPaise" INTEGER,
ADD COLUMN     "razorpayRefundId" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_status_driverId_paymentStatus_idx" ON "Order"("status", "driverId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Order_paymentStatus_createdAt_idx" ON "Order"("paymentStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Order_refundStatus_idx" ON "Order"("refundStatus");

-- CreateIndex (NULL clientRequestId values never collide, so existing rows are fine)
CREATE UNIQUE INDEX "Order_customerId_clientRequestId_key" ON "Order"("customerId", "clientRequestId");

-- Backfill the price parts of existing orders. Before this change every order paid a flat Rs 15
-- tax+packaging, so subtotal = total - delivery fee - 15 (floor 0); any gap becomes the discount,
-- which keeps total = subtotal + deliveryFee + taxAndPackaging - discount true for every row.
UPDATE "Order"
SET "taxAndPackaging" = 15,
    "subtotal" = GREATEST("totalAmount" - "deliveryFee" - 15, 0);
UPDATE "Order"
SET "discount" = GREATEST("subtotal" + "deliveryFee" + "taxAndPackaging" - "totalAmount", 0);

-- Terminal orders get their end time from the last update (best information we have).
-- paidAt is deliberately NOT backfilled: the maintenance job only auto-cancels/refunds orders whose
-- paidAt it set itself, so old paid-but-unaccepted rows are surfaced to the admin instead of being
-- refunded automatically on deploy.
UPDATE "Order" SET "deliveredAt" = "updatedAt" WHERE "status" = 'DELIVERED' AND "deliveredAt" IS NULL;
UPDATE "Order" SET "cancelledAt" = "updatedAt" WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL;

COMMIT;
