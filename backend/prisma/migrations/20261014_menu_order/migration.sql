-- Per-restaurant menu order, Docs/26_cut_commission_menu_order_contract.md section 3.
-- ADDITIVE and IDEMPOTENT (safe to run twice): one new column with a constant default and one index. No row is rewritten in a way that
-- changes behaviour: every existing dish gets sortOrder 0 (= unordered legacy), so the listing order stays createdAt ASC, id ASC.
-- (PostgreSQL 11+ adds a constant-default NOT NULL column without rewriting the table.)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MenuItem_vendorId_sortOrder_idx" ON "MenuItem"("vendorId", "sortOrder");

COMMIT;
