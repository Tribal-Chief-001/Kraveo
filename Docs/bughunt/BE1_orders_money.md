# BE1 - Backend orders, payments, refunds, dispatch, realtime, push, migrations (read-only bug hunt, 6 Oct 2026)

## 1. Scope covered

Read completely, line by line:
- `backend/src/services/`: orderFlow.ts, orderView.ts, orderMaintenance.ts, paymentService.ts, paymentReconcile.ts, refundService.ts, providerPool.ts, audit.ts, push/{pushService,events,provider,deviceTokens,types}.ts
- `backend/src/realtime.ts`, `src/routes/orders.ts`, `src/routes/devices.ts`, `src/index.ts`, `src/middleware/{auth,rateLimit,errorHandler}.ts`, `src/config/{orderFlow,campus,runtimeConfig}.ts`, `src/utils/{validation,catalog,http,log,stateMachine}.ts`
- `prisma/schema.prisma` and all 11 migrations (+ prisma/README.md)
- `src/routes/api.ts`: lines 1-160, 355-470, 545-760, 800-1097 (catalogue, vendor/menu writes, profile, logout, account delete, reviews, coupons/redeem-coins, campus, driver locations). NOT read: 160-355 (Google/partner/admin login), 470-545 (admin partner creation), 758-800 (analytics) - not payment related.
- Docs read first: 16 contract, council audit master register (checked which findings are still open), ORDER_FLOW_NOTES.md.

Tests: I read the full test inventory (titles of all 14 e2e files) and the harness DB helper, and opened bodies selectively (cleanup helpers, rate limit, replay, migration test). I did NOT read every test body line by line (12k lines). Test-gap findings below come from the inventory plus grep for missing cases.

Not run: nothing executed (read-only rules).

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 0 |
| MEDIUM | 6 |
| LOW | 9 |

Headline: I could not find a way to pay less than the total, get food without paying, double refund, double-use a coupon, deliver without the OTP, brute-force the OTP, claim two deliveries, or make a restaurant/rider see an unpaid order. The money state machine is genuinely tight (row locks, guarded updates, provider re-checks). The findings are about demo-path friction, ops/deploy traps and a few unfixed council items.

## 3. Findings

### BE1-01 MEDIUM - Abandoned (unpaid) checkouts keep single-use coupons, "first order" status and the 3-order cap locked for 15 minutes
- Status: backend CONFIRMED; the app trigger is SUSPECTED (needs one device run).
- Where: `src/utils/validation.ts:44-56` (couponEligibilityProblem counts every non-CANCELLED order incl. unpaid PLACED), `src/services/orderFlow.ts:194-199` (3 unpaid cap), app side `apps/customer_app/lib/providers/order_provider.dart:~485` (new cart = new clientRequestId, the old unpaid order is not cancelled).
- Trigger: on stage the presenter taps "Place order" (order is created unpaid), closes/backs out of payment, goes back to the cart, adds or removes an item, applies VITFIRST (or KRAVEO50 / KRAVEO20) again and places the order.
- What happens: the first unpaid order still holds the code, so the second POST /orders answers `400 COUPON_NOT_APPLICABLE "You have already used VITFIRST."` (or "VITFIRST is only for your first order."). KRAVEO20 says "needs 50 Kraveo Coins" because the unpaid order consumed the redemption. After three such abandoned checkouts: `429 TOO_MANY_UNPAID_ORDERS` until the 15-minute expiry job runs.
- Demo impact: the coupon demo fails with a message that looks like a bug; retrying does not help for 15 min.
- Minimal fix: in placeOrder, inside the transaction after the user-row lock, cancel (cancelledBy SYSTEM, reason "Replaced by a new checkout", no refund because unpaid) the same customer's older unpaid open orders for the same vendor/coupon, or make couponEligibilityProblem and the `earlier` count ignore orders whose paymentStatus is PENDING/FAILED while still blocking a second PAID use (re-check at markOrderPaid is NOT needed if you cancel the stale holder instead). Size M. Workaround for tomorrow: tell the presenter to use the in-app "Cancel order" on the unpaid order (checkout_screen.dart:474) or wait 15 min.

### BE1-02 MEDIUM - A database transaction + order row lock is held across the Razorpay HTTP call (council item M-01 is NOT fixed)
- Status: CONFIRMED in code, impact SUSPECTED (depends on the prod pool size).
- Where: `src/services/orderFlow.ts:243-263` (createPaymentForOrder: `withOrderLock` then `createRazorpayOrder` inside, timeout 15 s), `src/db.ts` (plain `new PrismaClient()`, no connection_limit).
- Trigger: Razorpay slow or down while 3+ customers tap Pay at once (or one customer double-taps and the app retries).
- What happens: each call keeps one pooled DB connection and the order lock for up to 15 s. Prisma's default pool is `2 x vCPU + 1` (3 on a 1-vCPU box, 5 on t3.micro); when it is exhausted every other request (including `requireAuth`'s user lookup) waits for a free connection and fails after Prisma's 10 s pool timeout, so the whole API looks dead until Razorpay answers. Push, refunds and the webhook share the same pool.
- Demo impact: Razorpay test API hiccup during checkout freezes all three apps for ~15-30 s.
- Minimal fix (config only, S): add `?connection_limit=15&pool_timeout=20` to the production DATABASE_URL (OWNER-INPUT: edit the server `.env`, restart PM2). Proper fix (M): create the Razorpay order before opening the transaction and reconcile the orphan if the insert fails (an orphan Razorpay order has no money in it).

### BE1-03 MEDIUM - `prisma migrate deploy` cannot build an empty database; the README runbook is wrong (council M-09 NOT fixed)
- Status: CONFIRMED by reading (folder names sort `20260904_align_legacy_schema` < `20260904_clear_legacy_gate_otps` < `20260904_make_order_otp_nullable`).
- Where: `prisma/migrations/20260904_align_legacy_schema/migration.sql` (ALTERs `MenuItem`, `Order`, `User`, `Vendor` and creates type `DutyStatus` before any table exists), `prisma/migrations/20260904_make_order_otp_nullable/migration.sql` (the real initial schema, would then fail with "type DutyStatus already exists"), `prisma/README.md` ("For a new database ... run `npx prisma migrate deploy`").
- Trigger: anyone creating a fresh staging/demo database (new laptop, new EC2, CI) with the documented command.
- What happens: first migration fails, deploy stops. Also `prisma/migrations/migration_lock.toml` is missing.
- Demo impact: none on the existing prod DB; a blocker only if you need to rebuild a DB tonight.
- Minimal fix: for a new DB use `npx prisma db push` (matches schema.prisma) and then `prisma migrate resolve --applied <each folder>`; fix the README accordingly. Do not rename applied folders on prod. Size S (docs) / M (squash baseline).

### BE1-04 MEDIUM - A concurrent duplicate "Place order" with a coupon (or near the unpaid cap) gets a misleading error instead of the idempotent replay
- Status: CONFIRMED by trace.
- Where: `src/services/orderFlow.ts:185-221` (replay lookup is only done BEFORE the transaction; inside it the coupon check at 190-193 and the unpaid cap at 194-199 run before `order.create`, so the P2002 fallback at 226 is never reached).
- Trigger: double tap / app retry that overlaps the first request, same `clientRequestId`, with VITFIRST/KRAVEO50/KRAVEO20, or when the customer already has 2 unpaid orders. Request B waits on the user-row lock, then sees the order A just created.
- What happens: B answers `400 COUPON_NOT_APPLICABLE "You have already used ..."` or `429 TOO_MANY_UNPAID_ORDERS`, while A answered 201. The app may show the error and drop the order that really exists (it stays unpaid and holds the coupon, see BE1-01). Tests only cover the no-coupon 5x concurrent case (`order_flow_v1.test.ts:567`).
- Demo impact: the VITFIRST first-order demo; low probability (app debounces with `_placing`), high confusion when it happens.
- Minimal fix: right after taking the user-row lock inside the transaction, repeat `findReplay` (same clientRequestId) and return it. Size S.

### BE1-05 MEDIUM - A paid order that the restaurant ACCEPTED can strand: no timeout, no customer cancel, no vendor reject, not flagged until READY (council M-06 NOT fixed)
- Status: CONFIRMED.
- Where: `orderFlow.ts:420-428` (customer only in PLACED, vendor reject only in PLACED), `orderMaintenance.ts` (only PLACED orders expire), `routes/orders.ts:431-446` (needs-attention has no ACCEPTED/PREPARING-too-long rule; NO_RIDER/RIDER_NOT_PICKED_UP only for READY_FOR_PICKUP).
- Trigger: restaurant taps Accept, then its phone dies / it never taps Preparing/Ready (or the restaurant app is killed).
- What happens: customer keeps a paid order forever (money is held, cannot cancel in the app, no push); rider sees an ACCEPTED order in the pool; the admin only notices if they open orders by hand.
- Demo impact: only if a demo restaurant stops mid-flow; an admin cancel (with refund) recovers it.
- Minimal fix: add a needs-attention rule for ACCEPTED/PREPARING older than ~30 min (S). The auto-cancel/refund timeout is an OWNER-INPUT business rule.

### BE1-06 MEDIUM - Cancel / reject / admin-cancel HTTP responses wait for the Razorpay refund (up to ~45 s worst case)
- Status: CONFIRMED in code, impact SUSPECTED (depends on Razorpay latency and app timeout).
- Where: `orderFlow.ts:97-101` (`awaitRefund` default true), `refundService.ts:104-128` (listRefunds + refund + maybe listRefunds again, each bounded by 15 s), routes/orders.ts cancel/reject/admin cancel.
- Trigger: the "refund of a cancelled order" step of the demo with a slow Razorpay test API.
- What happens: the customer's/restaurant's Cancel spinner runs 2-4 s normally, up to 15-45 s when Razorpay is slow. If the app timeout is shorter it shows an error even though the order is already CANCELLED and the refund continues (a second Cancel is an idempotent success, so no money risk).
- Minimal fix: for customer/vendor/admin cancel pass `awaitRefund:false` (use `runInBackground`) and let the order screen show `refundStatus` PENDING then REFUNDED via the socket/poll. Size S.

### BE1-07 LOW - `ORDER_CREATE` and `PAYMENT_CREATE` rate limits are skipped with a trailing slash
- CONFIRMED. `src/middleware/rateLimit.ts:78,84` compares `r.path === '/orders'` / `'/payments/create-order'`; Express also routes `/api/orders/` and `/api/payments/create-order/`, which never match. Order spam is still capped by the 3-unpaid limit, but payment-order creation (Razorpay calls) is not. Fix: normalise `r.path.replace(/\/+$/,'')` before matching. Size S. Test gap: no test uses a trailing slash.

### BE1-08 LOW - Restaurant sees the customer's free-text delivery notes (can hold a phone number)
- CONFIRMED. `orderView.ts:63,136-143`: VENDOR view keeps `dropoffNotes` (the pool view deliberately blanks them "customers write room numbers and phone numbers there"). Contract 16 says the restaurant never sees the customer phone. Fix: set `dropoffNotes: null` in the VENDOR branch. Size S. OWNER-INPUT only if restaurants need the notes.

### BE1-09 LOW - Restaurant rating is computed from the RIDER's star rating, and the formula decays (council BE-11 NOT fixed)
- CONFIRMED. `routes/api.ts:942-950`: `ratingToUse = driverRating`, and the prior (`C*m`) is added again on every review. Numbers (ran in node): vendor at 4.80 with 124 ratings falls to 4.78, 4.76, 4.74, 4.72, 4.71 after five 5-star reviews; any all-5-star stream converges to 4.55. Demo: submit a review in the demo and the restaurant's rating goes DOWN. Fix: use a dedicated restaurant rating (dhaba/dish rating from the app) and a plain running average `(rating*count + r)/(count+1)`. Size S.

### BE1-10 LOW - `join_room` and `leave_room` socket events are unthrottled and each join runs a heavy query
- CONFIRMED. `realtime.ts:97-111`, `canJoin` (line 61) loads the order with all relations. Any logged-in user can spam `join_room order_<uuid>` and load the 1 GB box's DB. Also no per-IP connection cap. Fix: a per-socket token bucket (e.g. 5 joins/s) like the 2 s throttle already used for `update_driver_location`. Size S. (In-memory limiting itself is an accepted limitation.)

### BE1-11 LOW - Clients that are not told about a change: previous rider after admin reassign; customers must re-join their order room after every reconnect
- CONFIRMED (backend side). `publishOrderChange` removes the previous rider from the room silently (`realtime.ts:165-168`, no event); admin reassign sends `DELIVERY_ASSIGNED` only to the new rider (`push/events.ts:176`). Customer sockets get no automatic `order_<id>` rooms (only user_/admins/drivers/vendor_, `realtime.ts:78-85`), so a socket reconnect silently stops live updates until the app re-emits `join_room` (the 15 s poll covers it, per contract). Rider A can keep driving to a restaurant for up to 15 s and a wrong-OTP attempt after reassign gets 404. Fix: on connect auto-join `order_<id>` for a customer's/rider's active orders, and emit `order_unavailable`/a final `order_updated` to the removed rider. Size S-M.

### BE1-12 LOW - Rider proximity is never checked; "arrived at gate" can be tapped from anywhere and immediately shows the OTP to the customer
- CONFIRMED by design gap. `advanceStatus` (orderFlow.ts:371-400) accepts PICKED_UP/ARRIVED_AT_GATE with no location check; at ARRIVED_AT_GATE the customer's app/push show the code (`orderView.ts:129`). A rider (or colluding customer) can mark delivered without being on campus. Fix: warn/flag when the last DriverLocation is more than ~300 m from the drop pin. OWNER-INPUT (business rule). Size M.

### BE1-13 LOW - System expiry and repeated webhook retries flood the admin audit log
- CONFIRMED. `orderFlow.ts:456-458` writes an `ORDER_CANCELLED` audit row for every SYSTEM cancel, i.e. one per abandoned checkout and one per un-accepted order; `markOrderPaid` writes `PAYMENT_AMOUNT_MISMATCH`/`PAYMENT_UNKNOWN` on every redelivery of the same webhook. If the admin shows the audit log on stage it is mostly "SYSTEM cancelled ... Payment not completed". Fix: skip the audit row for `by==='SYSTEM'` unpaid expiries (S).

### BE1-14 LOW - No maximum order total; an absurd cart fails at Razorpay with the generic "payment provider unavailable"
- CONFIRMED. `validation.ts:61-62,135-168`: 30 lines x qty 20 x price up to 10 000 = Rs 6 000 000. `createPaymentForOrder` then returns `503 PROVIDER_UNAVAILABLE` (Razorpay refuses large amounts) and the order stays unpaid until expiry. Fix: cap the total (e.g. Rs 10 000) at order creation with a clear message. Size S.

### BE1-15 LOW - Old customer APKs and the "VIT Main Gate" drop point; legacy-data side effects of the campus migration
- CONFIRMED by reading. `config/campus.ts` no longer accepts "VIT Main Gate" (commit message claims old APKs "keep working"): an old app that still offers "VIT Main Gate" gets `400 dropoffHostel` at checkout; a profile with that value cannot order via the profile fallback (`routes/orders.ts:62-68`). Migration `20261006_campus_dropoints` rewrites `User.hostelBlock` to `BHn`; an old app whose dropdown does not contain `BH1` may fail to render the profile (SUSPECTED, needs an old APK). Everyone on the DB default "Boys Hostel Block 1" silently becomes BH1 (the new app asks at checkout). The migration itself is NOT required for correctness (server normalises legacy text on read) and it fails the whole deploy if its 5 s `lock_timeout` hits an in-flight order transaction (recovery: `prisma migrate resolve --rolled-back 20261006_campus_dropoints`, rerun at a quiet moment). Recommendation for tomorrow: deploy the backend first; apply the migration only when no one is placing orders. Size S.

### Smaller notes (not worth separate IDs)
- `createPaymentForOrder` does not re-check that the restaurant is still APPROVED/open: a customer can pay for an order whose restaurant was suspended meanwhile; nobody is notified; it is cancelled and refunded after 10 min (needs-attention shows VENDOR_NOT_APPROVED). `orderFlow.ts:243-262`.
- `verify-signature` answers "cancelled before the payment arrived" also when the restaurant rejected a PAID order (retry of a lost verify response). `routes/orders.ts:555-558`. Wording only.
- A restart between commit and push-claim loses non-vendor/rider status pushes for customers (ORDER_ACCEPTED etc.); only NEW_ORDER and NEW_DELIVERY are re-swept. Accepted design (push is additive).
- `npm test` / `resetTestDatabase` (`test/harness/db.ts:138-155`) deletes ALL payments, order items and orders of whatever `DATABASE_URL` points to (council M-05 still open). The local `.env` points at `localhost:5432/kraveo`: do NOT run the suite on the laptop tonight without overriding DATABASE_URL, or any demo data in that DB disappears.
- `src/utils/stateMachine.ts` and `store.ts` are dead code (no importer).

## 4. Looked hard and found nothing

- Pay less than total: total is recomputed server-side in paise (`round2` before thresholds), Razorpay amount and capture amount are compared in integer paise, client prices/totals ignored; 600 random float-hostile carts are tested.
- Pay twice / lose money: one Razorpay order per Kraveo order under the row lock; duplicate captures are refunded by their own payment id once (lease + provider refund list); late payments after cancel/expiry refunded once.
- Free food: only `markOrderPaid` flips to PAID; verify-signature fetches the payment from Razorpay (captured, same order, same amount) and returns PENDING_CONFIRMATION otherwise; webhook is HMAC over raw bytes; the `valid_test_wh_signature` / `rzp_order_sim_` shortcuts are dead unless NODE_ENV is exactly `test` (a server started with NODE_ENV=test would accept forged webhooks: confirm the PM2 env does not set it).
- Paid invariant: every list/detail/socket/push path goes through `orderView`/`isVendorVisible`/`isPoolEligible`; vendor list filter, pool query and push recipients all require PAID.
- Coupon reuse: user-row `FOR UPDATE` serialises checkouts; counted per customer; cancel releases; KRAVEO20 needs a coin redemption.
- Cancel after cooking / illegal transitions: NEXT_STATUS table, role target sets, terminal-state checks, all under the row lock; admin cannot deliver without the OTP; reassign never changes status.
- OTP: CSPRNG 4 digits, constant-time compare, attempts counted in the DB under the lock (5 -> 423), never in rider/vendor views, pushes or logs, delivered orders keep only an HMAC proof.
- Two riders claiming / second active order: rider-row lock then guarded `updateMany`; no lock-order inversion found (rider -> order everywhere).
- IDOR: every order read/write goes through owner/assigned/vendor checks that answer 404; cursors only accept id characters and expose ordering only.
- Socket data leaks: per-socket `orderView`, `rider_location` only to the owning customer and admins, rooms re-checked server-side, tokens checked against tokenVersion.
- Push cannot change an order: scheduled after commit, never awaited, never throws, idempotent PushLog key, payload is `{event, orderId, v}` only, digit runs stripped from free text.
- Maintenance job: guarded under the order lock, safe to run twice, provider phase bounded (timeout, breaker, concurrency 5), restart-safe leases.
- Rounding: no float comparison left on money; thresholds on rounded subtotal.

## 5. Top 5 to do before the demo

1. BE1-02: set `connection_limit`/`pool_timeout` in the production DATABASE_URL (config only) so a slow Razorpay cannot freeze the API. OWNER-INPUT (server `.env`).
2. Confirm in the Razorpay dashboard that the webhook URL (`https://api.kraveo.site/api/payments/webhook`) and secret are set with events payment.captured, payment.failed, refund.processed, refund.failed. Without it a PENDING_CONFIRMATION payment waits for the 60 s reconcile tick instead of finishing in ~1 s. OWNER-INPUT.
3. BE1-01 + BE1-04: coupon/abandoned-checkout behaviour; at minimum brief the presenter (use the in-app Cancel on an unpaid order, do not rehearse the same coupon twice) and make sure the demo customer is fresh for VITFIRST.
4. BE1-06: make cancel/reject/admin-cancel return before the refund finishes (S) or rehearse the refund step once on the test Razorpay API to know the latency.
5. BE1-15 + BE1-03: deploy order: backend first, run migration `20261006` only when idle (or skip it), do not run `npm test` on the laptop DB, and do not try to rebuild a DB with `migrate deploy`.

## 6. What can only be proven on a device / browser / real server

- Whether the customer app really leaves the first unpaid order behind when the cart changes (BE1-01) and how its error UI shows a 400/429 from POST /orders.
- Real Razorpay behaviour: how fast an auto-capture payment turns `captured`, whether `payments.capture` on an `authorized` payment is accepted, test-mode refund latency (BE1-06), webhook delivery and signature with the real secret.
- Prisma pool size and Razorpay slowness effects on prod (BE1-02): needs the real DATABASE_URL and a load/chaos run.
- Old APK behaviour against the new server (BE1-15).
- Socket reconnect behaviour of the three apps (BE1-11) and the effect of an unthrottled `join_room` on the 1 GB box (BE1-10).
- That the production PM2 environment does not set `NODE_ENV=test` and that the migration `20261006` runs inside its 5 s lock timeout on live data.
