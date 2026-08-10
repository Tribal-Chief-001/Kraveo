# Scope: Milestone 3 - Payment Gateway & Server-Authoritative Gate OTP

## Architecture
- Backend monorepo module: `backend/src/`
- Payment Gateway Webhook: `POST /api/payments/webhook` validating `x-razorpay-signature` header via SHA256 HMAC signature verification with webhook secret.
- Order Placement Enforcement: Order status transitions to `PLACED` ONLY after payment status is verified as `COMPLETED` / `PAID`.
- Gate OTP Generation: When order status transitions to `ARRIVED`, backend generates a random 4-digit numeric string (stored in Prisma `Order.gateOtp`), and triggers student arrival notification (Socket/FCM).
- Gate OTP Delivery Enforcement: `PATCH /api/orders/:id/status` (or gate OTP verification endpoint) transitioning order status to `DELIVERED` requires `{ otpCode }` matching stored `gateOtp`. Reject mismatch/missing OTP with 400 Bad Request.

## Subtasks
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Payment Webhook & Order Placement | `POST /api/payments/webhook` with `x-razorpay-signature` verification; transition order to `PLACED` only on `PAID`/`COMPLETED` | Milestone 2 | IN_PROGRESS |
| 2 | Gate OTP Generation & Arrival Push | Generate 4-digit `gateOtp` when order becomes `ARRIVED`, save to DB, trigger student push/socket alert | Subtask 1 | PLANNED |
| 3 | Gate OTP Delivery Verification | Enforce valid `{ otpCode }` on `DELIVERED` transition; reject invalid OTP with 400 | Subtask 2 | PLANNED |
| 4 | Verification & Audit | Backend TypeScript build (`npm run build` = 0 errors), multi-agent review, challenger verification, forensic audit | Subtasks 1-3 | PLANNED |

## Interface Contracts
- `POST /api/payments/webhook`: Headers: `x-razorpay-signature`. Raw or JSON payload. Verifies signature against `RAZORPAY_WEBHOOK_SECRET` (or config secret). On success, marks payment `COMPLETED`/`PAID` and order status `PLACED`. Returns 200 `{ success: true }`. Invalid signature returns 400 Bad Request.
- `PATCH /api/orders/:id/status` (or status change endpoint):
  - Transition to `ARRIVED`: Generates 4-digit random OTP (e.g. `Math.floor(1000 + Math.random() * 9000).toString()`), saves to DB `gateOtp`, emits `order_updated` socket event and FCM arrival notification to student.
  - Transition to `DELIVERED`: Accepts body `{ status: "DELIVERED", otpCode: "1234" }` (or `otp`). Validates `otpCode` against DB `gateOtp`. If match, sets status to `DELIVERED`. If missing or invalid, returns HTTP 400 `{ error: "Invalid Gate OTP" }`.
