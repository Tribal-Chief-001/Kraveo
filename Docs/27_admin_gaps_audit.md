# Docs/27 - Admin portal gaps audit and implementation spec

Status: AUDIT + SPEC ONLY (2026-10-29). Nothing in this document is built. Written from the code at commit `22b55f3` (read-only; no tests, builds or servers were run, so every statement below is "read in the source", not "observed running").

Scope: `backend/` (Node + Prisma), `web/super_admin` (React dashboard). The three Flutter apps were only grepped for how they react to a revoked session.

Owner's asks: (1) remove users, (2) manage a restaurant's owner login, (3) any other important missing dashboard feature.

---------------------------------------------------------------------------------------------------

## 0. Headline findings

1. There is NO admin way to remove or ban a customer. `CustomersPanel.tsx` is read-only (its drawer footer is a single "Close" button, line 226) and the backend has only `GET /admin/customers` and `GET /admin/customers/:id` (`routes/partners.ts:552`, `:600`). `User` has no status column; the only "gone" flag is `deletedAt`, set by the customer's own `DELETE /auth/account` (`routes/api.ts:460-487`), which scrubs the identity.
2. Partner (restaurant owner / rider) "suspend" exists (`POST /admin/partners/:kind/:id/status`, `routes/partners.ts:458-505`) but it has no open-order or active-delivery check, has no "remove", and is only reachable from the Applications tab for restaurants that HAVE an owner (the list filters `userId: { not: null }`, `partners.ts:441,443`). A restaurant without an owner cannot be suspended from the dashboard at all.
3. Owner login management is only half there: create-with-restaurant (`POST /admin/partners`, `api.ts:492`) and reset password (`partners.ts:508`, UI only in Applications). Missing: create an owner for an EXISTING ownerless restaurant (the endpoint accepts `vendorId`, `api.ts:513-516,541-543`, but the dashboard never sends it), change owner phone or name (no endpoint at all; `PUT /auth/profile` lets only STUDENT change a phone, `api.ts:403-404`), disable/enable, detach, and showing who the owner is on the restaurant card.
4. TRAP (not asked, but dangerous): `placeOrder` only requires `approvalStatus === 'APPROVED'` and `isAcceptingOrders` (`services/orderFlow.ts:293-294`); it never checks that the restaurant has an owner. Restaurants created by `POST /api/vendors` (`api.ts:645`) have `userId = null`, `approvalStatus = APPROVED` (schema default), `isAcceptingOrders = true`. Customers can order from them; the NEW_ORDER push goes to nobody (`services/push/events.ts:140` returns `[]` without `vendor.userId`); the order sits until the 10-minute accept window auto-cancels and refunds it (`services/orderMaintenance.ts:62-64`, `config/orderFlow.ts:15`). Detaching or disabling an owner (B4) would recreate this on purpose, so B4 must include the guard.
5. The audit log has no actor. `AdminAuditLog` is `{action, targetType, targetId, summary, createdAt}` (`schema.prisma:409-419`) and `writeAudit(action, targetType, targetId, summary)` takes no actor (`services/audit.ts:8`). This is not only a missing column: the admin login is ONE shared passcode (`ADMIN_PASSCODE` env, `api.ts:306-322`) that signs in the FIRST `role = ADMIN` user (`api.ts:330-332`), so every admin is the same user id and "who did it" is unanswerable until individual admin accounts exist (B6-1).
6. An audit-log read endpoint exists (`GET /admin/audit-log`, `partners.ts:526-534`) but returns only the latest <= 200 rows with no filter or paging, and NOTHING in the dashboard calls it (grep of `web/super_admin/src` for "audit-log": zero hits outside copy text). So B5 is mostly a UI plus a filter/paging upgrade.
7. Removed-user accounting holes already in the code that B1/B2/B3 must fix, otherwise "keep history for accounting" is false: `partnerUser()` (`services/payoutAccount.ts:116-117`) and `createRiderPayout` (`services/finance.ts:237-238`) both 404 on a `deletedAt` user, so a rider/owner removed by the new feature could no longer be paid their last settlement or have their payout details looked up.
8. Re-sign-up: `/auth/google` looks accounts up with `deletedAt: null` (`api.ts:201,205`). If an admin removal keeps `googleSub`/`email` (needed to block the person), the lookups miss the removed row, `user.create` hits the unique index on `googleSub`/`email`, and the person gets a generic 500 (`api.ts:233-236`) instead of "account removed". The login code needs an explicit "found but blocked" branch (B1).
9. Order search is client-side over the loaded page only (`OrdersTable.tsx:101-104`); the server `GET /orders` filters by ids/status/payment status but not by phone, text or date (`routes/orders.ts:236-243`). There is no CSV export for orders or customers (only settlements, `routes/finance.ts:146`).
10. Things the brief said to check that ALREADY exist (do not rebuild): retry a FAILED refund (`orders.ts:478`, button `OrderDrawer.tsx:122-164`, Needs-attention tab), needs-attention incl. NO_RIDER / STUCK_UNACCEPTED / DELIVERY_OVERDUE (`orders.ts:560-645`), admin cancel with refund (`orders.ts:455`), reassign / unassign rider (`orders.ts:440`), OTP unlock (`orders.ts:468`), payment reconcile report (`orders.ts:496`, no dashboard button found), auto-cancel of unpaid (15 min) and unaccepted (10 min) orders (env-only: `PAYMENT_WINDOW_MIN`, `VENDOR_ACCEPT_WINDOW_MIN`, `config/orderFlow.ts:13,15`), per-restaurant ETA text (`vendorProfile.ts:17,49`), a Razorpay-side manual refund flows back via the `refund.processed` webhook (`orders.ts:746+`, `refundService.ts:254-280`).

---------------------------------------------------------------------------------------------------

## A. What exists today, per entity

Legend: OK = exists and wired in the dashboard; API = backend only, no dashboard control; MISSING = nothing. Evidence is `file:line`.

| Entity | Admin actions that exist | Missing |
|---|---|---|
| **Customers** | List with search, cursor paging, orders count, total spent (`partners.ts:552-598`); detail with last 30 orders, payments, stats (`partners.ts:600-652`); drawer in `CustomersPanel.tsx` (read-only). | Suspend / restore / remove (B1). Edit phone/hostel. Notes. Adjust coins (support goodwill). Block list. CSV export. Orders-by-customer deep link (server supports `?customerId=`, `orders.ts:240`, no UI). Show account state. |
| **Restaurants** | List incl. ownerless (`GET /vendors`, admin sees all, `api.ts:619-628`); create with owner (`POST /admin/partners`, UI `AddPartnerDrawer`); create ownerless (`POST /vendors`, `api.ts:645`, client fn `createVendor` `services/api.ts:449` has NO caller); edit profile (name, categories, address, banner, FSSAI, ETA) `api.ts:708`, `EditRestaurantDrawer`; set map pin `api.ts:692`; commission `catalog.ts:190`; open/close toggle `api.ts:718/738`, Switch in `VendorManager.tsx:148`; approve / reject / suspend (owner-bearing only) `partners.ts:458`, `ApplicationsPanel.tsx:207-223`; payout account view/verify/edit/reveal `finance.ts:75-114`. | Suspend or remove ownerless restaurant; remove at all; open-orders guard on suspend; owner info on the card; opening hours; per-restaurant fees; "no owner" warning; delete/hide history view (B3, B4, B6). |
| **Restaurant owners (User role VENDOR)** | Created together with restaurant; reset password (`partners.ts:508`, UI `ApplicationsPanel.tsx:223,292-346`, only for rows with `userId`); suspend/reactivate through the restaurant status (kills sessions: `partners.ts:495-498`, push tokens: `:489`, sockets `:492,497`). | Create owner for existing restaurant; change phone/name; generated password; disable owner without suspending restaurant; detach / replace owner; remove owner user; move payout account to a new owner (B4, B3). |
| **Riders** | List (`GET /drivers`, `api.ts:83`), read-only `DriverManager.tsx` (no actions except "Add rider"); create (`POST /admin/partners`); approve / reject / suspend (Applications tab); reset password; reassign orders (`orders.ts:440`); payout account (`finance.ts`), rider payout ledger (`finance.ts:325-340`, `RidersPanel`). | Remove; active-delivery guard on suspend (suspend sets OFFLINE and revokes tokens `partners.ts:477-498` but leaves the delivery assigned; the order just turns into `RIDER_NOT_APPROVED` in Needs attention, `orders.ts:620`); change phone; duty override; payouts to a removed rider are refused (`finance.ts:238`) (B2). |
| **Orders** | List with server filters vendor/driver/customer/status/payment (`orders.ts:226-278`, 100 per page, cursor); detail drawer; advance status as ADMIN (`ADMIN_TARGETS`, `orderFlow.ts:51`); cancel with reason + automatic refund (`orders.ts:455`); reassign / unassign rider; reset OTP lock; retry refund; needs-attention list; combined-order group view (`order-groups/:id`). | Server-side search by phone / name / payment id / order id; date range; CSV export; "refund by hand done" acknowledge note; bulk actions; force-resolve of PAYMENT_MISMATCH (hint tells the admin to use the Razorpay dashboard and cancel by hand, `orders.ts:544`) (B6). |
| **Dishes** | Full catalog tab: approve / reject / edit / soft delete / restore / bulk / menu import / commission recalculation (`catalog.ts:51-188`). | Complete. |
| **Payments / refunds** | Needs-attention shows mismatch, duplicate, failed, pending refunds; retry-refund; reconcile report (API only, `orders.ts:496`); webhook handles `refund.processed/failed`. | A refunds list (all refunds, any status); reconcile report button in the UI; acknowledge/dismiss with note. |
| **Settlements** | Full: list, detail, hold / release, adjustments, mark paid with reference, cancel, run now, CSV (`finance.ts:133-251`); finance analytics (`finance.ts:276-322`). | Payout to removed owner/rider blocked (see 0.7). |
| **Banners** | Full CRUD, reorder, duplicate, schedule, counters (`banners.ts`). | Complete. |
| **Categories** | Full CRUD, reorder, merge (`categories.ts`). | Complete. |
| **Settings** | 4 groups: fees, commission, rounding, settlement (`pricing.ts:70`, `catalog.ts:201-235`, `SettingsPanel.tsx`). | Auto-cancel windows (env only), SLA alert minutes (env only), support email / app version / maintenance mode, coupons. |
| **Coupons** | None. KRAVEO20 and others are a constant map in code (`utils/validation.ts:35-41`) plus a coins redemption (`api.ts:1076`). | Admin-managed coupons with limits and usage (B6-4). |
| **Audit** | Write side everywhere (62 `writeAudit` call sites, ~50 action codes). `GET /admin/audit-log` last <= 200 (`partners.ts:526-534`). | Actor, filters, paging, search, UI, CSV (B5). |
| **Admin accounts** | One shared passcode, constant-time compare, 5 fails / 15 min per IP (`api.ts:57,298-366`); 30-day JWT kept in `localStorage` (`services/api.ts:101-122`). | Individual admins, roles, 2FA, "log out everywhere", per-admin audit (B6-1). |
| **Realtime / health** | Socket room `admins` gets order and rider events (`realtime.ts:13,107`); sidebar badges for attention, applications, catalog, finance. `/health` returns a constant (`index.ts:94-100`). | System health page; browser/sound notification; DB, Razorpay webhook, FCM and maintenance-job status (B6). |

---------------------------------------------------------------------------------------------------

## B. Specs

### B0. Shared foundations (build FIRST, one agent, one migration)

Everything in B1..B5 shares these. They are additive; no existing column changes meaning.

**Migration `20261014_admin_account_controls`** (name suggestion; migrations dir ends at `20261013_home_banners`):

```prisma
enum AccountStatus { ACTIVE SUSPENDED REMOVED }

model User {
  // ...existing...
  // Admin-controlled state (Docs/27). REMOVED also sets deletedAt, so every existing "deletedAt" guard
  // (auth.ts:55, orderFlow.ts:290/306, push events, payoutAccount) applies without change.
  // deletedAt set + accountStatus ACTIVE = the customer deleted their own account (anonymised, NOT restorable).
  accountStatus   AccountStatus @default(ACTIVE)
  statusReason    String?       // shown to the person on SUSPENDED, max 200
  statusChangedAt DateTime?
  statusChangedBy String?       // admin user id
  @@index([accountStatus])
}

model Vendor {
  // ...existing...
  // Soft remove (Docs/27 B3). A removed restaurant is ALSO approvalStatus SUSPENDED, so every existing
  // "approvalStatus !== APPROVED" guard hides/blocks it: canSeeVendor (api.ts:77), placeOrder (orderFlow.ts:293),
  // push recipients (events.ts:140), category counts (categories.ts:161).
  removedAt     DateTime?
  removedReason String?
  @@index([removedAt])
}

model AdminAuditLog {
  // ...existing...
  actorId   String?   // admin user id; null = system (maintenance job, webhook)
  actorName String?   // admin display name at the time
  ip        String?
  meta      Json?     // optional {before, after}; never secrets, never passwords
  @@index([action, createdAt])
  @@index([actorId, createdAt])
}
```

Backfill: none needed (all defaults). Down-migration: columns are nullable/defaulted, drop is safe.

**Actor without touching 62 call sites:** add `services/actorContext.ts` (Node `AsyncLocalStorage<{id,name,ip}>`), populated in `requireAuth` after the token check (`middleware/auth.ts:129`) when `role === ADMIN`; `writeAudit` (`services/audit.ts:8`) reads it and fills `actorId/actorName/ip`. Rows written by the maintenance job / webhooks have no store, so `actorId = null` and the UI prints "system". An optional 5th argument `meta` is added to `writeAudit` for the new actions only. Test: a unit test that `writeAudit` outside a request stores `actorId null`, and inside `runWithActor` stores the id.

**Login guard helper** `services/accountGuard.ts` exporting `blockedLogin(user): null | {status, code, message}`:
- `accountStatus SUSPENDED` -> `403 ACCOUNT_SUSPENDED`, message `Your Kraveo account is paused: <reason>. Contact kraveo.contact@gmail.com.`
- `accountStatus REMOVED` -> `403 ACCOUNT_REMOVED`, message `This Kraveo account was removed. Contact kraveo.contact@gmail.com if you think this is a mistake.`
Used in `/auth/google` (`api.ts:181`) and `/auth/partner-login` (`api.ts:240`) AFTER identity is proven (partner: after the password verifies, so unknown numbers still look identical to wrong passwords). In `/auth/google` the lookup must stop filtering `deletedAt: null` for admin-removed rows: query `findFirst({ where: { OR: [{ googleSub }, { email }] } })`, then if the row is blocked return the guard answer BEFORE the "create" branch; a self-deleted row (`deletedAt` set, `accountStatus ACTIVE`, identity already scrubbed) never matches because its `googleSub/email` are null, so that path keeps today's behaviour (a fresh account).

**`partnerIsSuspended` (`middleware/auth.ts:81-89`)** also returns true when `User.accountStatus = SUSPENDED`, so the existing apps keep showing "account paused" (driver_app already handles `TOKEN_REVOKED` + `ACCOUNT_SUSPENDED`; customer_app and vendor_app do not mention the codes, they treat any 401 as "sign in again", `customer_api_service.dart:58-61`).

**Session kill helper** `revokeUserEverywhere(userId, reason)` in a new `services/accountControl.ts`: `bumpTokenVersion` (`auth.ts:65`), `disableUserTokens(userId, reason)` (`push/deviceTokens.ts:40`), `user.fcmToken = null`, and socket disconnect. The disconnect helper today is private to `partners.ts:54-60`; export a `disconnectUser(userId)` from `realtime.ts` (next to `dropFromPartnerRooms`, `:181`) and make `partners.ts` use it. Note the app runs one process (single PM2 instance, `Docs/council_audit/infra.md:145`): socket disconnect is local-only; with N instances the auth cache (15 s, `auth.ts:40-43`) is the backstop, document it.

**Admin mutation rate limits:** add to the rules table in `middleware/rateLimit.ts` (~lines 111-137, same shape as `ADMIN_BANNER_WRITE`): `ADMIN_ACCOUNT_WRITE` scope `user`, max 30 per 10 min, for `POST /admin/(customers|drivers|vendors)/:id/(suspend|restore|remove|owner...)`. Passwords shown once are only returned by POST endpoints under this limiter.

**Common error shape** (as everywhere): `{ success:false, code, message, field? }`. Common codes: `400 BAD_REQUEST` (`field`), `401 TOKEN_REVOKED`, `403 Forbidden` (not admin), `404 NOT_FOUND`, `409 <specific>`, `429 RATE_LIMITED`.

**Idempotency rule for all state changes below:** repeating the same transition answers `200 { success:true, changed:false }` and writes NO second audit row (like `cancelInTx` `alreadyCancelled`, `orderFlow.ts:648`). Transitions out of order answer `409 INVALID_STATE`.

**Typed-name confirmation** for every REMOVE: body must contain `confirmName` equal (case-insensitive, trimmed) to the target's current name; mismatch -> `400 { field:'confirmName', code:'CONFIRM_MISMATCH' }`. The server enforces it, not only the dialog.

---

### B1. Customer: suspend / restore / remove

#### Rules
- Suspend = reversible block with a visible reason. Remove = soft delete (row kept for `Order.customer` FK, which has no `onDelete`, i.e. RESTRICT, `schema.prisma:293`; `ReviewRecord.customer` is `Cascade`, `:436`, so a hard delete would also erase reviews; hence NEVER hard-delete).
- Both revoke every session and push token and refuse login. Remove keeps `email`+`googleSub` as the block key unless the admin chooses `scrub`, in which case only the harmless profile is wiped (see below).
- Admin may only act on `role = STUDENT` here. An id of another role -> `404` (never reveal it exists).
- An admin cannot act on a self-deleted account (`deletedAt` set, status ACTIVE): `409 NOT_RESTORABLE` for restore; suspend/remove -> `409 ALREADY_DELETED`.

#### Endpoints (new file `routes/adminUsers.ts`, mounted in `api.ts` next to the other routers; all `requireAuth, requireRole('ADMIN'), validParams('id')`)

| Method + path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/customers` (extend) | query `status=ACTIVE\|SUSPENDED\|REMOVED\|ALL` (default `ACTIVE`+`SUSPENDED`; `REMOVED` also lists self-deleted when `includeDeleted=1`, as today `partners.ts:560`) | each row gains `accountStatus`, `statusReason`, `statusChangedAt`, `openOrders` (count of non-terminal orders) | - |
| `GET /api/admin/customers/:id` (extend) | - | adds `accountStatus`, `statusReason`, `statusChangedAt`, `statusChangedBy`, `openOrders: [{id,status,paymentStatus,totalAmount}]`, `refundsOwed: [{orderId, refundStatus, amount}]` | 404 |
| `POST /api/admin/customers/:id/suspend` | `{ reason: string 3-200, openOrders?: 'REFUSE'(default)\|'CANCEL' }` | `{ success, changed, data: customerDetail, cancelled?: [{orderId, refund: 'NONE'\|'STARTED'}], failed?: [{orderId, code, message}] }` | 400 reason; 404; 409 `HAS_OPEN_ORDERS` (`openOrders:[...]`); 409 `ORDER_IN_DELIVERY` (an order is PICKED_UP/ARRIVED_AT_GATE: never cancelled, ask for rider return / wait); 409 `ALREADY_DELETED` |
| `POST /api/admin/customers/:id/restore` | `{ note?: string<=200 }` | `{ success, changed, data }` | 404; 409 `NOT_RESTORABLE` (self-deleted); 409 `INVALID_STATE` (already ACTIVE -> actually `changed:false`) |
| `POST /api/admin/customers/:id/remove` | `{ reason: 3-200, confirmName, scrub?: boolean=false, openOrders?: 'REFUSE'\|'CANCEL' }` | same as suspend | as suspend + 400 `CONFIRM_MISMATCH`; 409 `REFUND_NOT_SETTLED` when `scrub:true` and any order has `refundStatus` PENDING/FAILED |

#### Data effects
Order of operations in the endpoint (this order is what makes it race-free):
1. Pre-check (read-only): open orders = `status NOT IN (DELIVERED, CANCELLED)`; if `ORDER_IN_DELIVERY` or (open and `openOrders = REFUSE`) -> 409, nothing changed.
2. One transaction: `SELECT ... FROM "User" WHERE id = $1 FOR UPDATE` (same lock as checkout `orderFlow.ts:306`, `orderGroups.ts:194`, and delete-account `api.ts:465`), re-count open orders under the lock, then write `accountStatus`, `statusReason`, `statusChangedAt/By`, and for REMOVED `deletedAt = now`. After this commit no new checkout can start (`ACCOUNT_UNAVAILABLE` for removed; for suspended, `placeOrder` must also refuse: add `accountStatus === 'ACTIVE'` to the customer select at `orderFlow.ts:289` and `orderGroups.ts:180` and to the locked re-check, returning `403 ACCOUNT_SUSPENDED`).
3. `revokeUserEverywhere(userId, 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REMOVED')` (tokenVersion + cache + push tokens + `fcmToken` + sockets).
4. If `openOrders = CANCEL`: for each open order call `cancelOrder(id, actor, 'ADMIN', 'Account suspended by Kraveo')` (`orderFlow.ts:737`); paid ones start the automatic refund (the refund goes to the card, it does not need the account). Combined orders cancel as a whole group (Docs/22), so report `cancelledOrders` honestly. A failure is returned in `failed[]` and the account stays blocked (safe direction); the admin repeats the call (idempotent, already-cancelled orders are skipped).
5. Audit: `CUSTOMER_SUSPENDED` / `CUSTOMER_RESTORED` / `CUSTOMER_REMOVED` (`targetType 'USER'`), summary `Suspended customer <name> (<id8>): <reason>; <n> open order(s) cancelled`, `meta {before,after}`. Never put the phone or e-mail in the summary (use name + first 8 chars of id).

`scrub:true` (REMOVED only, irreversible for the profile, still blocks sign-in): sets `name = 'Removed user'`, `phone = null` (frees the number), `avatarId`, `isStudent`, `hostelBlock`, `upiId`, `fcmToken` to null, `kraveoCoins = 0` (coins are forfeited, say so in the dialog). Keeps `email` + `googleSub` ONLY as the block key (that is the stated trade-off: if these were wiped the same Google account could just sign up again, which is how the customer-initiated delete behaves today, `api.ts:471`). Orders keep `dropoffHostel`/`dropoffNotes` (snapshot, accounting) and payments untouched. `restore` after a scrub gives an empty profile (`needsProfile` true, `api.ts:167-170`), the customer re-enters it.

What must be impossible: acting on an ADMIN/VENDOR/DRIVER id through these routes; hard delete; cancelling a delivered order or one in delivery; removing without the typed name; two admins racing the same customer into two different end states (the row lock serialises them, second sees `changed:false`/`INVALID_STATE`); restoring a self-deleted account; any response containing `passwordHash`/`googleSub`/`tokenVersion`.

Unpaid payments in flight: a customer mid-Razorpay when blocked can still pay; `markOrderPaid` on a CANCELLED order is already handled by the auto-refund path (`PAID_AFTER_CANCEL`, `orders.ts:612-614`, maintenance `orderMaintenance.ts:104-123`), so no new code, but the test below must prove it.

#### UI (CustomersPanel.tsx + drawer)
- Filter chips next to the search: `Active`, `Suspended`, `Removed`, `All`. Row badge: amber `Suspended`, red `Removed`, grey `Deleted by user`.
- Drawer footer (replaces the lone Close): `Suspend` (secondary), `Remove` (danger), `Close`. For SUSPENDED the drawer shows a banner with the reason + `Restore`; for REMOVED by admin `Restore`; for self-deleted nothing (text: `The customer deleted this account themselves. It cannot be restored.`).
- Suspend dialog, title `Suspend <name>?`, body: `They will be signed out on every device and cannot sign in or order until you restore them. Their past orders and payments stay.` Field `Reason (shown to the customer, 3-200 characters)` with quick chips `Abuse of coupons`, `Fake orders`, `Harassing riders`. If `openOrders > 0` an extra radio: `They have N order(s) in progress.` ( ) `Keep this window open and deal with the orders first` (default; button disabled) ( ) `Cancel the orders that are not on the way yet and refund them`. Button `Suspend`.
- Remove dialog, title `Remove <name>?`, body: `This blocks the account for good: they cannot sign in again with the same Google account unless you restore them. Orders, payments and settlements stay for the books.` Checkbox `Also erase their name, phone, hostel and coins (cannot be undone)`. Field `Type the customer's name to confirm`. Button `Remove customer` (danger, disabled until the name matches and the reason is >= 3 chars).
- Error states: 409 `HAS_OPEN_ORDERS` renders the list of orders as links that open the OrderDrawer; 409 `ORDER_IN_DELIVERY` text `An order is with a rider right now (<id8>). Wait until it is delivered, or have the rider return it, then try again.`; generic failure keeps the dialog open with the server message; `failed[]` shows `Account blocked, but N order(s) could not be cancelled: ...`.
- Empty state for `Suspended`/`Removed` filters: `Nobody is suspended.` / `Nobody has been removed.`

#### Tests
Backend (`jest --runInBand`, one file `adminCustomers.test.ts`, use the existing test DB helpers): suspend revokes an old token (401 `TOKEN_REVOKED`); suspended customer: `/auth/google` -> 403 `ACCOUNT_SUSPENDED` with reason; `POST /orders` -> 403; restore -> old token still dead, new login works; remove -> `deletedAt` set, same Google identity -> 403 `ACCOUNT_REMOVED` and NOT a 500 (regression for 0.8), `identity` row count unchanged (no second `User`); remove with open order and `REFUSE` -> 409, nothing changed; with `CANCEL` and a PAID order -> order CANCELLED, `refundStatus PENDING`; with a PICKED_UP order -> 409 `ORDER_IN_DELIVERY` in both modes; `scrub` frees the phone (another user can take it), keeps `email`; `scrub` with a FAILED refund -> 409; repeat call -> `changed:false`, one audit row; non-ADMIN token -> 403; a rider id -> 404; concurrent `remove` + checkout (two promises) never leaves a new open order on a removed user; device tokens `disabledAt` set; audit rows have `actorId`. Dashboard (vitest, like `CustomersPanel` tests): dialog gating of the confirm button, chips filter request params, error rendering of 409s.

---

### B2. Rider: suspend / restore / remove

#### Rules
- Suspend already exists (`partners.ts:458-505`); this spec adds the guard and the remove. Reactivate already exists (APPROVED).
- A rider with a delivery in hand must not vanish: `ORDER` rows with `driverId = rider.userId` and `status IN (ACCEPTED, PREPARING, READY_FOR_PICKUP, PICKED_UP, ARRIVED_AT_GATE)`.
- Payout ledger (`RiderPayout`, no FK, `schema.prisma:585-600`) and payout account are KEPT and must stay usable by admins.

#### Endpoints
| Method + path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/admin/partners/DRIVER/:id/status` (extend, same route) | adds `handover?: 'REFUSE'(default)\|'RELEASE'` when `status:'SUSPENDED'` | as today | 409 `HAS_ACTIVE_DELIVERY` (`orders:[{id,status}]`); 409 `FOOD_WITH_RIDER` (an order is PICKED_UP / ARRIVED_AT_GATE: only fixable by `PATCH /orders/:id/reassign` to another rider or by cancelling the order, `orderFlow.ts:872+`) |
| `POST /api/admin/drivers/:id/remove` (`:id` = DriverPartner id) | `{ reason, confirmName, handover?: 'REFUSE'\|'RELEASE' }` | `{ success, changed, data: applicationRow }` | 400 `CONFIRM_MISMATCH`; 404; 409 as above; 409 `ALREADY_REMOVED` is `changed:false` |
| `POST /api/admin/drivers/:id/restore` | `{ note? }` | `{ success, changed, data }` | 409 `NOT_RESTORABLE` if the user was scrubbed/self-deleted |

`RELEASE` = for each order not yet picked up call `reassignOrder(orderId, null)` (existing code, handles the group, audit `ORDER_REASSIGNED`, pool broadcast and push `NEW_DELIVERY`, `orderFlow.ts:872-912`). Orders already picked up are never released.

#### Data effects
- Remove: `DriverPartner.approvalStatus = SUSPENDED` (keeps every existing guard), `dutyStatus = OFFLINE`, `User.accountStatus = REMOVED`, `User.deletedAt = now`, `revokeUserEverywhere`, `dropFromPartnerRooms(userId, ['drivers'])`, delete the `DriverLocation` row (stop showing a removed person on the map; location is personal data and has no accounting value), `RiderPayout` rows and `PayoutAccount` untouched, `ReviewRecord.driver` untouched.
- `partnerUser()` (`payoutAccount.ts:116-117`) and `createRiderPayout` (`finance.ts:237-238`) must accept a REMOVED partner for ADMIN actions (view masked details, verify, reveal-with-audit, record a final payout) and keep refusing a self-deleted/scrubbed one. Without this the owner cannot pay what is owed after removal. The dialog warns: `Record any payout you owe <name> first (Finance > Riders).`
- Reports: `GET /admin/finance/riders` and the CSV must still list a removed rider that has deliveries in the range (test).
- Phone: stays on the removed `User` (unique), so the number cannot be re-registered until restore; the dialog says so.

What must be impossible: removing a rider whose food is picked up; a removed rider appearing in the pool/idle-rider push (`events.ts:117-131` already filters `deletedAt: null`); the rider receiving any socket event after removal.

#### UI
`DriverManager.tsx` is read-only today. Add to the rider drawer footer: `Suspend` / `Reactivate` (reuse `ApplicationsPanel` reason dialog component, extract it to `components/ReasonDialog.tsx`), `Remove`, `Reset password` (reuse the dialog `ApplicationsPanel.tsx:292-346`). Active delivery text: `<name> is carrying order <id8> (Picked up). Reassign it to another rider first.` with a button that opens the OrderDrawer. Remove dialog wording: `Remove <name> as a rider? They are signed out and cannot work again unless you restore them. Past deliveries and payout records stay. Their phone number stays reserved.` Type-the-name field, button `Remove rider`.

#### Tests
Suspend rider with ACCEPTED order, `REFUSE` -> 409 and rider unchanged; `RELEASE` -> order `driverId null`, in pool, `order_available` emitted; with PICKED_UP -> 409 in both; remove sets OFFLINE, deletes `DriverLocation`, token dead, `/auth/partner-login` correct password -> 403 `ACCOUNT_REMOVED`, wrong password -> same 401 as unknown phone; `createRiderPayout` for removed rider works for ADMIN; finance riders report includes them; double remove idempotent; rider cannot call `/admin/...` (403).

---

### B3. Restaurant (and its owner user) : hide / remove

#### Rules
- Three different things, kept separate: (a) **Suspend restaurant** (exists: `approvalStatus SUSPENDED`, reversible, owner login also dies `partners.ts:495-498`), (b) **Disable owner login** only (B4), (c) **Remove restaurant** (new: soft delete).
- Remove = `Vendor.removedAt` set + `approvalStatus SUSPENDED` + `isAcceptingOrders false`. Dishes are NOT touched (kept, but unreachable because the restaurant is hidden: `canSeeVendor` `api.ts:77-78`, `GET /menus/:id` `api.ts:794-796`, `placeOrder` `orderFlow.ts:293`; category counts exclude it, `categories.ts:161`). Settlements and `Order`/`OrderItem` history kept (`Order.vendor` has no `onDelete`, i.e. RESTRICT, `schema.prisma:294`; `Settlement.vendor` too, `:557`), `VendorCategory` links kept.
- Removing a restaurant does NOT remove its owner user (owner might be re-attached elsewhere). The dialog offers a checkbox `Also disable the owner login` (default ON) which does B4 disable in the same call.

#### Endpoints
| Method + path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/admin/vendors/:id/suspend` (NEW, id-based, works for ownerless restaurants; the old `/admin/partners/VENDOR/:id/status` keeps working and gets the same guard) | `{ reason, openOrders?: 'REFUSE'(default)\|'CANCEL' }` | `{ success, changed, data: vendor, cancelled?, failed? }` | 409 `HAS_OPEN_ORDERS` (`orders:[...]`), 409 `ORDER_IN_DELIVERY` (any order PICKED_UP/ARRIVED_AT_GATE is never cancelled: food already left, let it finish) |
| `POST /api/admin/vendors/:id/reinstate` | `{}` | `{ success, changed, data }` | 409 `VENDOR_REMOVED` unless `removedAt` cleared first (use `/restore`) |
| `POST /api/admin/vendors/:id/remove` | `{ reason, confirmName, openOrders?, disableOwner?: boolean=true }` | as above | 400 `CONFIRM_MISMATCH`; 409 as above; 409 `UNSETTLED_ORDERS` is NOT an error (settlements keep running, see below) |
| `POST /api/admin/vendors/:id/restore` | `{}` | `{ success, changed, data }` (comes back SUSPENDED, `isAcceptingOrders false`; the admin then reinstates and opens it on purpose) | 404 |
| `GET /api/vendors` (admin view) | `?includeRemoved=1` | removed hidden by default | - |

Open orders for a restaurant: all non-terminal `Order` rows with `vendorId`. Status `PLACED` (not accepted) and `ACCEPTED/PREPARING/READY_FOR_PICKUP` are cancellable (admin cancel, refund automatic); `PICKED_UP/ARRIVED_AT_GATE` are never cancelled. Cancel one by one through `cancelOrder(..., 'ADMIN', 'Restaurant is no longer available')`; a combined order cancels as a whole group (Docs/22) and the response must say so (`cancelledOrders`), because it also cancels the OTHER restaurants' parts.

#### Data effects
- Same lock discipline as B1: `SELECT ... FROM "Vendor" WHERE id FOR UPDATE`, re-check open orders, then write. No order can be placed after the commit (`orderFlow.ts:293`).
- Sockets: `dropFromPartnerRooms(owner, ['vendor_<id>'])` (already done in the status route `partners.ts:492`); owner push tokens disabled when owner disabled.
- Settlements: the daily job and manual run must keep covering delivered orders of a removed restaurant (test: `runDailySettlementJob` includes a vendor with `removedAt` and `approvalStatus SUSPENDED`; if it filters by approval, that filter is a bug to fix in the same PR). Pending settlements stay PENDING/ON_HOLD for the admin to pay or cancel; the remove dialog shows the count and amount of PENDING + ON_HOLD settlements: `This restaurant still has N unpaid settlement(s) worth Rs X. They stay in Finance.`
- Payout account belongs to the OWNER user (`PayoutAccount.userId`, `schema.prisma:507-525`); `VendorPayout` reads it through `vendor.userId` (`VendorManager.tsx:42-51`). Detaching the owner makes the restaurant's payout details unreachable from its card; see B4 (`movePayoutAccount`).
- Audit: `VENDOR_SUSPENDED` (exists as `PARTNER_SUSPENDED`; keep that code), `VENDOR_REMOVED`, `VENDOR_RESTORED`, with counts of cancelled orders.
- OWNER user separately: removing the OWNER USER (not the restaurant) is `POST /api/admin/vendors/:id/owner/remove` in B4 (it detaches, then REMOVES the user: `accountStatus REMOVED`, `deletedAt`, login dead, payout account kept for settlements).

What must be impossible: removing a restaurant with an order in delivery; a removed restaurant visible to a customer through `/vendors`, `/vendors/:id`, `/menus/:id`, an old cart (`VENDOR_UNAVAILABLE`), or a category count; hard delete of a `Vendor` row that has orders.

#### UI
Restaurant card (`VendorManager.tsx:144-151` area): a `...` menu or a "Danger zone" accordion with `Suspend restaurant`, `Remove restaurant`; status pill already exists (`ApprovalPill`); new grey `Removed` pill and a filter chip `Removed` next to the existing filters (`VendorManager.tsx:91-96`). Suspend wording: `Hide <name> from customers and close it for new orders? <n> order(s) are in progress.` radio like B1. Remove wording: `Remove <name>? Customers will no longer see it. Its dishes, orders and unpaid settlements stay. This does not delete the owner's login unless you tick the box below.` + `Type the restaurant name to confirm` + button `Remove restaurant`. Ownerless restaurants get the same controls (this is the fix for 0.2).

#### Tests
Suspend ownerless restaurant; `REFUSE` with a PLACED order -> 409; `CANCEL` with a combined order -> both children cancelled and message says so; PICKED_UP -> 409; removed vendor absent from `GET /vendors` for a student token, present with `includeRemoved` for admin, `placeOrder` -> 400 `VENDOR_UNAVAILABLE`; menus empty for customers; restore -> still hidden until reinstate; settlement job still produces the batch for a removed vendor with delivered orders; owner login dead when `disableOwner`; payout-account admin read still works; second `remove` idempotent; audit rows.

---

### B4. Owner login management for a restaurant

#### Current behaviour (evidence)
Owner = `User(role VENDOR)` linked by `Vendor.userId` (nullable, `onDelete: SetNull`, `schema.prisma:93,120`). The partner-login picks `vendors.find(APPROVED) ?? vendors[0] ?? null` (`api.ts:275`), so the vendor app supports ONE restaurant per login. The admin create route already supports attaching: `vendorId` of an ownerless restaurant (`api.ts:513-516`, link in the transaction `:541-543`, `409 That restaurant already has an owner account`). Password hashing/limits: `services/password.ts` (min 8, max 128, scrypt). Failure limiter keyed by last-10 digits (`loginLimiter.ts`). Phone is canonical `+91 xxxxxxxxxx` and unique on `User.phone` (`utils/phone.ts`, `schema.prisma:59`).

#### Endpoints (new file `routes/adminOwners.ts`; all admin-only, under the `ADMIN_ACCOUNT_WRITE` limiter; passwords only ever in POST responses with `Cache-Control: no-store`)

| Method + path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/vendors/:id/owner` | - | `{ success, owner: null \| { userId, name, phone, accountStatus, statusReason, createdAt, restaurants: n } }` | 404 |
| `POST /api/admin/vendors/:id/owner` (create or attach) | `{ name, phone, password? }` OR `{ existingUserId }` | 201 `{ success, owner, generatedPassword? }`: `generatedPassword` is present only when the server generated it (body had no `password`), 16 chars from `[A-HJ-NP-Za-km-z2-9]` via `crypto.randomInt`, shown ONCE | 400 `name` / `phone` / `password` (use existing validators `NAME_RE`, `canonicalPhone`, `passwordProblem`); 409 `OWNER_EXISTS`; 409 `PHONE_TAKEN` (any `User` whose last 10 digits match, removed ones included, mirrors `api.ts:505`); 409 `VENDOR_REMOVED`; for `existingUserId`: 404 / 409 `NOT_A_VENDOR_USER` / 409 `OWNER_HAS_RESTAURANT` (one restaurant per login) |
| `PATCH /api/admin/vendors/:id/owner` | `{ name?, phone? }` (at least one) | `{ success, changed, owner }` | 400; 404 `NO_OWNER`; 409 `PHONE_TAKEN` (also map Prisma `P2002`) |
| `POST /api/admin/vendors/:id/owner/reset-password` | `{ password? }` (empty = generate) | `{ success, generatedPassword? }` | 404 `NO_OWNER`; 409 `OWNER_REMOVED`; extends the existing `partners.ts:508` handler (which keeps working with the `userId` path and typed `password`); the new route just resolves the user from the vendor and adds generation |
| `POST /api/admin/vendors/:id/owner/disable` | `{ reason, closeRestaurant?: boolean=true }` | `{ success, changed, owner, warning? }` | 404 `NO_OWNER`; 409 `INVALID_STATE` |
| `POST /api/admin/vendors/:id/owner/enable` | `{}` | `{ success, changed, owner }` | 404; 409 `OWNER_REMOVED` |
| `POST /api/admin/vendors/:id/owner/detach` | `{ reason, openOrders?: 'REFUSE'(default)\|'CANCEL', closeRestaurant?: boolean=true, movePayoutAccount?: false }` | `{ success, owner: null, detachedUser: {id,name} }` | 404 `NO_OWNER`; 409 `HAS_OPEN_ORDERS`; 409 `ORDER_IN_DELIVERY` |
| `POST /api/admin/vendors/:id/owner/remove` | `{ reason, confirmName }` | detach + user REMOVED (B3 owner-user case) | as detach + `CONFIRM_MISMATCH` |

Create/attach details:
- New user: `role VENDOR`, `passwordHash = hashPassword(...)`, `accountStatus ACTIVE`. One transaction: create user + `vendor.update({ where:{ id, userId: null }, data:{ userId } })` conditional on `userId: null`, so two admins racing give one `OWNER_EXISTS`. Vendor `approvalStatus` is not changed. Audit `OWNER_CREATED` (`targetType 'VENDOR'`, summary `Created owner login for <vendor> (owner <name>, <id8>)` , `meta` WITHOUT password). `generatedPassword` is never logged, never put in the audit summary, never stored.
- `existingUserId` re-attach: only a `VENDOR` user with zero restaurants (a previously detached login). Restores `accountStatus ACTIVE`; password unchanged.
- Phone change: write `User.phone`; `bumpTokenVersion` + `disconnectUser` (sessions end, the owner signs in again with the new number and the SAME password); do NOT disable push tokens (same person, same phone device); `recordSuccess(last10(old))` and `(new)` to clear lockouts; audit `OWNER_PHONE_CHANGED` with last-4 only of old and new (`...3210 -> ...4411`). Name change: no session change; audit `OWNER_RENAMED`. NOTE the owner's name is also copied into nothing else for vendors (restaurant name is separate, `vendorProfile.ts`), but for riders `DriverPartner.name/phone` duplicate `User` (`schema.prisma:381-382`); the rider phone/name change (B2 follow-up, same pattern `PATCH /admin/drivers/:id/account`) must update BOTH rows in one transaction.
- Reset password: sets hash, `tokenVersion + 1`, disconnect, clears limiter, audit `PASSWORD_RESET` (existing code). "Forces nothing else" = no status change, no push token disable, no restaurant change. The old password stops working at once and so do all sessions (inherent to tokenVersion; the dialog says so).
- Disable: `accountStatus SUSPENDED` + reason, `revokeUserEverywhere`, `dropFromPartnerRooms(owner, ['vendor_<id>'])`; default also `isAcceptingOrders = false` so customers are not sent to a restaurant nobody can run; `warning` text if the admin unticks it and the restaurant is still open or has open orders: `Orders will arrive that only an admin can accept.` Existing orders are NOT cancelled (the admin can drive them from the Orders tab: `ADMIN_TARGETS`, `orderFlow.ts:51`); the dashboard lists them.
- Detach: conditional update `vendor.userId -> null`, user `SUSPENDED` (reason `Detached from <vendor>`) so the orphan login is dead, tokens revoked, push disabled, vendor room dropped, `isAcceptingOrders false` by default. `movePayoutAccount:true` is only valid with a following `POST .../owner` and is therefore implemented as a param on THAT call: `{ ..., takePayoutAccountFrom: '<detachedUserId>' }` which re-points `PayoutAccount.userId` (unique per user, so the new owner must not already have one; else 409 `OWNER_HAS_PAYOUT_ACCOUNT`) and clears `verifiedAt`/`verifiedBy` (a changed holder must be re-verified, like any change: `schema.prisma:518-519`), audit `PAYOUT_ACCOUNT_CHANGED` (existing code). Pending settlements keep their `payoutSnapshot` (masked, taken at creation), so nothing already created changes.
- Effects on live data: open orders are not touched by create / reset / phone change / enable; disable + detach are refused or cancel per `openOrders`; settlements, dishes, categories, location, commission untouched. Realtime: the new owner's first login joins `vendor_<id>` automatically; a detached owner is removed from it.

Security: admin-only; `requireRole('ADMIN')` AFTER `requireAuth`; the admin cannot set the owner role to anything else; cannot attach an ADMIN/DRIVER/STUDENT user; password length rules reused; the generated password is returned once and the UI never persists it; all of these write an audit row with actor; typed-name confirmation on `remove`.

What must be impossible: two owners on one restaurant; an owner of two restaurants (until the vendor app supports it); an owner phone that collides with any user (incl. removed); reading an existing password (hash only); a response that echoes `passwordHash`; changing the phone without ending old sessions; a disabled owner holding a live socket.

#### UI
- Admin `GET /vendors` view (`fullVendorView`, `api.ts:610-612`, list query `:622`) gains `owner: { id, name, phone, accountStatus } | null` via a Prisma `user: { select }` include (this is a shared file, see section C). The dashboard `Vendor` type (`types.ts:109`) gets `owner`.
- `VendorManager` card: below the pills, an "Owner login" block. No owner: amber chip `No owner login` and button `Create owner login`; with owner: `Owner: <name> · +91 ... ` + status chip + `Manage` menu: `Change phone or name`, `Reset password`, `Disable login`/`Enable login`, `Remove owner`. Also add the same block in `EditRestaurantDrawer` for discoverability, and a `No owner` filter chip in the vendor filters.
- Create dialog: fields `Owner name`, `Owner phone (10 digits)`, checkbox `Generate a password for me` (default on) or a password field (min 8). After success a "Share the login" panel: phone, password (monospace), `Copy login` button (uses `copyText`, `lib/credentials`), warning `This password is shown only once. Kraveo cannot show it again; you can reset it any time.`, and the close button disabled until the box `I have copied it` is ticked. Password lives only in component state and is cleared on close.
- Change phone dialog: `Changing the phone signs the owner out of every device. They sign in again with the new number and the same password.`
- Reset dialog: `Reset the password for <name>? They are signed out everywhere and the old password stops working now.` Button `Reset and show new password`.
- Disable dialog: `Disable <name>'s login? They are signed out and cannot sign in until you enable it.` Checkbox `Also close <restaurant> for new orders` (default on). If `openOrders > 0`: `N order(s) are in progress. They will not be cancelled; you can handle them in Orders.`
- Detach / remove owner: `Remove the owner login from <restaurant>? The restaurant stays but nobody can run it until you add a new owner. Unpaid settlements stay.` Type the restaurant name. Offers `Close the restaurant now` (default on).
- Errors: `PHONE_TAKEN` -> field error `This number already belongs to another account.`; `OWNER_EXISTS` -> reload card; generic -> keep dialog open with the server text.

#### Tests
Backend: create for ownerless vendor (user created, linked, can log in via `/auth/partner-login`, `generatedPassword` works once and is absent in audit rows and in a second GET); create on a vendor that has an owner -> 409; two parallel creates -> exactly one 201; phone taken (incl. a REMOVED user's phone) -> 409; PATCH phone -> old token 401, new phone + old password logs in, old phone cannot; P2002 race mapped to 409; reset -> old password rejected, sessions dead, limiter cleared; disable -> login 403 `ACCOUNT_SUSPENDED`, restaurant closed, open order untouched; enable -> login works; detach with open order -> 409, with `CANCEL` -> cancelled+refund; detach then create with `takePayoutAccountFrom` -> account moved and unverified; vendor GET shows `owner` for admin only (a student token sees no `owner`/`userId`); every action writes an audit row with `actorId` and none contains the password; non-admin -> 403. Dashboard: show-once panel (close disabled until ticked, password cleared after close), ownerless chip, `No owner` filter.

---

### B5. Audit log viewer

#### Current state
`GET /admin/audit-log?limit=` (`partners.ts:526-534`), no filters, no cursor, no UI. Table indexes: `createdAt`, `(targetType,targetId)` (`schema.prisma:417-418`). Summaries are free text, <= 300 chars (`audit.ts:8-11`), ~50 action codes.

#### Endpoints (new file `routes/adminAudit.ts`, replaces the handler in `partners.ts:526`, same path so nothing else changes)
| Method + path | Query | Success | Errors |
|---|---|---|---|
| `GET /api/admin/audit-log` | `action` (comma list, max 20, `^[A-Z_]{2,60}$`), `targetType` (`ORDER\|VENDOR\|DRIVER\|USER\|SETTING\|...`), `targetId` (ID_RE), `actorId`, `q` (free text, 2-60 chars, case-insensitive `contains` on `summary`), `from`, `to` (ISO dates, IST day bounds like `parseIstRange`, `finance.ts:146`), `cursor` (opaque `createdAt|id`), `limit` (1-100, default 50) | `{ success, count, nextCursor, data: [{ id, createdAt, action, targetType, targetId, summary, actorId, actorName, ip? }] }` (`ip` only if the viewer is allowed, see below) | 400 `field`; 429 |
| `GET /api/admin/audit-log/actions` | - | `{ data: [{ action, count }] }` (distinct, last 90 days, cached 60 s) for the filter dropdown | - |
| `GET /api/admin/audit-log/export.csv` | same filters, hard cap 5000 rows, max range 366 days | `text/csv`, `Content-Disposition`, `Cache-Control: no-store`; CSV-injection safe (prefix `'` to cells that start with `= + - @`) | 400 `RANGE_TOO_LARGE` |

Rules: read-only; ADMIN only; the log is append-only (no update or delete endpoint exists or will be added; assert in a test that the router has no non-GET method on `/admin/audit-log`). Order: `createdAt desc, id desc`; keyset cursor; indexes `(action, createdAt)` and `(actorId, createdAt)` from B0. `q` uses `ILIKE`; at pilot volumes no trigram index is needed (note it as a follow-up when rows pass ~500k). `meta` is not returned in the list (only in a per-row `GET /audit-log/:id` if wanted later). Old rows have `actorId null` and show `Before individual admin accounts` (not "system"). The exported CSV and `ip` are visible to the `OWNER` role once roles exist (B6-1); until then all admins.

#### UI
New tab `audit`, label `Activity`, hint `Who changed what`, icon `ScrollText` (lucide) in `Sidebar.tsx` NAV_ITEMS (`:19-33`) and `TabType` (`types.ts:4`), wired in `App.tsx:668-696`. Layout like `FinancePanel`/`SettlementsPanel`: filter bar (multi-select `Action` grouped by prefix: Orders, Partners, Catalog, Finance, Settings, Banners/Categories; `Target type`; date range picker reusing `DateRangePicker`; search box; `Actor` select when accounts exist), table `Time (IST) | Action | Target | Summary | By`, load-more with cursor, `Download CSV` button. `Target` renders a link when it can be opened: `ORDER` -> OrderDrawer, `VENDOR` -> Vendors tab filtered, `DRIVER`/`USER` -> Drivers/Customers drawers. Empty state: `No activity matches these filters.` + `Clear filters`. Error state with retry. Mobile: cards, not a table (same pattern as `CustomersPanel`).

#### Tests
Backend: each filter alone and combined; cursor paging with equal `createdAt`; `q` escapes `%`/`_`; range > 366 days -> 400; CSV injection cell is neutralised; non-admin 403; no write verbs; `actorId` populated for a row written inside a request and null for a maintenance-job row. Dashboard: filter -> request param mapping, load-more, empty/error states, CSV button disabled while loading.

---

### B6. Other gaps, ranked (importance, then effort S/M/L, risk)

1. **Individual admin accounts, roles, 2FA** (L, risk HIGH if skipped). Evidence: single env passcode and single shared ADMIN row (`api.ts:298-366`), 30-day token in `localStorage` (`services/api.ts:101-122`), no actor in audit (0.5), per-IP lockout only (`api.ts:57`), passcode lives in the server `.env`. Spec: `AdminAccount` model (or reuse `User(role ADMIN)` with `email`, `passwordHash`, `adminRole OWNER|SUPPORT|FINANCE|VIEWER`, `totpSecretEnc`, `lastLoginAt`); `POST /auth/admin-login` accepts `{email,password,totp}` while the old passcode stays as a documented break-glass path that only works for the first-ever admin creation; per-role route guard `requireAdminPermission('refunds'|'finance'|'users'|'catalog'|'settings'|'audit')` (SUPPORT: orders, customers read, cancel; FINANCE: settlements, payouts, reveal; OWNER: everything + admin management); admin token lifetime 12 h (the apps keep 30 d); "sign out everywhere" via `tokenVersion`; admin management screen (invite = generated password shown once, disable, reset, role change; cannot disable the last OWNER: `409 LAST_OWNER`); every audit row carries the real admin. TOTP via RFC 6238 (no SMS cost). Dashboard: login screen change (`LoginScreen.tsx`), new `Admins` tab. Do after B0-B5 (it reuses `actorContext`). Risk of the work: lock-out of everyone, so keep the passcode path behind an env flag until the first OWNER account is verified.
2. **Order trap: customers can order from ownerless / owner-disabled restaurants** (S, risk MEDIUM, needs an owner decision). Evidence: 0.4. Options: (a) refuse in `placeOrder` and hide from the customer list when `userId` is null (then admin-run demo restaurants need an owner or a flag; `utils/seedDemoPartners.ts:34` attaches owners to ownerless vendors, so seeds already expect it), or (b) add `Vendor.operatedByAdmin Boolean` for restaurants Kraveo runs by hand. Recommended: (a) now, plus an amber `No owner` warning chip on the card (already in B4). Tests: `placeOrder` -> 400 `VENDOR_UNAVAILABLE` for `userId null`; public list hides it; admin list shows it.
3. **Server-side order search, date filter, CSV export** (M, risk LOW). Evidence: client-only filter (`OrdersTable.tsx:101-104`), server filters lack text/date (`orders.ts:236-243`), 100 rows per page. Spec: `GET /orders` admin branch accepts `q` (order id prefix, razorpay order/payment id, customer name/phone last digits, hostel), `from`/`to`; `GET /admin/orders/export.csv` (cap 5000, 31-day max) with columns id, createdAt, customer name (no phone by default), restaurant, status, payment, total, fee, discount, refundStatus; needs indexes on `Payment.razorpayPaymentId`. Dashboard: header search calls the server when the query is >= 3 chars (debounced), "Export CSV" button on Orders and Customers (customers: name, hostel, orders, spent; no phone/e-mail unless `includePii=1` and logged in audit as `EXPORT_PII`).
4. **Coupons management** (M, risk MEDIUM: money). Evidence: constant map in code (`utils/validation.ts:35-41`), no usage report, a new coupon needs a deploy. Spec: `Coupon {code unique, kind PERCENT|FLAT, value, minSubtotal, maxDiscount, startsAt, endsAt, perUserLimit, totalLimit, usedCount, isActive, vendorIds[]?}`; checkout reads the table (atomic `UPDATE ... SET usedCount = usedCount + 1 WHERE usedCount < totalLimit`); the existing single-use-per-customer logic (`Order.couponCode`, `schema.prisma:257`) stays; KRAVEO20 migrated as a coins-gated row; Coupons tab with usage, kill switch. Coupons are paid by Kraveo (`pricing.ts:203`), so a hard `totalBudgetRs` cap is part of the spec.
5. **Broadcast push / announcements** (M, risk MEDIUM: spam, policy). Evidence: push infra exists (`services/push/*`, `DeviceToken`), no admin trigger. Spec: `POST /admin/broadcasts {title<=40, body<=120, audience: ALL_CUSTOMERS|HOSTEL:<code>|ALL_RESTAURANTS|ALL_RIDERS, scheduleAt?}`, rate limit 3 per day, test-send-to-me first, batches of 500 tokens, idempotency key, audit `BROADCAST_SENT` with counts, respects `disabledAt`. UI: Broadcast tab with preview.
6. **Opening hours per restaurant** (M, risk MEDIUM). Evidence: only a manual toggle (`api.ts:718-752`); an owner who forgets to close gets late-night paid orders that auto-cancel after 10 min. Spec: `Vendor.openingHours Json` (`[{days, open:"09:00", close:"23:00"}]`, IST), `isOpenNow(vendor, now)` used by `placeOrder` (`orderFlow.ts:294`) and returned as `openNow` in the customer vendor list; the manual toggle stays as an override to CLOSE only. Admin editor in `EditRestaurantDrawer`.
7. **System health page and admin notifications** (S-M, risk LOW). Evidence: `/health` is constant (`index.ts:94-100`); no browser/sound alert when `new_order_alert`/needs-attention items appear while the tab is in the background. Spec: `GET /admin/system` -> DB ping + latency, last maintenance run time and counts (`orderMaintenance.ts` summary), last Razorpay webhook received time (add a timestamp in `AppSetting` or memory), FCM configured yes/no, pending refunds count, build commit, uptime. UI: a small status dot in `Header` + `System` section on Settings; optional Notification API alert for NEW attention items (permission asked on click only).
8. **Support tools on a customer: coin adjustment, notes** (S, risk LOW-MEDIUM: money-like). Evidence: `kraveoCoins` can only change through reviews and redemption; goodwill coins/refund-by-hand have no tool. Spec: `POST /admin/customers/:id/coins {delta -500..500, reason}` with audit and a daily per-admin cap; `CustomerNote` table (free text, actor) shown in the drawer.
9. **Auto-cancel windows and SLA minutes as settings** (S, risk LOW). Evidence: env-only (`config/orderFlow.ts:13,15`; alert minutes constants in `orders.ts`). Add an `operations` setting group (Settings page already has 4 groups, `SettingsPanel.tsx:490-493`, validated by `validateSettingGroup`). Needs a restart-free read (the maintenance job reads it each tick).
10. **Reviews moderation** (M, risk LOW). Evidence: no admin list/hide. `ReviewRecord.driverNotes/dhabaNotes` are free text from customers (`api.ts:917+`) and `GET /reviews/vendor/:id` and `/reviews/driver/:id` need only ANY login (`api.ts:1131-1148`) and return the customer's name with the notes (`api.ts:1122`) - decide whether every logged-in user should see that (I did not verify the app-side use; flag for the owner). Spec: `hiddenAt/hiddenBy` on `ReviewRecord`, `GET /admin/reviews?vendorId&driverId&maxRating`, `POST /admin/reviews/:id/hide|unhide`, exclusion in `reviewPage`; hiding must not undo the rating already averaged (document).
11. **Refunds list and "acknowledge" for manual cases** (S-M, risk LOW). Evidence: `PAYMENT_MISMATCH` has no resolution action (hint tells the admin to refund in the Razorpay dashboard and cancel, `orders.ts:544`); the reconcile report exists (`orders.ts:496`) but nothing in the dashboard calls it. Spec: a `Payments` sub-tab listing orders with `refundStatus` in any state + reconcile button; `POST /admin/orders/:id/ack-payment-issue {note}` stores an acknowledged marker so the order leaves Needs attention without data loss (audit with note).
12. **Bulk actions for orders/customers** (M, risk MEDIUM). Only the catalog has bulk (`CatalogBulkBar`). Low priority until volume exists; the useful one is "cancel all unpaid open orders older than N minutes" (already automatic).
13. **Per-restaurant fee overrides** (M, risk MEDIUM money): fees are global (`pricing.ts` fee group). Skip until the owner asks.
14. **Complaint/ticket tracking** (L): support is by e-mail (`kraveo.contact@gmail.com`); out of scope for the pilot.
15. **Rider/owner phone and name edit for riders** (S): same pattern as B4 `PATCH`, updates `User` and `DriverPartner` in one transaction. Folded into B2 follow-up.
16. **`lastLoginAt` on User** (S): useful for "is this owner actually using the app" in B4's card; add with B0 if wanted (nullable column, updated at partner-login).

---

## C. Recommended implementation order and collision map

Hard limits from the owner's rules: at most 2 agents in parallel, only ONE running builds/tests, Sonnet only, `jest --runInBand`, no APK builds. Backend contract first, dashboard second, so each dashboard agent codes against fixed JSON.

| Step | Work | Agent | Why this order |
|---|---|---|---|
| 0 | **B0 foundations**: migration, `actorContext`, `writeAudit` actor, `accountGuard`, login guards (`/auth/google`, `/auth/partner-login`), `partnerIsSuspended`, `revokeUserEverywhere`, `disconnectUser`, rate-limit rules, `placeOrder` suspended check | A (backend), alone | Everything else depends on it; touches the most shared files, so nobody else works on them now. Lead runs the migration test + full jest once. |
| 1 | **B4 owner login** (backend `routes/adminOwners.ts`) + **B6-2 ownerless-order guard** | A or B | This is the owner's explicit ask #2 and the trap in 0.4 gets worse the moment owners can be detached/disabled. |
| 1 ‖ | **B5 audit viewer** backend (`routes/adminAudit.ts`) | B (parallel with step 1; touches only new files + removing one handler from `partners.ts`) | Independent of B4. |
| 2 | **B1 customers** backend (`routes/adminUsers.ts`) | A | Owner's ask #1 (most visible). |
| 2 ‖ | Dashboard for B4 + B5 (`VendorManager`, `EditRestaurantDrawer`, new `ActivityPanel`, `types.ts`, `services/api.ts`, `Sidebar`, `App.tsx`) | C (dashboard) | Backend contracts of step 1 are frozen. |
| 3 | **B3 + B2** backend (status endpoint guard in `partners.ts`, vendor suspend/remove, driver remove, `payoutAccount.ts` + `finance.ts` fixes) | A | They share the open-order guard and the `partners.ts` status handler, so ONE agent. |
| 3 ‖ | Dashboard for B1 (`CustomersPanel`) then B2/B3 (`DriverManager`, `VendorManager`, extracted `ReasonDialog`) | C | Sequential inside one agent: `VendorManager.tsx` is touched by B3 and B4 UI. |
| 4 | B6 items in the ranked order: 1 (admin accounts) is its own project after the above; 3, 7, 9, 11 are small and independent. | any | |

**Shared files (never two agents at once):**
- `backend/prisma/schema.prisma` + the migration folder: Step 0 only, one migration. Later steps add NO columns (all B1-B5 fields are in B0). B6 items add their own migrations later, one at a time.
- `backend/src/routes/api.ts` (1155 lines): login guards, admin vendor view with `owner`, router mounting. Edit only in step 0 (guards, mounting all three new routers up front, even if the files start as empty stubs) and step 1 (`owner` in the vendor view). Everyone else puts code in NEW route files.
- `backend/src/routes/partners.ts`: status handler (B2/B3 guard), the audit handler removal (B5), reset-password (B4). Owned by step 3's agent; B5 and B4 only touch it in one-line changes made in step 0 by agent A (remove the old audit handler, export what B4 needs).
- `backend/src/middleware/auth.ts`, `backend/src/middleware/rateLimit.ts`, `backend/src/realtime.ts`, `backend/src/services/audit.ts`: step 0 only.
- `backend/src/services/orderFlow.ts` and `orderGroups.ts`: `placeOrder` guards (suspended customer, ownerless restaurant) in steps 0/1 by agent A only; order cancel code is reused, not edited.
- `backend/src/services/payoutAccount.ts`, `services/finance.ts`: step 3 only.
- Dashboard: `types.ts`, `services/api.ts` (append-only), `App.tsx`, `Sidebar.tsx`: one dashboard agent at a time (C). `VendorManager.tsx`: B3 and B4 UI must be the same agent in sequence. `ApplicationsPanel.tsx`: the reason dialog and reset-password dialog are extracted to shared components in step 3 (so `DriverManager` and `VendorManager` reuse them) - extraction by C only.
- Test files: each feature in its own new test file; do not append to `orders.test` style shared files.

**Verification the lead must do (agents cannot be trusted to claim it):** after step 0 and after each backend step run `cd backend && npx tsc --noEmit` and ONE `npx jest --runInBand` (nothing else running); after each dashboard step `cd web/super_admin && npx tsc --noEmit && npx vitest run`; then a manual pass in the browser against a local backend for the three flows the owner named (remove a customer, create an owner for an ownerless restaurant, view the Activity tab). Deploy = migration first, backend second, dashboard third; the Flutter apps need no release for B1-B5 except possibly the customer app showing the server's message on a 403 from `/auth/google` (not verified; check `apps/customer_app/lib/services/customer_api_service.dart` and the auth screen before promising it).

## D. Open questions for the owner

1. Ownerless restaurants: refuse customer orders (recommended) or allow "operated by Kraveo staff"? (B6-2)
2. Customer remove: default `scrub` off (keeps the Google block, recommended) - OK to keep the e-mail/Google id of a removed person for blocking?
3. Is one restaurant per owner login still the rule (vendor app shows one)? B4 enforces it.
4. Do you want the shared passcode kept as emergency access once admin accounts exist (B6-1)?
5. Should a suspended customer be able to see their past orders (read-only app)? The spec says no (signed out).

## E. Not checked / limits of this audit

- Nothing was executed: no migration was applied, no test or server run; line numbers are from the working tree at `22b55f3`.
- Not read in depth: `middleware/rateLimit.ts` beyond the rule table shape, `services/settlement.ts` (whether the daily job skips non-APPROVED vendors is flagged as a test to write, not a confirmed bug), `realtime.ts` room joining for customers, the Flutter apps' reaction to 403 on sign-in, `CatalogPanel`/`FinancePanel`/`AnalyticsPanel` internals, `services/googleAuth.ts`.
- Checked: every socket joins `user_<id>` automatically at connect for every role (`realtime.ts:106`), so `disconnectUser` works for customers too.
