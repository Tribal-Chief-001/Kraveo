# Pricing, catalog approval, fees, settlements, multi-restaurant orders - contract (6 Oct 2026)

Owner decisions (settled, do not re-ask):
1. A restaurant sets only ITS price for a dish (`vendorPrice`). The customer sees a different, final price computed by Kraveo = vendor price + commission. The restaurant never sees the customer price, the commission, the fees or the order total.
2. Commission is flexible: PERCENT or FLAT (an exact rupee amount), set as a global default, a per-restaurant default and a per-dish override (most specific wins).
3. Every new dish a restaurant adds needs admin approval; at approval the admin fixes the commission (or leaves the inherited one) and the final customer price is computed. Admin can also create, edit, hide and delete (soft) any dish from the admin portal. A restaurant's later price change is a request: the dish stays live at the old price until the admin approves.
4. Fees: ONE all-in fee per order, default Rs 25, covering delivery + GST + packaging + restaurant charge (the admin can split it into named lines for the records; the customer sees one line). Each EXTRA restaurant in the same order adds a flat Rs 15 (default). All amounts live in admin settings, not in code.
5. Multi-restaurant orders are wanted (restaurants are close together; it will take longer, that is accepted). They are built AFTER phases 1 and 2 are stable in production (design in section 8).
6. Restaurants are settled DAILY (default 22:00 IST, configurable), not instantly (instant payout would break refunds). Settlement batches are created automatically; the admin marks them paid with a bank/UPI reference. An optional auto-payout is a provider hook that stays OFF until RazorpayX payouts is activated (needs a separate RazorpayX account; Razorpay Route needs more turnover than we have). Riders are NOT settled daily: Kraveo only keeps their records and payout details (UPI id or bank account).
7. Everything is recorded for analytics: per dish, per restaurant, per day, per rider.

Non-goals now: automatic bank transfers, invoicing/TDS filing (CA item: Section 194O TDS 0.1% above Rs 5 lakh gross per restaurant per year; GST treatment of fees), partial refunds, per-order rider pay rules.

## 1. Phases

| Phase | Content | Order flow touched? |
|---|---|---|
| 1 | Settings (fees, commission default, rounding), commission engine, dish approval + soft delete, admin catalog UI, vendor app shows vendor price and status only, order items remember vendor price and commission, fee shown as one line | pricing only, not the state machine |
| 2 | Payout details (restaurants, riders), daily settlement batches, finance analytics, exports, rider delivery records | no |
| 3 | Multi-restaurant orders | yes (designed, built later) |

## 2. Data model (additive migration; existing rows are backfilled so nothing changes for live data)

`MenuItem` (existing `price` stays and means the CUSTOMER price, so the customer app, the pricing code and the cart keep working):
- `vendorPrice Float` (backfill = price), `commissionType String?` (`PERCENT`|`FLAT`, null = inherit), `commissionValue Float?`, `approvalStatus` (`PENDING`|`APPROVED`|`REJECTED`, backfill APPROVED), `rejectionReason String?`, `pendingVendorPrice Float?` (a requested change on a live dish), `deletedAt DateTime?`, `reviewedAt DateTime?`, `reviewedByUserId String?`, `createdBy String` (`VENDOR`|`ADMIN`, backfill `VENDOR`).
- Customer-visible = `approvalStatus = APPROVED AND deletedAt IS NULL` (sold-out dishes still appear greyed as today).

`Vendor`: `commissionType String?`, `commissionValue Float?` (null = inherit the global default).

`OrderItem`: `vendorUnitPrice Float` and `commissionUnit Float` (backfill: vendorUnitPrice = price, commissionUnit = 0). The existing `price` (customer unit price at order time) stays.
`Order`: `vendorSubtotal Float` (sum of vendorUnitPrice x qty; backfill = subtotal), `commissionTotal Float` (backfill 0), `feeBreakdown Json?`, `settlementId String?`. `deliveryFee` now holds the all-in fee; `taxAndPackaging` is 0 for new orders (the column stays; old orders keep their old values).

`AppSetting` (key/value JSON, one row per group, audited): `fees` = `{ baseFee: 25, lines: [{key,label,amount}] (optional breakdown, must sum to baseFee), extraRestaurantFee: 15, freeFeeAbove: 0 (0 = off), smallOrderBelow: 0, smallOrderFee: 0, gstOnFeesPercent: 18, gstOnFoodPercent: 5 }` (GST percents are informational for records until the CA decides), `commission` = `{ type: 'PERCENT', value: 0 }` default, `rounding` = `{ step: 1 }` (customer price rounded UP to a multiple of step: 0 = no rounding, 1, 5), `settlement` = `{ time: '22:00', mode: 'MANUAL_PAYOUT'|'AUTO_PAYOUT', autoCreate: true, holdDays: 0 }`. Server-side validation of every value (non-negative, sane maximums, lines sum to baseFee). Defaults are used when a row does not exist, so a fresh DB behaves like today minus the old Rs 40 (see section 3 for the one visible change).

`PayoutAccount` (one per user, partner type VENDOR|DRIVER): `method` (`UPI`|`BANK`), `upiId?`, `accountHolder?`, `accountNumberEnc?` (AES-256-GCM, key from env `PAYOUT_ENC_KEY`; the API returns only `accountLast4` and masks everywhere; the admin can fetch the full number through ONE explicit endpoint that writes an audit row), `ifsc?`, `bankName?`, `verifiedAt?` (admin marks), `updatedAt`. Validation: UPI regex, IFSC regex, account number 6-20 digits.

`Settlement`: id, `vendorId`, `periodStart`, `periodEnd` (UTC instants of the IST window), `status` (`PENDING`|`ON_HOLD`|`PAID`|`CANCELLED`), `orderCount`, `foodGross` (customer food total, for analytics), `vendorAmount` (sum of vendorSubtotal of the eligible orders), `commissionAmount`, `adjustmentTotal` (manual +/-), `netPayable` (= vendorAmount + adjustmentTotal), `payoutSnapshot Json` (method and masked destination at creation), `paidAt?`, `paymentReference?` (UTR), `note?`, `createdBy` (`AUTO`|userId), `createdAt`. `SettlementAdjustment`: id, settlementId, `amount` (+/-), `reason`, `createdBy`. `SettlementOrder` is expressed by `Order.settlementId` (an order belongs to at most one settlement; enforced by a conditional update).
`RiderPayout` (ledger only): id, `driverUserId`, `amount`, `method`, `reference?`, `periodStart?`, `periodEnd?`, `note?`, `createdBy`, `createdAt`.

## 3. Pricing engine (backend `utils/validation.ts` calculation, the single source of truth)

- Dish customer price = `roundUp(vendorPrice + commission, step)`, commission = PERCENT: `vendorPrice * value / 100`, FLAT: `value`; resolution order dish override -> restaurant default -> global default. The stored `price` is recomputed and saved whenever a vendorPrice, a commission or the rounding setting changes (admin action "Recalculate all prices" with a preview). The effective commission = `price - vendorPrice` (so rounding goes to Kraveo).
- Order totals: `subtotal` = sum(price x qty) (customer food), `deliveryFee` = baseFee (or 0 above `freeFeeAbove`, plus `smallOrderFee` below `smallOrderBelow`), extra restaurants add `extraRestaurantFee` each (phase 3), discount from coupons (the platform bears coupons; vendor amounts never reduce), `total = subtotal + fee - discount`. `vendorSubtotal` and `commissionTotal` are stored on the order from the item snapshots. The one visible change versus today: the order no longer has the separate Rs 15 "tax and packaging": the all-in fee is Rs 25 (owner decision), so a Rs 100 food order totals Rs 125.
- The server stays authoritative: clients never send prices; the customer app still shows the server's numbers.
- Vendor-facing order views (OrderView for the restaurant viewer): item `price` = vendorUnitPrice, `subtotal` = vendorSubtotal, and NO fee, discount, commission, customer total or coupon fields (`total` = vendorSubtotal, labelled "You earn" by the app). Admin sees everything. Customer and rider views are unchanged.

## 4. Catalog endpoints (backend)

Restaurant (role VENDOR, own restaurant, approved partner): 
- `GET /api/vendors/:id/menu-manage`: its dishes including pending/rejected, each `{ id, name, category, description, imageUrl, isVeg, isAvailable, price: <vendorPrice>, pendingPrice?, status: 'PENDING'|'LIVE'|'REJECTED'|'CHANGE_PENDING', rejectionReason? }` (never the customer price or commission).
- `POST /api/vendors/:id/items` creates a `PENDING` dish with `vendorPrice = price`; response `{ ..., status: 'PENDING' }` (admin-created dishes are APPROVED at once). `PATCH /api/vendors/items/:itemId` `{ isAvailable }` instant; `{ price }` on a PENDING dish edits it, on a LIVE dish sets `pendingVendorPrice` (status CHANGE_PENDING); a REJECTED dish may be resubmitted (back to PENDING). Customers keep seeing the old price until approval.
- Existing customer endpoints (`GET /api/vendors`, `/api/menus/:vendorId`) only return `APPROVED` and not deleted dishes.

Admin (role ADMIN):
- `GET /api/admin/catalog?status=&vendorId=&q=&page=` (dishes with vendorPrice, commission effective, final price, status, vendor name); `GET /api/admin/catalog/pending-count`.
- `POST /api/admin/catalog/:id/approve` `{ commissionType?, commissionValue?, vendorPrice?, applyPending? }` (approve a new dish, or accept a price change request), `POST .../reject` `{ reason }`, `PATCH /api/admin/catalog/:id` (name, description, category, imageUrl, isVeg, isAvailable, vendorPrice, commissionType/Value, with a price preview in the response), `DELETE /api/admin/catalog/:id` (soft delete: `deletedAt`; old orders keep their copies), `POST .../restore`. `POST /api/admin/catalog` creates an APPROVED dish for any restaurant. `POST /api/admin/catalog/preview` `{ vendorPrice, commissionType?, commissionValue?, vendorId }` returns the customer price and effective commission.
- `GET/PUT /api/admin/settings/:group` (`fees`, `commission`, `rounding`, `settlement`) with validation, audit rows (old and new value), and `POST /api/admin/catalog/recalculate` (dry-run flag) after a commission or rounding change. `PATCH /api/admin/vendors/:id/commission` `{ type, value }`.
All admin writes are audit-logged (existing audit log) and rate limited like other admin writes.

## 5. Settlement and finance (phase 2)

- Daily job (inside the existing 60 s maintenance tick, once per IST day after `settlement.time`, guarded by a unique key per vendor and IST date so it never double-creates): for every restaurant, collect orders that are `DELIVERED`, `settlementId IS NULL`, delivered before the cut-off (and older than `holdDays`), create one `Settlement` (`PENDING`) with the totals and `UPDATE ... SET settlementId WHERE settlementId IS NULL` in a transaction. Cancelled/refunded orders are never included. A restaurant with nothing to settle gets nothing. If the restaurant has no payout details the settlement is still created (the admin sees "no payout details").
- Admin endpoints: `GET /api/admin/settlements?status=&vendorId=&from=&to=`, `GET /api/admin/settlements/:id` (with the order list and per-dish lines), `POST /api/admin/settlements/run` (create now, `{ vendorId?, until? }`, same idempotency), `POST .../:id/mark-paid` `{ reference, paidAt?, note? }` (idempotent, refuses a second different reference), `POST .../:id/hold`, `.../release`, `.../adjustments` `{ amount, reason }` (only while not PAID), `POST .../:id/cancel` (frees the orders back to unsettled), `GET .../:id/export.csv` and `GET /api/admin/settlements/export.csv?from&to`.
- Provider hook `PayoutProvider { name, enabled, send(settlement) }` with a `manual` provider (always) and a `razorpayx` stub that reports "not configured" until keys exist; `AUTO_PAYOUT` mode is refused with a clear message while the provider is not enabled.
- Payout details: `GET/PUT /api/partner/payout-account` (restaurant or rider, own account, masked response), `GET/PUT /api/admin/partners/:userId/payout-account` (masked), `POST /api/admin/partners/:userId/payout-account/reveal` (audit-logged, returns the full number once).
- Finance analytics (admin): `GET /api/admin/finance/summary?from&to` (orders, food gross, vendor amount, commission, fees collected, discounts given, refunds, platform revenue = commission + fees - discounts), `/finance/by-restaurant`, `/finance/by-dish` (units, vendor revenue, commission, per dish and per restaurant), `/finance/by-day`, `/finance/riders` (deliveries per rider per day, ledger totals) and `GET/POST /api/admin/rider-payouts`. All dates are Asia/Kolkata days.
- The restaurant sees its own settlements read-only (`GET /api/partner/settlements`, amounts it earned only).

## 6. Admin portal (web/super_admin)

New sections (sidebar): **Catalog** (approval queue with a pending badge; all dishes table with filters; row drawer to edit name/photo URL/category/veg/availability/vendor price/commission with a LIVE price preview; approve / reject with reason / delete / restore; "add dish" for any restaurant), **Settings** (fees with optional lines and the extra-restaurant fee, free-delivery and small-order rules, global commission, rounding, settlement time and mode, "Recalculate prices" with a preview of how many dishes change), **Restaurants** gets a commission field and payout details panel, **Finance** (today/week/month summary, by restaurant, by dish, settlements list with paid/hold actions, CSV export, rider records and payout ledger). Responsive, accessible, same design system, no invented numbers, confirm dialogs for destructive actions, errors shown plainly.

## 7. Apps

- Restaurant Partner app: dishes list shows ONLY its own price and a status chip (Pending approval / Live / Price change pending / Rejected + reason); add dish -> "Sent for approval"; price edit on a live dish -> "Change sent for approval"; order card and takeover show only "You earn Rs X" (no total, fees, discount); a "Payout details" screen (UPI id or bank account, masked after saving) and "My settlements" (read-only list). Veg switch stays.
- Customer app: the bill shows one line "Delivery & service fee" from the server (`deliveryFee`) and no separate tax line when it is 0; nothing else changes (prices are the customer prices from the server).
- Delivery Partner app: "Payout details" (UPI id / bank), already has `upiId`; admin sees the rest.

## 8. Phase 3 design - multi-restaurant order (not built in this change)

One checkout, one payment, one rider, one gate handover; each restaurant keeps its own accept/prepare/ready flow. Model: `OrderGroup` (customer, drop point, notes, group total, one Razorpay payment) with one child `Order` per restaurant (existing state machine and vendor views unchanged); fees: base fee on the first child, `extraRestaurantFee` on each other; coupons only on the group; the rider claims the group (all children together, the "one active order" rule counts the group as one) and picks up child by child; the gate OTP and delivery are per group; any restaurant rejecting or ignoring its child cancels the whole group with a full refund (partial refunds are a later step); ETA = slowest restaurant + extra pickup time. Required work: group payment mapping, per-child captured amount, refund per child amount, pool/claim logic for groups, customer cart/checkout/tracking for several restaurants, rider multi-pickup screen, dashboard group view, tests for every failure mode. Designed here, built after phases 1-2 are deployed and stable.

## 9. Rules for every part

- No regressions: all existing tests keep passing except where a rule legitimately changes (list each); migrations are additive with backfill; old APKs keep working with the new server (the fields they read stay); deploy backend first. Money math in integer paise or rounded to 2 decimals, never raw floats compared for equality. Every admin action audited. Never log or return full bank account numbers. `PAYOUT_ENC_KEY` is a new secret: 32 random bytes base64, only in the server env, never in the repo or chat.
- Idempotency and races: approval, delete, mark-paid and settlement creation must be safe under double clicks and parallel requests (conditional updates, unique keys).
- Tests with real Postgres for the engine, approval flow, visibility (a restaurant can never read a customer price, commission, fee or total; customers never see unapproved or deleted dishes), settlement creation and idempotency, mark-paid, adjustments, CSV, encryption round trip and masking, settings validation, migration backfill on legacy rows.
