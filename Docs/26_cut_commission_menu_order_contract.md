# "Cut from sale" commission, menu price entry, per-restaurant menu order - contract (29 Oct 2026)

Binding for backend, dashboard and customer app. Builds on Docs/21 (pricing engine, settlements), Docs/23 (categories, import, uploads). Nothing here may change orders, payments, refunds, group orders, settlement math or any existing price: all existing dishes keep their price; no existing test may break (list every test you change and why).

## 0. Why (owner, 29 Oct 2026)
The owner finalised six real restaurants. Each restaurant sent a menu with the PRICES CUSTOMERS PAY and the file name carries the platform's cut as a percentage of the restaurant's sales ("DESART NATION MENU (20%)"). Business rule: the customer pays the menu price; Kraveo keeps X percent of the food sale and pays the restaurant the rest. Today's engine only adds a markup on the restaurant's own price (PERCENT of vendorPrice or FLAT), which cannot express "keep 30 percent of 115" exactly (30 percent of the sale = 43 percent markup on the restaurant's share, a repeating decimal that breaks rounding). So the engine needs a third commission type that is exact, and the importer must be able to take the customer's menu price.
The menu files also give the ORDER of the sections (and dishes) for each restaurant, which must be shown in the customer app per restaurant.

## 1. New commission type `CUT` (cut from sale)
- `CommissionType = 'PERCENT' | 'FLAT' | 'CUT'` everywhere (pricing.ts types, `checkCommissionRule`, `ruleFromColumns`, settings validation of the global default, vendor and dish overrides, PATCH vendor commission, catalog preview/recalculate/approve, dashboard-facing views `commission:{type,value,source}`; DB columns are plain strings, no migration for this part).
- Meaning: `value` = percent of the CUSTOMER price that Kraveo keeps, 0..90, up to 2 decimals. The customer price is derived from the restaurant's price: `vendorPaise = menuPaise - commissionPaise`, i.e. `menuPaise = ceil(vendorPaise * 10000 / (10000 - pBp))` where `pBp = round(value * 100)` (basis points) using INTEGER arithmetic only, then the existing round-up-to-step. `commission = price - vendorPrice`. `priceBeforeStepPaise` is the single place that changes; keep PERCENT and FLAT results byte-identical.
- Exactness property (test it with 100,000 random cases): for every menu price `m` (integer rupees 1..5000) and every integer percent 1..90 (plus a few two-decimal percents): `vendorPaise = m*100*(10000-pBp)/10000` is an integer when the percent is a whole number or m is such that it divides; pricing that vendorPaise with the same rule returns exactly `m` (with rounding step 1 or 0 or 5). For values where the division is not an integer paise, the helper `vendorPaiseForMenuPrice(menuPaise, rule)` must return the LARGEST vendorPaise whose derived price (before step, and after the current step) is <= the menu price AND, among those, equals the menu price whenever any vendorPaise does; document the rounding direction (never overpay the restaurant by rounding up).
- Settlement and finance keep working unchanged: they only read the stored per-order snapshots (`vendorUnitPrice`, `commissionUnit`, `vendorSubtotal`, `commissionTotal`). Add a test that a delivered order of a CUT restaurant settles to exactly (100 - X) percent of its food sale and that `commissionTotal` is exactly X percent (use 3 restaurants, 3 percents, multi-item carts, odd prices).
- Display strings: wherever the API or messages describe a rule ("5% of the restaurant price"...), add the CUT wording ("30% of the sale").
- Validation: `CUT` value 0..90 (reject 100 and above: division by zero); `FLAT`/`PERCENT` limits unchanged. The global default may be CUT too.

## 2. Entering the customer's menu price
- `POST /api/admin/vendors/:id/menu-import` rows accept an alternative to `vendorPrice`: `menuPrice` (the price the customer pays). Exactly one of `vendorPrice` / `menuPrice` per row (both or neither -> invalid row `PRICE_REQUIRED`). `menuPrice` is only allowed when the dish's EFFECTIVE rule (dish override, else restaurant, else global) is `CUT`; otherwise the row is invalid with `MENU_PRICE_NEEDS_CUT_RULE` and a plain message. Server derives `vendorPrice` with `vendorPaiseForMenuPrice` and the dry-run report shows both `vendorPrice` and the computed customer price (which must equal `menuPrice`; if it cannot be exact the row is invalid `MENU_PRICE_NOT_EXACT` with the nearest achievable price).
- `POST /api/admin/catalog` (admin create dish) and `PATCH /api/admin/catalog/:id` accept `menuPrice` the same way (mutually exclusive with `vendorPrice`).
- Rows may also carry `position` (integer, optional): see section 3. Rows keep `isVeg`, `description`, `imageUrl`, `isAvailable`, `category`.
- All prices stay two-decimal safe; `menuPrice` 1..5000 (same cap as vendorPrice); names, labels and duplicates rules unchanged.

## 3. Per-restaurant menu order (additive migration `20261014_menu_order`)
- `MenuItem.sortOrder Int @default(0)` (+ index on (`vendorId`, `sortOrder`)). 0 = unordered legacy.
- Ordering contract: every payload that lists a restaurant's dishes (public vendor + menu endpoints, owner `menu-manage`, admin catalog list for a vendor) returns dishes ordered by `sortOrder` ASC (rows with 0 AFTER ordered ones? NO: keep it simple: `sortOrder ASC, createdAt ASC, id ASC`; legacy rows are all 0 so their order is exactly today's). New dishes created without `position` get `max(sortOrder of that restaurant) + 10` (so they appear last); a restaurant with only legacy 0 rows gives the first new dish 10, which would sort after the 0s: that is acceptable and documented.
- Section order of a restaurant = order of the first appearance of each category among its dishes in that order. Customer app uses it (section 5).
- Import: `position` per row (1-based as written in the file) -> `sortOrder = position * 10`; if absent, file order.
- Admin endpoint `PUT /api/admin/vendors/:id/menu-order` `{ sections: [categoryName,...], dishes?: [{id, position}] }`: rewrites `sortOrder` for ALL of the restaurant's non-deleted dishes in one transaction so that sections follow `sections` (sections not listed keep their relative order after the listed ones), dishes inside a section follow `dishes` positions (unlisted ones keep their relative order after). Validates ids belong to the vendor, names exist among its dishes (unknown -> 400 `MENU_ORDER_INVALID`), caps (<= 60 sections, <= 400 dishes), idempotent (same body twice = `changed:false`), audited, rate limited, row locks (vendor row, then dishes by id ascending). Returns the ordered section list `[ {category, dishCount} ]`.
- Admin catalog dish edit may set `position` too (moves the dish within its section), optional.

## 4. Dashboard (web/super_admin)
- Commission editors (Settings -> Commission, restaurant commission editor, dish commission override) offer the third option "Cut from sale (%)" with a plain explanation and a live example ("Menu price Rs 115, cut 30%: restaurant gets Rs 80.50, Kraveo keeps Rs 34.50"); all views that print the rule (`CatalogPanel` table, drawer, restaurant card, finance labels, preview card) show the new wording; types/parsers accept `CUT` defensively.
- Dish drawer (create/edit) and the Import menu wizard: when the effective rule is CUT, the price field is "Menu price (customer pays)" and shows the restaurant's earning computed by the preview endpoint; CSV template gets an optional `menuPrice` column (and `position`); the dry-run preview shows both prices and errors `MENU_PRICE_NEEDS_CUT_RULE` etc. in plain words.
- Restaurant "Edit restaurant" or Catalog gets a "Menu order" panel for a restaurant: its sections as a list with up/down reorder (and a dish list per section with up/down), Save order (calls the menu-order endpoint), keyboard accessible, shows what changed.

## 5. Customer app
- The restaurant menu screen (`dhaba_menu_screen.dart`) orders its category tabs by first appearance in the server's dish order whenever the restaurant's dishes carry a positive `sortOrder` (new field `sortOrder` on the dish model, defensive default 0), and orders dishes inside a tab by the server order; when all dishes have `sortOrder` 0 behaviour stays exactly as today (global category order from `/categories`, then server order). No other screen changes. Bump version to 1.11.0+17 at the end (the lead does it).

## 6. Rules for every part
- No regression: backend (1163), dashboard (1006), customer (524), restaurant (514), rider (394), kraveo_ui (33) tests keep passing; existing dishes, orders and settlements unchanged; old app builds keep working (new fields additive).
- Tests with real Postgres: the engine exactness property, every endpoint that accepts a rule, preview/recalculate/approve with CUT, menu-import with `menuPrice` (dry run vs apply, mixed rows, wrong rule, non-exact case, both/neither price), admin dish create/edit with `menuPrice`, ordering of every dish-list payload, `menu-order` (sections, dishes, unknown names, other vendor's ids, idempotency, concurrency with a dish create, caps), settlement with CUT, legacy rows untouched, migration on a table with existing rows.
- Deploy order: backup, migration `20261014_menu_order`, backend, dashboard, apps.

## 7. Implementation notes (backend, 29 Oct 2026) - exact shapes for the dashboard and the apps

Everything below was produced by the real server against a real PostgreSQL in the test suites (`backend/test/e2e/cut_commission.test.ts`, `menu_order.test.ts`, `pricing_visibility.test.ts`, `backend/test/unit/cut_pricing.test.ts`); the JSON is copied from real responses (ids and times differ per run, long lists are cut to 2-3 rows and marked). Nothing here changes an order, payment, refund, settlement, group or an existing price.

### 7.1 What was built, where

- `src/services/pricing.ts`: `CommissionType = 'PERCENT' | 'FLAT' | 'CUT'`; `checkCommissionRule` (CUT 0..90, 2 decimals; 90.01 and 100 refused with "A cut from the sale cannot be more than 90%."), `ruleFromColumns` (a stored CUT above 90 is read as "inherit": never a division by zero), `priceBeforeStepPaise` (CUT = `ceil(vendorPaise x 10000 / (10000 - bp))` in exact integer arithmetic; PERCENT and FLAT untouched, proved byte-identical on 50,000 random cases), `customerPaiseFor`, and `vendorPaiseForMenuPrice(menuPaise, rule, stepRupees = 0) -> { vendorPaise, exact, lower, higher, nearest }`.
- `src/services/catalog.ts`: `menuPrice` on admin create / edit / preview (`vendorPriceForMenuPrice`, the three new error codes), `position` on admin edit, `sortOrder` on the admin dish view, the CUT audit wording, new dishes go last.
- `src/services/catalogBulk.ts`: `menuPrice` and `position` on import rows; the report rows carry `vendorPrice` and `sortOrder`.
- `src/services/menuOrder.ts` (new): `PUT /api/admin/vendors/:id/menu-order`, the position edit and the section layout; `src/utils/catalog.ts`: `MENU_ORDER_BY` (the one dish order) and `sortOrder` in the public dish payload; `src/routes/api.ts`, `src/services/vendorProfile.ts`: every dish list orders by it; `src/middleware/rateLimit.ts`: rule `ADMIN_MENU_ORDER` (60 per 10 minutes per admin).
- Migration `prisma/migrations/20261014_menu_order/migration.sql` (additive, idempotent: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0` + `CREATE INDEX IF NOT EXISTS "MenuItem_vendorId_sortOrder_idx"`). Verified twice with `psql` on a scratch database holding the previous schema (db push of the 20261013 schema) and 150 production-shaped dishes of 7 restaurants (PERCENT / FLAT overrides, pending, deleted, price requests): first run adds the column, every old column of every row has the identical checksum, all 150 rows have sortOrder 0; the second run is a no-op (NOTICEs "already exists, skipping"); `prisma migrate diff` from that database to `schema.prisma` is empty; the scratch database was dropped. `menu_order.test.ts` repeats this on a scratch schema inside the test run.
- Lock order for everything that writes dish positions: category rows (FOR SHARE, ascending id) -> restaurant row (FOR UPDATE) -> dish rows by ascending id. Dish create, import, menu-order and the position edit all take the restaurant row first, so they serialise per restaurant and can never deadlock with each other or with category renames (tested with a storm of 24 mixed parallel requests on one restaurant: no 4xx/5xx, every dish once, a final rewrite gives 10, 20 ... n x 10 with no duplicate or gap).

### 7.2 Decisions where this document was ambiguous

1. **Rounding direction of `vendorPaiseForMenuPrice`**: the restaurant's share is rounded DOWN to the paisa (`floor`), so the restaurant is never paid a paisa more than (100 - X)% of the menu price. It returns the largest share whose customer price is <= the menu price; because the customer price never falls when the share rises, that same share gives EXACTLY the menu price whenever any share does. `exact:false` carries `lower` / `higher` (the achievable prices on either side) and `nearest` (a tie goes to the lower).
2. **The rounding step matters**: the customer price is rounded UP to the step (default Rs 1). With the default step a whole-rupee menu price is exact for every whole percent and almost always for two-decimal percents; a menu price WITH PAISE (99.90) is `MENU_PRICE_NOT_EXACT` (nearest 100) unless the rounding setting is 0. With step 5 only multiples of 5 are sellable (117 -> nearest 115).
3. **Exactness**: for whole percents and whole-rupee menu prices the commission is exactly X% of the sale to the paisa (proved on 100,000 random cases and on real orders). When the division is not a whole paisa (two-decimal percents, paise prices) the engine's ceil can make Kraveo's part up to a fraction of a paisa MORE than X% (12.5% of Rs 101 -> the restaurant gets 88.37, Kraveo keeps 12.63): never the restaurant.
4. **`PRICE_REQUIRED`** is answered for "both prices" everywhere (admin create / edit / preview: 400, `field: menuPrice`) and, in an import row, for both AND neither (`field: menuPrice` / `vendorPrice`). On admin create / preview "neither" keeps the old `BAD_REQUEST` ("The restaurant price must be a number.", `field: vendorPrice`); an edit without any price just does not touch the price. In an import row `null` counts as absent.
5. **`menuPrice` is admin only**: the restaurant app endpoints ignore it (a restaurant always enters ITS price). `POST /admin/catalog/:id/approve` does not take it (approval keeps `vendorPrice`; fix a customer price afterwards with `PATCH` + `menuPrice`). `POST /admin/catalog/preview` accepts it too (the dashboard's live "restaurant earns" line) and answers the same error codes as create.
6. **The effective rule decides `menuPrice`**: dish override, else restaurant, else global, resolved in the same transaction as the write. A new override sent in the same request counts. A restaurant PERCENT rule beats a global CUT (and the reverse).
7. **Import**: `position` is a whole number 1..10000, stored as `position x 10`; duplicates are allowed (equal positions keep FILE order: created rows get `createdAt` one millisecond apart); a created row WITHOUT a position goes after the restaurant's last dish in file order (`max(sortOrder) + 10 x k`; for a fresh restaurant that is exactly 10, 20, 30 ... = file order); an UPDATE row without a position keeps the dish where it is; an UPDATE row with a position moves it. The dry run shows the position each row would get (`sortOrder`, null = unchanged / invalid).
8. **Menu order list**: dishes of a restaurant are listed `sortOrder ASC, createdAt ASC, id ASC` in the public menu / vendor payloads, the owner payloads (`menu-manage`, `/vendors`, `/vendors/:id`, `/menus/:id`), the admin vendor views and `GET /admin/catalog?vendorId=...` for every status filter EXCEPT the two review queues (`status=PENDING`, `status=CHANGE_PENDING`), which stay "oldest change first" because they are work queues. The all-restaurants admin list is unchanged (newest change first). Legacy dishes all have 0, so their order is exactly the old one; 0 sorts BEFORE ordered dishes (so a new dish 10 lands after legacy rows, as the contract says).
9. **`PUT menu-order` shape**: success answers `{ success, changed, message, count, data: [ { category, dishCount } ] }` (`data` is the ordered section list itself, `changed` is at the top like in approve / delete). It rewrites EVERY non-deleted dish of the restaurant (pending and rejected ones included) to 10, 20, 30 ... with each section contiguous (an interleaved legacy layout is normalised), keeps deleted dishes' numbers (a restore lands by its old number), does NOT bump `updatedAt` (reordering is not a dish edit, the approval queues keep their order) and writes nothing when nothing changes. `dishes[].position` is a RANK inside the dish's own section (gaps are fine; equal ranks keep the old order; listed dishes first, unlisted after). Sections match by name ignoring case and spacing; a section listed twice, a name the restaurant has no (non-deleted) dish in, a dish id of another restaurant / deleted / unknown, a malformed body, > 60 sections or > 400 dishes are all `400 MENU_ORDER_INVALID` with a `field` and nothing is written.
10. **Position on dish edit** (`PATCH /admin/catalog/:id` `{ position }`): 1..10000 rank inside the dish's section after the edit (a category change in the same request moves it to the new section); larger than the section = last. The whole menu is renumbered from its current order, so other sections keep their order.
11. `sortOrder` is in the CUSTOMER dish payload (`/menus/:id`, `/vendors`, `/vendors/:id`, section 5 reads it) and in the admin dish view / raw admin rows; it is NOT in the owner (restaurant) payloads. New dishes created by admin or by a restaurant get `max(sortOrder of the restaurant, deleted dishes included) + 10`. `position` on dish CREATE is not supported (create then move).
12. The global default commission may be CUT: restaurants and dishes without their own rule then price as CUT (tested). PUT of only `{type:'CUT'}` over a stored PERCENT 100 is refused as a whole (merged value 100 > 90).
13. Audit wording: `30% of the sale` for CUT (PERCENT `10%` and FLAT `Rs 7 flat` are unchanged); new audit action `MENU_ORDER_SET` (target VENDOR) only when something changed.
14. Order flow, group orders, payments, refunds and settlement code is untouched: they read the stored per-dish `vendorPrice` / `price`, so a CUT dish orders, groups and settles like any other.

### 7.3 Error answers and codes

Every error is `{ success:false, code, message, field? , ...extra }`. New codes:

| Code | HTTP | Where | Extra |
|---|---|---|---|
| `PRICE_REQUIRED` | 400 | admin create / edit / preview with BOTH `vendorPrice` (or legacy `price`) and `menuPrice`; import row with both or neither (in `rows[].errors[]`, with `code`) | `field`: `menuPrice` (both) / `vendorPrice` (neither, import only) |
| `MENU_PRICE_NEEDS_CUT_RULE` | 400 | `menuPrice` while the dish's effective rule is not CUT (create, edit, preview, import row) | `field: menuPrice`; message: "A menu price can only be used when the commission is \"Cut from sale\". ..." |
| `MENU_PRICE_NOT_EXACT` | 400 | the menu price cannot be sold exactly (paise price with step 1, not a multiple of the step, a two-decimal percent that skips that price, price too small) | `nearestPrice` (rupees, tie -> lower), `field: menuPrice`; in an import row the same three fields are inside `errors[]` |
| `MENU_ORDER_INVALID` | 400 | `PUT menu-order` with a bad body, unknown section, foreign / deleted / unknown dish, duplicates, caps | `field` (`sections[1]`, `dishes`, `dishes[0].position` ...) |
| existing `BAD_REQUEST` | 400 | CUT value over 90 or with 3 decimals (`field: value` / `commissionValue`), bad `menuPrice` number (0, > 5000, 3 decimals, text; `field: menuPrice`), bad `position` on dish edit (`field: position`) | |
| existing `IMPORT_INVALID` | 400 | apply with any invalid row (nothing written); `data` is the dry-run report | |
| existing `RATE_LIMITED` | 429 | `ADMIN_MENU_ORDER` 60 per 10 minutes | |

Import row errors without a machine code (as before): `{ field, message }`; `position` errors: `field: position`, "The position must be a whole number from 1 to 10000."; `menuPrice` out of range: "The menu price must be more than 0." / "The menu price cannot be more than ₹5000.".

### 7.4 Real responses

**A CUT rule in the settings view** (`PUT /api/admin/settings/commission` `{ "type": "CUT", "value": 20 }`; GET answers the same `data`):

```json
{
  "success": true,
  "changed": true,
  "message": "Saved. Existing dish prices keep their old value until you run \"Recalculate prices\".",
  "recalculateRecommended": true,
  "data": {
    "group": "commission",
    "value": {
      "type": "CUT",
      "value": 20
    },
    "isDefault": false,
    "updatedAt": "2026-10-28T23:34:23.305Z",
    "updatedBy": "usr-5"
  }
}
```

**In the restaurant (vendor) view** (`PATCH /api/admin/vendors/:id/commission` `{ "type": "CUT", "value": 30 }`; `GET /api/vendors` as admin shows the raw columns `commissionType: "CUT"`, `commissionValue: 30`; `{ "type": null, "value": null }` resets to inherit):

```json
{
  "success": true,
  "message": "Saved.",
  "data": {
    "vendor": {
      "id": "cut-ven-1",
      "name": "Cut Kitchen 1",
      "commissionType": "CUT",
      "commissionValue": 30
    },
    "effective": {
      "type": "CUT",
      "value": 30,
      "source": "VENDOR"
    },
    "dishCount": 0,
    "staleDishes": 0
  }
}
```

**In the dish view** (`POST /api/admin/catalog` `{ vendorId, name, menuPrice: 115 }` for a restaurant whose rule is CUT 30; the same object is in `GET /admin/catalog`, `GET /admin/catalog/:id`, `PATCH`, approve, delete, restore). `commission` is the effective rule + source (`DISH` | `VENDOR` | `GLOBAL`), `commissionOverride` the dish's own override (`{type:"CUT",value}` or null), `sortOrder` the menu position. Note `vendorPrice` 80.5 (derived) and `price` 115 (exactly the menu price):

```json
{
  "success": true,
  "message": "Dish created and live.",
  "data": {
    "id": "2b5f1172-3395-4d4b-b9f0-9a37c75fb617",
    "vendorId": "cut-ven-1",
    "vendorName": "Cut Kitchen 1",
    "name": "Dish c55c391e",
    "category": "Main Course",
    "categoryId": "82681b26-f8ff-47a4-ae8c-90dbd9e55c1b",
    "description": "",
    "imageUrl": "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400",
    "isVeg": true,
    "isAvailable": true,
    "sortOrder": 10,
    "rating": 4.5,
    "ratingCount": 0,
    "status": "LIVE",
    "approvalStatus": "APPROVED",
    "rejectionReason": null,
    "vendorPrice": 80.5,
    "pendingVendorPrice": null,
    "price": 115,
    "computedPrice": 115,
    "priceIsStale": false,
    "pendingPrice": null,
    "effectiveCommission": 34.5,
    "commission": {
      "type": "CUT",
      "value": 30,
      "source": "VENDOR"
    },
    "commissionOverride": null,
    "createdBy": "ADMIN",
    "createdAt": "2026-10-28T23:34:23.820Z",
    "updatedAt": "2026-10-28T23:34:23.820Z",
    "reviewedAt": "2026-10-28T23:34:23.819Z",
    "reviewedByUserId": "usr-5",
    "deletedAt": null
  }
}
```

**Edit with `menuPrice`** (`PATCH /api/admin/catalog/:id` `{ "menuPrice": 200 }`; `preview` shows before / after; `{ "position": 2 }` and other fields can ride along):

```json
{
  "success": true,
  "message": "Dish updated.",
  "data": {
    "id": "37a53191-b8d0-44ac-9d6e-57d736e14e0d",
    "vendorId": "cut-ven-1",
    "vendorName": "Cut Kitchen 1",
    "name": "Dish dd92ca8b",
    "category": "Main Course",
    "categoryId": "82681b26-f8ff-47a4-ae8c-90dbd9e55c1b",
    "description": "",
    "imageUrl": "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400",
    "isVeg": true,
    "isAvailable": true,
    "sortOrder": 10,
    "rating": 4.5,
    "ratingCount": 0,
    "status": "LIVE",
    "approvalStatus": "APPROVED",
    "rejectionReason": null,
    "vendorPrice": 140,
    "pendingVendorPrice": null,
    "price": 200,
    "computedPrice": 200,
    "priceIsStale": false,
    "pendingPrice": null,
    "effectiveCommission": 60,
    "commission": {
      "type": "CUT",
      "value": 30,
      "source": "VENDOR"
    },
    "commissionOverride": null,
    "createdBy": "ADMIN",
    "createdAt": "2026-10-28T23:34:24.068Z",
    "updatedAt": "2026-10-28T23:34:24.075Z",
    "reviewedAt": "2026-10-28T23:34:24.067Z",
    "reviewedByUserId": "usr-5",
    "deletedAt": null
  },
  "preview": {
    "previousVendorPrice": 80.5,
    "previousPrice": 115,
    "vendorPrice": 140,
    "price": 200,
    "effectiveCommission": 60,
    "nominalCommission": 60,
    "commission": {
      "type": "CUT",
      "value": 30,
      "source": "VENDOR"
    },
    "roundingStep": 1
  }
}
```

**Preview with CUT** (`POST /api/admin/catalog/preview`; `menuPrice` OR `vendorPrice`, `commissionType` + `commissionValue` optional dish override). With `menuPrice` the answer starts with `menuPrice`:

```json
{
  "success": true,
  "data": {
    "menuPrice": 115,
    "vendorPrice": 80.5,
    "price": 115,
    "effectiveCommission": 34.5,
    "nominalCommission": 34.5,
    "commission": {
      "type": "CUT",
      "value": 30,
      "source": "DISH"
    },
    "roundingStep": 1
  }
}
```

With `vendorPrice` (restaurant rule CUT 20, no override):

```json
{
  "success": true,
  "data": {
    "vendorPrice": 80,
    "price": 100,
    "effectiveCommission": 20,
    "nominalCommission": 20,
    "commission": {
      "type": "CUT",
      "value": 20,
      "source": "VENDOR"
    },
    "roundingStep": 1
  }
}
```

**Menu import dry run with `menuPrice`** (`POST /api/admin/vendors/:id/menu-import` `{ rows: [ {name,category,menuPrice:115}, {name,category,vendorPrice:70,isVeg:false}, {name,category,menuPrice:99}, {name,category,menuPrice:250,position:7} ] }`; `dryRun` defaults to true). Every row has `vendorPrice` (given or derived), `computedPrice` (the customer price; equals `menuPrice` for menuPrice rows) and `sortOrder` (the stored menu position this row writes, `position x 10`, or after the last dish; null when the row does not move a dish or is invalid):

```json
{
  "success": true,
  "message": "Preview only: 4 to add, 0 to update, 0 to skip, 0 not valid.",
  "data": {
    "dryRun": true,
    "applied": false,
    "summary": {
      "create": 4,
      "update": 0,
      "skip": 0,
      "invalid": 0,
      "total": 4
    },
    "rows": [
      {
        "index": 0,
        "name": "Imp A",
        "action": "create",
        "errors": [],
        "computedPrice": 115,
        "vendorPrice": 80.5,
        "sortOrder": 10
      },
      {
        "index": 1,
        "name": "Imp B",
        "action": "create",
        "errors": [],
        "computedPrice": 100,
        "vendorPrice": 70,
        "sortOrder": 20
      },
      {
        "index": 2,
        "name": "Imp C",
        "action": "create",
        "errors": [],
        "computedPrice": 99,
        "vendorPrice": 69.3,
        "sortOrder": 30
      },
      {
        "index": 3,
        "name": "Imp D",
        "action": "create",
        "errors": [],
        "computedPrice": 250,
        "vendorPrice": 175,
        "sortOrder": 70
      }
    ]
  }
}
```

**Apply** (`dryRun:false`; same rows, `dishId` added; here cut to 2 rows, all 4 are in the real answer; with `position` on a restaurant that already has a dish at 50):

```json
{
  "success": true,
  "message": "Imported: 5 added, 0 updated, 0 skipped.",
  "data": {
    "dryRun": false,
    "applied": true,
    "summary": {
      "create": 5,
      "update": 0,
      "skip": 0,
      "invalid": 0,
      "total": 5
    },
    "rows": [
      {
        "index": 0,
        "name": "File 1",
        "action": "create",
        "errors": [],
        "computedPrice": 10,
        "vendorPrice": 10,
        "sortOrder": 60,
        "dishId": "8fc516e6-cdc4-4d1e-843d-cd0260244911"
      },
      {
        "index": 1,
        "name": "File 2",
        "action": "create",
        "errors": [],
        "computedPrice": 10,
        "vendorPrice": 10,
        "sortOrder": 30,
        "dishId": "3af2bf33-f219-4045-b4b5-bf1837198b0a"
      },
      {
        "index": 2,
        "name": "File 3",
        "action": "create",
        "errors": [],
        "computedPrice": 10,
        "vendorPrice": 10,
        "sortOrder": 70,
        "dishId": "f307ebdc-46a7-4de1-af19-23246d06008c"
      }
    ]
  }
}
```

**Row errors** (a dry run answers 200 with these inside `rows[]`; an apply with any of them answers `400 IMPORT_INVALID` and `data` is the same report, nothing written). Cut to 3 rows of the 9 in the test:

```json
{
  "success": false,
  "code": "IMPORT_INVALID",
  "message": "2 rows are not valid. Nothing was imported. Fix them and try again.",
  "field": "rows",
  "data": {
    "dryRun": false,
    "applied": false,
    "summary": {
      "create": 1,
      "update": 0,
      "skip": 0,
      "invalid": 2,
      "total": 3
    },
    "rows": [
      {
        "index": 0,
        "name": "Good One",
        "action": "create",
        "errors": [],
        "computedPrice": 115,
        "vendorPrice": 80.5,
        "sortOrder": 10
      },
      {
        "index": 1,
        "name": "Both",
        "action": "invalid",
        "errors": [
          {
            "field": "menuPrice",
            "code": "PRICE_REQUIRED",
            "message": "Give either the restaurant price (vendorPrice) or the customer menu price (menuPrice), not both."
          }
        ],
        "computedPrice": null,
        "vendorPrice": null,
        "sortOrder": null
      },
      {
        "index": 2,
        "name": "Neither",
        "action": "invalid",
        "errors": [
          {
            "field": "vendorPrice",
            "code": "PRICE_REQUIRED",
            "message": "Give the restaurant price (vendorPrice) or the customer menu price (menuPrice)."
          }
        ],
        "computedPrice": null,
        "vendorPrice": null,
        "sortOrder": null
      }
    ]
  }
}
```

**A row that is not exact** (`rows[]` element; `nearestPrice` also at the top of the single-dish error below):

```json
{
  "index": 0,
  "name": "Third",
  "action": "invalid",
  "errors": [
    {
      "field": "menuPrice",
      "code": "MENU_PRICE_NOT_EXACT",
      "message": "Rs 10 cannot be split exactly at a 33.33% cut. The nearest price that works is Rs 9.99.",
      "nearestPrice": 9.99
    }
  ],
  "computedPrice": null,
  "vendorPrice": null,
  "sortOrder": null
}
```

**New error codes on single-dish endpoints:**

`PRICE_REQUIRED` (both prices):
```json
{
  "success": false,
  "code": "PRICE_REQUIRED",
  "message": "Send either the restaurant price (vendorPrice) or the customer menu price (menuPrice), not both.",
  "field": "menuPrice"
}
```

`MENU_PRICE_NEEDS_CUT_RULE`:
```json
{
  "success": false,
  "code": "MENU_PRICE_NEEDS_CUT_RULE",
  "message": "A menu price can only be used when the commission is \"Cut from sale\". Enter the restaurant price instead, or change the commission to \"Cut from sale\" first.",
  "field": "menuPrice"
}
```

`MENU_PRICE_NOT_EXACT` (rounding step 0, CUT 33.33%, menuPrice 10):
```json
{
  "success": false,
  "code": "MENU_PRICE_NOT_EXACT",
  "message": "Rs 10 cannot be split exactly at a 33.33% cut. The nearest price that works is Rs 9.99.",
  "field": "menuPrice",
  "nearestPrice": 9.99
}
```

**Menu order**: `PUT /api/admin/vendors/:id/menu-order` with

```json
{ "sections": ["Desserts", "Snacks"], "dishes": [ { "id": "<dish id of this restaurant>", "position": 1 } ] }
```

(`sections` is required, may be `[]`; `dishes` optional, at most 400; sections not listed keep their relative order AFTER the listed ones). Answer (here the restaurant had Main Course x3, Snacks x2, Desserts x1; the same body again answers the same `data` with `changed:false` and the message "Nothing to change: the menu already has this order."):

```json
{
  "success": true,
  "changed": true,
  "message": "Menu order saved.",
  "count": 3,
  "data": [
    {
      "category": "Desserts",
      "dishCount": 1
    },
    {
      "category": "Snacks",
      "dishCount": 2
    },
    {
      "category": "Main Course",
      "dishCount": 3
    }
  ]
}
```

Unknown section (`400`, nothing written):
```json
{
  "success": false,
  "code": "MENU_ORDER_INVALID",
  "message": "This restaurant has no dishes in a section called \"Biryani\".",
  "field": "sections[1]"
}
```

How the customer app derives the tabs from the served order (section 5): the dishes of `GET /api/menus/:vendorId` (or `menuItems` of `/vendors/:id`) already come in menu order; the tab order is the first appearance of each `category`; a dish payload now carries `sortOrder` (0 = unordered legacy):

```json
{
  "id": "64310262-8b58-4508-a263-dd44bd950493",
  "vendorId": "cut-ven-1",
  "name": "Dish c90858d2",
  "price": 115,
  "category": "Main Course",
  "categoryId": "82681b26-f8ff-47a4-ae8c-90dbd9e55c1b",
  "description": "",
  "imageUrl": "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400",
  "isAvailable": true,
  "isVeg": true,
  "rating": 4.5,
  "ratingCount": 0,
  "sortOrder": 10
}
```

### 7.5 Tests

- New: `test/unit/cut_pricing.test.ts` (36: examples, validation, 100,000-case exactness property for whole percents x whole-rupee prices x steps 0/1/5, 50,000-case property for two-decimal percents and paise prices, rounding direction, PERCENT/FLAT byte-identical on 50,000 cases), `test/e2e/cut_commission.test.ts` (24: every place that takes a rule, `menuPrice` on preview / create / edit / import with every error, 3 restaurants x 3 percents x 6-dish carts with odd prices exact to the paisa, a GROUP order across a CUT and a PERCENT restaurant, settlement of CUT orders exact, owner and customer visibility), `test/e2e/menu_order.test.ts` (30: the order in 15 payloads incl. ties, new-dish position, import `position`, menu-order sections / dishes / every error / idempotency / caps / audit / rate limit / auth, position edit, storm of mixed parallel writers, two racing menu-orders, migration on rows), plus one test in `test/e2e/pricing_visibility.test.ts` (a paid order of a CUT restaurant: no customer price, cut or commission in any restaurant payload; restaurant cannot call the new endpoints).
- Changed existing tests (4, all forced by an additive field or a new migration file, no behaviour assertion was weakened): `test/e2e/dish_categories_bulk_import.test.ts` "dry run is the DEFAULT ..." (`toEqual` on the report rows: they now also carry `vendorPrice` and `sortOrder`, required by section 2); `test/e2e/hardening.test.ts` "13. public catalogue" and `test/e2e/restaurant_profile.test.ts` "GET /vendors and /vendors/:id ..." (exact key list of a PUBLIC dish: `sortOrder` added, required by section 5); `test/e2e/settlement.test.ts` "migration and schema sanity" (the name of the newest migration directory: `20261014_menu_order`).
- Counts: 91 new tests (36 + 24 + 30 + 1), backend suite 1163 -> 1254 in 39 suites, all green on the final full run.

### 7.6 Deploy and rollback

Backup, apply `20261014_menu_order/migration.sql` (seconds; no table rewrite; `lock_timeout 5s`), `npx prisma generate`, restart the backend; then dashboard, apps. Old app builds keep working (new response fields are additive; `sortOrder` in the customer dish payload is ignored by old parsers). Rollback of the code is safe without touching the column (an old server ignores `sortOrder`); the column can stay.
