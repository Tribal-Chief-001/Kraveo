# Categories, multi-category restaurants, edit restaurant, edit dishes (bulk, import, photos) - contract (12 Oct 2026)

Binding for backend, dashboard, customer app, restaurant app. Builds on Docs/21 (pricing, catalog approval) and Docs/22 (groups). Nothing in this document may change the behaviour of orders, payments, refunds, settlement, pricing or order groups; no existing test may break (list any test you must change and why).

## 0. What the owner asked for (12 Oct 2026)
1. Edit a restaurant after it exists (name, categories, address, banner photo, FSSAI, ETA) from the admin portal.
2. A restaurant can have MULTIPLE categories (cuisines), chosen from a managed list.
3. New categories can be created later by the admin (and renamed, reordered, hidden, merged), and they flow to the apps without a new app build.
4. The dish side must be looked at and finished too: dish categories were free text (spelling drift, hard-coded list of 6 in the restaurant app); edit dishes properly in the admin portal (single, bulk, duplicate, import a whole menu, upload photos).
5. Production hardened, end to end, no regression, tested.

## 1. Concepts

**One managed list: `Category`.** Used for restaurants (many per restaurant) and dishes (exactly one per dish). Each category has three switches so one list serves both: `forRestaurants` (can be tagged on a restaurant), `forDishes` (can be a dish's category), `showOnHome` (appears as a chip on the customer Home). Plus `name` (2..30 chars, unique ignoring case and spacing), `nameHi` (optional Hindi label, <= 30, shown by the restaurant app next to the English one), `icon` (a key from the fixed icon set below), `sortOrder`, `isActive`.

Fixed icon keys (apps map key -> icon, unknown key -> generic restaurant icon): `restaurant, thali, rice, biryani, dosa, noodles, roll, burger, pizza, snack, bread, tandoor, egg, chicken, fish, veg, sweet, dessert, icecream, tea, coffee, juice, shake, healthy, latenight`.

**Restaurant categories (cuisines)**: 0..6 per restaurant, ordered (first = main). Stored in `VendorCategory`. The legacy `Vendor.category` string stays and is DERIVED: names joined with " • " (so every old app build keeps showing the right text); `Vendor.category` falls back to "Campus kitchen" when none.
**Dish category**: exactly one. `MenuItem.categoryId` (FK, nullable only for legacy rows until backfilled) plus the denormalised `MenuItem.category` display name (kept in sync; old app builds read it).
**Deactivating a category** hides it from pickers and from Home chips; existing restaurants/dishes keep it (still shown). **Deleting** is only allowed when nothing uses it (otherwise 409 `CATEGORY_IN_USE`: deactivate or merge). **Merging** A into B moves every dish and restaurant link to B and removes A.

## 2. Data model (additive migration `20261012_categories`, backfill included, safe on live data)
- `Category`: `id uuid`, `name`, `slug` (normalised: lower case, `[^a-z0-9]+` -> `-`, trimmed; UNIQUE), `nameHi?`, `icon` default `restaurant`, `sortOrder Int`, `isActive Boolean default true`, `forRestaurants Boolean default true`, `forDishes Boolean default true`, `showOnHome Boolean default false`, `createdAt`, `updatedAt`.
- `VendorCategory`: `vendorId`, `categoryId`, `position Int`; PRIMARY KEY (`vendorId`,`categoryId`); FK both ON DELETE CASCADE for vendor, RESTRICT for category (a category in use cannot be deleted by accident).
- `MenuItem.categoryId String?` FK to Category ON DELETE RESTRICT, index.
- Backfill (in the migration SQL, idempotent, no data loss, test it on a copy of realistic data): (a) every distinct MenuItem.category (trimmed, case-insensitively unique) becomes a Category with `forDishes=true, forRestaurants=true, showOnHome=true` (this reproduces today's Home chips), `sortOrder` by dish count descending; (b) the six names the old restaurant app hard-codes (`Main Course, Breads, Beverages, Snacks, Desserts, Fast Food`) are added if missing (`forDishes=true, forRestaurants=false, showOnHome=false`) so old restaurant apps keep working; (c) every token of every Vendor.category split on `•`, `,` or `|` (trimmed, empty dropped, case-insensitively merged with an existing category) becomes/links a Category (`forRestaurants=true`, `showOnHome=false` unless it already exists from (a)) and a `VendorCategory` row in the order it appears; (d) `MenuItem.categoryId` is set by case-insensitive trimmed name match; (e) `Vendor.category` is NOT rewritten by the migration (it already reads fine); it is re-derived on the next edit. Real data today (production, 12 Oct 2026): 11 dish categories (Snacks, South Indian, Beverages, Main Course, Chinese, Desserts, Starters, Biryani, Street Food, Breads & Tandoor, Thali) and 7 vendors with strings like `North Indian • Thalis • Parathas`; use these as the fixture of the backfill test and assert the result row by row.

## 3. Backend API (all admin writes: audit-logged (one row per change with a before/after summary), rate limited in middleware/rateLimit.ts, validated strictly, answers `{success:false, code, message, field?}` on errors, idempotent where stated)

### 3.1 Public and partner reads
- `GET /api/categories?for=restaurants|dishes|home` (no auth; cacheable `Cache-Control: public, max-age=60`): ACTIVE categories ordered by `sortOrder` then name -> `{ success, data:[{ id, name, nameHi, icon, forRestaurants, forDishes, showOnHome, sortOrder, restaurantCount, dishCount }] }`. `restaurantCount` = approved restaurants tagged with it; `dishCount` = customer-visible dishes (approved, not deleted) in it. `for=home` = `showOnHome` and (restaurantCount>0 or dishCount>0). Counts come from ONE grouped query (no N+1).
- Vendor/restaurant payloads (public and owner and admin views of `GET /api/vendors`, `/api/vendors/:id`): keep every existing field, ADD `cuisines: [{ id, name, icon }]` (ordered) and `tags: string[]` = the cuisine names (the customer app already reads `tags`, so even old builds get category search/filter for free). Restaurant owner views never gain commission or price data (Docs/21 rules unchanged).
- Dish payloads: keep `category` (display name), ADD `categoryId`.

### 3.2 Admin: categories
- `GET /api/admin/categories?includeInactive=1` (all, with counts), `POST /api/admin/categories` `{name, nameHi?, icon?, forRestaurants?, forDishes?, showOnHome?}` (new gets the next `sortOrder`; duplicate name (slug) -> 409 `CATEGORY_EXISTS` with the existing one), `PATCH /api/admin/categories/:id` (any of the fields incl. `isActive`, `sortOrder`; renaming rewrites the denormalised `MenuItem.category` and `Vendor.category` strings of everything that uses it, in ONE transaction; changing `forDishes`/`forRestaurants` to false while in use -> 409 `CATEGORY_IN_USE` unless unchanged), `POST /api/admin/categories/reorder` `{ids:[...]}` (renumbers in that order, unknown ids -> 400), `POST /api/admin/categories/:id/merge` `{intoId, dryRun?}` (dryRun default TRUE: returns `{dishes, restaurants}` that would move; `dryRun:false` does it in one transaction, rewrites denormalised strings, dedupes vendor links keeping the better position, deletes the source), `DELETE /api/admin/categories/:id` (only when unused).
- Name rules: trimmed, collapsed spaces, 2..30 chars, letters/digits/space/`&` `-` `'` `/` `+` only, no HTML/control characters; slug uniqueness case-insensitive.

### 3.3 Admin: edit restaurant
`PATCH /api/admin/vendors/:id/profile` body (all optional, unknown keys -> 400): `name` (2..60, not equal, ignoring case, to another APPROVED restaurant's name -> 409 `NAME_TAKEN`), `cuisineIds` (array of 0..6 distinct existing category ids, order = position; every NEW link must be `isActive && forRestaurants`; links the restaurant already had may stay), `address` (3..140), `bannerImage` (http(s) URL <= 500 chars, or `null` = reset to the default banner), `fssaiNumber` (exactly 14 digits or null), `eta` (matches `^\d{1,3}-\d{1,3} min$`, first <= second). Response: the admin vendor view. It re-derives `Vendor.category`, writes the audit row, and publishes the existing realtime/admin refresh events if the vendor list uses them. Row lock on the vendor; double submit safe (same body twice = no-op success `changed:false`). Location, commission, open/closed and payout details keep their own endpoints. Renaming a restaurant never touches old orders (they read the live name).
Create restaurant (`POST /api/admin/partners` kind VENDOR and `POST /api/vendors`) also accepts `cuisineIds` (instead of the free-text `category`; the free-text form keeps working for old callers: it is parsed like backfill step (c) and matched to existing categories, unknown tokens are created as restaurant-only categories (`showOnHome=false`)).

### 3.4 Dish category rules (all dish writers: restaurant app create/edit, admin create/edit, bulk, import)
- The category must be an ACTIVE `forDishes` category, matched by name ignoring case and spacing; the stored name is the canonical one. Unknown or inactive -> 400 `CATEGORY_UNKNOWN` with a plain message ("Pick a category from the list.") and, for admins, `suggestions` (closest names). An admin edit that does not change the category never fails because the current category is inactive.
- Restaurant-app create sends the old `category` string: still accepted. The server also accepts `categoryId`.
- Missing category on create keeps today's default `Main Course` (must exist/seeded: if missing create it).

### 3.5 Admin: edit dishes more completely
`PATCH /api/admin/catalog/:id` already edits name, description, category, imageUrl, isVeg, isAvailable, vendorPrice, commission (Docs/21): keep, add `categoryId` support and the rules above. New:
- `POST /api/admin/catalog/bulk` `{ ids:[<=100 distinct], action: 'AVAILABLE'|'UNAVAILABLE'|'DELETE'|'RESTORE'|'APPROVE'|'SET_CATEGORY', category?|categoryId? }` -> `{ success, data:{ results:[{id, ok, changed, code?, message?}], ok, failed } }` (each item processed in its own transaction with the same checks and audit as the single endpoint; a failure never aborts the others; `APPROVE` refuses what single approve refuses).
- `POST /api/admin/vendors/:id/menu-import` `{ rows:[{ name, category, vendorPrice, isVeg?, description?, imageUrl?, isAvailable? }], dryRun? , onDuplicate?: 'SKIP'|'UPDATE' }` (<= 200 rows; dryRun default TRUE): per-row validation exactly like admin create (name 2..60, price > 0 and <= 5000 two decimals, category known, image http(s) or empty -> default image, veg default true), duplicate = same name ignoring case in that restaurant (also within the file); `dryRun:true` returns `{ summary:{create, update, skip, invalid}, rows:[{index, action, errors:[{field,message}], computedPrice}] }` including the computed customer price (Docs/21 engine) and writes nothing; `dryRun:false` re-validates and applies ALL valid rows in ONE transaction (all-or-nothing: any invalid row -> 400 with the same row report, nothing written); created dishes are APPROVED/live with commission inherited; audit row summarising counts. Idempotent against double click (second identical call -> every row is a duplicate -> skipped).
- Duplicate dish = client-side prefill of Add dish (no endpoint).

### 3.6 Image upload (so photos no longer need an external link)
`POST /api/admin/uploads/image?purpose=banner|dish` (ADMIN only, raw body, `Content-Type` image/jpeg | image/png | image/webp, body <= 1 MB (nginx allows 2 MB), rate limit 60 per hour per admin): validate the MAGIC BYTES (not the header), read the real width/height from the file header (reject < 200 px on the short side or > 4000 px on the long side), refuse everything else (SVG, GIF, HTML...). Store under `UPLOAD_DIR` (env, default `/home/ubuntu/kraveo-uploads`, OUTSIDE the git checkout) as `<purpose>/<yyyy>/<random 128-bit hex>.<ext>` (never the client's file name), return `{ success, data:{ url, width, height, bytes } }` with an absolute URL on the API host (`PUBLIC_BASE_URL` env, default `https://api.kraveo.site`). Serve `GET /uploads/*` with `express.static`: no directory listing, no dotfiles, path traversal impossible, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin` (the dashboard on another origin must be able to show them; check `middleware/securityHeaders.ts`, it sets its own headers), content type from the extension. The existing `catalog.checkImageUrl` accepts these URLs like any https link (nothing special). The nightly backup script must also archive `UPLOAD_DIR` (deploy task, noted here so it is not forgotten). Orphan files are not cleaned automatically (note in the code and in the final report).

## 4. Admin portal (web/super_admin)
- **New sidebar section "Categories"**: table of all categories (name, Hindi name, icon, flags as switches, active switch, restaurant and dish counts, order), create/edit drawer (icon picker showing the icon set), drag or up/down buttons to reorder (saved with the reorder endpoint), merge action with a dry-run preview ("moves 5 dishes and 2 restaurants") and a confirm, delete only when unused (button disabled with the reason otherwise), search, plain explanations of the three switches, empty/error states.
- **Vendors**: each restaurant card gets "Edit restaurant" (drawer): name, categories as an ordered multi-select of chips (add from the list, remove, move first; up to 6; inline "Create new category" opens the same small form), address, banner (upload with preview, or paste a link, or reset to default), FSSAI, ETA; save shows what changed; errors per field. The Add partner drawer's category becomes the same multi-select (the free text path stays only as an "other" quick-create).
- **Catalog**: dish drawer category becomes a select of active dish categories (with inline create), photo upload (preview, replace, remove) next to the URL field, "Duplicate" on a dish (opens Add dish prefilled, name + " (copy)"), row checkboxes + a bulk bar (Available / Unavailable / Delete / Restore / Approve / Change category) with a result summary listing failures; **Import menu** wizard on a restaurant (download a CSV template; pick a CSV or paste rows; client-side parse (quotes, commas, UTF-8, Excel BOM, header aliases) with a preview table from the dry run showing create/update/skip/invalid per row and the computed customer price; "Import N dishes" button only when there are no invalid rows; success summary).
- Client-side image compression before upload (canvas, longest side <= 1200 px, WebP if supported else JPEG, quality ~0.82, result must be <= 1 MB else lower the quality/size) with a plain error when the file is not an image.
- Everything accessible, 360 px usable, destructive actions confirmed, no invented numbers, errors shown in plain words, defensive parsing of every response, tests with REAL backend shapes.

## 5. Customer app
- `Dhaba` parses `cuisines` (list of {id,name,icon}) defensively; the restaurant card and menu header show the cuisines joined with " • " (fallback: the legacy `category` string).
- Home chips come from `GET /api/categories?for=home` (ordered by the admin, with icons; max 10 chips; "All" first); on any failure or an empty list fall back to the current behaviour (derived from dish categories). A restaurant matches a chip if it is tagged with that category OR has an available dish in it (current rule plus tags). Search also matches cuisine names.
- Inside a restaurant the dish category tabs are ordered by the category's `sortOrder` (unknown/legacy categories last, alphabetical).
- Icon keys -> existing icon set; unknown key -> keyword fallback as today -> generic icon.
- Old servers/404: everything falls back, never crashes. Version 1.9.0+15.

## 6. Restaurant app
- Add-dish category picker is loaded from `GET /api/categories?for=dishes` (shows `nameHi` as the Hindi sublabel when present, otherwise the existing hard-coded Hindi map), with the current six as the offline/404 fallback; a 400 `CATEGORY_UNKNOWN` shows the server message and reloads the list. No other change. Restaurant owners still cannot edit restaurant profile data (admin only).

## 7. Rules for every part
- No regression: backend 889, dashboard 498, customer 400, restaurant 490, rider 394 tests keep passing (list every changed test with the reason). Old app builds must keep working against the new server (all old fields stay; old create/edit calls with the free-text `category` keep working).
- Migrations additive; backfill tested on realistic data (the production fixture in section 2) and idempotent (running twice changes nothing).
- Every admin write audited, validated, rate limited; every list bounded; no N+1; no secrets or personal data in logs; uploads cannot be abused (type, size, dimensions, path, rate).
- Races: parallel category create/rename/merge/delete vs dish creation, double clicks, double imports must end consistent (unique constraints + transactions + row locks in a fixed order: category rows by ascending id, then vendors, then dishes).
- Tests with real Postgres: backfill, categories CRUD + rename cascade + merge + delete rules + reorder + visibility of the public list (counts, inactive hidden), restaurant edit (every field, validation, duplicate name, 6-category cap, banner reset, idempotency, audit, role checks, owner/customer cannot edit), dish category rules for restaurant-app and admin writers (old-style string, id, unknown, inactive), bulk (mixed success/failure), import (dry run vs apply, duplicates in file and in DB, all-or-nothing, price computation equals the pricing engine, 200 row cap, double click), upload (magic bytes vs header, SVG/GIF/HTML refused, size, dimensions, traversal attempts on GET, headers incl. CORP), payload compatibility (old fields intact, `tags`/`cuisines` present), concurrency stress.
- Deploy order: backup (pg_dump + nothing else changes on disk), migration, backend (create `UPLOAD_DIR`, extend the backup script), dashboard, then the apps. Customer app must work against the NEW server before its build is distributed (it falls back on old servers anyway).

## 8. Implementation notes (backend, 12 Oct 2026) - exact shapes for the dashboard and the apps

Everything below was produced by the real server against a real PostgreSQL in the test suites (`backend/test/e2e/*`); the JSON is copied from real responses (ids and times differ per run). Nothing here changes an order, payment, refund, settlement, pricing or group rule.

### 8.1 What was built, where, and how it is verified

- Migration `backend/prisma/migrations/20261012_categories/migration.sql`: additive (2 tables, 1 nullable column, indexes, FKs), every statement idempotent (`IF NOT EXISTS`, guarded FKs), backfill in one `DO` block marked `BACKFILL-BEGIN/END`. Verified two ways: (1) the whole file was run twice with `psql` on a scratch database that had the previous (Phase-3) schema plus the production-shaped fixture of section 2 (7 restaurants, 45 dishes in the 11 categories incl. case/space variants): 24 categories, 19 restaurant links, all 45 dishes linked; a checksum of all four tables was identical before and after the second run, and `prisma migrate diff` from that database to `schema.prisma` is empty; (2) `test/e2e/categories_backfill.test.ts` runs the same block on copies of the tables and asserts every category / link / dish row by row, plus edge cases and idempotency. Result of the fixture (sortOrder: name): 1 Main Course, 2 Snacks, 3 Beverages, 4 South Indian, 5 Starters, 6 Thali, 7 Chinese, 8 Desserts, 9 Street Food, 10 Biryani, 11 Breads & Tandoor (all dish + restaurant + Home), 12 Breads (dish only), 13 Fast Food (dish + restaurant, flipped to restaurant because "Fast Food . Maggi . Beverages" uses it), 14 North Indian, 15 Chai, 16 Dosa, 17 Filter Coffee, 18 Maggi, 19 Noodles, 20 Parathas, 21 Rolls, 22 Shakes, 23 Tandoor, 24 Thalis (restaurant only, not on Home).
- New code: `src/services/categories.ts` (rules, locks, rename / merge / delete / reorder, dish category resolution, legacy text), `src/services/vendorProfile.ts`, `src/services/catalogBulk.ts` (bulk + import), `src/routes/categories.ts`, `src/routes/uploads.ts` (+ `mountUploads(app)`), `src/utils/imageProbe.ts`, `src/middleware/bodyLimits.ts`; changed: `routes/api.ts`, `routes/catalog.ts`, `routes/partners.ts`, `services/catalog.ts`, `utils/catalog.ts`, `middleware/rateLimit.ts`, `index.ts`, `utils/seedDb.ts`.
- Lock order everywhere: category rows by ascending id (FOR SHARE for a writer that only uses a category, FOR UPDATE for rename / merge / delete / reorder) -> restaurant rows -> dish rows. Renames, merges, imports, dish creation and restaurant edits therefore serialise per category and a dish or restaurant can never keep a stale name or point at a missing category (tested with parallel storms).
- Environment: `UPLOAD_DIR` (default `/home/ubuntu/kraveo-uploads`, created on first upload; it must be on the nightly backup), `PUBLIC_BASE_URL` (default `https://api.kraveo.site`). After deploying run `npx prisma generate` (new models) and apply the migration before starting the new backend.

### 8.2 Decisions where this document was ambiguous

1. Names: ASCII letters, digits, spaces and `& - ' / +` only (2..30, at least one letter or digit), because the slug is `[^a-z0-9]+ -> -`; Hindi goes into `nameHi` (<= 30, no `<` `>` or control characters).
2. `icon` when a category is created without one is GUESSED from the name with the same keyword table the migration used (`Biryani` -> `biryani`, `Chai` -> `tea`, unknown -> `restaurant`), not always `restaurant`: the customer app falls back to keywords only for unknown keys, and `restaurant` is a known key.
3. Backfill extras: the dish text `MenuItem.category` is rewritten to the canonical name (so `snacks` and `Snacks ` become one tab); links are only created for restaurants that have none yet (a second run never re-adds a removed link); a category that restaurants use becomes `forRestaurants` (the dish-only legacy six stay dish-only unless a restaurant uses them); a dish category without letters or digits keeps `categoryId` NULL; a restaurant with more than 6 words keeps all of them (the cap of 6 applies to API edits).
4. Dish category on create/edit: nothing given = `Main Course` (created dish-only when missing); matching is by slug (case, spaces and punctuation ignored); `category` + `categoryId` together must be the same category; an edit that keeps the dish's current category (by id or by name) never fails, even if that category is hidden now.
5. Import: per-row rules are the stricter numbers written in 3.5 (name 2..60, price <= 5000) not the 80 / 10000 of the single admin create; an unknown column is a row error; a repeated name inside the file makes the LATER row invalid; a name that two live dishes of that restaurant already share is invalid; soft-deleted dishes do not count as duplicates; `UPDATE` only touches the cells that are present, keeps the approval status (a PENDING dish stays PENDING), clears an open price request when the price changes, and a row that changes nothing is `skip` with reason `UNCHANGED`; `index` is the 0-based position in `rows`.
6. Bulk: dishes are processed one after the other in the order given; `AVAILABLE` / `UNAVAILABLE` on a deleted dish fails with `ITEM_DELETED`; `SET_CATEGORY` with an unusable category is ONE 400 for the whole request (every item would fail the same way); `category` / `categoryId` with any other action is a 400.
7. Merge: the target must be active (`CATEGORY_INACTIVE`) and able to hold what moves (`CATEGORY_INCOMPATIBLE`); the second click on the same merge is a 404 (the source is gone). Reorder: listed ids get 1..n, categories not listed follow in their old order; the answer is the full admin list.
8. Upload: the `Content-Type` must be one of the three AND agree with the real bytes (`IMAGE_TYPE_MISMATCH`); a PNG must end exactly at IEND and a WebP exactly at its RIFF size (nothing hidden after the image); the file is written under a dot-name and renamed; `GET /uploads/*` answers 404 (JSON) for every path that is not exactly `<banner|dish>/<4 digits>/<32 lower-case hex>.<jpg|png|webp>`, so traversal, encodings, dotfiles, listings and other methods never reach the file system. The route is mounted after CORS (allowed origins get their CORS headers like every other route).
9. Legacy free text on restaurant creation (`POST /admin/partners`, `POST /vendors`): characters outside the name charset are dropped, at most 6 words, words matching a hidden or dish-only category are skipped, unknown words are created restaurant-only (not on Home, icon guessed); nothing given keeps the old default text (`Campus kitchen`, or `North Indian . Campus Dhaba` for `POST /vendors`) and creates NO category and no links; text that matches nothing usable is kept as typed.
10. `cuisines` / `tags` are also on the partner session payloads (`/auth/partner-login`, `/partner/me`, `/partner/application`, sign-up), `/admin/applications` and `/admin/partners`. `tags` are the cuisine names only (no fallback to the legacy text). Self sign-up restaurants (restaurant app) have no cuisine rows until an admin edits them (`cuisines: []`, `tags: []`, `category` is their own text); the dashboard should offer "Edit restaurant" on approval.
11. Restaurant name uniqueness (`NAME_TAKEN`) is among APPROVED restaurants only, ignoring case and spacing, protected by an advisory lock so two parallel renames cannot both win. A save that sends back the stored `eta` (old spelling like `25-35 mins`) or the stored banner is not re-validated; `fssaiNumber: ""` is treated as `null`.
12. No realtime event is published for a restaurant edit: the vendor list does not use one today (the dashboard should reload the vendor after a save; the response is the fresh admin view).
13. Limits: at most 300 categories (`TOO_MANY_CATEGORIES`, 409), at most 6 per restaurant, bulk <= 100 ids, import <= 200 rows. `POST /admin/vendors/:id/menu-import` has its own JSON limit of 400 KB (a worst-case 200-row file is about 190 KB); every other JSON route keeps 100 KB (413 `PAYLOAD_TOO_LARGE`).

### 8.3 Error answers and codes

Every error is `{ success:false, code, message, field? , ...extra }`; the HTTP status decides the class. New codes:

| Code | HTTP | Where | Extra fields |
|---|---|---|---|
| `CATEGORY_UNKNOWN` | 400 | any dish write (restaurant app create, admin create/edit, bulk SET_CATEGORY), cuisineIds with a deleted id, reorder with an unknown id | `field` = `category` / `categoryId` / `cuisineIds` / `ids`; admin writers also get `suggestions: string[]` (closest active dish categories, may be empty); the message for dishes is always "Pick a category from the list." |
| `CATEGORY_NOT_AVAILABLE` | 400 | `cuisineIds` contains a hidden or dish-only category that the restaurant does not already have | `field: cuisineIds` |
| `TOO_MANY_CATEGORIES` | 400 / 409 | 400: more than 6 `cuisineIds`; 409: creating the 301st category | |
| `CATEGORY_EXISTS` | 409 | create or rename onto an existing name (same slug) | `existing` = the admin view of that category |
| `CATEGORY_IN_USE` | 409 | delete of a used category; switching off `forDishes` / `forRestaurants` while used | `dishes` and/or `restaurants` counts; `field` for the flag case |
| `CATEGORY_INACTIVE`, `CATEGORY_INCOMPATIBLE` | 409 | merge target hidden / cannot hold dishes or restaurants | `field: intoId` |
| `NAME_TAKEN` | 409 | restaurant rename onto another approved restaurant's name | `field: name` |
| `TOO_MANY_ITEMS` | 400 | bulk with more than 100 ids | `field: ids` |
| `TOO_MANY_ROWS` | 400 | import with more than 200 rows | `field: rows` |
| `IMPORT_INVALID` | 400 | apply (`dryRun:false`) with at least one invalid row; nothing was written | `data` = the same report as the dry run |
| `CATEGORIES_CHANGED` | 409 | the import could not settle because its categories kept changing; just retry | |
| `ITEM_DELETED`, `NOT_FOUND` | per item in `results[]` | bulk | |
| `UNSUPPORTED_IMAGE_TYPE` | 415 | upload with a Content-Type other than image/jpeg, image/png, image/webp | |
| `NOT_AN_IMAGE` | 415 | the bytes are not a JPEG / PNG / WebP (SVG, GIF, HTML ...) | |
| `IMAGE_TYPE_MISMATCH` | 415 | header says one type, the bytes are another | |
| `IMAGE_CORRUPT` | 400 | truncated or damaged file | |
| `EMPTY_FILE` | 400 | no body | |
| `IMAGE_TOO_SMALL` | 400 | shorter side < 200 px | |
| `IMAGE_DIMENSIONS_TOO_LARGE` | 400 | longer side > 4000 px | |
| `PAYLOAD_TOO_LARGE` | 413 | upload over 1 MB, import over 400 KB, other JSON over 100 KB | |
| `UPLOAD_UNAVAILABLE` | 503 | the storage directory cannot be written | |
| `RATE_LIMITED` | 429 | any limit below; `Retry-After` header and `retryAfterSeconds` | |

Existing codes that these endpoints also use: `BAD_REQUEST` (400, with `field`), `NOT_FOUND` (404), `ITEM_DELETED` (409), 401 / 403 for no token / not an admin.

Rate limits (per admin, per window): category writes 120 / 10 min; restaurant profile edits 120 / 10 min; bulk 30 / 10 min; menu import (dry runs count) 30 / 10 min; image upload 60 / hour; catalog writes keep their 300 / 10 min.

### 8.4 Real responses

#### GET /api/categories  (no login; `?for=restaurants|dishes|home`; header `Cache-Control: public, max-age=60`)
```json
{
  "success": true,
  "count": "<number of rows>",
  "data": [
    {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani",
      "nameHi": "बिरयानी",
      "icon": "biryani",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 25,
      "restaurantCount": 1,
      "dishCount": 1
    },
    {
      "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
      "name": "North Indian",
      "nameHi": null,
      "icon": "restaurant",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 26,
      "restaurantCount": 1,
      "dishCount": 0
    }
  ]
}
```

`restaurantCount` = APPROVED restaurants tagged with it, `dishCount` = approved, not deleted dishes. Hidden categories are not in this list. `?for=home` = `showOnHome` and (restaurantCount > 0 or dishCount > 0). A bad `for` is `400 BAD_REQUEST`.

#### GET /api/admin/categories?includeInactive=1
```json
{
  "success": true,
  "count": "<number of rows>",
  "data": [
    {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani",
      "nameHi": "बिरयानी",
      "icon": "biryani",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 25,
      "restaurantCount": 1,
      "dishCount": 1,
      "slug": "biryani",
      "isActive": true,
      "usage": {
        "restaurants": 1,
        "dishes": 1
      },
      "inUse": true,
      "createdAt": "2026-10-12T07:51:29.270Z",
      "updatedAt": "2026-10-12T07:51:29.270Z"
    },
    {
      "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
      "name": "North Indian",
      "nameHi": null,
      "icon": "restaurant",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 26,
      "restaurantCount": 1,
      "dishCount": 0,
      "slug": "north-indian",
      "isActive": true,
      "usage": {
        "restaurants": 1,
        "dishes": 0
      },
      "inUse": true,
      "createdAt": "2026-10-12T07:51:29.316Z",
      "updatedAt": "2026-10-12T07:51:29.316Z"
    }
  ]
}
```

`usage` counts every restaurant / dish in any state (pending, rejected, deleted) and `inUse` is true when either is > 0: a delete is refused exactly when `inUse`. Without `includeInactive` hidden categories are left out. The same object is returned by create, patch and merge.

#### POST /api/admin/categories  `{ name, nameHi?, icon?, forRestaurants?, forDishes?, showOnHome? }` -> 201
```json
{
  "success": true,
  "message": "Category created.",
  "data": {
    "id": "72077a2d-9b97-48de-9956-8d0167228f34",
    "name": "Biryani",
    "nameHi": "बिरयानी",
    "icon": "biryani",
    "forRestaurants": true,
    "forDishes": true,
    "showOnHome": true,
    "sortOrder": 25,
    "restaurantCount": 0,
    "dishCount": 0,
    "slug": "biryani",
    "isActive": true,
    "usage": {
      "restaurants": 0,
      "dishes": 0
    },
    "inUse": false,
    "createdAt": "2026-10-12T07:51:29.270Z",
    "updatedAt": "2026-10-12T07:51:29.270Z"
  }
}
```

Duplicate -> 409:
```json
{
  "success": false,
  "code": "CATEGORY_EXISTS",
  "message": "There is already a category called \"North Indian\".",
  "field": "name",
  "existing": {
    "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
    "name": "North Indian",
    "nameHi": null,
    "icon": "restaurant",
    "forRestaurants": true,
    "forDishes": true,
    "showOnHome": true,
    "sortOrder": 26,
    "restaurantCount": 0,
    "dishCount": 0,
    "slug": "north-indian",
    "isActive": true,
    "usage": {
      "restaurants": 0,
      "dishes": 0
    },
    "inUse": false,
    "createdAt": "2026-10-12T07:51:29.316Z",
    "updatedAt": "2026-10-12T07:51:29.316Z"
  }
}
```

Invalid name -> 400:
```json
{
  "success": false,
  "code": "BAD_REQUEST",
  "message": "Use only letters, digits, spaces and & - ' / + in the name. Put the Hindi label in the Hindi name field.",
  "field": "name"
}
```

#### PATCH /api/admin/categories/:id  (any of name, nameHi, icon, forRestaurants, forDishes, showOnHome, isActive, sortOrder; unknown keys 400)
Rename (rewrites the dish and restaurant strings in the same transaction):
```json
{
  "success": true,
  "changed": true,
  "message": "Category saved.",
  "data": {
    "id": "3f19f8c2-09bc-414c-962d-183fc2237e9a",
    "name": "Rolls & Wraps",
    "nameHi": null,
    "icon": "roll",
    "forRestaurants": true,
    "forDishes": true,
    "showOnHome": false,
    "sortOrder": 27,
    "restaurantCount": 0,
    "dishCount": 0,
    "slug": "rolls-wraps",
    "isActive": true,
    "usage": {
      "restaurants": 0,
      "dishes": 0
    },
    "inUse": false,
    "createdAt": "2026-10-12T07:51:29.434Z",
    "updatedAt": "2026-10-12T07:51:29.746Z"
  }
}
```

Identical values: `200` with `"changed": false, "message": "Nothing to change."` and the same `data`, no audit row. Switching a flag off while in use:
```json
{
  "success": false,
  "code": "CATEGORY_IN_USE",
  "message": "1 dish uses this category, so it cannot stop being a dish category. Merge it into another one first.",
  "field": "forDishes",
  "dishes": 1
}
```

#### POST /api/admin/categories/reorder  `{ ids:[...] }`
```json
{
  "success": true,
  "changed": true,
  "message": "Order saved.",
  "data": "<the FULL admin list (same rows as GET /api/admin/categories?includeInactive=1) in the new order>",
  "first rows": [
    {
      "id": "c5db97e1-9ed4-4701-bfc8-24322a97f025",
      "name": "Chai",
      "nameHi": null,
      "icon": "tea",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 1,
      "restaurantCount": 0,
      "dishCount": 0,
      "slug": "chai",
      "isActive": true,
      "usage": {
        "restaurants": 0,
        "dishes": 0
      },
      "inUse": false,
      "createdAt": "2026-10-12T07:51:29.461Z",
      "updatedAt": "2026-10-12T07:51:29.802Z"
    },
    {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani",
      "nameHi": "बिरयानी",
      "icon": "biryani",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 2,
      "restaurantCount": 1,
      "dishCount": 1,
      "slug": "biryani",
      "isActive": true,
      "usage": {
        "restaurants": 1,
        "dishes": 1
      },
      "inUse": true,
      "createdAt": "2026-10-12T07:51:29.270Z",
      "updatedAt": "2026-10-12T07:51:29.804Z"
    }
  ]
}
```

#### POST /api/admin/categories/:id/merge  `{ intoId, dryRun? }`  (dryRun defaults to true)
Dry run:
```json
{
  "success": true,
  "message": "Merging would move 0 dishes and 1 restaurant. Nothing was changed.",
  "data": {
    "dryRun": true,
    "from": {
      "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
      "name": "North Indian"
    },
    "into": {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani"
    },
    "dishes": 0,
    "restaurants": 1
  }
}
```

Apply (`dryRun:false`): same keys with `"dryRun": false` plus `category` (the admin view of the target after the move):
```json
{
  "success": true,
  "message": "Merged. Moved 0 dishes and 0 restaurants.",
  "data": {
    "dryRun": false,
    "from": {
      "id": "cdeb9715-a9b1-454e-b6a7-89fe0497f9a9",
      "name": "Street Snacks"
    },
    "into": {
      "id": "c5db97e1-9ed4-4701-bfc8-24322a97f025",
      "name": "Chai"
    },
    "dishes": 0,
    "restaurants": 0,
    "category": {
      "id": "c5db97e1-9ed4-4701-bfc8-24322a97f025",
      "name": "Chai",
      "nameHi": null,
      "icon": "tea",
      "forRestaurants": true,
      "forDishes": true,
      "showOnHome": true,
      "sortOrder": 1,
      "restaurantCount": 0,
      "dishCount": 0,
      "slug": "chai",
      "isActive": true,
      "usage": {
        "restaurants": 0,
        "dishes": 0
      },
      "inUse": false,
      "createdAt": "2026-10-12T07:51:29.461Z",
      "updatedAt": "2026-10-12T07:51:29.802Z"
    }
  }
}
```

#### DELETE /api/admin/categories/:id
```json
{
  "success": true,
  "message": "Category deleted.",
  "data": {
    "id": "3f19f8c2-09bc-414c-962d-183fc2237e9a",
    "name": "Rolls & Wraps"
  }
}
```
In use -> 409:
```json
{
  "success": false,
  "code": "CATEGORY_IN_USE",
  "message": "This category is used by 1 restaurant and 1 dish. Hide it, or merge it into another category.",
  "restaurants": 1,
  "dishes": 1
}
```

#### Vendor payloads (GET /api/vendors, /api/vendors/:id; partner session `vendor`)
Customer / anonymous view of one restaurant: all old keys stay, `cuisines` and `tags` are new; the dish gets `categoryId`:
```json
{
  "keys": [
    "id",
    "name",
    "category",
    "rating",
    "totalRatingsCount",
    "eta",
    "bannerImage",
    "address",
    "isAcceptingOrders",
    "lat",
    "lng",
    "cuisines",
    "tags",
    "menuItems",
    "menu"
  ],
  "category": "North Indian • Biryani",
  "cuisines": [
    {
      "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
      "name": "North Indian",
      "icon": "restaurant"
    },
    {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani",
      "icon": "biryani"
    }
  ],
  "tags": [
    "North Indian",
    "Biryani"
  ],
  "menuItem0": {
    "id": "0e4af759-820a-4859-9135-ccb08af7b0b0",
    "vendorId": "sh-ven-1",
    "name": "Chicken Biryani",
    "price": 180,
    "category": "Biryani",
    "categoryId": "72077a2d-9b97-48de-9956-8d0167228f34",
    "description": "",
    "imageUrl": "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400",
    "isAvailable": true,
    "isVeg": true,
    "rating": 4.5,
    "ratingCount": 0
  }
}
```

The owner of that restaurant sees the same plus its own private fields (as before) and ITS price on dishes; `cuisines` / `tags` are there too and there is still no commission or customer price:
```json
{
  "keys": [
    "id",
    "userId",
    "name",
    "category",
    "rating",
    "totalRatingsCount",
    "eta",
    "bannerImage",
    "address",
    "isAcceptingOrders",
    "lat",
    "lng",
    "locationSource",
    "locationSetAt",
    "locationAccuracyM",
    "approvalStatus",
    "rejectionReason",
    "fssaiNumber",
    "appliedAt",
    "reviewedAt",
    "createdAt",
    "updatedAt",
    "menuItems",
    "cuisines",
    "tags",
    "hasLocation",
    "menu"
  ],
  "cuisines": [
    {
      "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
      "name": "North Indian",
      "icon": "restaurant"
    },
    {
      "id": "72077a2d-9b97-48de-9956-8d0167228f34",
      "name": "Biryani",
      "icon": "biryani"
    }
  ],
  "tags": [
    "North Indian",
    "Biryani"
  ],
  "menuItem0": {
    "id": "0e4af759-820a-4859-9135-ccb08af7b0b0",
    "vendorId": "sh-ven-1",
    "name": "Chicken Biryani",
    "category": "Biryani",
    "categoryId": "72077a2d-9b97-48de-9956-8d0167228f34",
    "description": "",
    "imageUrl": "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400",
    "isVeg": true,
    "isAvailable": true,
    "price": 180,
    "status": "LIVE",
    "rating": 4.5,
    "ratingCount": 0,
    "createdAt": "2026-10-12T07:51:29.649Z"
  }
}
```

The admin view is the owner's list of keys plus `commissionType` and `commissionValue`; its dishes are the raw rows (with `vendorPrice`, `categoryId`). A restaurant without categories has `"cuisines": [], "tags": []`.

#### PATCH /api/admin/vendors/:id/profile  (all keys optional, unknown keys 400)
Body sent: `{ name, cuisineIds:[northId, biryaniId], address, bannerImage:null, fssaiNumber, eta }` -> 200, `data` is the admin vendor view (with `menuItems`, `cuisines`, `tags`, `hasLocation`):
```json
{
  "success": true,
  "changed": true,
  "message": "Restaurant saved.",
  "data": {
    "id": "sh-ven-1",
    "userId": "usr-sh-o",
    "name": "Shape Kitchen & Co",
    "category": "North Indian • Biryani",
    "rating": 4.5,
    "totalRatingsCount": 50,
    "eta": "15-20 min",
    "bannerImage": "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600",
    "address": "Ashta road, near gate 4",
    "isAcceptingOrders": true,
    "lat": 23.0768,
    "lng": 76.8524,
    "locationSource": null,
    "locationSetAt": null,
    "locationAccuracyM": null,
    "approvalStatus": "APPROVED",
    "rejectionReason": null,
    "fssaiNumber": "12345678901234",
    "appliedAt": null,
    "reviewedAt": null,
    "commissionType": null,
    "commissionValue": null,
    "createdAt": "2026-10-12T07:51:29.186Z",
    "updatedAt": "2026-10-12T07:51:29.551Z",
    "menuItems": [],
    "cuisines": [
      {
        "id": "02236158-229f-48fc-9fe8-4b1220e74ed7",
        "name": "North Indian",
        "icon": "restaurant"
      },
      {
        "id": "72077a2d-9b97-48de-9956-8d0167228f34",
        "name": "Biryani",
        "icon": "biryani"
      }
    ],
    "tags": [
      "North Indian",
      "Biryani"
    ],
    "hasLocation": false
  }
}
```

Same body again: `200`, `"changed": false`, `"message": "Nothing to change."`, same `data`. Errors:
```json
{
  "success": false,
  "code": "NAME_TAKEN",
  "message": "Another restaurant already uses this name.",
  "field": "name"
}
```
```json
{
  "success": false,
  "code": "TOO_MANY_CATEGORIES",
  "message": "A restaurant can have at most 6 categories.",
  "field": "cuisineIds"
}
```

Field rules: `name` 2..60 (no `<` `>`), `cuisineIds` 0..6 distinct existing ids in order (first = main; `[]` = none, `category` becomes `Campus kitchen`), `address` 3..140, `bannerImage` http(s) <= 500 or `null` (= default banner `https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600`), `fssaiNumber` 14 digits or `null`, `eta` like `15-20 min` (first <= second).

#### Creating a restaurant
`POST /api/admin/partners` (role VENDOR, new restaurant) and `POST /api/vendors` accept `cuisineIds: string[]` (0..6 ids); without it the old `category` text is matched / created as described in 8.2 (9). Responses keep their old shape; `POST /api/vendors` returns `data` with `cuisines` and `tags` added. Wrong `cuisineIds` are a 400 before any account is created.

#### Dish writers
Restaurant app `POST /api/vendors/:id/items` still takes the free-text `category` (and now optionally `categoryId`); answers keep their shape and add `categoryId`. A category that is not usable:
```json
{
  "success": false,
  "code": "CATEGORY_UNKNOWN",
  "message": "Pick a category from the list.",
  "field": "category"
}
```
The admin endpoints (`POST /api/admin/catalog`, `PATCH /api/admin/catalog/:id`, bulk) answer the same plus `suggestions`:
```json
{
  "success": false,
  "code": "CATEGORY_UNKNOWN",
  "message": "Pick a category from the list.",
  "field": "category",
  "suggestions": [
    "Biryani"
  ]
}
```

#### POST /api/admin/catalog/bulk  `{ ids:[<=100], action, category?|categoryId? }`  (here: UNAVAILABLE on 2 live dishes, 1 deleted dish, 1 unknown id)
```json
{
  "success": true,
  "message": "2 done, 2 could not be changed.",
  "data": {
    "results": [
      {
        "id": "0e4af759-820a-4859-9135-ccb08af7b0b0",
        "ok": true,
        "changed": true
      },
      {
        "id": "efbf262d-5b74-403a-8547-f334323bb1f0",
        "ok": true,
        "changed": true
      },
      {
        "id": "1686259a-acb1-400c-b4d5-9ebcff5725a1",
        "ok": false,
        "changed": false,
        "code": "ITEM_DELETED",
        "message": "This dish is deleted. Restore it first."
      },
      {
        "id": "missing-id",
        "ok": false,
        "changed": false,
        "code": "NOT_FOUND",
        "message": "Menu item not found."
      }
    ],
    "ok": 2,
    "failed": 2
  }
}
```
Request errors (empty list, bad action, ...) are an ordinary 400:
```json
{
  "success": false,
  "code": "BAD_REQUEST",
  "message": "Choose at least one dish.",
  "field": "ids"
}
```

#### POST /api/admin/vendors/:id/menu-import  `{ rows:[{ name, category, vendorPrice, isVeg?, description?, imageUrl?, isAvailable? }], dryRun?, onDuplicate? }`
Dry run (the default; writes nothing). Row 1 is a duplicate of an existing dish, row 3 has two errors, row 4 repeats a name of the file:
```json
{
  "success": true,
  "message": "Preview only: 2 to add, 0 to update, 1 to skip, 2 not valid.",
  "data": {
    "dryRun": true,
    "applied": false,
    "summary": {
      "create": 2,
      "update": 0,
      "skip": 1,
      "invalid": 2,
      "total": 5
    },
    "rows": [
      {
        "index": 0,
        "name": "Paneer Tikka",
        "action": "create",
        "errors": [],
        "computedPrice": 150
      },
      {
        "index": 1,
        "name": "chicken biryani",
        "action": "skip",
        "errors": [],
        "computedPrice": 190,
        "reason": "DUPLICATE_EXISTS",
        "dishId": "0e4af759-820a-4859-9135-ccb08af7b0b0"
      },
      {
        "index": 2,
        "name": "Masala Chai",
        "action": "create",
        "errors": [],
        "computedPrice": 20
      },
      {
        "index": 3,
        "name": "Bad One",
        "action": "invalid",
        "errors": [
          {
            "field": "category",
            "message": "Pick a category from the list."
          },
          {
            "field": "vendorPrice",
            "message": "The price must be more than 0."
          }
        ],
        "computedPrice": null
      },
      {
        "index": 4,
        "name": "Masala chai",
        "action": "invalid",
        "errors": [
          {
            "field": "name",
            "message": "This dish name is repeated in the file (first at row 3)."
          }
        ],
        "computedPrice": null
      }
    ]
  }
}
```

`action` is `create | update | skip | invalid`; `reason` (only on `skip`) is `DUPLICATE_EXISTS` or `UNCHANGED`; `computedPrice` is the customer price from the Docs/21 engine (null when the price itself is invalid); `dishId` is the existing dish (update / skip). Applying a file with an invalid row: `400 IMPORT_INVALID` carrying the SAME report in `data`, nothing written:
```json
{
  "success": false,
  "code": "IMPORT_INVALID",
  "message": "2 rows are not valid. Nothing was imported. Fix them and try again.",
  "field": "rows",
  "data": "<same object as the dry run's data, with \"dryRun\": false>"
}
```

Apply of a good file (`dryRun:false`): created rows now carry their new `dishId`; a second identical call turns every row into a `skip` (double click safe):
```json
{
  "success": true,
  "message": "Imported: 2 added, 0 updated, 1 skipped.",
  "data": {
    "dryRun": false,
    "applied": true,
    "summary": {
      "create": 2,
      "update": 0,
      "skip": 1,
      "invalid": 0,
      "total": 3
    },
    "rows": [
      {
        "index": 0,
        "name": "Paneer Tikka",
        "action": "create",
        "errors": [],
        "computedPrice": 150,
        "dishId": "f4084af6-c433-430a-82d0-02ea9781b61e"
      },
      {
        "index": 1,
        "name": "chicken biryani",
        "action": "skip",
        "errors": [],
        "computedPrice": 190,
        "reason": "DUPLICATE_EXISTS",
        "dishId": "0e4af759-820a-4859-9135-ccb08af7b0b0"
      },
      {
        "index": 2,
        "name": "Masala Chai",
        "action": "create",
        "errors": [],
        "computedPrice": 20,
        "dishId": "39e8d175-0d15-411e-be18-6806decf9078"
      }
    ]
  }
}
```

#### POST /api/admin/uploads/image?purpose=banner|dish  (raw body, `Content-Type: image/jpeg|image/png|image/webp`, <= 1 MB)
```json
{
  "success": true,
  "data": {
    "url": "https://api.kraveo.site/uploads/banner/2026/bcff31b889235190508d11aaf6161e67.png",
    "width": 800,
    "height": 450,
    "bytes": 68
  }
}
```
Served with:
```json
{
  "content-type": "image/png",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin"
}
```
Refusals: SVG header `415 UNSUPPORTED_IMAGE_TYPE`; a 100x100 photo `400 IMAGE_TOO_SMALL` ("The photo is too small (100x100). The shorter side must be at least 200 pixels."). The returned `url` can be used as `imageUrl` of a dish or `bannerImage` of a restaurant like any https link. Orphan files are never deleted automatically.

### 8.5 Tests that had to change (and why)

- `test/e2e/hardening.test.ts` (public catalogue shape): the allowed key lists gained `cuisines`, `tags` (restaurant) and `categoryId` (dish) - forced by 3.1.
- `test/e2e/settlement.test.ts` (migration sanity): the assertion that the newest migration directory is `20261011_order_groups` now expects `20261012_categories`.
- `test/harness/db.ts` (shared seed): `seedTestDatabase()` also creates the dish categories that older suites type into dish requests (`Main`, `Starters`, `Drinks`, the six of the restaurant app, `Thalis`, `Parathas`) and links the two seeded dishes, because the test database is built with `prisma db push` (no migration backfill) and 3.4 now refuses unknown categories. `test/harness/app.ts` mounts `/uploads` and the import JSON limit exactly like `src/index.ts`.
- `test/e2e/pricing_visibility.test.ts`: the "a restaurant owner reaches nothing admin" table gained the new endpoints (additions only).
No other existing test was modified. Tests added: `categories_backfill` 5, `categories_admin` 22, `restaurant_profile` 17, `dish_categories_bulk_import` 30, `uploads` 16, `unit/image_probe` 3 (93 new); the whole backend suite is 982 tests (889 before).
