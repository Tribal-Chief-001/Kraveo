-- Restaurant location, auto-detect + manual (Docs/20_vendor_location_contract.md, 2026-10-05).
-- Additive only: three nullable columns, no default, no data rewrite (a nullable ADD COLUMN is metadata-only).
ALTER TABLE "Vendor" ADD COLUMN "locationSource" TEXT,
ADD COLUMN "locationSetAt" TIMESTAMP(3),
ADD COLUMN "locationAccuracyM" DOUBLE PRECISION;
