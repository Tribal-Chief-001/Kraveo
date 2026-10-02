# Order flow v1 – backend notes

Contract: `Docs/16_order_flow_contract.md`. Sample payloads: `Docs/fixtures/order_flow_samples.json`
(regenerate with `WRITE_ORDER_FIXTURES=1` on the test command below, `-- test/e2e/order_flow_v1.test.ts`).

## Where things live
| What | File |
|---|---|
| Constants / env | `src/config/orderFlow.ts` |
| The only order JSON shape (`orderView`) | `src/services/orderView.ts` |
| Every state change (row-locked transactions), `markOrderPaid`, claim/release, gate OTP | `src/services/orderFlow.ts` |
| Refunds (lease + provider check, never twice) | `src/services/refundService.ts` |
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
| `MAX_REFUND_ATTEMPTS` | 10 | automatic refund retries (once a minute) before they stop |
| `REFUND_LEASE_MS` / `PROVIDER_TIMEOUT_MS` | 2 min / 15 s | refund worker lease / Razorpay call timeout |

Existing env still required in production: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `JWT_SECRET`.
Razorpay must have **automatic capture** on (refunds only work on captured payments). Subscribe the webhook to
`payment.captured` (or `order.paid`) and `payment.failed`.

## The job
Started in `src/index.ts` every 60 s (`setInterval(...).unref()`, not in `NODE_ENV=test`, overlapping ticks skipped).
1. Expire unpaid `PLACED` orders older than the payment window.
2. Cancel + refund `PLACED`+`PAID` orders whose `paidAt` is older than the accept window.
3. Retry `refundStatus=FAILED` (attempts < 10) and `PENDING` refunds whose worker died.
Every cancel re-checks its condition under the order row lock, so two instances or a racing request are safe.
Orders paid before this release have no `paidAt` and are **never** auto-refunded; they appear in needs-attention.
On the first tick after deploy, old unpaid `PLACED` orders (>15 min) are cancelled — intended cleanup, no money moves.

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
| `DUPLICATE_PAYMENT` | Second captured payment on a paid order. Refund that payment in Razorpay. |
| `REFUND_FAILED` | Read `detail`/`order.refundError`. Job retries 10×. Fix cause, then `POST /admin/orders/:id/retry-refund`, or refund by hand in Razorpay (then nothing else is needed: the next retry finds the refund and marks it done). |
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
