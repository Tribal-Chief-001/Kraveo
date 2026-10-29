# Admin management (remove users, owner logins, audit viewer): scope and owner decisions (29 Oct 2026)

The SPEC is Docs/27_admin_gaps_audit.md (sections B0-B5 and B6 item 2, plus the stage-2 items below). This file only fixes the SCOPE, the owner's answers to the open questions (Docs/27 section D) and the overrides where the owner decided differently from the audit's recommendation. Where Docs/27 and this file differ, THIS FILE wins. The owner was asleep and told us: "decide everything yourself, my answer is yes; production hardened, zero regression".

## Stage 1 (must ship together): B0 foundations, B4 owner login, B5 audit viewer, B1 customers, B2 riders, B3 restaurants + owners, B6-2 ownerless guard
## Stage 2 (after stage 1 is verified and deployed): B6-3 server-side order search + date filter + CSV export (orders, customers), B6-7 system health (admin/system + header dot), B6-9 operations settings group (auto-cancel windows / SLA minutes read each tick), B6-11 refunds/payment-issue tab (list, reconcile button, acknowledge), B6-16 lastLoginAt (fold into B0)

## Owner decisions (answers to Docs/27 section D)
1. **Ownerless restaurants** (created by the admin without an owner login, e.g. the six imported restaurants): they stay VISIBLE to customers (menu, photos, prices) but are always shown as closed; `placeOrder` and the group-order path refuse them with a plain message ("This restaurant is not taking orders right now") whatever `isAcceptingOrders` says; the admin/owner open-close toggle REFUSES to open a restaurant without an owner (409 `NO_OWNER`, message "Add an owner login first"). The audit's recommendation to hide them from the customer list is NOT adopted. Admin list shows an amber "No owner" chip.
2. **Customer remove**: `scrub` off by default (keep email/Google id of a removed person so the block holds); a removed customer cannot sign in again or re-register with the same Google account unless an admin restores the account.
3. **One restaurant per owner login** stays the rule (B4 enforces it).
4. **Admin passcode** stays the only admin login for now (individual admin accounts + 2FA = B6-1 is a LATER project; do not build it now, but do add the audit ACTOR to every audit row as spec'd in B0 using whatever identity the request has).
5. **Suspended customer**: signed out everywhere (tokens revoked, sockets disconnected, push tokens disabled), cannot see past orders until restored.
6. Removal never deletes accounting data: orders, payments, refunds, settlements, payout ledger and audit rows stay; payouts to a removed rider or owner still work for the last amount (fix the lookups as in Docs/27 finding 7).
7. The apps keep working: a blocked user gets a plain 403 with `code` and `message` on sign-in and on token use; no app crash (apps just show the server message; do not change the apps in stage 1).

## Rules
- Backend first (one agent, one migration, new route files; shared files edited only as in Docs/27 section C), dashboard second, review third. Each backend step: `tsc` + the full jest once; each dashboard step: `tsc` + vitest + build. All 1163+ backend, 1006 dashboard tests stay green.
- Every removal/suspension action: admin only, audited with actor, confirmation text in the UI naming the person and the consequences, idempotent, refuses (409 with the exact blocking items) when the user has open orders / active deliveries / pending refunds unless the spec says how to resolve them; sessions killed everywhere; open orders of a removed restaurant are cancelled with full refunds only through the existing cancel code path.
- Tests: real Postgres for every endpoint, every guard, race cases (removal vs a concurrent order/payment), login attempts of removed/suspended users (Google, partner login, token reuse, socket connect), payout of a removed user, visibility (customer/owner/rider cannot call admin routes), migration safe on live rows.

---

# Implementation notes (backend stage 1, written 29 Oct 2026)

Status: the backend of stage 1 is BUILT and tested against a real PostgreSQL (7 new test files, 102 new tests; full backend suite 1356 / 1356 green, see the end). `20261014_menu_order` is already deployed; `20261015_admin_user_management` is the next, not yet deployed, migration. The dashboard agent codes against this section. Everything below was observed in the tests, not guessed; the JSON examples are real answers of the running code (ids shortened).

## 0. What changed, in one screen

- Migration `backend/prisma/migrations/20261015_admin_user_management/migration.sql`: ADDITIVE and IDEMPOTENT (applied twice on a scratch database that held old rows; `prisma migrate diff` against `schema.prisma` shows no difference). New enum `AccountStatus {ACTIVE, SUSPENDED, REMOVED}`; `User.accountStatus/statusReason/statusChangedAt/statusChangedBy/lastLoginAt`; `Vendor.removedAt/removedReason/ownerDisabledByRemoval`; `AdminAuditLog.actorId/actorName/ip/meta` + 2 indexes. Deploy order: migration, backend, dashboard.
- New route files: `adminUsers.ts` (customers), `adminDrivers.ts`, `adminVendors.ts`, `adminOwners.ts`, `adminAudit.ts`. New services: `accountGuard`, `accountControl` (`revokeUserEverywhere`), `actorContext`, `adminOrders` (guarded cancel), `orderGuards`, `customerAdmin`, `riderAdmin`, `vendorAdmin`, `ownerAdmin`.
- Every admin endpoint here: ADMIN only (401 anonymous, 403 customer / owner / rider), rate limited by `ADMIN_ACCOUNT_WRITE` (30 POST/PATCH per 10 min per admin, 429 `RATE_LIMITED`), audited WITH the acting admin (`actorId`, `actorName`, `ip`), idempotent (same transition again = `200 { changed:false }` and no second audit row), strictly validated (unknown JSON key = 400 with `field`).
- Error shape everywhere: `{ success:false, code, message, field? , ...extra }`. 400 `BAD_REQUEST` (+`field`) or `CONFIRM_MISMATCH`; 404 `NOT_FOUND`; 409 specific codes below; 429 `RATE_LIMITED`.
- Nothing is ever hard-deleted: orders, payments, refunds, settlements, payout ledger, payout accounts, dishes and audit rows stay.

## 1. Sessions of a blocked person (what the apps see)

- Sign-in of a SUSPENDED / REMOVED account (Google, partner login, admin login): `403 { success:false, code:'ACCOUNT_SUSPENDED' | 'ACCOUNT_REMOVED', message }`, no token. Messages: `Your Kraveo account is paused: <reason>. Contact kraveo.contact@gmail.com.` / `This Kraveo account was removed. Contact kraveo.contact@gmail.com if you think this is a mistake.` A removed Google account signing up again gets this 403 (it used to be a 500); wrong password of a removed partner is still the plain `401 Wrong phone or password.` (identity is proven first).
- An OLD token of a blocked account: `401 { code:'TOKEN_REVOKED', reason:'ACCOUNT_SUSPENDED'|'ACCOUNT_REMOVED', message }` (same 401 `TOKEN_REVOKED` the apps already handle, plus `reason` and the readable `message`). Sockets: handshake refused, live sockets disconnected, push tokens disabled (and never used while the account is not ACTIVE).
- `restore` does NOT revive anything the block killed: old tokens stay dead, push tokens stay off until the person signs in again on a device, cancelled orders stay cancelled.
- A socket whose handshake passed just before a block is closed by a re-check right after it joins its rooms (no timers, so a restored person can reconnect immediately).
- Auth cache: single PM2 instance, the cache is cleared on every change; with several instances a change takes up to 15 s on the others.

## 2. Customers (`routes/adminUsers.ts`, GETs in `routes/partners.ts`)

| Call | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/customers?status=ACTIVE\|SUSPENDED\|REMOVED\|ALL&search&limit&cursor&includeDeleted=1` | - | `{ success, total, nextCursor, data:[row] }`; default = ACTIVE + SUSPENDED; self-deleted only with `includeDeleted=1` | 400 `status` |
| `GET /api/admin/customers/:id` | - | `{ success, data: detail }` | 404 |
| `POST /api/admin/customers/:id/suspend` | `{ reason 3-200, openOrders?: 'REFUSE'(default)\|'CANCEL' }` | `{ success, changed, data: detail, cancelled?, failed? }` | 400; 404 (also any non-customer id); 409 `HAS_OPEN_ORDERS` (`openOrders:[...]`), `ORDER_IN_DELIVERY` (`orders:[...]`), `ALREADY_DELETED`, `INVALID_STATE` (a REMOVED customer cannot be suspended) |
| `POST /api/admin/customers/:id/restore` | `{ note?: <=200 }` | same shape | 409 `NOT_RESTORABLE` (self-deleted) |
| `POST /api/admin/customers/:id/remove` | `{ reason, confirmName, scrub?: false, openOrders? }` | same shape | 400 `CONFIRM_MISMATCH`; 409 as suspend + `REFUND_NOT_SETTLED` (`orders:[ids]`, only with `scrub:true`) |

Row = `{ id, name, email, phone, isStudent, hostelBlock, avatarId, kraveoCoins, createdAt, deleted, accountStatus, statusReason, statusChangedAt, lastLoginAt, ordersCount, totalSpent, lastOrderAt, openOrders:<count> }`. `deleted:true` = the customer deleted the account themselves (never restorable). Detail adds `statusChangedBy`, `openOrders:[{id,status,paymentStatus,totalAmount,groupId?}]`, `refundsOwed:[{orderId,refundStatus:'PENDING'|'FAILED',amount}]`, `stats`, `orders`.

- `cancelled` / `failed` appear only when `openOrders:'CANCEL'`. Real answer of a suspend with a paid order:
```json
{"success":true,"changed":true,"data":{"id":"zc-cust-1","name":"Cust1 Tester","accountStatus":"SUSPENDED","statusReason":"Fake orders","statusChangedBy":"zc-admin-0","openOrders":[],"refundsOwed":[]},
 "cancelled":[{"orderId":"6aa89843-...","groupId":null,"cancelledOrders":1,"refund":"STARTED"}],"failed":[]}
```
  A combined order is cancelled as a whole: one entry with `groupId` and `cancelledOrders:2` (also the other restaurants' parts). `failed:[{orderId,code,message}]` = the account IS blocked but that order could not be cancelled; call again (already-cancelled orders are skipped).
- Real refusals: `409 {"code":"HAS_OPEN_ORDERS","message":"This customer has 1 order(s) in progress. Cancel them first, or choose to cancel them with this action.","openOrders":[{"id":"6aa89843-...","status":"PLACED","paymentStatus":"PAID","totalAmount":205}]}`; `400 {"code":"CONFIRM_MISMATCH","field":"confirmName","message":"The name you typed does not match."}`; `400 {"code":"BAD_REQUEST","field":"reason","message":"Reason must be 3 to 200 characters."}`.
- `remove` keeps e-mail + Google id (the block key) unless `scrub:true`, which erases name (`Removed user`), phone (freed), avatar, hostel, UPI, coins; e-mail + Google id still stay. Food already picked up is never cancelled (`ORDER_IN_DELIVERY`, both modes).

## 3. Riders (`routes/adminDrivers.ts`, `routes/partners.ts`)

| Call | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/drivers/:id/impact` (`:id` = DriverPartner id or user id) | - | `{ success, data:{ driverId, userId, name, approvalStatus, accountStatus, activeDeliveries:[{id,status,groupId?}], foodWithRider:[{id,status}] } }` | 404 |
| `POST /api/admin/drivers/:id/remove` | `{ reason, confirmName (rider name), handover?: 'REFUSE'(default)\|'RELEASE' }` | `{ success, changed, released?:[orderId], releaseFailed?:[...], data: applicationRow }` | 400; 404; 409 `HAS_ACTIVE_DELIVERY` (`orders`), `FOOD_WITH_RIDER` (`orders`, picked up: never released), `ALREADY_DELETED`, `NO_ACCOUNT`, `NOT_A_RIDER_USER` |
| `POST /api/admin/drivers/:id/restore` | `{ note? }` | same | 409 `NOT_RESTORABLE` |
| `POST /api/admin/partners/DRIVER/:id/status` (existing) | adds `handover?` when `status:'SUSPENDED'` | adds `changed`, `released?` | adds the same 409s; APPROVED of a removed rider = 409 `ACCOUNT_NOT_ACTIVE` |

`applicationRow` (real): `{ id, kind:'DRIVER', userId, name, phone, status:'SUSPENDED', rejectionReason:'Left the company', selfSignup, appliedAt, reviewedAt, createdAt, accountStatus:'REMOVED', removedAt:null, driver:{ runnerCode, vehicleType, vehicleRegNo, emergencyPhone, upiId } }` (`accountStatus` and `removedAt` are new on ALL application rows, driver and vendor). Remove: rider `SUSPENDED` + `OFFLINE`, login `REMOVED` (phone stays reserved), map position deleted, payouts and reviews untouched. RELEASE sends not-picked-up orders back to the pool through the normal reassign code. Restore: login `ACTIVE`, rider stays `SUSPENDED` (admin presses Reactivate on purpose). Payout lookups and `POST /admin/rider-payouts` accept a REMOVED rider (a self-deleted one stays 404); `GET /admin/finance/riders` still lists them. `GET /api/drivers` rows now carry `user.accountStatus` and `user.lastLoginAt`.

## 4. Restaurants (`routes/adminVendors.ts`, `routes/api.ts`, `routes/partners.ts`)

| Call | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/vendors/:id/impact` | - | `{ success, data:{ vendorId, name, approvalStatus, removed, isAcceptingOrders, hasOwner, openOrders:[...], inDelivery:[...], unpaidSettlements:{count,amount} } }` | 404 |
| `POST /api/admin/vendors/:id/suspend` | `{ reason, openOrders?: 'REFUSE'\|'CANCEL' }` | `{ success, changed, cancelled?, failed?, data: vendor }` | 409 `HAS_OPEN_ORDERS` (`orders`), `ORDER_IN_DELIVERY` (also when it is another restaurant's part of the same combined order), `VENDOR_REMOVED`, `INVALID_STATE` (not APPROVED) |
| `POST /api/admin/vendors/:id/reinstate` | `{}` | `{ success, changed, warning?, data }` SUSPENDED -> APPROVED, stays CLOSED | 409 `VENDOR_REMOVED`, `INVALID_STATE` |
| `POST /api/admin/vendors/:id/remove` | `{ reason, confirmName (RESTAURANT name), openOrders?, disableOwner?: true }` | `{ success, changed, ownerDisabled, cancelled?, failed?, data }` | 400 `CONFIRM_MISMATCH`; 409 as suspend |
| `POST /api/admin/vendors/:id/restore` | `{}` | `{ success, changed, ownerRestored, data }` stays SUSPENDED + closed | - |
| `GET /api/vendors?includeRemoved=1` (admin) | - | removed restaurants hidden by default; `removedAt`, `removedReason` on the row | - |
| `POST /api/admin/partners/VENDOR/:id/status` (existing) | adds `openOrders?` when SUSPENDED | adds `changed`, `cancelled?`, `failed?` | the same guard (default REFUSE: 409 `HAS_OPEN_ORDERS`); APPROVED of a removed one = 409 `VENDOR_REMOVED` |

`data` = the restaurant exactly as `GET /api/vendors` shows it to an admin, with the new `owner` block (real): `"owner":{"id":"zc-vown-2","name":"Owner2 Kitchen","phone":"+91 9777620002","accountStatus":"ACTIVE","statusReason":null,"lastLoginAt":null}` or `"owner":null` (ownerless), plus `removedAt`, `removedReason`, `ownerDisabledByRemoval`. Customers and owners never see `owner`, `userId`, `removedReason`.
- Removed = `removedAt` set, closed, `approvalStatus` SUSPENDED when it was APPROVED (a PENDING / REJECTED one keeps its state); dishes, orders, settlements, category links stay; the daily settlement job still settles its delivered orders. Hidden from customers, from its own owner, from category counts; `placeOrder` answers `400 VENDOR_UNAVAILABLE`; the open toggle answers `409 VENDOR_REMOVED`.
- `disableOwner:true` (default) pauses the owner login with reason `Restaurant removed`; `restore` re-enables exactly that (flag `ownerDisabledByRemoval`), never a login an admin disabled separately. With `disableOwner:false` the login stays ACTIVE but its old sessions end.
- Ownerless (Docs/28 decision 1): `GET /vendors` for customers shows them with menu and `isAcceptingOrders:false`; `placeOrder`, quote and combined orders answer `400 { code:'VENDOR_CLOSED', message:'This restaurant is not taking orders right now.' }`; `PATCH /vendors/:id/status` and `/toggle` answer `409 { code:'NO_OWNER', message:'Add an owner login first.' }` when OPENING (closing always works); `POST /vendors` now creates closed. The admin list shows the raw `isAcceptingOrders` and `owner:null`: the dashboard draws the amber "No owner" chip from `owner === null`.

## 5. Owner logins (`routes/adminOwners.ts`; all under `/api/admin/vendors/:id/owner`)

| Call | Body | Success | Errors |
|---|---|---|---|
| `GET` | - | `{ success, owner: null \| ownerView }` | 404 |
| `POST` (create or attach) | `{ name, phone, password? }` OR `{ existingUserId }`, optional `takePayoutAccountFrom: <detached owner user id>` | **201** `{ success, owner, generatedPassword?, restaurantClosed:true, payoutAccountMoved }` (`Cache-Control: no-store`) | 400 `name`/`phone`/`password`/`existingUserId`/`takePayoutAccountFrom`; 409 `OWNER_EXISTS`, `PHONE_TAKEN` (every user incl. removed, any number format), `VENDOR_REMOVED`, `NOT_A_VENDOR_USER`, `OWNER_HAS_RESTAURANT`, `OWNER_REMOVED`, `PAYOUT_SOURCE_IN_USE`, `NO_PAYOUT_ACCOUNT`, `OWNER_HAS_PAYOUT_ACCOUNT` |
| `PATCH` | `{ name?, phone? }` (at least one) | `{ success, changed, owner }` | 400; 404 `NO_OWNER`; 409 `PHONE_TAKEN`, `OWNER_REMOVED` |
| `POST /reset-password` | `{ password? }` (empty = generate) | `{ success, generatedPassword? }` (`no-store`) | 400 `password`; 404 `NO_OWNER`; 409 `OWNER_REMOVED` |
| `POST /disable` | `{ reason, closeRestaurant?: true }` | `{ success, changed, owner, openOrders:<n>, warning? }` | 404 `NO_OWNER`; 409 `OWNER_REMOVED` |
| `POST /enable` | `{}` | `{ success, changed, owner }` | 404 `NO_OWNER`; 409 `OWNER_REMOVED` |
| `POST /detach` | `{ reason, openOrders?, closeRestaurant?: true }` | `{ success, changed, owner:null, detachedUser:{id,name}, cancelled?, failed? }` | 404 `NO_OWNER`; 409 `HAS_OPEN_ORDERS`, `ORDER_IN_DELIVERY` |
| `POST /remove` | `{ reason, confirmName (restaurant OR owner name), openOrders?, closeRestaurant? }` | same as detach, and the login is REMOVED | + 400 `CONFIRM_MISMATCH` |

`ownerView` (real): `{ userId, name, phone:'+91 9876543299', accountStatus, statusReason, lastLoginAt, createdAt, restaurants:1 }`. Real create answer: `{"success":true,"owner":{...},"generatedPassword":"<16 chars from A-HJ-NP-Za-km-z2-9>","restaurantClosed":true,"payoutAccountMoved":false}`. A typed password is never echoed.
- The password is shown once: it is in the POST answer only, never stored in plain text, never logged, never in an audit row (tests scan the whole audit table and the console). The dashboard must keep it in component state only.
- Creating or attaching an owner leaves the restaurant CLOSED (`restaurantClosed:true`): the owner signs in and opens it.
- Phone change: all sessions of that login end, push tokens stay, the owner signs in with the new number and the SAME password; login lockouts of old and new number are cleared. Reset password: all sessions end. Disable: login 403 `ACCOUNT_SUSPENDED`, restaurant closed by default, running orders untouched (an admin can drive them), `warning` when the admin keeps it open: `Orders will arrive that only an admin can accept.` Enable brings back the login only, not the open state.
- Detach: login paused (reason `Detached from <restaurant>`), sessions ended, restaurant ownerless and closed. A detached login can be attached to another ownerless restaurant with `{ existingUserId }` (same password, becomes ACTIVE). `takePayoutAccountFrom` moves the payout details to the new owner (account number re-encrypted for the new user id, verification cleared, audit `PAYOUT_ACCOUNT_CHANGED`).
- One restaurant per login and one login per restaurant are enforced inside transactions (two parallel attaches: one 201, one 409). Only users with role VENDOR are ever changed (a mislinked admin row gives 409 `NOT_A_VENDOR_USER`); no admin account can be suspended or removed through any of these routes.

## 6. Activity log (`routes/adminAudit.ts`, read only)

- `GET /api/admin/audit-log?action=A,B&targetType&targetId&actorId&q&from&to&cursor&limit` -> `{ success, count, nextCursor, data:[{ id, createdAt, action, targetType, targetId, summary, actorId, actorName, ip }] }`. Newest first (`createdAt desc, id desc`), keyset paging (`nextCursor` is opaque; pass it back as `cursor`), `limit` 1-100 (default 50; the old consumers' `limit=200` is lowered to 100, junk = 50). `from`/`to` are IST dates `YYYY-MM-DD` (max 3660 days). `q` = 2-60 characters, case-insensitive, `%` and `_` are literal. `action` = up to 20 codes `^[A-Z][A-Z0-9_]{1,59}$`. Bad value / unknown parameter = 400 with `field`. `meta` is never returned. `actorId:null` = the system (job, webhook) or a row from before actors existed.
- `GET /api/admin/audit-log/actions` -> `{ success, data:[{ action, count }] }` (last 90 days, cached 60 s). `GET /api/admin/audit-log/export.csv?...same filters (no cursor/limit)` -> `text/csv`, `Content-Disposition: attachment; filename="audit-log-<from>-<to>.csv"`, `Cache-Control: no-store`, columns `time,action,targetType,targetId,summary,by,actorId,ip`, at most 5000 rows, default last 31 days, range over 366 days = `400 RANGE_TOO_LARGE`; cells starting with `= + - @` get a leading `'`.
- Nothing can write or delete: the router has GET handlers only (any other verb = 404).
- New action codes: `CUSTOMER_SUSPENDED`, `CUSTOMER_RESTORED`, `CUSTOMER_REMOVED`, `DRIVER_REMOVED`, `DRIVER_RESTORED`, `VENDOR_REMOVED`, `VENDOR_RESTORED`, `OWNER_CREATED`, `OWNER_PHONE_CHANGED`, `OWNER_RENAMED`, `OWNER_DISABLED`, `OWNER_ENABLED`, `OWNER_DETACHED`, `OWNER_REMOVED`; reused: `PARTNER_SUSPENDED` (vendor and rider suspension, old and new route), `PARTNER_APPROVED` (reinstate), `PASSWORD_RESET`, `PAYOUT_ACCOUNT_CHANGED`, `ORDER_CANCELLED`/`ORDER_GROUP_CANCELLED`/`ORDER_REASSIGNED` (written by the normal cancel / reassign code with the admin as actor). Summaries use name + first 8 characters of the id, never a full phone or e-mail.

## 7. Decisions taken where Docs/27 / Docs/28 left room (safest option)

1. A blocked person's OLD token answers `401 TOKEN_REVOKED` + `reason` + `message`, not `403`: the three apps already treat a 401 as "sign in again" (and the sign-in then shows the 403 message); a 403 would leave an app stuck with a dead session. Sign-in answers 403 as Docs/28 decision 7 says.
2. Suspending a restaurant or rider through the OLD status route got the same open-order / delivery guard as the new endpoints (the Docs/27 text says so). Existing tests that encoded the old "suspend with running orders just works" behaviour were changed, and only those: `partner_approval.test.ts` ("suspending a restaurant ...": now asserts the 409 `HAS_OPEN_ORDERS` and then the `openOrders:'CANCEL'` result), `lifecycle_journeys.test.ts` (3 tests of J5 plus one that did not check the status: they assert the 409 `FOOD_WITH_RIDER` / `HAS_ACTIVE_DELIVERY` / `HAS_OPEN_ORDERS` and then put the partner in the suspended state with the new test helper `suspendPartnerDirect` in `test/harness/journey.ts`, to keep testing what a blocked partner can still do mid-order), `push_notifications.test.ts` (same pattern), and `settlement.test.ts` (the "newest migration" assertion now expects `20261015_admin_user_management`). Nothing else was touched.
3. Open orders include UNPAID ones (any order not DELIVERED / CANCELLED): they block with REFUSE and are cancelled (no refund needed) with CANCEL.
4. Creating / attaching an owner closes the restaurant (`isAcceptingOrders=false`) so a restaurant never goes live before its owner has signed in. The older `POST /admin/partners` with `vendorId` is unchanged.
5. `restore` of a customer or rider never re-enables push tokens or sessions; restoring a rider leaves approval SUSPENDED; restoring a restaurant leaves it SUSPENDED and closed (reinstate, then the owner opens it).
6. `disable` of an already disabled owner is `changed:false` (idempotent) rather than 409 `INVALID_STATE`; a REMOVED owner is 409 `OWNER_REMOVED`.
7. `detach` does not take `movePayoutAccount`; moving payout details is `takePayoutAccountFrom` on the following POST (as Docs/27 explains). `owner/remove` also accepts `openOrders` and `closeRestaurant`.
8. New endpoints `GET /admin/vendors/:id/impact` and `GET /admin/drivers/:id/impact` (read only) feed the confirmation dialogs; customers already carry `openOrders` / `refundsOwed` in their detail.
9. A removed owner or rider keeps the phone reserved (unique); only `scrub` frees a customer's phone.
10. `ADMIN_PASSCODE` login is unchanged (decision 4); it now also refuses a blocked admin row and records `lastLoginAt`.

## 8. Tests (backend, real PostgreSQL)

New files in `backend/test/e2e/`: `admin_foundations` (21), `admin_customers` (19), `admin_riders` (11), `admin_vendors` (18), `admin_owners` (17), `admin_audit` (10), `admin_races` (6) = 102 tests: login / token / socket / push guards (Google, partner login, passcode admin login, old token, socket), ownerless and removed restaurants, role matrix of every endpoint, rate limit, all validations, idempotency, refunds exactly once, combined orders, settlements and payouts of removed users, password-never-leaks, and races (removal vs checkout / payment / claim, two admins, restore vs sign-in) with the second request started 0-20 ms after the first. Full backend suite: 1356 tests, 46 suites, all green (1254 before + 102 new; 5 existing tests adapted as listed in decision 2).
