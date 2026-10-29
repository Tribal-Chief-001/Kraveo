# Adversarial review: admin user management (commit 95af6bc, backend)

Reviewer: read-only code reading, 29 Oct 2026. Nothing was run (no jest, no build, no DB). Every "CONFIRMED" below was traced line by line in the files named; "SUSPECTED" needs data or a running server to prove.
Scope read completely: migration.sql, schema.prisma diff, accountGuard, accountControl, actorContext, customerAdmin, riderAdmin, vendorAdmin, ownerAdmin, adminOrders, orderGuards, the five admin routes, adminInput, and the diffs of auth.ts, rateLimit.ts, realtime.ts, api.ts, partners.ts, audit.ts, finance.ts, orderFlow.ts, orderGroups.ts, payoutAccount.ts, deviceTokens.ts, catalog.ts. Also read (unchanged but touched by the new code): orderFlow cancelInTx / markOrderPaid / claimOrder / reassignOrder / finishChange, refundService, settlement.createForVendor, requireApprovedPartner, index.ts, errorHandler.

## Verdict

No BLOCKER found (no path that locks out a normal active user by itself, loses or doubles money, or lets a blocked person back in through a normal path). The core design (User row lock shared with checkout, Vendor FOR SHARE vs FOR NO KEY UPDATE, cancel only through withOrderLock + cancelInTx, refunds after commit and through the existing lease) holds up on trace. The real risks are operational / edge cases: 3 MEDIUM that can hurt on day one of the deploy, a handful of LOW race and hygiene items, and test gaps for the dangerous cases.

## Summary table (ranked by impact)

| # | Sev | Status | Area | One line | Fix size |
|---|-----|--------|------|----------|----------|
| 1 | MEDIUM | CONFIRMED (by design, deploy risk) | Ownerless guard | On deploy every restaurant with `userId = null` (the six imported ones) turns closed and unorderable at once, also if admins were handling their orders by hand | none in code; deploy checklist / attach owners first |
| 2 | MEDIUM | CONFIRMED | Rider / vendor suspend | No emergency stop: rider with food picked up cannot be suspended or removed at all (409 FOOD_WITH_RIDER, both routes); the OLD dashboard cannot suspend a restaurant that has any open order (409 HAS_OPEN_ORDERS, default REFUSE, old UI sends no `openOrders`) | S: add `force` flag that only blocks login + revokes (no cancel) / ship dashboard together |
| 3 | MEDIUM | SUSPECTED (data) | Owner lockout | `removeVendor(disableOwner:true, default)`, `disableOwner`, `detachOwner(removeUser)` suspend/remove the whole USER; if that login still runs a second restaurant (data from before the one-per-owner rule), that restaurant loses its owner | S: count the owner's other vendors under the lock, skip the user-level change or 409 |
| 4 | MEDIUM | CONFIRMED | Rollback | Rolling the backend back after the migration silently re-admits SUSPENDED customers and owners (old code ignores `accountStatus`); REMOVED ones stay out only by accident (`deletedAt`) | doc only: rollback = run an UPDATE first; or keep new code |
| 5 | MEDIUM-LOW | CONFIRMED | confirmName | Typed-name confirmation rejects any name containing U+200B-200F / 202A-202E / 2060 / FEFF (ZWJ, ZWNJ, LRM...) because `badLabel(given)` runs on the admin's input while the stored name (Google display name, unvalidated) may contain them: that customer can be suspended but never removed | S: strip INVISIBLE_CHARS from both sides, do not reject the input |
| 6 | LOW-MEDIUM | CONFIRMED (tiny window) | Block evasion | `DELETE /auth/account` takes the User lock but never looks at `accountStatus`; a request already past requireAuth when an admin suspends/removes the person erases email + googleSub (the block key) and the person can sign up fresh | S: `AND "accountStatus"='ACTIVE'` in that tx |
| 7 | LOW | CONFIRMED | Rider removal | `activeDeliveries` only counts ACCEPTED..ARRIVED_AT_GATE; an order a rider holds in status PLACED (admin pre-assign) is ignored, the removed rider stays on `driverId` and the pool never offers it | S: add PLACED to the removal check (and release) |
| 8 | LOW | CONFIRMED | Refund loop | CANCEL mode cancels and refunds serially inside the HTTP request (`finishChange awaitRefund`), no cap: removing a restaurant with 100 open orders = 100 sequential Razorpay calls in one request (proxy timeout, admin retries; safe but ugly). The report also says `refund: 'STARTED'` even when the refund then FAILED | M: `deferRefund` + background, or cap |
| 9 | LOW | CONFIRMED | Audit meta | `scrubMeta` regex `/pass(word)?|token|.../` masks harmless keys: `passwordGenerated`, `tokenVersion`, anything containing "otp" (e.g. "footprint"). The audit meta of OWNER_CREATED / PASSWORD_RESET therefore shows `"[hidden]"` instead of true/false | XS |
| 10 | LOW | CONFIRMED | Owner ops | `resetOwnerPassword` does not take the vendor lock / `sameOwner`, and two quick resets each generate a different password: the dashboard can show the older (already replaced) one | S: lock + UI shows only the last response |
| 11 | LOW | CONFIRMED | Stale read | `removeVendor` / `suspendVendor` end sessions of `v.userId` read BEFORE the lock; if an attach/detach commits in between, the wrong (or no) login is signed out (status check + 15 s cache bound the damage) | XS: use `row.userId` from the lock |
| 12 | LOW | CONFIRMED | Restore | Attaching an existing login (`existingUserId`) forces ACTIVE and clears `statusReason`: it also un-pauses a login that was suspended for another reason (any VENDOR user with 0 restaurants) | XS: only accept `OWNER_DETACHED`-style reason or require explicit flag |
| 13 | LOW | CONFIRMED | Data | A restore of a customer removed with `scrub:true` brings back an empty profile ("Removed user", coins 0, no phone); no warning in the API. Coins are forfeited by scrub | doc / warning field |
| 14 | LOW | CONFIRMED | Money ops | After a detach, settlements created while the restaurant is ownerless snapshot no payout account (`vendor.userId` null); the old details sit on the detached login until `takePayoutAccountFrom` is used on re-attach | doc |
| 15 | LOW | CONFIRMED | Rate limit | `ADMIN_ACCOUNT_WRITE` does not cover the OLD `POST /admin/partners/:kind/:id/status` (which can now cancel + refund a whole restaurant) nor `/admin/partners/:userId/reset-password` | XS |
| 16 | LOW | SUSPECTED | Old apps | A 403 on sign-in plus a 401 TOKEN_REVOKED loop: if an old customer app silently re-signs-in on 401, a suspended student hammers `/auth/google` (AUTH_IP = 60/min per IP, and campus NAT shares IPs) | prove on a real app |
| 17 | LOW | CONFIRMED | Audit | `PASSWORD_RESET` target is `('VENDOR', owner.id)` (a user id under a vendor type), so filtering by the restaurant's id never finds it; summaries contain the raw customer name (Google text, may hold bidi characters) | XS |

## Findings in detail

### 1. MEDIUM, ownerless restaurants go dark at deploy (CONFIRMED, intentional)
- `orderGuards.ts:299` (`!v.userId` -> VENDOR_CLOSED), `catalog.ts:70` (`isAcceptingOrders: !!v.isAcceptingOrders && !!v.userId`), `api.ts:785` (`setAccepting`).
- Trigger: deploy. Every `Vendor.userId IS NULL` row (the six imported restaurants) is shown closed to customers and `placeOrder` / quote / `placeGroup` refuse it, whatever `isAcceptingOrders` says.
- Effect: Docs/28 decision 1 wants this, but if any of those six currently get real orders (admin accepts them by hand) revenue stops at the moment of deploy, and customers with them in a cart get "not taking orders". Also `seedDb.ts` re-run would not help (owners usr-3.. are fine; it is only the imported six).
- Fix: before deploy run `SELECT id,name,"isAcceptingOrders" FROM "Vendor" WHERE "userId" IS NULL` and either attach owners first or accept the closure explicitly.

### 2. MEDIUM, no emergency stop (CONFIRMED)
- `riderAdmin.assertNoDelivery` (picked -> FOR ever 409 FOOD_WITH_RIDER), `riderAdmin.suspendRider`, `vendorAdmin.suspendVendor/removeVendor` (`ORDER_IN_DELIVERY` even in CANCEL mode), `partners.ts:480-490` (old route default `openOrders = 'REFUSE'`).
- Trigger A: a rider with a delivery in hand turns out to be a thief / is hurt / is abusing customers. Before this commit an admin could suspend him in one click (journey tests J5 relied on it, and were edited to bypass the API with `suspendPartnerDirect`). Now: 409 until the order is reassigned to someone else or cancelled; the account stays usable meanwhile. There is also no "block login only" action.
- Trigger B: the deployed dashboard sends `{status:'SUSPENDED', reason}` with no `openOrders`; a restaurant with ANY open order (even unpaid PLACED) now answers 409 HAS_OPEN_ORDERS and the old UI shows a generic error. Backend-before-dashboard means admins cannot pause a restaurant that has an order running until the new UI ships.
- Fix: a `force:true` (admin only, audited) that sets the login status / approval and revokes sessions without touching orders; ship backend + dashboard together or document the interim.

### 3. MEDIUM (SUSPECTED), owner who runs two restaurants
- `vendorAdmin.ts:135` (`user.updateMany ... SUSPENDED` for `row.userId`), `ownerAdmin.ts:233` (disableOwner), `ownerAdmin.ts:281-286` (detach with removeUser: user REMOVED + deletedAt), `partners.ts` `partnerIsSuspended`.
- Trigger: a VENDOR login with two `Vendor` rows (the partner-login code still handles `vendors[]`, `vendorRow = ... ?? vendors[0]`; signup and `POST /admin/partners` can only create one, so this needs old/manual data). Removing restaurant A with the default `disableOwner:true` suspends the login, so restaurant B (live, taking orders) loses its owner: `accountMatchesToken` false for every request, orders land on nobody.
- Not provable here (no DB access). Cheap to check on prod: `SELECT "userId",count(*) FROM "Vendor" WHERE "userId" IS NOT NULL GROUP BY 1 HAVING count(*)>1`.
- Fix: inside the Vendor-locked tx count `vendor.count({where:{userId:row.userId, id:{not:vendorId}, removedAt:null}})`; when > 0 skip the user-level change (or 409 OWNER_HAS_OTHER_RESTAURANT).

### 4. MEDIUM, rollback re-admits suspended accounts (CONFIRMED)
- The migration is additive; the old backend ignores `accountStatus`. After `prisma migrate deploy` + new code + some admin actions, rolling the code back: SUSPENDED customers (deletedAt null) sign in again with Google; SUSPENDED owners/riders sign in with their password. REMOVED customers hit the old `deletedAt:null` lookup, miss, and crash on the unique index (500), so they stay out by accident.
- Fix: write it in the deploy notes ("rollback: first `UPDATE "User" SET "tokenVersion"="tokenVersion"+1 WHERE "accountStatus"<>'ACTIVE'` is NOT enough; keep new code or restore from backup"). No down-migration exists; none is needed technically (additive).

### 5. MEDIUM-LOW, `confirmName` cannot match some real names (CONFIRMED)
- `adminInput.ts:44-48`: `badLabel(given)` throws CONFIRM_MISMATCH for U+200B-200F, U+202A-202E, U+2060, U+2066-2069, U+FEFF, controls. `customerAdmin.ts:141` compares with `collapse(n).toLowerCase()` of the STORED name, which for a Google student is `p.name.slice(0,60)` straight from Google (`googleAuth.ts:31`), never run through NAME_RE.
- Trigger: a customer whose Google display name contains a ZWJ / ZWNJ / LRM (Devanagari or emoji ZWJ names, or a prankster setting one on purpose). The admin pastes the name from the UI, the server rejects it, nothing the admin types can match. Removal is impossible (suspend works). Same risk for rider names (`d.user.name`), though NAME_RE-validated at signup.
- Fix: compare `nameKey(given)` to `nameKey(stored)` (both already drop INVISIBLE_CHARS) and do not call `badLabel` on the confirmation input.

### 6. LOW-MEDIUM, self-delete racing an admin block (CONFIRMED, window = ms)
- `api.ts:513-530`: `DELETE /auth/account` locks `User ... FOR UPDATE`, counts open orders, then anonymises: sets `email=null, googleSub=null, passwordHash=null, deletedAt`. It never reads `accountStatus`.
- Trace: request R passes requireAuth (ACTIVE) at t0; admin block commits at t1; R's tx gets the lock at t2 > t1 and erases the block key. The person can sign in with the same Google account as a brand-new student. For a SUSPENDED row the result is a row with deletedAt set and status SUSPENDED which `notDeletedBySelf` treats as admin-removed, and `restoreCustomer` would resurrect an anonymised account.
- Needs the person to fire the delete at the exact moment of the admin action; low odds, trivial fix: `SELECT "accountStatus" ... FOR UPDATE` in that tx and 409/401 when not ACTIVE.

### 7. LOW, a rider holding a PLACED order
- `riderAdmin.activeDeliveries` uses `ACTIVE_RIDER_STATUSES` (ACCEPTED, PREPARING, READY_FOR_PICKUP, PICKED_UP, ARRIVED_AT_GATE). `reassignOrder` (admin) allows assigning any non-terminal PAID order, including PLACED. A removed rider then stays `driverId` on that order; when the restaurant accepts it, `isPoolEligible` needs `driverId === null` so it is never offered and nobody can deliver it until an admin reassigns (reassign works). Same applies to `suspendRider`.
- Fix: include PLACED in the removal / release query.

### 8. LOW, serial refunds in the request (CONFIRMED)
- `adminOrders.cancelOneGuarded` -> `finishChange(result, { awaitRefund: true })` -> `executeRefund` per order; `cancelOrdersGuarded` loops. Each provider call is bounded (`withProviderTimeout`) and `runRefund` never throws, so money is safe and exactly once (lease + provider list check), but a big removal keeps the HTTP request open for minutes, the proxy times out, the admin clicks again (safe, `changed:false`).
- `cancelled[].refund = 'STARTED'` is reported whether or not the refund then succeeded; the admin must read `refundsOwed` / REFUND_FAILED. Refund failures are retried by the maintenance sweep, so no money is stranded.

### 9-17. See table. Code references: audit.ts:5 (regex), ownerAdmin.ts:212-224 (reset), vendorAdmin.ts:89 and 148 (`v.userId`), ownerAdmin.ts:143 (attach forces ACTIVE), customerAdmin.ts:159 (scrub), settlement.ts:142 (snapshot), rateLimit.ts:156-161 (regex only matches customers|drivers|vendors), ownerAdmin.ts:222 (target).

## Hunt checklist and result

### (1) Lockout of the wrong people
- Id confusion: SAFE. Customer routes use `role='STUDENT'` in both the read and the locked SQL (`customerAdmin.ts:58,111,131,188`); a rider/owner/admin/unknown/`ven-3` id is a 404. Owner routes check `owner.role === 'VENDOR'` (`ownerAdmin.ts:52`); rider routes check `d.user.role === 'DRIVER'` (`riderAdmin.ts:288,323`; `suspendRider` does not, but it only touches DriverPartner and revokes the linked user, harmless). `loadRider` accepts DriverPartner id OR user id; uuid vs `usr-` seed ids cannot collide. `validParams` accepts `ven-3` (ID_RE) and the lookups just 404.
- Admin removal of the only admin / self: SAFE, no route can target an ADMIN row (test `admin_foundations` 365+ covers it; code agrees).
- Guard misfire for ACTIVE users: SAFE. Column is NOT NULL DEFAULT 'ACTIVE', so no null on legacy rows; `accountMatchesToken` compares `!== 'ACTIVE'` on a non-null enum; seed/demo users get ACTIVE from the migration default. Google sign-in of a new student takes the create branch unchanged (P2002 fallback is new but only on a race).
- Cache poisoning: blocked state is never cached (`auth.ts:59-61` deletes the entry, only ACTIVE rows are cached) and `bumpTokenVersion` clears the entry, so "stale BLOCKED after restore" cannot happen. "Stale ACTIVE after block": only the sub-millisecond race where a request read the row before the commit and sets the cache entry after `invalidateAuthCache` (then the OLD token passes for up to 15 s, pre-existing design, LOW), and when `bumpTokenVersion` itself fails (swallowed in `revokeUserEverywhere`).
- Old builds: sign-in 403 with `{code,message}` and 401 TOKEN_REVOKED + `reason`/`message`: same status codes the apps already treat as "sign in / error", can only be proven on real builds (list below).
- `lastLoginAt`: SAFE for load. Written only in `touchLogin` at Google / partner / admin sign-in (once per sign-in, not per request), failures swallowed, partner-login awaits one `updateMany`.
- Detach / owner orphan: restaurant ends ownerless and closed (`closeRestaurant` default true; even if left open the ownerless guard refuses orders); owner login paused and signed out; payout details stay on the login. SAFE except finding 3 / 14.

### (2) Bypass of a block
- Other token types / refresh: none exist (one 30-day JWT, `generateToken`), every verify goes through `accountMatchesToken` (requireAuth, sockets, `optionalViewer`). SAFE.
- Admin passcode path: unchanged and now refuses a blocked admin row; no route can block an ADMIN. SAFE.
- Sockets: handshake via `verifyTokenForAccount`; live sockets closed by `disconnectUser` (all sockets are in `user_<id>`); late joiners caught by the post-join `accountMatchesToken` re-check. SAFE (single process).
- Push: `activeTokensFor` filters `user.accountStatus ACTIVE, deletedAt null`; tokens disabled; fcmToken wiped; `push/events` skips deleted customers. SAFE.
- REST without requireAuth: only `/payments/webhook`, public catalog GETs, banners, auth routes, uploads. The webhook has no account check on purpose (late-payment refund path). No public order tracking exists. Razorpay verify / cancel / delete-account all sit behind requireAuth (token dead). Exception: finding 6 (in-flight delete-account).
- Group paths: placeGroup re-checks customer + every vendor under lock. SAFE.
- `partner-login` ordering: identity proven first, then blocked answer, so no enumeration oracle. SAFE.

### (3) Money
- Single refund exactly once: cancel goes through `withOrderLock` + `cancelInTx` (a second caller sees `alreadyCancelled`), refund claimed with `refundLeaseUntil` and provider refund list. Two admins / double click: SAFE (tests agree).
- Group cancel cascade: whole group cancelled once, only the primary carries the refund, in-delivery siblings block first (`findOpenOrders` looks at siblings). SAFE.
- Order with payment still PENDING: cancelled without refund; a payment arriving later goes to `markOrderPaid` -> `LATE_PAYMENT_REFUND` (no account check, so it works for removed/scrubbed customers). SAFE.
- Removed restaurant settlement: `createForVendor` has no approval / removedAt filter, settles delivered orders; payout lookups accept REMOVED users (`deletedAt && status !== 'REMOVED'`). SAFE. Payout snapshot is empty while ownerless (finding 14).
- Rider payout for a removed rider: `createRiderPayout` and `finance.ts:152` accept REMOVED riders. SAFE.
- `scrub:true` erasing data read later: refund and settlement code read only order/payment rows, never the customer's name/phone (grep of refundService, settlement, finance, orderMaintenance, paymentReconcile). SAFE. Receipts/CSV show vendor names only.
- Refund failure in CANCEL mode: `runRefund` never throws; FAILED + retry sweep; admin `retry-refund` exists. Reported as `STARTED` (finding 8).
- Provider calls inside DB transactions: none added (all cancels/refunds run after commit). `createPaymentForOrder` calls Razorpay under the order lock but that is old code.
- Deadlocks: new lock orders are User(customer) -> Vendor SHARE ascending (checkout), Vendor NO KEY UPDATE -> User(owner) (vendor/owner admin), DriverPartner -> User(rider) (rider admin), Order locks only in cancel. A customer is never an owner, so no User/Vendor cycle; `movePayoutAccountInTx` takes PayoutAccount rows ascending; existing code takes rider -> group -> orders as before. No inversion found. Note: checkout's `FOR SHARE` now also conflicts with old `Vendor ... FOR UPDATE` tx (catalog, menu import) for their duration, but the FK key-share of the order insert already conflicted with those, so not new.

### (4) Owner login
- Password: 16 chars from a 57-letter alphabet with `crypto.randomInt` (about 93 bits). SAFE. Response `Cache-Control: no-store` on create and reset; no request/body logging anywhere (index.ts, errorHandler log `errSummary` only, first line); audit rows and `meta` carry no password (scrubMeta + tests scan the audit table). `req.rawBody` keeps the buffer in memory only. SAFE.
- Phone: canonical `+91 XXXXXXXXXX`, uniqueness checked with `endsWith last10` across ALL users (removed too) and P2002 mapped to 409 PHONE_TAKEN in create and patch; login lookup uses the same last-10 key. A race between two different legacy formats of the same number is only possible if legacy rows are not canonical (not found in code). SAFE.
- Reset password / phone change bump `tokenVersion`, clear the cache, disconnect sockets. SAFE.
- Attach to a restaurant that has an owner: 409 OWNER_EXISTS inside the UPDATE (`userId: null` in the WHERE). SAFE. One restaurant per login: advisory lock + count. SAFE. See 3 and 12.
- Payout details follow only on explicit `takePayoutAccountFrom`, re-encrypted for the new user id, in the same tx. SAFE.

### (5) Audit
- Actor present on every admin write via AsyncLocalStorage set in `requireAuth` (tests show it survives Prisma); jobs/webhooks write system rows. `payoutAccount.revealAccountNumber` sets actor by hand. SAFE.
- Search escapes `%`, `_`, backslash; keyset cursor uses `(createdAt, id)` with equal timestamps handled; CSV neutralises `= + - @ TAB CR`; `meta` never returned; caps on keys/depth/strings in `scrubMeta`. SAFE. LOW: `q` without `from/to` scans the whole table (ILIKE), meta size is bounded only by callers (cap is per level, not total).

### (6) Input validation
- `strictBody` rejects unknown keys (including an own `__proto__` key from JSON.parse), arrays, non-objects; texts go through `badLabel` (control/bidi/zero-width) and length caps; enums and booleans strict; ids regex-checked. SAFE except finding 5.
- Rate limit: `ADMIN_ACCOUNT_WRITE` regex runs on the lower-cased, slash-normalised path, so spelling tricks do not skip it. Covers every new POST/PATCH. Not covered: finding 15.

### (7) Migration safety
- One transaction, `lock_timeout 5s`, `statement_timeout 60s`, `CREATE TYPE` guarded, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. PG 11+ adds `NOT NULL DEFAULT 'ACTIVE'` without a rewrite. The non-concurrent index builds hold a write lock on `User` / `Vendor` / `AdminAuditLog` for the build (tables are small). If `lock_timeout` hits, the whole script rolls back and Prisma records it failed: `prisma migrate resolve --rolled-back 20261015_admin_user_management` then redeploy. Old backend keeps working on the new schema. Deploy order must be migration, backend, dashboard (new code on the old schema = every auth call 503). No down-migration (finding 4).

### (8) Regressions in shared files
- `/auth/google` lookup no longer filters `deletedAt`; self-deleted rows have email/googleSub null so they never match; defensive null at `api.ts:238`. SAFE.
- `/auth/partner-login` no `deletedAt` filter but the same self-deleted guard (`api.ts:306`); `findFirst endsWith` has no orderBy, only an issue if two users' phones share the last 10 digits (blocked at creation).
- `writeAudit` is now async with one cached name lookup; same never-throws behaviour. `activeTokensFor` adds a relation filter (one join).
- `publicVendorView` is called only with full vendor rows (both callers in api.ts), so `!!v.userId` cannot wrongly close restaurants. `fullVendorView` strips `user`, `removedReason`, `ownerDisabledByRemoval` for owners and never includes the owner's phone for customers.
- Old partner status route: same response shape plus `changed`/`cancelled`; `next==='APPROVED'` refuses removed rows; behaviour change in finding 2.
- Seeded vendors (usr-3, usr-6, usr-7 owners) are unaffected; `seedDb.ts` is a stand-alone script, not run at boot.

## Test gaps (what the 102 new tests do not assert)
1. `DELETE /auth/account` racing an admin suspend/remove (finding 6); delete-account of an already-SUSPENDED row.
2. Owner (or rider) with TWO restaurants: removeVendor(disableOwner), disableOwner, detach(removeUser) (finding 3).
3. `confirmName` for a name containing ZWJ/ZWNJ/RLO (finding 5); riders and owners too.
4. Auth cache ON (`AUTH_CACHE_TTL_MS` > 0): every admin test runs with TTL 0 (`NODE_ENV=test`), so cache invalidation after suspend, owner disable, `removeVendor` owner change and the "read before commit, cache after" race are untested.
5. A rider holding a PLACED order at removal (finding 7); reassign to a rider that is removed at the same moment.
6. Backend rollback / old-schema behaviour (finding 4) and the migration on a table with live concurrent writes.
7. Many open orders (50+) under CANCEL: duration, partial `failed`, retry; refund FAILED after a CANCEL (the response says STARTED).
8. Restore of a scrubbed customer then a Google sign-in and an order (needsProfile path through checkout).
9. Old status route throttling (finding 15) and bulk cancel via that route.
10. A customer whose phone was freed by scrub being re-used by a new owner/partner, then the scrubbed customer restored (phone null, no collision) and the reverse (restore while the phone is taken, not applicable since phone is gone).
11. A second admin session-based actor: all admin actions share ONE user row (`admin-login` picks the first ADMIN), so `actorId` can never tell two humans apart: expected per Docs/28 decision 4, but the audit viewer's "who" column is really "the admin passcode".
12. Concurrency: simultaneous `reset-password` double click (finding 10); `attach` vs `removeVendor` (finding 11).

## Only provable on a running server / real apps
- Old customer, vendor and driver app builds against the new 403 sign-in answer and the 401 TOKEN_REVOKED `reason`/`message` (do they show the message, loop on silent re-login, hit the AUTH_IP limit?).
- The real dashboard build against `HAS_OPEN_ORDERS` on the old suspend route (finding 2) and the 30 per 10 min `ADMIN_ACCOUNT_WRITE` limit when all admins share one account.
- The migration on the production database: lock time on `User` under real traffic, index build time on `AdminAuditLog`, Prisma history table state.
- Prod data checks: owners with more than one restaurant (finding 3); count of ownerless restaurants and whether they currently receive orders (finding 1); any customer or rider names with hidden characters (finding 5).
- Razorpay live behaviour: refund timing for 20+ cancellations in one request, a captured payment arriving after cancel + scrub, webhook retries after the customer is removed.
- nginx proxy timeout vs a long CANCEL request (finding 8) and `Cache-Control: no-store` surviving the proxy on the password responses.
- Socket behaviour on a real phone: reconnect storm after `disconnectSockets`, FCM delivery stopping after suspend.
- Multi-instance behaviour (not the current setup): auth cache and `disconnectUser` are per process.

## What I did not check
Dashboard code (not part of this commit), the apps, Flutter parsing of the new error shapes, `jest` results (not run, per rules), Razorpay sandbox, production data. The "1355/1356" claim in the commit message was not re-verified.
