-- Campus drop points (Docs/19_campus_maps_contract.md, 2026-10-06). DATA ONLY: no table or column changes.
-- Rewrites the legacy spellings stored in "User"."hostelBlock" and "Order"."dropoffHostel" to the canonical names:
--   Block N | Boys Hostel Block N   (N 1..6)  ->  BHN
--   Girls Gate N | Girls Hostel Gate N  (N 1..2)  ->  GHN
-- Case-insensitive, extra spaces tolerated (same rules as normalizeDropPoint in src/config/campus.ts).
-- Everything else ("VIT Main Gate", unknown text, already-canonical names, NULL) is left exactly as it is.
-- "updatedAt" is NOT touched: the text is the same place, so no client should see these orders as changed.
BEGIN;

-- Short and safe on a live database: give up quickly instead of queueing behind a long lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE "User"
SET "hostelBlock" = CASE
  WHEN lower(btrim(regexp_replace("hostelBlock", '[[:space:]]+', ' ', 'g'))) ~ '^(boys hostel block|block) [1-6]$'
    THEN 'BH' || right(btrim("hostelBlock"), 1)
  ELSE 'GH' || right(btrim("hostelBlock"), 1)
END
WHERE "hostelBlock" IS NOT NULL
  AND (
    lower(btrim(regexp_replace("hostelBlock", '[[:space:]]+', ' ', 'g'))) ~ '^(boys hostel block|block) [1-6]$'
    OR lower(btrim(regexp_replace("hostelBlock", '[[:space:]]+', ' ', 'g'))) ~ '^(girls hostel gate|girls gate) [12]$'
  );

UPDATE "Order"
SET "dropoffHostel" = CASE
  WHEN lower(btrim(regexp_replace("dropoffHostel", '[[:space:]]+', ' ', 'g'))) ~ '^(boys hostel block|block) [1-6]$'
    THEN 'BH' || right(btrim("dropoffHostel"), 1)
  ELSE 'GH' || right(btrim("dropoffHostel"), 1)
END
WHERE (
    lower(btrim(regexp_replace("dropoffHostel", '[[:space:]]+', ' ', 'g'))) ~ '^(boys hostel block|block) [1-6]$'
    OR lower(btrim(regexp_replace("dropoffHostel", '[[:space:]]+', ' ', 'g'))) ~ '^(girls hostel gate|girls gate) [12]$'
  );

COMMIT;
