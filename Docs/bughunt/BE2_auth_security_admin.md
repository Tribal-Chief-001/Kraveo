# BE2 - Backend auth, security, admin, vendor/location (bug hunt, 6 Oct 2026)

Hunter: BE2. Read-only. Method: read every line in scope, traced the code, ran one throw-away Express snippet (scratchpad, no repo change) to prove the rate-limit bypass, and one `node -e` regex check.

## 1. Scope covered

Read completely: `backend/src/index.ts`, `db.ts`, `realtime.ts` (sockets: auth, rooms, location), `middleware/{auth,rateLimit,errorHandler}.ts`, `routes/{api,partners}.ts` (whole files), `routes/devices.ts`, `routes/orders.ts` lines 1-360 (only the auth/role/gate parts), `config/{runtimeConfig,campus}.ts`, `services/{vendorLocation,audit,googleAuth,password,loginLimiter}.ts`, `services/push/deviceTokens.ts`, `utils/{log,phone,http,stateMachine,catalog,validation,seedDemoPartners}.ts`, `utils/seedDb.ts` (vendors/users part), `store.ts` (head), `prisma/schema.prisma`, `package.json`, `.gitignore` (backend and root), `.env` (names and lengths only), `scripts/build_mobile_apks.sh`, `ORDER_FLOW_NOTES.md`, `Docs/15_auth_v2_contract.md`, `Docs/council_audit/sec.md` + master roadmap (to check what is still open), tests: `auth_pipeline`, `test/harness/{app,auth,db}`, and the test lists (titles, plus the rate-limit/admin-login/login-limiter/config blocks in full) of `partner_approval`, `vendor_location`, `hardening`, `campus_maps`.

Not read line by line (other hunters' territory): `orderFlow.ts`, `orderView.ts`, `refundService.ts`, `paymentService.ts`, `paymentReconcile.ts`, `orderMaintenance.ts`, `services/push/{events,pushService,provider}.ts`, `routes/orders.ts` lines 360+, payment/lifecycle/push tests; test bodies of `partner_approval`, `vendor_location`, `campus_maps`, `hardening` (read the titles and the security-relevant blocks only).

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 2 |
| MEDIUM | 11 |
| LOW | 7 |

No remotely exploitable authz/IDOR/injection hole found in scope. Authz, token revocation and validation are in good shape. The demo risks are product/operational traps (phone numbers, names, lockouts) and wrong dashboard numbers.

Earlier-audit items in my scope, status now (not re-listed as findings): SEC-01 sign-up spam and global 80/h cap: still open (see BE2-04). SEC-02 coupon reset by delete-and-resign-in and any Gmail: still open (owner decision). SEC-03 shared admin passcode, 30-day token, no actor in audit log: still open. SEC-06 partner lock by third party: still open (BE2-09). SEC-07 `NODE_ENV=test` bypasses: still in code. SEC-08 no security headers, `uncaughtException` swallowed: still open (BE2-08). SEC-09 demo vendors `ven-1/ven-2` on prod: cannot be verified from the repo (check the prod DB). M-18 every dish is veg: still open (BE2-13). P1.17 timezone/avg delivery/vendor rating: all still open (BE2-05, BE2-06). M-05 test harness wipes any DB it points at: no guard yet (BE2-17). Verified fixed since the audit: JWT secret on prod is not the public default (audit forged a token and prod refused it); token revocation (`tv`), per-IP admin lockout, `trust proxy 1`, role checks on partner routes, rider list PII, coupon rules.

## 3. Findings

### HIGH

**BE2-01 - One phone number = one account across ALL roles; the presenter cannot use the same number for the customer app and the restaurant/rider app** - HIGH (demo trap) - CONFIRMED
- Where: `backend/src/routes/partners.ts:199` (sign-up duplicate check across every user, `endsWith last10`), `routes/api.ts:483` (admin create, same check), `routes/api.ts:412` + schema `User.phone @unique`, `routes/api.ts:238` (partner-login looks the number up across STUDENT too).
- Trigger: a presenter signs into the customer app with Google and (mandatory for `needsProfile`) saves their own mobile as the profile phone. Later, on stage, signs up a restaurant or rider in the partner app with the same mobile. Or the reverse order.
- What happens: `POST /auth/partner-signup` answers 409 "This phone number already has an account. Try logging in." Logging in answers 401 "Wrong phone or password." (the student row has no password). In the reverse order the customer profile save answers 400 field phone "This phone number is already used by another account." Nothing tells the user the number belongs to the OTHER app.
- Demo impact: the "new restaurant signs up and is approved" scene dies on the first screen if the same phone was used earlier as a customer. Very likely with one presenter and two phones.
- Fix: operational today: use a different number for each role and tell the team. Code (S): make the 409 text say "already used by another Kraveo account (for example the customer app). Use a different number." Real fix (M, OWNER-INPUT): allow one number as a customer and as a partner (separate uniqueness per role) - needs a schema change, not for tomorrow.
- OWNER-INPUT: yes (policy).

**BE2-02 - Name validation rejects Hindi/Tamil/any script with combining marks, curly apostrophes, and digits** - HIGH for an Indian campus audience (MEDIUM if everyone types English) - CONFIRMED (regex run)
- Where: `routes/api.ts:138` (`NAME_RE`) used at `:374` (profile) and `:478` (admin create); `routes/partners.ts:23` used at `:185` (partner-signup name) and `:336` (re-apply). The regex is `^[\p{L}][\p{L}\s.'\-]{1,59}$`: letters only. Devanagari vowel signs (matras) are `\p{M}`, not `\p{L}`.
- Trigger: `PUT /auth/profile {name:"राहुल शर्मा"}` -> 400 "Enter your full name (2-60 letters)." Same for "அருண் குமார்", "D’Souza" (U+2019), "Ramesh 😀". Partner sign-up with a Hindi owner name -> 400 field name. A Google name like "RAHUL SHARMA 22BCE10123" (common for VIT-managed accounts) is accepted on first sign-in (`api.ts:204`, no validation) but then the profile screen that submits the unchanged name is rejected.
- Demo impact: an audience member (or the restaurant owner) types a name in Hindi and cannot finish sign-up; the error text says "letters" which looks wrong to them. Restaurant name and address are not affected (they use `clean()` only).
- Fix (S): allow marks and ASCII/curly apostrophes: `/^[\p{L}][\p{L}\p{M}\s.'’\-]{1,59}$/u`; allow digits only if the owner wants reg numbers in names (OWNER-INPUT); also normalise Google names the same way when creating the user. Add a test with a Hindi name.
- OWNER-INPUT: digits yes/no.

### MEDIUM

**BE2-03 - Admin passcode lock is per public IP: five wrong guesses from anyone on the same Wi-Fi lock the presenter out for 15 minutes** - MEDIUM (demo risk) - CONFIRMED
- Where: `routes/api.ts:34, 289-303`; test `hardening.test.ts:546` even asserts "stays locked, even with the right code". State is in memory.
- Trigger: the demo laptop is on campus Wi-Fi (one NAT address for hundreds of phones); a curious student opens the dashboard and tries a few passcodes, or the presenter typos five times (caps lock). `req.ip` is the shared NAT address.
- What happens: `429 RATE_LIMITED` for the whole address; the correct passcode is also refused. Only a server restart (in-memory) or waiting clears it. The dashboard shows a generic login error.
- Fix: operational: demo from a phone hotspot, and know the recovery: `pm2 restart` clears the lock. Code (S): count failures per (IP + a client-chosen device id) or allow a correct passcode to pass while only throttling the speed; at minimum raise to 10 per 15 min. Also confirm the passcode is long and random (cannot be checked here).
- OWNER-INPUT: passcode strength on prod.

**BE2-04 - Partner sign-up throttle: three tries per phone per hour count even the 409 and rehearsal attempts; one script blocks everybody for an hour** - MEDIUM - CONFIRMED
- Where: `routes/partners.ts:66-79, 196-198`. `allowSignup` runs after validation and BEFORE the duplicate check, so a 409 counts.
- Trigger A (rehearsal): sign up the demo restaurant 3 times within an hour with the same phone (e.g. after deleting the rows in the DB between rehearsals); the 4th attempt on stage is `429 Too many sign-up attempts. Please try again in an hour.` Trigger B (attack): 80 valid-looking sign-ups with fresh phones from anyone block all real sign-ups for the hour and fill the approval queue (`partner_application` socket toasts to the admin dashboard).
- Fix: operational: rehearse with different phones, or `pm2 restart` right before the demo (counters are in memory). Code (S): count only successful creations for the per-phone limit; per-IP limiter.
- OWNER-INPUT: keep open sign-up at all? (audit SEC-01).

**BE2-05 - Rate-limit rules are bypassed by a trailing slash or other letter case** - MEDIUM (security) - CONFIRMED (Express snippet: `req.path` was `/orders/`, `/ORDERS`, rule compared with `=== '/orders'`; the route still answered 200)
- Where: `middleware/rateLimit.ts:249` (ORDER_CREATE), `:255` (PAYMENT_CREATE), `:257` (DEVICE_WRITE only the slash is tolerated, not case), `:259` (VENDOR_LOCATION, case), `:261-262` (AUTH_IP list of exact paths), `:251-252` (cancel: case).
- Trigger: `POST /api/orders/` or `/api/Orders` instead of `/api/orders`; `POST /api/auth/partner-signup/` etc.
- What happens: the per-user order/payment/location limits and the per-IP auth cap are skipped. Remaining brakes: `MAX_UNPAID_OPEN_ORDERS` (3), the in-handler admin/partner failure limiters (not path dependent), the sign-up per-phone cap. So: unlimited `payments/create-order` calls (Razorpay API traffic), unlimited location writes, unlimited Google/sign-up calls per IP.
- Fix (S): in the middleware use `const p = req.path.toLowerCase().replace(/\/+$/, '') || '/'` before matching; add a test for `/api/orders/` and `/api/ORDERS`.

**BE2-06 - Dashboard analytics: wrong hours/"today" (server time zone) and wrong average delivery time** - MEDIUM (admin demo) - CONFIRMED in code; server TZ SUSPECTED (EC2 default is UTC)
- Where: `routes/api.ts:763` (`from.setHours(0,0,0,0)` for range=today), `:778` (`createdAt.getHours()` for the hourly chart), `:785` (average delivery = `updatedAt - createdAt`).
- Trigger: open the Analytics view. On a UTC server a 14:00 IST order is in the "08:00" bar, "Today" starts at 05:30 IST, and the average delivery minutes include payment time. Also `POST /reviews` updates the order row (`:916`), which bumps `updatedAt`, so every review a student leaves makes that order's "delivery time" grow to the review time (could show hours).
- Demo impact: after you deliver demo orders and review one, the "average delivery" jumps (e.g. 3 min -> 40 min) and the hourly chart peak is at the wrong clock hour.
- Fix (S): compute with explicit IST (`Asia/Kolkata`) or set `TZ=Asia/Kolkata` in PM2; use `deliveredAt - createdAt` (or `paidAt`) for delivery time. Test with an order reviewed an hour after delivery.

**BE2-07 - Restaurant rating is computed from the DRIVER rating** - MEDIUM (wrong visible data) - CONFIRMED
- Where: `routes/api.ts:944` (`ratingToUse = driverRating ?? 4.5`), `:956-966`. The request has no restaurant star field at all; `dhabaNotes` is text only.
- Trigger: a student rates the rider 1 star and the food 5 stars -> the restaurant's rating (shown to every customer) goes down. A review with no `driverRating` pulls the restaurant toward 4.5 and stores `driverRating: 5` for the rider (`:976`).
- Also (LOW): dish rating bootstraps with `ratingCount || 10` (`:926-927`) so the first review of a brand-new dish (count 0) stores count 11 and shows "11 ratings".
- Fix (S/M): accept `dhabaRating` and use it for the vendor; do not store a default 5 for a missing driver rating; start dish counts at 0. Coordinate with the customer app (field name).
- OWNER-INPUT: the customer app must send the restaurant stars (check the review screen).

**BE2-08 - `uncaughtException`/`unhandledRejection` are swallowed; a failed `listen()` leaves a zombie process that still runs the maintenance job** - MEDIUM (chaos) - CONFIRMED in code
- Where: `src/index.ts:33-40, 114-116`. `startOrderMaintenance()` starts before `server.listen`, and the server has no `'error'` listener, so `EADDRINUSE` (a second manual `npm start`, a PM2 double start, a restart before the old process freed the port) is caught by the global handler and logged; the process keeps running with no HTTP/socket but with refunds, reminders and expiry running.
- Trigger: hot-fix on demo morning: `pm2 start` while another instance holds the port, or a manual `node dist/index.js` for a test.
- What happens: PM2 shows "online", `/health` is still answered by the OTHER process, so nothing looks wrong; two processes run maintenance (leases make refunds safe, vendor reminders are idempotent) and the new code is NOT serving. You think the fix is live when it is not.
- Fix (S): `server.on('error', (e) => { console.error(...); process.exit(1); })`; in the global handlers log and `process.exit(1)` for `uncaughtException` (PM2 restarts). Also log with `errSummary` (see BE2-16).

**BE2-09 - Partner login can be locked by anyone who knows the phone number; the lock beats the correct password** - MEDIUM - CONFIRMED (known as SEC-06, still open)
- Where: `services/loginLimiter.ts:7-27`, `routes/api.ts:233-236` (lock checked before the password), test `auth_pipeline.test.ts:262` asserts the right password is refused while locked.
- Trigger: 5 wrong passwords against the restaurant owner's number (it is printed on menus).
- Demo impact: a hostile student (or a typo storm by the presenter) locks the restaurant/rider demo account for 15 minutes; existing sessions keep working, a fresh login does not.
- Fix (S): OPS: log the demo accounts in beforehand and do not log out; `pm2 restart` clears locks. Code: key the lock on (phone + IP) or let a correct password through after the lock with an extra delay.

**BE2-10 - Sockets: `join_room` is not rate limited and each `order_*` join runs a heavy DB query; no cap on connections** - MEDIUM (DoS, needs one student account) - CONFIRMED in code
- Where: `realtime.ts:97-107` and `canJoin` `:58-62` (`order.findUnique` with `ORDER_VIEW_INCLUDE` per call); `index.ts:67` (default socket.io options, no limits).
- Trigger: a logged-in student loops `join_room` with random `order_<id>` names 1000 times a second, or opens thousands of sockets.
- What happens: a heavy query per event on a t3.micro; the live demo (orders, alarms) slows down.
- Fix (S): per-socket counter (e.g. 20 joins per minute), `maxHttpBufferSize` smaller, per-user socket cap.

**BE2-11 - New restaurant appears to customers as a closed, empty card after approval** - MEDIUM (demo flow) - CONFIRMED
- Where: `routes/partners.ts:211` (sign-up: `isAcceptingOrders:false`), `:428` (approval keeps it false), `routes/api.ts:581-590` (`GET /vendors` returns every APPROVED vendor, with zero menu items and closed state). Test `partner_approval.test.ts:406` documents "approval does not open it".
- Trigger: demo scene "restaurant signs up, admin approves": immediately after approval the customer app lists the new restaurant with no dishes and closed (what the customer app shows for that is the other hunters' scope).
- Fix (S, OWNER-INPUT): either `GET /vendors` hides APPROVED vendors with no available items, or the owner is told to add a dish and tap Open before refreshing the customer app. Script the demo: approve -> owner adds dish -> owner opens store.

**BE2-12 - A restaurant cannot rename, delete or describe a dish; every dish is veg** - MEDIUM (demo "add dish") - CONFIRMED
- Where: `routes/api.ts:698-722` (create), `:808-834` (patch accepts only `isAvailable` and `price`), no DELETE route; `validateMenuItemFields` supports `isVeg`/`description`/`imageUrl` but the vendor app sends only name/category/price (`apps/vendor_app/lib/services/vendor_backend.dart:279`), so `isVeg` is always true (audit M-18 still open) and the photo is always the stock image.
- Trigger: on stage the owner mistypes "Panner" or adds a non-veg dish: it cannot be corrected (only hidden with the availability toggle) and non-veg shows the green veg mark.
- Fix: S for the veg flag (vendor app must send `isVeg`; the backend already validates it); M for edit/delete (`PATCH /vendors/items/:itemId` accept `name/category/description/isVeg`, add `DELETE`). For tomorrow: type dishes carefully, or fix typos from the DB.

**BE2-13 - Student phone numbers are unverified AND unique: squatting and number enumeration** - LOW-MEDIUM (griefing) - CONFIRMED
- Where: `routes/api.ts:382-386, 412` (any student can claim any unclaimed number; `needsProfile` requires a phone, `:144`).
- Trigger: a student saves the presenter's/friend's mobile as their own phone first. The real owner then gets 400 "already used by another account" on the profile step, stays `needsProfile=true` and cannot finish onboarding. Also the 400 text lets anyone test whether any mobile number is registered in Kraveo (no rate limit on `PUT /auth/profile`).
- Fix (M): OTP-verify phones (out of scope for tomorrow). Cheap (S): rate limit profile writes; make the message neutral. OWNER-INPUT.

### LOW

**BE2-14 - Reviewer shown as "Deleted" after account deletion** - LOW - CONFIRMED. `routes/api.ts:1068` takes the first word of `customer.name`, which is "Deleted user" after `DELETE /auth/account` (`:449`). Fix (S): show "Student" when `deletedAt` is set (select `deletedAt`).

**BE2-15 - Account deletion leaves live sockets and a few rows** - LOW - CONFIRMED. `routes/api.ts:438-465` does not `disconnectSockets` (the suspend/reset paths do). Remains by design: orders (drop-off notes, address), payment rows, review text, disabled device tokens for 60 days, push logs 14 days. A deleted student can create a new account with the same Google login and get VITFIRST/KRAVEO50 again (known SEC-02). Fix (S): call `io.in('user_<id>').disconnectSockets(true)`.

**BE2-16 - Crash handlers print the raw error object** - LOW. `index.ts:35, 39` log `err`/`reason` fully; Prisma errors embed query arguments (phones/emails) in the message, which `errSummary` was written to avoid. Fix (S): use `errSummary`.

**BE2-17 - Test harness has no guard against pointing at a real database** - LOW (reminder of audit M-05). `test/harness/db.ts:121-132` deletes all payments/orders; `.env` here points at `localhost:5432/kraveo`. The safe procedure exists in memory notes (port 55440) but nothing enforces it. Fix (S): refuse unless the DB name ends `_test`. Also: no test covers a trailing slash/case on rate-limited routes (BE2-05), and the real Google verifier (audience/issuer/expiry) is never exercised (tests inject a fake).

**BE2-18 - Phone normaliser is permissive** - LOW. `utils/phone.ts:2-7`: strips every non-digit and takes the last 10, so "+44 7123456789", "abc9876543210xyz" and any 11-13 digit string ending in a valid 10-digit pattern are saved as +91 numbers. Fix (S): require the `+91`/`0`/`91` prefix or exactly 10 digits.

**BE2-19 - Unused heavy dependency** - LOW. `package.json` lists `@aws-sdk/client-ec2` (never imported in `src/`); it enlarges `npm ci` on a 1 GB box and the supply-chain surface. Fix (S): remove it (and `axios` as direct dependency; razorpay brings its own).

**BE2-20 - Admin token cannot be revoked** - LOW (known SEC-03). All admin logins share one user row; no endpoint bumps its `tokenVersion`, so a leaked admin token lives 30 days. Fix (S): add an admin-only "sign out everywhere" that calls `bumpTokenVersion(adminUser.id)`.

## 4. Looked hard and found nothing

- JWT: HS256 only, expiry enforced, `tv` revocation checked on every request and on socket connect; suspended/reset/deleted accounts lose access within 15 s cache at most (cache cleared on this instance at the same moment).
- Role confusion: students cannot reach vendor/driver/admin routes; `canManageVendor` blocks cross-vendor menu/status/toggle edits; `requireApprovedPartner` covers every partner write; PENDING/REJECTED/SUSPENDED cannot join `vendor_*`/`drivers` rooms; suspended partner sockets are closed.
- Rider location: a rider can only write their own position (id from token); only admin may pass `driverId`; non-admin `GET /drivers/locations` returns only their own row.
- Admin-only data (customers' email/phone, partners' UPI/emergency phone, audit log, payments) is behind `requireRole('ADMIN')`; public vendor/menu views are field-whitelisted; `GET /drivers/:id` for riders strips PII.
- Google sign-in: audience list, library-verified issuer/expiry, `email_verified`, link-by-sub, no re-pointing, partner emails refused.
- Password handling: scrypt N=16384, random salt, constant-time compare, dummy hash for unknown phones, identical 401 text; per-phone and per-IP failure limiters run before the expensive hash.
- Mass assignment: profile, vendor, menu, review and signup bodies are whitelisted; `__proto__` bodies are inert; numbers must be JSON numbers; `1e999` is rejected by `isFinite`.
- SQL: only tagged `$queryRaw` with parameters; no string-built SQL.
- Body size (100 KB default), 413/400 handling, no stack/Prisma text leaks, CORS allow-list (no cookies used, so no CSRF), `x-powered-by` off.
- Delete-account: row-locked, blocks while an order is live, anonymises, revokes tokens and push tokens.
- Boot with missing env: refuses to start (checked by a child-process test).

## 5. Top 5 to do before the demo

1. BE2-01: decide the phone numbers for each role today (student, restaurant, rider, admin all different) and write them on the run sheet; improve the 409 message if time permits.
2. BE2-02: relax `NAME_RE` (allow `\p{M}` and U+2019) in `api.ts:138` and `partners.ts:23`; 5-minute fix plus one test.
3. BE2-06: set `TZ=Asia/Kolkata` for the PM2 process (or compute IST) and use `deliveredAt`; otherwise do not show the Analytics numbers on stage.
4. BE2-08 + BE2-03/04/09 (ops): add the `server.on('error', exit)`/exit-on-fatal handler (S); and `pm2 restart` right before the demo to clear in-memory lockouts and sign-up counters; demo from a hotspot so one shared Wi-Fi IP cannot lock the admin.
5. BE2-05: normalise the path in `rateLimitMiddleware` (lowercase, strip trailing slash) before the rule matching.

## 6. Can only be proven on a real device/server

- Server time zone of the EC2 box (BE2-06), whether nginx really appends `X-Forwarded-For` and port 5000 is closed to the internet (audit saw it time out), the strength of `ADMIN_PASSCODE`, whether `ven-1/ven-2` and seed users still exist on prod (SEC-09), and whether the customer/vendor apps pre-fill a Google name with digits (BE2-02).
- The Hindi-name rejection screens (BE2-02) and what the customer app shows for an approved-but-empty restaurant (BE2-11).
- Real FCM/Razorpay/Google round trips (tests use fakes), process-manager behaviour for BE2-08 (PM2 restart policy).
