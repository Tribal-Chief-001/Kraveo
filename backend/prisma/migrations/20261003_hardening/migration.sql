-- Backend hardening (security audit + QA, 2026-10-03). Additive only: every new column is nullable or has a
-- default, so existing rows and the running app keep working while the migration is applied.
BEGIN;

-- AlterTable: token revocation, account deletion marker, KRAVEO20 coin redemptions
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "kraveo20Redeemed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Accounts deleted before this release were anonymised without a marker: mark them now.
UPDATE "User" SET "deletedAt" = "updatedAt"
WHERE "deletedAt" IS NULL AND "name" = 'Deleted user' AND "email" IS NULL AND "googleSub" IS NULL AND "phone" IS NULL AND "role" = 'STUDENT';

-- AlterTable: which coupon produced the discount (single use per customer while the order is not cancelled)
-- and the proof of the delivered gate code (see schema.prisma, Order.otpProof)
ALTER TABLE "Order" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "otpProof" TEXT;

-- CreateIndex
CREATE INDEX "Order_customerId_couponCode_idx" ON "Order"("customerId", "couponCode");

COMMIT;
