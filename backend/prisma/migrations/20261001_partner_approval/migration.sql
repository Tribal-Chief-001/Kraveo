-- Partner self sign-up with admin approval. Additive and safe on existing data:
-- every existing vendor and driver keeps working because the new column defaults to APPROVED.
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

ALTER TABLE "Vendor"
  ADD COLUMN "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "fssaiNumber" TEXT,
  ADD COLUMN "appliedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "DriverPartner"
  ADD COLUMN "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "appliedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  -- Riders are local people, not VIT students, and a cycle has no registration number.
  ALTER COLUMN "studentRegNo" DROP NOT NULL,
  ALTER COLUMN "avatarUrl" DROP NOT NULL,
  ALTER COLUMN "vehicleRegNo" DROP NOT NULL,
  ALTER COLUMN "emergencyPhone" DROP NOT NULL;

CREATE INDEX "Vendor_approvalStatus_idx" ON "Vendor"("approvalStatus");
CREATE INDEX "DriverPartner_approvalStatus_idx" ON "DriverPartner"("approvalStatus");

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");
