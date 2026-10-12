# Adversarial review: managed categories, restaurant profile edit, bulk/import, image upload (commit 9ac3d05, Docs/23)

Reviewer: read-only, line by line (no jest, no build, no DB, nothing contacted). Read in full: migration.sql, schema diff, services/categories.ts,
vendorProfile.ts, catalogBulk.ts, routes/categories.ts, routes/uploads.ts, utils/imageProbe.ts, bodyLimits.ts, rateLimit.ts diff, index.ts diff,
utils/catalog.ts diff, services/catalog.ts diff, api.ts + partners.ts + catalog.ts route diffs, seedDb diff, test harness diff, all new test titles.
Two throw-away experiments were run in the scratchpad (imageProbe.ts copy fed with hand-made bytes; the `distance()` function timed). Nothing in the repo was changed.

## Verdict

No BLOCKER and no HIGH. I could not construct a path that loses or corrupts data, leaks a secret/commission/price, lets a non-admin reach a new endpoint,
reads a file outside UPLOAD_DIR, or deadlocks (lock order category -> vendor -> dish holds in every writer I traced). The migration is safe to run on
real data as far as the SQL goes: one transaction, additive, idempotent, clean rollback on any error. What remains is MEDIUM/LOW: an admin-edit trap on
backfilled names, an upload size policy that is too generous for the customer app, a probe that is weaker than the doc says, a lock-duration caveat for the
migration, one old-client path (re-application) that desyncs cuisines, and test gaps.

## Summary table

| # | Sev | Status | Area | One line |
|---|-----|--------|------|----------|
| 1 | MEDIUM | CONFIRMED | admin edit vs backfilled names | `PATCH /admin/categories/:id` re-validates an UNCHANGED `name` with the strict 30-char/ASCII rule: any backfilled category with `(`, `,`, `.`, accents or >30 chars cannot be edited if the form sends `name` along |
| 2 | MEDIUM | CONFIRMED | upload policy | Max 4000x4000 (16 MP) accepted; customer app `Image.network` has no `cacheWidth`, so one decoded photo is ~64 MB |
| 3 | MEDIUM | CONFIRMED | migration ops | ACCESS EXCLUSIVE on "MenuItem" + SHARE ROW EXCLUSIVE on "Vendor"/"Category" are held from the first ALTER until COMMIT (whole backfill); no snapshot/rollback runbook; `MenuItem.category` rewrite is irreversible |
| 4 | LOW-MEDIUM | CONFIRMED | old-client path | `PUT /partner/application` (pending/rejected owner) writes `Vendor.category` from the derived string cut to 60 chars, or the owner's new text, while cuisine links stay: string vs `cuisines`/`tags` desync |
| 5 | LOW-MEDIUM | CONFIRMED | CPU DoS (admin) | Bulk `SET_CATEGORY` with a 95 KB `category` string: `suggestDishCategories` Levenshtein on the whole string x 300 categories, about 20 s of blocked event loop |
| 6 | LOW | CONFIRMED | probe | JPEG: anything after the SOF header is accepted (no SOS/EOI check); PNG without IDAT and WebP VP8X without image data pass; "truncated JPEG is IMAGE_CORRUPT" is not true |
| 7 | LOW | CONFIRMED | disk | No total quota, no orphan cleanup, limiter is in memory (reset by pm2 restart); a failed write leaves a `.tmp-*` file behind |
| 8 | LOW | CONFIRMED | old clients | Renaming/hiding/merging/deleting any of the six hard-coded names breaks add-dish in EVERY old restaurant app build (400, no list shown) |
| 9 | LOW | CONFIRMED | input hygiene | Label check misses bidi/zero-width characters; import name-duplicate check can be bypassed with U+200B |
| 10 | LOW | CONFIRMED | legacy dishes | A legacy dish with NULL `categoryId` and a non-ASCII-only category text cannot echo its category back on admin edit (400) |
| 11 | LOW | CONFIRMED | migration SQL | `btrim` before `regexp_replace` (wrong order): tab/newline at the edge of a stored category leaves a leading/trailing space in the new Category name |
| 12 | LOW | CONFIRMED | pre-auth body | Menu-import JSON parser (400 KB) runs before auth and before the rate limiter |
| 13 | LOW | CONFIRMED | reorder | Reorder reads ids before locking: a delete in between gives P2025 -> 500; it also holds FOR UPDATE on all categories while doing up to 300 updates |
| 14 | LOW | CONFIRMED | public endpoint | `GET /api/categories`: no server cache/rate limit; `dishCount` ignores the restaurant's approval state; zero-count categories are listed |
| 15 | INFO | - | tests | Test gaps (list at the end) |

## Findings

### 1. MEDIUM - an unchanged legacy name cannot be re-saved (services/categories.ts:459, 45-53)
`patchCategory` runs `checkCategoryName(b.name)` BEFORE comparing with the stored name (the diff is computed later, line 473). The migration creates
names from free text with no charset/length rule (SQL lines 91-97 and 154-159): "Rolls (Veg)", "Dal, Rice", "Café", a 38-character token from a restaurant
string, one-letter tokens from "A, B". Those names fail `NAME_CHARS` / 2..30 on every later save.
Trigger: admin portal edit form that sends the whole object (`name` included) to change `showOnHome`, `icon`, `nameHi` or `sortOrder` of such a category -> 400
"Use only letters, digits ...". Tools that send only the changed field are fine, so this depends on the dashboard (not verified).
Effect: not data loss; the admin has to rename first. Worse, the only "fix" offered (rename) cascades to every dish and restaurant.
Fix: in `patchCategory` skip validation when `collapse(b.name) === before.name` (move the name check after the lock, compare, validate only when different). Size: S (5 lines + 1 test).

### 2. MEDIUM - 4000x4000 is too big for the customer app (routes/uploads.ts:24-25, 64-66; apps/customer_app/lib/widgets/ui/k_image.dart:36)
Only the LONGER side is capped (4000), so 4000x4000 = 16 MP passes. A 1 MB highly compressed JPEG of that size is easy. `KImage` uses `Image.network` with no
`cacheWidth/cacheHeight`, so Flutter decodes full size: 16 MP x 4 bytes = 64 MB per image (default image cache 100 MB). A menu list with a few of them
on a 3-4 GB phone means jank/OOM in the customer app. The probe cannot defend (it never decodes).
Fix (pick one): lower `MAX_SIDE_PX` to about 2000 and add an area cap (e.g. width*height <= 4 MP); and/or add `cacheWidth` in `KImage`. Size: S.

### 3. MEDIUM - migration lock duration and no runbook (migration.sql:15-20, 49-60, 225)
Everything is one transaction (BEGIN line 15). `ALTER TABLE "MenuItem" ... ADD COLUMN` (line 20) takes ACCESS EXCLUSIVE on "MenuItem", held until COMMIT
(line 234), i.e. through the whole backfill including the full-table `UPDATE "MenuItem"` (line 225). The FK block (lines 49-60) adds SHARE ROW EXCLUSIVE on "Vendor"
and "Category" (blocks Vendor writes such as rating updates, open/closed toggles, createDish `FOR UPDATE`). While it runs, customer menu reads and order
placement (which read MenuItem) queue. With the current data size this is seconds, but it is not "zero impact", and the doc says "safe on live data" without a window.
Failure mode is clean: `lock_timeout 5s` makes the ALTER fail if any open transaction touches MenuItem/Vendor (the 60 s maintenance job can), everything rolls back,
but Prisma records a FAILED migration and `migrate deploy` then refuses (P3009) until `prisma migrate resolve --rolled-back 20261012_categories`.
Irreversibility: step (d) rewrites `MenuItem.category` to the canonical spelling ("snacks"/"Snacks " -> "Snacks"); the original spellings are not kept anywhere.
Not verified: behaviour through `prisma migrate deploy` itself (verified only with psql and the jest copy of the DO block).
Fix (runbook, no code): take a pg_dump/RDS snapshot first, run in a quiet minute, `SELECT * FROM pg_stat_activity WHERE state='idle in transaction'` before, have the
`migrate resolve --rolled-back` command ready, restart the backend only after success. Optional: split DDL and backfill into two migrations so the long lock is just the DDL. Size: S (docs).

### 4. LOW-MEDIUM - re-application desyncs cuisines (routes/partners.ts:374-376)
`PUT /partner/application` builds `vendorFields({ category: p.vendor.category, ...b })`; `clean(x, 60)` (partners.ts:37) slices to 60 chars and the result is written with
`prisma.vendor.update`. After an admin sets 3+ cuisines the derived `Vendor.category` ("North Indian • South Indian • Chinese • Street Food") exceeds 60 -> the stored
string is cut mid-word on the owner's next re-submit (PENDING/REJECTED only). If the owner (old app) edits the category text, `Vendor.category` changes while
`VendorCategory` rows stay, so `category` and `cuisines`/`tags` disagree until the next admin edit. The Docs/23 8.2 #10 note covers self sign-up restaurants, not this path.
Fix: in that handler, when the vendor has cuisine links, keep `category` out of the update (or run it through `cuisinesFromText` like admin creation). Size: S.

### 5. LOW-MEDIUM - event-loop freeze through the category suggestion (services/categories.ts:206-228; services/catalogBulk.ts:75)
`bulkDishAction` -> `peekDishCategory({ name: b.category })` -> `resolveDishCategory(admin:true)` -> `unknownCategory` -> `suggestDishCategories(typed)`.
`b.category` has no length limit (only the 100 KB body limit). `distance()` allocates `(len+1)` arrays and runs len x |slug| cells per category; categories whose slug
neither contains nor is contained in the typed slug are all measured. Measured here: 95,000 characters x one 20-character slug = about 75 ms; 300 categories = about 22 s
of fully blocked Node event loop (the whole API, sockets, order maintenance), 30 such requests per 10 minutes allowed by ADMIN_CATALOG_BULK.
Admin-only, so only a compromised/looping admin client; single dish create/edit are safe (40-char cap, catalog.ts:461, 520).
Fix: `typed.slice(0, 40)` (or reject >40 with 400) at the start of `resolveDishCategory`, and `if (Math.abs(a.length-b.length) > limit) return Infinity` in `distance`. Size: S.

### 6. LOW - probe accepts non-images (utils/imageProbe.ts:39-63, 27-35, 82-84)
Experiment (copy of the file, hand-made bytes): `FFD8 FFC0 000B 08 0BB8 0BB8 01 01 11 00` followed by 500 bytes of `<?php ... <script>` returns
`{jpeg, 3000x3000}`; the same header with 1000 zero bytes at 4000x4000 passes; a PNG with only IHDR + IEND (no IDAT, CRC never checked) at 4000x4000 passes;
a WebP VP8X header with no image chunk passes. The test helpers (`test/harness/images.ts`) build the same stub files, so tests cannot notice.
Impact: the file is stored and served as `image/jpeg` with `nosniff`, so no script runs; the harm is (a) the doc claim "truncated or damaged file -> IMAGE_CORRUPT" is false for JPEG,
(b) a broken photo reaches customers (the app shows its fallback icon), (c) the admin upload becomes a 1 MB-per-call file host for any bytes after a 15-byte header.
Fix: JPEG: require an SOS marker after the frame and an EOI (FFD9) in the last bytes; PNG: require at least one IDAT before IEND (optionally CRC check, zlib.crc32 exists on Node 22 as used by the tests); WebP: walk RIFF chunks and require an image chunk. Size: M.

### 7. LOW - disk usage has no ceiling (routes/uploads.ts:68-81)
60 uploads/hour/admin x 1 MB = 1.4 GB/day per admin account, files are never deleted (documented), the SlidingWindow is in memory so a pm2 restart resets it, and nothing checks free space.
`writeFile` then `rename` inside one try: if `writeFile` fails with ENOSPC the partial `.tmp-<hex>` stays (no `unlink` in the catch); a failed `rename` leaves a full file.
Fix: unlink tmp in the catch; optional cheap guard (`fs.statfs` free space > e.g. 2 GB, else 503) and a daily count/size cap read from the audit log. Size: S.

### 8. LOW - the six hard-coded names are a trap for old restaurant apps (services/categories.ts:246-291, 554-624)
The old app (`add_dish_modal.dart`) offers exactly Main Course, Breads, Beverages, Snacks, Desserts, Fast Food and sends the name. After an admin renames, hides, merges or deletes (when unused) one of
them, the next add-dish of every old build with that chip returns 400 `CATEGORY_UNKNOWN` ("Pick a category from the list."), which the old app has no list for. The code is "documented" (8.2 #4) but nothing
warns the admin. Also `Main Course` hidden makes the no-category default fail.
Fix: either block rename/merge/hide/delete of those six slugs while old builds are in use (409 with an explanation), or keep a small alias table (old slug -> category id). Size: S/M.

### 9. LOW - bidi and zero-width characters pass every label check (categories.ts:43, vendorProfile.ts:18, catalogBulk.ts:109)
`[<>\u0000-\u001f\u007f-\u009f  ]` does not exclude U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF. `collapse()` uses `\s`, which catches U+FEFF and NBSP but not U+200B.
Effects: restaurant names, addresses, `nameHi`, dish names/descriptions of an import can contain an RTL override (visual spoofing in the apps) and "Dosa" vs "Dosa<U+200B>" are two distinct dishes
for the duplicate check (catalogBulk.ts:192, 214), so SKIP/UPDATE does not match. Names that reach the apps are rendered as text (no `innerHTML` in the new code paths; I did not audit the whole dashboard bundle).
CSV exports are guarded by `csvText` (settlement.ts:435), so no formula injection from renamed restaurants. Fix: add those ranges to the three regexes (one shared constant). Size: S.

### 10. LOW - echoing a slug-less category on a legacy dish (services/categories.ts:265-266, services/catalog.ts:462-484)
`adminEditDish` treats any `category` in the body as "touched". For a legacy dish with NULL `categoryId` and a category such as "मुख्य" (slug "" - the backfill leaves these NULL on purpose),
`resolveDishCategory` throws before the "unchanged" shortcut (`typed && !wantedSlug && !wantedId`, line 266). An old dashboard that PATCHes the whole dish therefore gets 400 on every save of such a dish.
Likely very rare (the old restaurant app only offers English names). Fix: if `opts.current` is given and `collapse(typed) === collapse(current.category)`, return the current row's category (or a clear message). Size: S.

### 11. LOW - wrong trim order in the backfill (migration.sql:93 and the vendor twin at 157)
`regexp_replace(btrim(m."category"), '\s+', ' ', 'g')`: `btrim` removes only spaces, then `\s+` turns a leading tab/newline into a leading space. A stored "\tSnacks" yields the Category name " Snacks".
Old APIs trimmed input, so real data is unlikely to contain it. Fix: `btrim(regexp_replace(x, '\s+', ' ', 'g'))`. Size: XS. (The migration is already merged; changing it before the first deploy is free, after the first deploy it is not allowed.)

### 12. LOW - 400 KB JSON parsed before auth (middleware/bodyLimits.ts:118)
`app.post('/api/admin/vendors/:id/menu-import', express.json({ limit: '400kb' }))` runs before the router, so an anonymous caller can make the server parse 400 KB of JSON per request (4x the global 100 KB, already pre-auth).
No memory risk worth noting; no rate limit applies to anonymous callers. Fix: none needed unless nginx lacks request limits; note for the deploy checklist. Size: -.

### 13. LOW - reorder (services/categories.ts:529-547)
`all`/`known` are read before `lockCategories(...'UPDATE')`; a category deleted in between is still in `ids`, then `tx.category.update` hits P2025 -> `fail()` answers 500. Also all (up to 300) category rows are locked FOR UPDATE for the whole loop of up to 300 sequential updates, so dish creation by restaurants waits meanwhile (a few seconds at most).
Fix: re-read `current` after the lock and re-check `ids` against it (400 CATEGORY_UNKNOWN); one `UPDATE ... FROM (VALUES ...)`. Size: S.

### 14. LOW - public categories (services/categories.ts:122-155, routes/categories.ts:18-26)
Nothing sensitive leaks: inactive categories are filtered, counts use APPROVED restaurants and APPROVED non-deleted dishes, fields are the documented ones. Smaller points: (a) `dishCount` (line 135) does not look at the restaurant's approval or open state, so a SUSPENDED restaurant's dishes still make a category appear on `home`; (b) `for=restaurants|dishes` list zero-count categories (every backfilled dish category is forRestaurants=true by decision 3); (c) every request runs two grouped scans; `Cache-Control: public, max-age=60` helps only if nginx/CDN caches. There is no limiter for anonymous callers. Fix: 30-60 s in-process memo of the three filter variants; join Vendor approval for dish counts. Size: S.

## Checked and OK (no finding)

- Migration SQL: only literal patterns, no user input; idempotent (second run: every INSERT is guarded by `NOT EXISTS`/`ON CONFLICT`, UPDATE (d) only touches `categoryId IS NULL`); NULL `Vendor.category` gives zero rows from `regexp_split_to_table`; empty/symbol-only names get slug '' and are dropped; names that normalise to the same slug collapse to one row (deterministic winner); unique slug cannot be violated inside one INSERT (rank 1 per slug); explicit BEGIN/COMMIT plus `ON COMMIT DROP` temp tables, so a failure leaves no partial state and no temp objects; `SET LOCAL` limits are scoped to the transaction; md5->uuid ids are valid for `ID_RE`; "updatedAt" is untouched; Vendor.category is not rewritten.
- Raw SQL in the new services: every value is a tagged-template parameter (`ANY(${list}::text[])`, separators and names bound), no string concatenation; `__proto__`/unknown keys are rejected by `rejectUnknownKeys`, bulk, import rows and profile (`Object.keys` sees the own `__proto__` key that JSON.parse creates).
- Authz: every new endpoint sits behind `requireAuth, requireRole('ADMIN')` (categories router, profile, bulk, import, upload); the restaurant-owner create path (`/vendors/:id/items`) keeps `requireApprovedPartner` + `canManageVendor`, and an owner cannot use inactive or non-dish categories. The upload route authenticates BEFORE `express.raw`, so a non-admin never makes the server buffer a body; the global `express.json` ignores `image/*`; gzip bodies are limited after inflation.
- Static route: the regex gate `^/(banner|dish)/\d{4}/[0-9a-f]{32}\.(jpg|png|webp)$` runs on the still-encoded `req.path`, so `%2e`, `%2f`, `%00`, backslashes, double encoding, case tricks, trailing dots, dotfiles and `.tmp-` names never reach `express.static`; `$` has no newline slack in JS; `\d` is ASCII; only GET/HEAD; nothing outside UPLOAD_DIR can be named. nosniff + CORP cross-origin set in `setHeaders`; random 128-bit names, `wx` flag, `mkdir recursive` is race safe; the error answer never contains a path (only the errno code is logged).
- Probe arithmetic: no overflow (JS numbers), every read is bounds-checked (`segLen`, `i + segLen > length`), loops always advance, WebP RIFF size must match the file (max 1 padding byte), PNG must end exactly at IEND. The server never decodes, so there is no server-side decompression bomb.
- Concurrency: lock order category(ascending id) -> vendor -> dish holds in createDish, adminEditDish, bulk SET_CATEGORY, import (retry on category change), profile edit, rename, merge, delete. Unique-slug races map to 409 (P2002 handled in create and patch; `ON CONFLICT DO NOTHING` in the two raw inserts). Merge dedupes `VendorCategory` with LEAST(position) and re-tidies positions, refuses itself, is a 404 the second time. The 6-cuisine cap is enforced inside the vendor-row lock. Import apply re-reads existing dishes after the vendor lock, so a double click or 6 parallel applies create nothing twice.
- Old clients: no response field removed or retyped; `categoryId`, `cuisines`, `tags` are additive; `category` strings keep working on dish create for the six names; vendor payload spreads keep every old key. Order, payment, pricing, group, settlement code paths are not edited (only `catalog.ts`/`api.ts` read paths gained an `include` of `cuisines`).
- CSV: settlement exports escape `= + - @ tab CR`, so a hostile restaurant name cannot inject a formula.

## Test gaps

1. Backfill test never feeds: tab/newline/NBSP at the edges, names over 30 chars or outside `NAME_CHARS` followed by a PATCH of another field (finding 1), a category with a comma/bullet/parenthesis, >6 tokens followed by a profile save, 10k-row volume or timing, and it never runs through `prisma migrate deploy` (only psql and the DO block copy).
2. No test that a failed migration leaves nothing behind (e.g. force an error after the ALTER and assert the table is unchanged) and none for the lock timeout behaviour.
3. Upload tests use stub files without pixel data (`test/harness/images.ts`): no real encoder output (EXIF orientation, progressive CMYK JPEG, animated WebP), no JPEG-with-junk-after-SOF, no PNG-without-IDAT, no ENOSPC test that checks no `.tmp-` is left, no gzip `Content-Encoding` test, no test that the limiter still counts a request whose body is refused.
4. No test of `PUT /partner/application` after cuisines were set (finding 4) and none of old-dashboard echo of `category` on a NULL-categoryId dish (finding 10).
5. No test of bulk `SET_CATEGORY` with a very long `category` (finding 5), nor of `reorder` racing a delete (finding 13).
6. No check that the six hard-coded names survive an admin rename/merge (finding 8) or that an old-app add-dish error is understandable.
7. The concurrency tests are good but assert "no 500, no stale name"; none asserts the number of Postgres deadlocks (`pg_stat_database.deadlocks`) before/after the storm.

## Deploy checklist additions (not code)

- Snapshot/pg_dump before the migration; low-traffic minute; `migrate resolve --rolled-back` ready (finding 3).
- UPLOAD_DIR exists, owned by the pm2 user, on the nightly backup; `PUBLIC_BASE_URL` set (default is `https://api.kraveo.site`); nginx must proxy `/uploads/` to Node (only `/api` may be proxied today) and its `client_max_body_size` must be >= 1 MB (nginx default is exactly 1m, equal to `MAX_UPLOAD_BYTES`, so a file of 1,048,576 bytes is the edge).
- Decide findings 2 and 8 BEFORE the dashboard/apps ship, because old photos and old app builds are the hard part to fix later.
