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
