# Handoff Report — Explorer 1 (E2E Subtask 1: Test Harness & Tier 1 Test Spec)

## 1. Observation

### Codebase & Specification Inspection
- **Project Structure**: Monorepo containing `backend/`, `web/super_admin/`, `apps/customer_app/`, `apps/vendor_app/`, `apps/driver_app/`.
- **Backend Infrastructure (`backend/`)**:
  - `package.json`: Express 4.19.2, Socket.io 4.7.5, Prisma 5.14.0, jsonwebtoken 9.0.2, razorpay 2.9.4, firebase-admin 14.2.0.
  - `src/index.ts`: Express application & Socket.io server creation. Listens on `PORT || 5000`. Socket events handled: `join_room`, `update_driver_location`, `order_status_change`. Global crash protection handlers set up for uncaught exceptions and unhandled rejections.
  - `src/routes/api.ts` (587 lines): REST API routes for auth (`/auth/send-otp`, `/auth/verify-otp`, `/auth/login`, `/auth/profile`), payments (`/payments/create-order`, `/payments/verify-signature`), vendors (`/vendors`, `/vendors/:id/toggle`), menus (`/menus/:vendorId`, `/menus/:itemId/toggle`), orders (`/orders`, `/orders/:id`, `/orders/:id/status`, `/orders/:id/accept-driver`), drivers (`/drivers`, `/drivers/location`), reviews (`/reviews`), and coupons (`/coupons/redeem-coins`).
  - `src/middleware/auth.ts`: `generateToken`, `requireAuth`, `requireRole` middleware. Uses `JWT_SECRET`. Lines 34-38 currently allow `mock_jwt_token_` fallback in development mode.
  - `src/services/paymentService.ts`: `createRazorpayOrder` and `verifyRazorpayPaymentSignature`. Uses HMAC SHA256 for signature verification.
  - `src/services/notificationService.ts`: Firebase Admin SDK initialization and `sendPushNotification`, `triggerDhabaAlarmPushNotification`, `triggerStudentArrivalNotification`.
  - `src/store.ts`: Currently holds in-memory mock arrays (`users`, `vendors`, `driverPartners`, `menuItems`, `orders`, `reviews`, `driverLocations`).
  - `src/utils/stateMachine.ts`: `isValidStateTransition` enforcing valid order state flow (`PLACED` -> `ACCEPTED` -> `PREPARING` -> `READY_FOR_PICKUP` -> `PICKED_UP` -> `ARRIVED_AT_GATE` -> `DELIVERED`).
  - `src/utils/validation.ts`: Server-side order price recalculation to prevent price tampering.
  - `prisma/schema.prisma`: PostgreSQL models: `User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `Payment`, `DriverLocation`. Enums: `Role`, `OrderStatus`, `PaymentStatus`.
  - `src/utils/seedDb.ts`: Database seeder using `@prisma/client`.
- **Target Specifications**:
  - `PROJECT.md`: Defines Milestones 1-7. Milestone 1 is the E2E Testing Suite (Dual Track). Interface contracts specified for HTTP REST headers (`Authorization: Bearer <jwt_token>`), roles (`CUSTOMER`, `VENDOR`, `DRIVER`, `ADMIN`), payment webhook (`POST /api/payments/webhook`), Gate OTP (`DELIVERED` status transition requiring OTP code), and Socket.io rooms (`order_${id}`, `vendor_${id}`).
  - `TEST_INFRA.md`: Requirements for opaque-box E2E testing suite covering 6 features across 4 Tiers. Tier 1 requires ≥30 happy-path feature coverage test cases (5 cases per feature across 6 features).

---

## 2. Logic Chain

### 1. Harness & Architecture Design
To satisfy opaque-box requirements while remaining robust, performant, and maintainable within Node.js / TypeScript environment:
- The E2E test runner harness will reside in `backend/test/` (or root `test/`).
- Harness components:
  - **`test/harness/app.ts`**: Helper to launch the Express HTTP server on a dynamic test port (or wrap with HTTP request client like Axios/node-fetch/supertest).
  - **`test/harness/db.ts`**: Database helper using `@prisma/client` to execute seed/cleanup routines before test suites run.
  - **`test/harness/auth.ts`**: Helper generating valid JWT tokens for standard test personas (`STUDENT`, `VENDOR`, `DRIVER`, `ADMIN`).
  - **`test/harness/socket.ts`**: Helper initializing real `socket.io-client` sockets connected to test server to capture and assert real-time events.
- **Runner**: Node native test runner (`node --test`) or `ts-node` test runner script executing tests in sequence.

### 2. Tier 1 Test Specification (30 Cases Across 6 Features)

#### Feature 1: Database Persistence & Query (No In-Memory Fallback)
- **T1_DB_01: User Creation & Persistence Query**: Submit valid user registration/OTP verify; query Prisma DB directly or via profile endpoint; verify `User` record exists in PostgreSQL with phone, role, hostel block.
- **T1_DB_02: Vendor & Menu Relational Query**: Query vendors and menu items; verify `Vendor` records and associated `MenuItem` records reflect relational foreign key mapping and availability flags.
- **T1_DB_03: Order Placement DB Insertion**: Place order via `POST /api/orders`; verify `Order` and `OrderItem` records are created in DB with status `PLACED` and matching items.
- **T1_DB_04: Order Status & Driver Assignment DB Update**: Accept order as driver and patch status; verify `Order.driverId` and `Order.status` are updated in DB.
- **T1_DB_05: Payment Record Relational Persistence**: Create payment order; verify corresponding `Payment` record is persisted in DB referencing the correct `Order.id`.

#### Feature 2: Razorpay Payment Webhooks & Server-Authoritative Status
- **T1_PAY_01: Razorpay Order Creation**: `POST /api/payments/create-order` with valid orderId and amount; verify response contains `razorpayOrderId` and amount in paise.
- **T1_PAY_02: Razorpay Signature Verification**: `POST /api/payments/verify-signature` with valid HMAC SHA256 signature returns `success: true`.
- **T1_PAY_03: Razorpay Webhook Event Processing**: Send `POST /api/payments/webhook` with `x-razorpay-signature` and `payment.captured` event; verify order payment status transitions to `PAID` in DB.
- **T1_PAY_04: Server-Authoritative Order Status Transition**: Verify order status transitions to `PLACED` condition only upon valid payment webhook confirmation.
- **T1_PAY_05: Webhook Event Idempotency**: Send identical payment webhook payload twice; verify server processes it idempotently without duplicate status transitions or double charges.

#### Feature 3: Server-Side 4-Digit Gate Handshake OTP Verification
- **T1_OTP_01: Dynamic Gate OTP Generation on Arrival**: Patch order status to `ARRIVED_AT_GATE`; verify server generates a dynamic, secure 4-digit numeric OTP attached to the order.
- **T1_OTP_02: FCM Push Notification with OTP Code**: Verify transitioning to `ARRIVED_AT_GATE` triggers student notification containing the generated 4-digit OTP.
- **T1_OTP_03: Status Patch to DELIVERED with Valid OTP**: Patch order status to `DELIVERED` supplying correct 4-digit `otpCode`; verify order transitions successfully to `DELIVERED`.
- **T1_OTP_04: Dedicated OTP Verification Endpoint**: Send `POST /api/orders/:id/verify-gate-otp` with valid OTP; verify order status transitions to `DELIVERED`.
- **T1_OTP_05: Single-Use OTP Invalidation**: Attempt to re-use consumed OTP code after delivery; verify server rejects duplicate OTP verification attempts.

#### Feature 4: Removal of Universal OTPs & JWT/RBAC Auth Enforcement
- **T1_AUTH_01: Complete SMS OTP & JWT Token Flow**: Send OTP via `POST /api/auth/send-otp` and verify via `POST /api/auth/verify-otp`; verify issuance of signed JWT token.
- **T1_AUTH_02: Authenticated Bearer Profile Access**: `GET /api/auth/profile` with `Authorization: Bearer <jwt_token>` returns 200 OK and user profile.
- **T1_AUTH_03: Vendor Role RBAC Enforcement**: `PATCH /api/vendors/:id/toggle` succeeds with `VENDOR` or `ADMIN` JWT token and returns 403 Forbidden for `STUDENT`.
- **T1_AUTH_04: Driver Role RBAC Enforcement**: `POST /api/orders/:id/accept-driver` succeeds with `DRIVER` or `ADMIN` JWT token and returns 403 Forbidden for `STUDENT`.
- **T1_AUTH_05: Master OTP & Mock Token Rejection**: Verify static master OTPs (`4829`, `1234`) and mock tokens (`mock_jwt_token_`) are rejected when environment security is enabled.

#### Feature 5: Real-time Socket.io & FCM Multi-Persona Sync
- **T1_SOC_01: Vendor Room Order Alert Broadcast**: Socket client joined to `vendor_${vendorId}` receives `new_order_alert` event upon new order placement.
- **T1_SOC_02: Scoped Order Status Room Sync**: Socket client joined to `order_${orderId}` receives `order_updated` event when status is patched.
- **T1_SOC_03: Real-Time Driver Location Broadcast**: Emitting `update_driver_location` streams `driver_location_update` payload to connected clients.
- **T1_SOC_04: FCM Push Token Registration & Dispatch**: Register FCM token via `POST /api/notifications/register-token`; verify status changes dispatch FCM push notifications.
- **T1_SOC_05: Multi-Persona Simultaneous State Sync**: Order status change simultaneously updates vendor room socket, customer room socket, and triggers FCM push notification.

#### Feature 6: Transport Security, CORS & Cleartext Traffic Guards
- **T1_SEC_01: CORS Headers Validation**: API responses contain `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods` matching configuration.
- **T1_SEC_02: Preflight OPTIONS Handling**: `OPTIONS` preflight requests to API endpoints return HTTP 200/204 with required CORS headers.
- **T1_SEC_03: Content-Type & JSON Payload Enforcement**: POST/PATCH requests require `Content-Type: application/json` and reject malformed JSON.
- **T1_SEC_04: Environment Port & Base URL Config**: Server respects `PORT` and `NODE_ENV` environment variable settings.
- **T1_SEC_05: Security Header Safeguards**: Server response headers include security safeguards (e.g. `X-Content-Type-Options: nosniff`) and suppress framework signature leaks.

---

## 3. Caveats

- **Database Dependency**: PostgreSQL instance specified by `DATABASE_URL` in `backend/.env` is required when running database-connected tests. For isolated local runs, test harness will seed test data via Prisma or Prisma Client mock/test database.
- **Socket Connection Timing**: Socket.io tests require async handshake handling (e.g. `await socket.connect()`) to prevent race conditions during real-time event assertions.
- **Webhook Raw Body**: Razorpay signature verification for webhooks depends on raw body payload parsing in Express. Test harness must send raw buffer/string to avoid body-parser JSON formatting discrepancies.

---

## 4. Conclusion

- The Kraveo backend structure has been fully mapped across Express routes, JWT auth, Razorpay payment service, FCM notifications, Prisma ORM schema, and Socket.io rooms.
- The test harness architecture for `backend/test/` is specified with 4 essential harness modules (`app.ts`, `db.ts`, `auth.ts`, `socket.ts`).
- A comprehensive suite of 30 Tier 1 happy-path test cases across all 6 features (5 cases/feature) is fully defined and ready for implementation in Subtask 1.

---

## 5. Verification Method

To verify this exploration report and harness plan:
1. Inspect files in `backend/src/`:
   - `index.ts`
   - `routes/api.ts`
   - `middleware/auth.ts`
   - `services/paymentService.ts`
   - `services/notificationService.ts`
   - `prisma/schema.prisma`
2. Validate harness design against `TEST_INFRA.md` and `PROJECT.md`.
3. Verify test case coverage count: 6 features x 5 cases = 30 total Tier 1 test cases defined.
