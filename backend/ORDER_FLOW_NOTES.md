# Order flow v1 – backend notes

Contract: `Docs/16_order_flow_contract.md`. Sample payloads: `Docs/fixtures/order_flow_samples.json`
(regenerate with `WRITE_ORDER_FIXTURES=1` on the test command below, `-- test/e2e/order_flow_v1.test.ts`).

## Where things live
| What | File |
|---|---|
| Constants / env | `src/config/orderFlow.ts` |
| The only order JSON shape (`orderView`) | `src/services/orderView.ts` |
| Every state change (row-locked transactions), `markOrderPaid`, claim/release, gate OTP | `src/services/orderFlow.ts` |
| Refunds (lease + provider check, never twice), extra-payment refunds, refund webhooks | `src/services/refundService.ts` |
| Reconcile (pull), verify-signature confirmation, orphan report | `src/services/paymentReconcile.ts` |
| Circuit breaker + bounded parallelism for provider calls | `src/services/providerPool.ts` |
| Maintenance job `runOrderMaintenance(now)` | `src/services/orderMaintenance.ts` |
| Razorpay seam (`setPaymentProvider`, simulator in tests) | `src/services/paymentService.ts` |
| Socket.io (auth, rooms, per-viewer events) | `src/realtime.ts` |
| HTTP endpoints | `src/routes/orders.ts` |
| Multi-restaurant orders (Docs/22): quote, place a group, GroupView | `src/services/orderGroups.ts` (the group state changes live in `orderFlow.ts`) |
| Group locking rule (rider -> OrderGroup row -> children by ascending id) | `src/services/groupLock.ts`, `lockOrderInTx` / `withOrderLock` in `orderFlow.ts` |
| Group money split (largest remainder, paise exact) | `splitGroupMoney` in `src/services/pricing.ts`, `validateAndCalculateGroup` in `src/utils/validation.ts` |

## Constants and env vars
| Name | Default | Meaning |
|---|---|---|
| `PAYMENT_WINDOW_MIN` (env) | 15 | unpaid `PLACED` order is cancelled by SYSTEM ("Payment not completed") |
| `VENDOR_ACCEPT_WINDOW_MIN` (env) | 10 | paid order not accepted within this many minutes of `paidAt` is cancelled + refunded |
| `MAX_UNPAID_OPEN_ORDERS` | 3 | per customer, else 429 `TOO_MANY_UNPAID_ORDERS` |
| `MAX_ACTIVE_ORDERS_PER_RIDER` | 1 | else 409 `RIDER_BUSY` |
| `OTP_MAX_ATTEMPTS` | 5 | wrong gate codes before 423 `OTP_LOCKED` |
| `MAX_REFUND_ATTEMPTS` | 3 | PERMANENT refund failures (provider 4xx other than 429, local problems) before automatic retries stop. Transient failures never count |
| `REFUND_LEASE_MS` | 2 min | refund worker lease |
| `PROVIDER_TIMEOUT_MS` (env) | 15000 | every Razorpay call is abandoned after this long |
| `REFUND_BACKOFF_BASE_MS` / `_MAX_MS` | 30 s / 1 h | transient refund failure n waits 30 s, 1, 2, 4 ... min (max 1 h) |
| `PROVIDER_CONCURRENCY` / `PROVIDER_BREAKER_FAILURES` | 5 / 3 | max provider calls in flight in a tick / the provider phase stops after this many transient failures in a row |
| `RECONCILE_MIN_AGE_MS` / `_MAX_AGE_MS` / `_BATCH` | 2 min / 6 h / 20 | unpaid Payment rows asked about at Razorpay: age window and rows per tick |

Existing env still required in production: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `JWT_SECRET`.
Razorpay orders are created with `payment_capture: 1` (automatic capture; refunds only work on captured payments). Subscribe the webhook to
`payment.captured` (or `order.paid`), `payment.failed`, `refund.processed` and `refund.failed`.

## The job
Started in `src/index.ts` every 60 s (`setInterval(...).unref()`, not in `NODE_ENV=test`, overlapping ticks skipped).
Database-only work comes first and never waits for Razorpay:
1. Expire unpaid `PLACED` orders older than the payment window.
2. Cancel `PLACED`+`PAID` orders whose `paidAt` is older than the accept window (their refund is left `PENDING` for step 3).
Then the **provider phase** (at most 5 Razorpay calls in flight, each bounded by `PROVIDER_TIMEOUT_MS`, and the whole phase stops after 3 transient provider failures in a row; the next tick tries again):
3. Refunds: the ones from step 2, `FAILED` ones whose backoff has passed (permanent failures < 3), and `PENDING` ones whose worker died.
4. Extra (duplicate) payments that still need their refund (see below).
5. Reconcile (pull): unpaid `Payment` rows (PENDING/FAILED, no captured amount on record, order not yet paid) older than 2 minutes and younger than 6 hours are asked about with `orders.fetchPayments`, newest 10 every tick plus a rotating slice (20 per tick in all). A captured payment goes through `markOrderPaid` (source `RECONCILE`): the order becomes PAID, or, when it was cancelled/expired meanwhile, the money is refunded (once). An `authorized` payment of the right amount is captured first. A wrong amount is recorded and flagged (`PAYMENT_MISMATCH`), never paid, and not asked again. Audit: `PAYMENT_RECONCILED`.
Every cancel re-checks its condition under the order row lock, so two instances or a racing request are safe.
Orders paid before this release have no `paidAt` and are **never** auto-refunded; they appear in needs-attention.
On the first tick after deploy, old unpaid `PLACED` orders (>15 min) are cancelled — intended cleanup, no money moves.

### Refund retry policy
- Provider errors are typed (`PaymentProviderError`, `statusCode`, `transient`). **Transient**: no HTTP answer (network error, timeout, the SDK's "reading status" TypeError), 5xx, 429, 408. **Permanent**: other 4xx.
- Transient: `refundAttempts` is not used up (the lease's increment is given back), `refundStatus=FAILED`, `refundError` = readable reason, and `refundLeaseUntil` is the "not before" time: 30 s, 1, 2, 4 ... min, capped at 1 h (the number of failures in a row is counted from the audit log since the last admin retry). A long outage ends with the refund done by the job, not with a dead FAILED. needs-attention shows `REFUND_FAILED` with "Next automatic try ...".
- Permanent: `refundAttempts` counts, retried each tick, stops after 3 (`MAX_REFUND_ATTEMPTS`); the provider's message stays in `refundError`; `POST /admin/orders/:id/retry-refund` starts over.
- A 4xx answer to a refund call is double-checked against the provider's refund list: if the payment is already fully refunded the order becomes `REFUNDED` (no loop, no second refund).
- Webhooks: `refund.processed` (full amount) confirms a `PENDING`/`FAILED` refund as `REFUNDED` without calling Razorpay. `refund.failed` sets `refundStatus=FAILED` with the provider's reason and stops the automatic retries (attempts = cap; a refund we had booked as DONE is taken back: order `PAID` again); the admin retries. For an extra payment whose refund bounced, the row goes back to PENDING and is retried after an hour. Unknown payments/events answer 200 and are ignored.

### Duplicate (extra) payments
A second captured payment for an order that is already PAID/REFUNDED (another Razorpay order, or another payment id on the same one) is refunded automatically by **its own payment id**, exactly once (claim on `Payment.refundedAt` + the provider's refund list); the order and the original payment stay untouched. `Payment.status` of the extra row becomes `REFUNDED` (+`razorpayRefundId`), so the `DUPLICATE_PAYMENT` flag clears. While a refund is pending/failed, `Payment.refundedAt` on a PENDING row means "owned until / not before" (retried with backoff by the job). Audit: `PAYMENT_DUPLICATE`, `PAYMENT_DUPLICATE_REFUNDED`, `PAYMENT_DUPLICATE_REFUND_FAILED`. A wrong-amount payment on a paid order is still only flagged (`PAYMENT_MISMATCH`).

### POST /payments/verify-signature (changed)
After a valid signature the server fetches the payment (`payments.fetch`) and requires `captured` (an `authorized` one is captured with `payments.capture`), this Razorpay order and the exact amount, then marks PAID with the amount Razorpay reports. If Razorpay cannot be reached or the payment is not captured yet, **nothing is marked paid** and the answer is
`200 { success: true, status: 'PENDING_CONFIRMATION', paymentStatus: 'PENDING', message, data: <OrderView, still unpaid> }`.
The app treats `success: true` as "go to tracking" as before; the order flips to PAID by the webhook or the next reconcile tick (the order screen updates over the socket/polling). Normal success is unchanged (`success: true`, no `status` field, `data.paymentStatus = 'PAID'`). A replay of an already confirmed payment answers success without calling Razorpay. A payment of another Razorpay order answers `404 NOT_FOUND`; a different amount `409 PAYMENT_AMOUNT_MISMATCH`.

### GET /admin/payments/reconcile?from=&to= (new, ADMIN, read-only)
`from`/`to`: ISO date-time or unix seconds (default: the last 24 h; max 7 days, else `400 RANGE_TOO_LARGE`). Looks at most 200 payments at Razorpay (`payments.all`) and returns the **captured** ones that no `PAID`/`REFUNDED` Payment row accounts for: `{ success, from, to, scanned, truncated, count, data: [{ paymentId, razorpayOrderId, amountPaise, createdAt, kraveoOrderId|null, kraveoPaymentStatus|null }] }`. Razorpay unreachable: `503 PROVIDER_UNAVAILABLE`. No contact/card data is returned.

## Run
```
cd backend
DATABASE_URL=... NODE_ENV=test RAZORPAY_WEBHOOK_SECRET=test_webhook_secret GOOGLE_WEB_CLIENT_ID=test-client-id.apps.googleusercontent.com npx jest --runInBand
npx tsc --noEmit
```
Migration: `prisma/migrations/20261002_order_flow` (additive; applied by `prisma migrate deploy`).

## Admin playbook: `GET /admin/orders/needs-attention`
Each entry: `{ problem, problems[], detail, since, hint, order }` (`order` = admin OrderView incl. `payments[]`, `refundError`).
| problem | What to do |
|---|---|
| `PAYMENT_MISMATCH` | Captured amount ≠ order total; not marked paid. Refund in the Razorpay dashboard, cancel the order. |
| `DUPLICATE_PAYMENT` | Second captured payment on a paid order. Refunded automatically (retried with backoff); stays only if the refund keeps failing: read the audit log (`PAYMENT_DUPLICATE_REFUND_FAILED`) and refund that payment in Razorpay. |
| `REFUND_FAILED` | Read `detail`/`order.refundError`. Razorpay unreachable: the job keeps retrying by itself with backoff (up to hourly). Razorpay refused (permanent): the job stops after 3 tries. Fix cause, then `POST /admin/orders/:id/retry-refund`, or refund by hand in Razorpay (then nothing else is needed: the next retry finds the refund and marks it done). |
| `PAID_AFTER_CANCEL` | Money arrived after cancel; refund normally clears within a minute. If it stays (old orders), refund in Razorpay. |
| `REFUND_PENDING` | Refund started >5 min ago, not finished. Check Razorpay before doing anything by hand. |
| `OTP_LOCKED` | Call the customer. `POST /admin/orders/:id/reset-otp-lock` issues a **new** code to the customer; or cancel. |
| `STUCK_UNACCEPTED` | Call the restaurant; else `POST /admin/orders/:id/cancel {reason}` (refund is automatic). |
| `RIDER_NOT_APPROVED` / `VENDOR_NOT_APPROVED` | Partner suspended mid-order: reassign (`PATCH /orders/:id/reassign`) or cancel. |
| `DELIVERY_OVERDUE` / `RIDER_NOT_PICKED_UP` / `NO_RIDER` | Call the rider / riders on duty; reassign. |
| `UNPAID_IN_PROGRESS` | Legacy order moving without payment: check Razorpay, cancel if unpaid. |
| `PAYMENT_FAILED` | Informational; the order expires by itself. |

All admin/system actions land in `GET /admin/audit-log` (ORDER_CANCELLED, REFUND_DONE/FAILED, PAYMENT_*, OTP_LOCKED/UNLOCKED, ORDER_RELEASED/REASSIGNED).

## Hardening release (2026-10-03, migration `20261003_hardening`)
Additive columns: `User.tokenVersion`, `User.deletedAt`, `User.kraveo20Redeemed`, `Order.couponCode`, `Order.otpProof`.

| Topic | Behaviour |
|---|---|
| Tokens | JWT carries `tv` (tokenVersion; missing = 0). `requireAuth` and the socket handshake reject a token whose `tv` differs from the database or whose user does not exist / is deleted (401 `TOKEN_REVOKED`). 15 s in-memory cache (`AUTH_CACHE_TTL_MS`, 0 under `NODE_ENV=test`), cleared on every bump. Bumped by: `DELETE /auth/account`, admin reset-password, partner SUSPENDED (live sockets are closed too). A suspended partner signs in again and gets the "suspended" answer (403 `PARTNER_NOT_APPROVED`). |
| Coupons | `Order.couponCode` records the code. Single use per customer while a non-CANCELLED order holds it (cancel releases it). `VITFIRST` also needs a customer with no earlier non-cancelled order. `KRAVEO20` costs 50 coins at `POST /coupons/redeem-coins` (each redemption = one use, counted in `User.kraveo20Redeemed`). A code that gives nothing is `400 COUPON_NOT_APPLICABLE`. Thresholds use the subtotal rounded to paise. |
| `clientRequestId` | Same id + different vendor / items / drop point / notes / coupon = `409 CLIENT_REQUEST_MISMATCH`. |
| Gate OTP on a delivered order | Only the retry of the same code (HMAC `Order.otpProof`) or an admin gets the idempotent success; otherwise `409 ALREADY_DELIVERED`. Pushes are never logged (event type + order id only). |
| Claim | Cancelled / delivered orders answer `ORDER_NOT_AVAILABLE` (not `ALREADY_TAKEN`). |
| Reassign | `409 RIDER_BUSY` (second active order, no override), `409 RIDER_OFFLINE` unless `force: true`, `409 CANNOT_UNASSIGN` after pickup. |
| Rate limits (per user / per IP, in memory) | order create 8 / 10 min, order cancel 5 / 10 min, payment create-order 10 / 10 min, auth routes 60 / min / IP, partner-login 30 wrong / 15 min / IP, admin passcode 5 wrong / 15 min / IP. `429 {code:'RATE_LIMITED', retryAfterSeconds}`. Env: `RL_<ORDER_CREATE\|ORDER_CANCEL\|PAYMENT_CREATE\|AUTH_IP>_MAX` and `_WINDOW_MS`. Under `NODE_ENV=test` a rule is off unless its `_MAX` is set. |
| Proxy | `app.set('trust proxy', 1)` (nginx = one hop): `req.ip` is the right-most `X-Forwarded-For` entry. nginx must set/append `X-Forwarded-For $proxy_add_x_forwarded_for`. |
| Boot | Whenever `NODE_ENV` is not `test` the server refuses to start without `JWT_SECRET, DATABASE_URL, ADMIN_PASSCODE, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET` (`GOOGLE_WEB_CLIENT_ID` only warns). Local dev needs a `.env` with them. |
| Errors | `fail(res, err, what)` (`src/utils/http.ts`) logs a data-free summary and answers a generic 500; body-parser errors keep their status (413 / 400); path ids are validated (`validParams`). |
| Sockets | Vendor rooms need an APPROVED restaurant (connect + `join_room`; suspension drops the room). `drivers` room = approved and on duty; going OFFLINE leaves it, going ONLINE joins it; `order_available` only reaches riders who are ONLINE. |
| Public catalogue | `GET /vendors`, `/vendors/:id`, `/menus/:vendorId` return only customer fields; admin and the owning restaurant keep the full rows. |

## Push notifications (2026-10-05, migration `20261005_push_notifications`, contract: Docs/18_push_notifications_contract.md)
Push (FCM) is an addition to Socket.io and polling; it never changes an order. Code: `src/services/push/` (`types`, `provider`, `events`, `pushService`, `deviceTokens`), routes in `src/routes/devices.ts`.

| Topic | Behaviour |
|---|---|
| Env vars | `FIREBASE_KEY_PATH` (path of the service-account JSON file, preferred) or `FIREBASE_SERVICE_ACCOUNT` (the JSON as one string, fallback). Neither is ever logged. Optional: `PUSH_SEND_TIMEOUT_MS` (default 10000, one FCM call), `RL_DEVICE_WRITE_MAX` / `RL_DEVICE_WRITE_WINDOW_MS` (default 30 per 10 min per user on `POST/DELETE /api/devices`). |
| Disable | Unset both variables (or point them at nothing) and restart: ONE line `push notifications are OFF: ...` is logged at boot, the server runs normally, the push code does no database work. A key the server cannot read or that is not a service-account key gives the same single warning. Under `NODE_ENV=test` the real provider is never built (tests inject a fake with `setPushProvider`). |
| Devices | `POST /api/devices {token, app, platform?, appVersion?}` upserts by token (a token seen for another user MOVES to the caller and is re-enabled); `app` must match the role (STUDENT=CUSTOMER, VENDOR, DRIVER) else 403 `ROLE_NOT_ALLOWED`; max 10 active tokens per user (least recently seen are disabled, reason `LIMIT`). `DELETE /api/devices {token}` switches the caller's own token off (idempotent). Token length 20-2048 visible ASCII characters. Tokens are also disabled on account deletion (`ACCOUNT_DELETED`) and when an admin suspends or rejects a partner (`PARTNER_SUSPENDED` / `PARTNER_REJECTED`); FCM "dead token" answers disable the token with the FCM code. `User.fcmToken` still exists and the old `/notifications/register-token` still writes it, but nothing sends to it any more. |
| When it sends | After the order transaction committed, from `finishChange` (status changes, new paid order, admin reassign) and `recordSuccess` (refund done); scheduled with `queuePush`, never awaited, never throws. Events, recipients, copy, channels: `src/services/push/events.ts` (table in the contract). PREPARING and the admin dashboard are not pushed. An admin "reset OTP lock" does not push (the new code is only visible in the app). |
| Idempotency | `PushLog.key = orderId:event:userId` is unique; the insert is the claim, so webhook + verify + reconciliation can never push twice. |
| Retries | Transient FCM errors (UNAVAILABLE, INTERNAL, QUOTA_EXCEEDED, network, our 10 s timeout) retry from the 60 s maintenance tick: backoff 30 s, 1, 2, 4, 8 min, max 5 attempts, only while useful (10 min for NEW_ORDER / NEW_DELIVERY, 30 min for the rest; a retry is dropped as `STALE` when the news is no longer true, e.g. the order was already accepted). The same tick deletes `PushLog` older than 14 days and `DeviceToken` disabled for more than 60 days (once an hour). |
| Debug | `SELECT event, status, attempts, "lastError", "nextAttemptAt", "sentAt" FROM "PushLog" WHERE "orderId" = '<id>' ORDER BY "createdAt";` Status `SENT` (at least one device accepted), `PENDING` (waiting for a retry), `FAILED` (`lastError` = FCM code, `EXPIRED`, `MAX_ATTEMPTS`), `SKIPPED` (`NO_DEVICE`, `STALE`, `NOT_RECIPIENT`, `ORDER_GONE`). No row at all = the push is off, or nobody is a recipient (restaurant/rider not APPROVED, no ONLINE idle rider). Devices: `SELECT app, "disabledReason", "lastSeenAt" FROM "DeviceToken" WHERE "userId" = '<id>'` (never print the token column). Server logs carry event, order id and error code only. |
| Not verified here | Delivery to a real phone through real Firebase (tests use a fake provider). Do that on a device with the app killed and the screen locked, after deploying with the new key. |

## Campus drop points, maps and rider tracking (2026-10-06, migration `20261006_campus_dropoints`, contract: Docs/19_campus_maps_contract.md sections 1 and 2)
Code: `src/config/campus.ts` (single source of truth), used by `routes/orders.ts`, `routes/api.ts`, `services/orderFlow.ts`, `services/orderView.ts`. Tests: `test/e2e/campus_maps.test.ts`. Dashboard: `web/super_admin` (Leaflet map, vendor location input).

| Topic | Behaviour |
|---|---|
| Drop points | `BH1..BH8`, `Special Block`, `GH1`, `GH2` (11 names, 7 distinct pins, order fixed in `DROP_POINTS`). `normalizeDropPoint(raw)` accepts the canonical names plus the legacy `Block N`, `Boys Hostel Block N` (N 1..6), `Girls Gate N`, `Girls Hostel Gate N` (N 1..2), case-insensitive, extra spaces tolerated. `VIT Main Gate`, `Block 7`, `BH9`, `BH 2` and anything else: `400 {field, "Choose one of the campus drop points."}` (unchanged field and message). |
| Where it applies | `POST /orders` (`dropoffHostel`, or the profile value when omitted) and `PUT /auth/profile` (`hostelBlock`) STORE the canonical name, so `Block 2` is saved as `BH2` and push texts say `BH2`. Idempotent replay compares canonical names, so an order stored before the migration (`Block 2`) still matches a replay with `BH2`. |
| `GET /api/campus` | Any logged-in user. `{center, dropPoints:[{id,name,group,lat,lng}]}`, `Cache-Control: private, max-age=300`. |
| OrderView | `dropoff: {name,lat,lng} \| null` next to `dropoffHostel` (same visibility for every role; null when the stored text is not a drop point, e.g. an old `VIT Main Gate` order). `vendor.hasLocation` (all roles): false while the vendor has the schema placeholder pin 23.0768/76.8524 (or 0,0). The admin vendor list (`GET /vendors`, admin or owner) also carries `hasLocation`. |
| Vendor pin | `PATCH /admin/vendors/:id/location {lat,lng}` (ADMIN): JSON numbers only, lat -90..90, lng -180..180, within 3 km of the campus centre, else `400 {field: lat\|lng\|location}`; `404` unknown vendor; audit entry `VENDOR_LOCATION_SET`. `POST /vendors` and `POST /admin/partners` (VENDOR) validate a supplied `lat`/`lng` the same way (both required together; omitted = placeholder as before). Before this release a non-number was silently ignored; now it is a 400. |
| Rider locations | `GET /drivers/locations` rows now also carry `dutyStatus` and `approvalStatus` (`lastUpdated` already existed). `driver_location_update` to admins is sent only while the rider is on duty (`dutyStatus` is not `OFFLINE`; ONLINE and IN_TRANSIT both count, otherwise a rider carrying an order would vanish from the map); a fix that arrives after going OFFLINE is stored but not broadcast. The event now also carries `id` (= `driverId`), `dutyStatus`, `approvalStatus`. `rider_location` to the owning customer is unchanged. |
| Migration | Data only: rewrites `User.hostelBlock` and `Order.dropoffHostel` for the recognised legacy patterns, in one short transaction (`SET LOCAL lock_timeout = '5s'`); other text, NULL and `updatedAt` are untouched; running it twice changes nothing. Note: the schema default of `User.hostelBlock` is still `Boys Hostel Block 1` (legacy spelling, still accepted and normalised on read); changing it would be a schema migration and was not needed. |
| Dashboard | Leaflet + OpenStreetMap tiles (attribution shown; `vercel.json` CSP `img-src` allows `https://tile.openstreetmap.org`). Markers: drop points, restaurants with a real pin, riders by state (idle / to restaurant / delivering / stale after 2 min / offline). Socket positions are buffered and applied once a second; markers are updated in place. Tile failures only show a notice. |

## Restaurant location: auto-detect by the restaurant + manual by admin (2026-10-05, migration `20261008_vendor_location_source`, contract: Docs/20_vendor_location_contract.md section 1)
Code: `src/services/vendorLocation.ts` (helpers), `routes/partners.ts` (sign-up, `PUT /partner/vendor/location`, views), `routes/api.ts` (admin paths, login), `middleware/rateLimit.ts`. Tests: `test/e2e/vendor_location.test.ts`. Dashboard: Applications card, vendor cards, needs-attention list.

| Topic | Behaviour |
|---|---|
| Columns | `Vendor.locationSource` (`DEVICE` = the restaurant's phone, `ADMIN` = dashboard / admin API, NULL = never set or a row from before this release), `locationSetAt`, `locationAccuracyM` (metres). Migration is three nullable `ADD COLUMN`s, no default, no data rewrite; old rows stay NULL ("source unknown"). |
| Sign-up | `POST /auth/partner-signup` (VENDOR) accepts optional `lat`, `lng`, `locationAccuracyM`. Both coordinates or neither (`null` counts as absent); JSON numbers only; `checkVendorLocation` (ranges + within 3 km of campus) -> `400 {field: lat\|lng\|location}`; accuracy 0..5000 else `400 {field: locationAccuracyM}`. Stored with source `DEVICE`. A rider sign-up ignores these fields; an accuracy sent without coordinates is ignored. Bad location input is rejected before the sign-up throttle counts the try. |
| `PUT /partner/vendor/location` | `{lat, lng, accuracyM?}`, role VENDOR only (others 403), acts on the caller's own restaurant (the one `/partner/me` shows; any id in the body is ignored; 404 if the account has no restaurant row). Allowed while PENDING (the pin is part of what the admin reviews) and APPROVED. REJECTED / SUSPENDED: `403 {code: PARTNER_NOT_APPROVED, approvalStatus, message}` as the other partner writes. `/partner/application` has no such gate but only PENDING/REJECTED may re-apply; this route differs on purpose: a REJECTED applicant must fix the application first. Validation as sign-up (`accuracyM` is the field name here). Sets source `DEVICE`, setAt now. Answer `{success, data:{lat, lng, hasLocation, locationSource, locationSetAt, locationAccuracyM}}`. |
| Rate limit | Rule `VENDOR_LOCATION`: 10 per hour per user (`RL_VENDOR_LOCATION_MAX` / `RL_VENDOR_LOCATION_WINDOW_MS`; off under `NODE_ENV=test` unless set). Every PUT counts, valid or not. 429 `RATE_LIMITED` with `retryAfterSeconds`. |
| Audit | `VENDOR_LOCATION_SET` / `VENDOR` / vendor id: `<name> set its own map location from the phone to 23.074500, 76.859000 (about 12 m); previous: 23.073300, 76.860100 (admin)` (or `previous: not set`). The admin PATCH line now also ends with `; previous: ...`. A device update does replace an ADMIN pin (campus validation is the only guard, as decided); the audit line is how admin notices. |
| Admin writes | `PATCH /admin/vendors/:id/location`, `POST /vendors` with a pin and `POST /admin/partners` (new VENDOR with a pin) set source `ADMIN`, setAt now, accuracy NULL. Linking an existing restaurant to a new owner (`vendorId`) does not touch the pin. |
| Where the fields appear | `hasLocation`, `lat`, `lng`, `locationSource`, `locationSetAt`, `locationAccuracyM` are on: `vendor` in sign-up / `/partner/me` / `/partner/application` answers and `partner-login`; `vendor` of each `/admin/applications` row (and the status-change answer); `vendorsOwned[]` of `GET /admin/partners`; the admin / owner rows of `GET /vendors` (full row: raw columns + `hasLocation`); the PATCH answer. Customers still get only `lat`/`lng` (public view) and `OrderView.vendor.hasLocation`. |
| Dashboard | Applications card: coordinates, "Set by the restaurant on 5 Oct 2026, about 12 m", "Open in Google Maps", "Not provided" state and the same paste-coordinates editor as the vendor cards (typed before approving; saved pins show as "Set by admin"). Needs-attention tab: a section for live (APPROVED) restaurants without a real pin, text "No location - riders cannot navigate to it", counted in the sidebar badge. |
| Not verified here | Anything on a real phone (the vendor app is built separately), and the migration against a production-sized database (it is metadata-only). |

## Pricing, catalog approval and fees, phase 1 (2026-10-06, migration `20261009_pricing_catalog`, contract: Docs/21_pricing_catalog_settlement_contract.md sections 1-4 and 9)
- **Money model.** `MenuItem.price` stays the CUSTOMER price (what apps and the cart read); the restaurant's own price is `vendorPrice` (required, no default). Customer price = `roundUp(vendorPrice + commission, step)`, commission PERCENT or FLAT, most specific wins: dish override, then `Vendor.commissionType/Value`, then the global setting. All maths is integer paise in `src/services/pricing.ts` (pure, unit tested in `test/unit/pricing_engine.test.ts`); rounding is always UP, so effective commission = `price - vendorPrice`. The stored `price` is recomputed whenever a dish's `vendorPrice` or commission override changes; a change of a restaurant/global commission or the rounding step is applied by `POST /admin/catalog/recalculate` (dry run is the DEFAULT; send `{dryRun:false}` to write; `vendorId` limits it).
- **Settings** (`AppSetting`, one row per group `fees|commission|rounding|settlement`, `src/services/settings.ts`): defaults in code when a row is missing or invalid; `PUT` merges the sent keys over the current value under a row lock, validates the whole group (unknown keys, ranges, 2 decimals, fee lines must sum to `baseFee`), writes an audit row with old -> new and drops the in-process cache (TTL 30 s as a bound; 0 under NODE_ENV=test unless `SETTINGS_CACHE_TTL_MS` is set). `AUTO_PAYOUT` is refused until phase 2 sets `AUTO_PAYOUT_AVAILABLE`.
- **Orders.** `validateAndCalculateOrder` reads the fees: `deliveryFee` = the ONE all-in fee (default Rs 25, `freeFeeAbove` waives the base fee at or above the limit, `smallOrderFee` below `smallOrderBelow`, both compared on the food subtotal before the coupon), `taxAndPackaging` is 0 for new orders (old orders keep their values). Coupons only reduce the customer total. The order stores `vendorSubtotal`, `commissionTotal`, `feeBreakdown` (JSON, lines for the records) and each `OrderItem` stores `vendorUnitPrice` and `commissionUnit`. Only APPROVED, not-deleted dishes can be ordered; any other dish id answers like an unknown one.
- **Who sees what.** `orderView` for a restaurant: item `price` = vendor unit price, `subtotal` and `totalAmount` = vendorSubtotal, and no `deliveryFee`, `taxAndPackaging`, `discount`, coupon, commission or payments. Admin additionally gets `vendorSubtotal`, `commissionTotal`, `feeBreakdown`, `couponCode`, per-item `vendorUnitPrice`/`commissionUnit`. Customer and rider views are unchanged. The restaurant push says "You earn Rs X". Rows with `vendorSubtotal`/`vendorUnitPrice` still 0 (written by old code) are read as "no commission" (`vendorEarnTotal` / `vendorEarnUnit`). The public menus are public by nature: an authenticated restaurant gets its own dishes in restaurant shape (own price + status), but nothing can stop it opening the customer menu without a token.
- **Catalog flow.** Restaurant `POST /vendors/:id/items` -> PENDING (admin-created: APPROVED), max 50 pending per restaurant; `PATCH /vendors/items/:id` `{isAvailable}` instant, `{price}` edits a PENDING dish, sets `pendingVendorPrice` on a LIVE dish (CHANGE_PENDING, same price again withdraws it), resubmits a REJECTED one; `GET /vendors/:id/menu-manage`. Admin: `GET /admin/catalog` (status, vendorId, q, page, pageSize), `GET /admin/catalog/pending-count`, `GET|PATCH|DELETE /admin/catalog/:id`, `POST /admin/catalog`, `.../:id/approve|reject|restore`, `POST /admin/catalog/preview|recalculate`, `PATCH /admin/vendors/:id/commission`, `GET /admin/settings[/:group]`, `PUT /admin/settings/:group`. Every state change locks the dish row (`SELECT ... FOR UPDATE`), approve/delete/restore are idempotent (`changed:false`), all admin writes are audited and rate limited (`ADMIN_CATALOG_WRITE`, `ADMIN_RECALCULATE`, `ADMIN_SETTINGS_WRITE`, `VENDOR_CATALOG_WRITE`; off under test unless `RL_<NAME>_MAX` is set).
- **Migration.** Additive with backfill in a short transaction (`lock_timeout` 5 s): `vendorPrice = price`, `approvalStatus = APPROVED`, `OrderItem.vendorUnitPrice = price`, `commissionUnit = 0`, `Order.vendorSubtotal = subtotal`, `commissionTotal = 0`; `Order.settlementId` is a plain nullable column for phase 2 (no table yet). Deploy the backend BEFORE the new apps: old apps keep working (`taxAndPackaging` is still sent, as 0; the restaurant app's old `deliveryFee`/`discount` fields are nullable there).
- **Tests.** `test/unit/pricing_engine.test.ts`, `test/e2e/pricing_catalog.test.ts` (settings, restaurant flow, customer reach, admin endpoints, races), `test/e2e/pricing_visibility.test.ts` (totals, per-role visibility over REST/sockets/push, legacy rows, the migration SQL run on legacy-shaped tables).
