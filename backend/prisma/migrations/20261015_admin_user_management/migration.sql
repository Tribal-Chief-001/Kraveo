-- Admin user management (remove / suspend users, owner logins, audit actor), Docs/27 B0-B5 + Docs/28.
-- ADDITIVE and IDEMPOTENT (safe to run twice): one enum, new nullable / defaulted columns, new indexes. Nothing existing is read,
-- rewritten or deleted: every existing user becomes accountStatus ACTIVE, every existing audit row has no actor, no vendor is removed.
-- (PostgreSQL 11+ adds a constant-default NOT NULL column without rewriting the table.)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "statusReason" TEXT,
  ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "statusChangedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

-- AlterTable Vendor
ALTER TABLE "Vendor"
  ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "removedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerDisabledByRemoval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable AdminAuditLog
ALTER TABLE "AdminAuditLog"
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT,
  ADD COLUMN IF NOT EXISTS "ip" TEXT,
  ADD COLUMN IF NOT EXISTS "meta" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_accountStatus_idx" ON "User"("accountStatus");
CREATE INDEX IF NOT EXISTS "Vendor_removedAt_idx" ON "Vendor"("removedAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");

COMMIT;
