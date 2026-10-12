-- Managed categories (cuisines for restaurants, categories for dishes), Docs/23_taxonomy_restaurant_dish_edit_contract.md section 2.
-- ADDITIVE and IDEMPOTENT (safe to run twice): two new tables (Category, VendorCategory), one NULLABLE column MenuItem."categoryId",
-- indexes and foreign keys (all guarded with IF NOT EXISTS), then a backfill that turns today's free text into rows:
--   (a) every distinct MenuItem."category" (trimmed and collapsed the way the app does: tabs, newlines, no-break and other Unicode spaces
--       count as spaces, zero-width characters are dropped; unique ignoring case and punctuation = the slug) becomes a category
--       with forDishes, forRestaurants, showOnHome = true (this reproduces today's Home chips); sortOrder by dish count, most used first;
--   (b) the six names the old restaurant app hard-codes (Main Course, Breads, Beverages, Snacks, Desserts, Fast Food) are added when missing
--       (forDishes only, not on Home) so old restaurant apps keep working;
--   (c) every token of every Vendor."category" split on bullet, comma or pipe becomes (or links to) a category (forRestaurants = true,
--       restaurant-only and not on Home when new) and a VendorCategory row in the order it appears. Only restaurants that have NO link yet
--       are processed, so a second run never re-adds a link an admin removed;
--   (d) MenuItem."categoryId" is set by slug match, and MenuItem."category" is set to the canonical category name (so "snacks" and
--       "Snacks " become one tab). Rows whose category has no letters or digits stay NULL.
-- Vendor."category" is NOT rewritten (it already reads fine); it is re-derived on the next edit of the restaurant.
-- Nothing is deleted. "updatedAt" of dishes is not touched (raw SQL). Orders, payments, settlements and prices are not read or changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameHi" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'restaurant',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "forRestaurants" BOOLEAN NOT NULL DEFAULT true,
    "forDishes" BOOLEAN NOT NULL DEFAULT true,
    "showOnHome" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VendorCategory" (
    "vendorId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "VendorCategory_pkey" PRIMARY KEY ("vendorId","categoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Category_isActive_sortOrder_idx" ON "Category"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VendorCategory_categoryId_idx" ON "VendorCategory"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

-- AddForeignKey (guarded)
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItem_categoryId_fkey') THEN
    ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorCategory_vendorId_fkey') THEN
    ALTER TABLE "VendorCategory" ADD CONSTRAINT "VendorCategory_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorCategory_categoryId_fkey') THEN
    ALTER TABLE "VendorCategory" ADD CONSTRAINT "VendorCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$fk$;

-- BACKFILL-BEGIN (test/e2e/categories_backfill.test.ts runs exactly this block against a copy of the production-shaped data)
DO $backfill$
DECLARE
  base INTEGER;
BEGIN
  DROP TABLE IF EXISTS _bf_names;
  DROP TABLE IF EXISTS _bf_vtok;
  DROP TABLE IF EXISTS _bf_vnames;

  -- (a) dish categories. One row per slug: the most used spelling (ties: one with a capital letter, then alphabetical) is the name.
  CREATE TEMP TABLE _bf_names ON COMMIT DROP AS
  SELECT x.slug, x.name, x.total FROM (
    SELECT s.slug, s.name,
           SUM(s.n) OVER (PARTITION BY s.slug) AS total,
           ROW_NUMBER() OVER (PARTITION BY s.slug ORDER BY s.n DESC, (s.name <> LOWER(s.name)) DESC, s.name ASC) AS rk
    FROM (
      SELECT btrim(regexp_replace(lower(m."category"), '[^a-z0-9]+', '-', 'g'), '-') AS slug,
             btrim(regexp_replace(regexp_replace(m."category", '[\u200b-\u200d\u2060\ufeff]', '', 'g'), '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g')) AS name,
             COUNT(*) AS n
      FROM "MenuItem" m
      GROUP BY 1, 2
    ) s
    WHERE s.slug <> ''
  ) x
  WHERE x.rk = 1;

  SELECT COALESCE(MAX("sortOrder"), 0) INTO base FROM "Category";
  INSERT INTO "Category" ("id", "name", "slug", "icon", "sortOrder", "isActive", "forRestaurants", "forDishes", "showOnHome", "createdAt", "updatedAt")
  SELECT md5(random()::text || clock_timestamp()::text || n.slug)::uuid::text, n.name, n.slug,
         CASE
           WHEN ('-' || n.slug || '-') ~ 'biryani' THEN 'biryani'
           WHEN ('-' || n.slug || '-') ~ 'thali' THEN 'thali'
           WHEN ('-' || n.slug || '-') ~ '(dosa|idli|south)' THEN 'dosa'
           WHEN ('-' || n.slug || '-') ~ '(noodle|chinese|chowmein|momo)' THEN 'noodles'
           WHEN ('-' || n.slug || '-') ~ '-(roll|wrap)s?-' THEN 'roll'
           WHEN ('-' || n.slug || '-') ~ 'burger' THEN 'burger'
           WHEN ('-' || n.slug || '-') ~ '(pizza|pasta)' THEN 'pizza'
           WHEN ('-' || n.slug || '-') ~ '(tandoor|tikka|kebab|grill)' THEN 'tandoor'
           WHEN ('-' || n.slug || '-') ~ '(bread|paratha|naan|roti|kulcha)' THEN 'bread'
           WHEN ('-' || n.slug || '-') ~ '-eggs?-' THEN 'egg'
           WHEN ('-' || n.slug || '-') ~ 'chicken' THEN 'chicken'
           WHEN ('-' || n.slug || '-') ~ '(fish|seafood)' THEN 'fish'
           WHEN ('-' || n.slug || '-') ~ '-ice-?cream' THEN 'icecream'
           WHEN ('-' || n.slug || '-') ~ '(dessert|sweet|mithai|cake|pastry)' THEN 'dessert'
           WHEN ('-' || n.slug || '-') ~ '-(tea|chai)s?-' THEN 'tea'
           WHEN ('-' || n.slug || '-') ~ 'coffee' THEN 'coffee'
           WHEN ('-' || n.slug || '-') ~ 'juice' THEN 'juice'
           WHEN ('-' || n.slug || '-') ~ '(shake|smoothie|lassi)' THEN 'shake'
           WHEN ('-' || n.slug || '-') ~ '(beverage|drink|soda)' THEN 'juice'
           WHEN ('-' || n.slug || '-') ~ '(healthy|salad|diet)' THEN 'healthy'
           WHEN ('-' || n.slug || '-') ~ 'night' THEN 'latenight'
           WHEN ('-' || n.slug || '-') ~ '(rice|pulao)' THEN 'rice'
           WHEN ('-' || n.slug || '-') ~ '-veg-' THEN 'veg'
           WHEN ('-' || n.slug || '-') ~ '(snack|starter|chaat|street|fast|maggi|sandwich|fries)' THEN 'snack'
           ELSE 'restaurant'
         END,
         base + ROW_NUMBER() OVER (ORDER BY n.total DESC, n.slug ASC),
         true, true, true, true, now(), now()
  FROM _bf_names n
  WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."slug" = n.slug);

  -- (b) the six names the old restaurant app hard-codes (dish categories only, not on Home).
  SELECT COALESCE(MAX("sortOrder"), 0) INTO base FROM "Category";
  INSERT INTO "Category" ("id", "name", "slug", "icon", "sortOrder", "isActive", "forRestaurants", "forDishes", "showOnHome", "createdAt", "updatedAt")
  SELECT md5(random()::text || clock_timestamp()::text || d.slug)::uuid::text, d.name, d.slug, d.icon, base + ROW_NUMBER() OVER (ORDER BY d.ord), true, false, true, false, now(), now()
  FROM (VALUES
    ('Main Course', 'main-course', 'restaurant', 1),
    ('Breads',      'breads',      'bread',      2),
    ('Beverages',   'beverages',   'juice',      3),
    ('Snacks',      'snacks',      'snack',      4),
    ('Desserts',    'desserts',    'dessert',    5),
    ('Fast Food',   'fast-food',   'snack',      6)
  ) AS d(name, slug, icon, ord)
  WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."slug" = d.slug);

  -- (c) restaurant categories from the free text, only for restaurants that have no link yet. Tokens keep their order (position 0, 1, ...);
  -- a token repeated inside one restaurant counts once; tokens without letters or digits are dropped.
  CREATE TEMP TABLE _bf_vtok ON COMMIT DROP AS
  SELECT y."vendorId", y.name, y.slug, ROW_NUMBER() OVER (PARTITION BY y."vendorId" ORDER BY y.ord) - 1 AS pos
  FROM (
    SELECT z."vendorId", z.name, z.slug, z.ord,
           ROW_NUMBER() OVER (PARTITION BY z."vendorId", z.slug ORDER BY z.ord) AS dupe
    FROM (
      SELECT v."id" AS "vendorId", t.ord,
             btrim(regexp_replace(regexp_replace(t.raw, '[\u200b-\u200d\u2060\ufeff]', '', 'g'), '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g')) AS name,
             btrim(regexp_replace(lower(t.raw), '[^a-z0-9]+', '-', 'g'), '-') AS slug
      FROM "Vendor" v
      CROSS JOIN LATERAL regexp_split_to_table(v."category", '[•,|]') WITH ORDINALITY AS t(raw, ord)
      WHERE NOT EXISTS (SELECT 1 FROM "VendorCategory" vc WHERE vc."vendorId" = v."id")
    ) z
    WHERE z.slug <> ''
  ) y
  WHERE y.dupe = 1;

  CREATE TEMP TABLE _bf_vnames ON COMMIT DROP AS
  SELECT q.slug, q.name, q.vendors FROM (
    SELECT s.slug, s.name,
           SUM(s.n) OVER (PARTITION BY s.slug) AS vendors,
           ROW_NUMBER() OVER (PARTITION BY s.slug ORDER BY s.n DESC, (s.name <> LOWER(s.name)) DESC, s.name ASC) AS rk
    FROM (SELECT slug, name, COUNT(*) AS n FROM _bf_vtok GROUP BY 1, 2) s
  ) q
  WHERE q.rk = 1;

  SELECT COALESCE(MAX("sortOrder"), 0) INTO base FROM "Category";
  INSERT INTO "Category" ("id", "name", "slug", "icon", "sortOrder", "isActive", "forRestaurants", "forDishes", "showOnHome", "createdAt", "updatedAt")
  SELECT md5(random()::text || clock_timestamp()::text || n.slug)::uuid::text, n.name, n.slug,
         CASE
           WHEN ('-' || n.slug || '-') ~ 'biryani' THEN 'biryani'
           WHEN ('-' || n.slug || '-') ~ 'thali' THEN 'thali'
           WHEN ('-' || n.slug || '-') ~ '(dosa|idli|south)' THEN 'dosa'
           WHEN ('-' || n.slug || '-') ~ '(noodle|chinese|chowmein|momo)' THEN 'noodles'
           WHEN ('-' || n.slug || '-') ~ '-(roll|wrap)s?-' THEN 'roll'
           WHEN ('-' || n.slug || '-') ~ 'burger' THEN 'burger'
           WHEN ('-' || n.slug || '-') ~ '(pizza|pasta)' THEN 'pizza'
           WHEN ('-' || n.slug || '-') ~ '(tandoor|tikka|kebab|grill)' THEN 'tandoor'
           WHEN ('-' || n.slug || '-') ~ '(bread|paratha|naan|roti|kulcha)' THEN 'bread'
           WHEN ('-' || n.slug || '-') ~ '-eggs?-' THEN 'egg'
           WHEN ('-' || n.slug || '-') ~ 'chicken' THEN 'chicken'
           WHEN ('-' || n.slug || '-') ~ '(fish|seafood)' THEN 'fish'
           WHEN ('-' || n.slug || '-') ~ '-ice-?cream' THEN 'icecream'
           WHEN ('-' || n.slug || '-') ~ '(dessert|sweet|mithai|cake|pastry)' THEN 'dessert'
           WHEN ('-' || n.slug || '-') ~ '-(tea|chai)s?-' THEN 'tea'
           WHEN ('-' || n.slug || '-') ~ 'coffee' THEN 'coffee'
           WHEN ('-' || n.slug || '-') ~ 'juice' THEN 'juice'
           WHEN ('-' || n.slug || '-') ~ '(shake|smoothie|lassi)' THEN 'shake'
           WHEN ('-' || n.slug || '-') ~ '(beverage|drink|soda)' THEN 'juice'
           WHEN ('-' || n.slug || '-') ~ '(healthy|salad|diet)' THEN 'healthy'
           WHEN ('-' || n.slug || '-') ~ 'night' THEN 'latenight'
           WHEN ('-' || n.slug || '-') ~ '(rice|pulao)' THEN 'rice'
           WHEN ('-' || n.slug || '-') ~ '-veg-' THEN 'veg'
           WHEN ('-' || n.slug || '-') ~ '(snack|starter|chaat|street|fast|maggi|sandwich|fries)' THEN 'snack'
           ELSE 'restaurant'
         END,
         base + ROW_NUMBER() OVER (ORDER BY n.vendors DESC, n.slug ASC),
         true, true, false, false, now(), now()
  FROM _bf_vnames n
  WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."slug" = n.slug);

  -- A category that restaurants are tagged with can be tagged on restaurants (the six hard-coded names start as dish-only).
  UPDATE "Category" c SET "forRestaurants" = true, "updatedAt" = now()
  WHERE c."forRestaurants" = false AND c."slug" IN (SELECT slug FROM _bf_vtok);

  INSERT INTO "VendorCategory" ("vendorId", "categoryId", "position")
  SELECT t."vendorId", c."id", t.pos
  FROM _bf_vtok t
  JOIN "Category" c ON c."slug" = t.slug
  ON CONFLICT ("vendorId", "categoryId") DO NOTHING;

  -- (d) link the dishes and make the display name canonical.
  UPDATE "MenuItem" m SET "categoryId" = c."id", "category" = c."name"
  FROM "Category" c
  WHERE m."categoryId" IS NULL
    AND c."slug" <> ''
    AND c."slug" = btrim(regexp_replace(lower(m."category"), '[^a-z0-9]+', '-', 'g'), '-');
END
$backfill$;
-- BACKFILL-END

COMMIT;
