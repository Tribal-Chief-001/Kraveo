# Kraveo Backend Comprehensive Investigation & Migration Handoff Report

## 1. Observation

### 1.1 Project Structure & Build Configuration
- **Entry Point**: `backend/src/index.ts` (lines 19–75) initializes Express app, HTTP server, and Socket.io server.
- **TypeScript & Build**:
  - `backend/package.json` (lines 6–10):
    ```json
    "scripts": {
      "build": "tsc",
      "start": "node dist/index.js",
      "dev": "ts-node-dev --respawn --transpile-only src/index.ts"
    }
    ```
  - `backend/tsconfig.json` (lines 1–15): Configured for `target: ES2022`, `module: CommonJS`, `rootDir: ./src`, `outDir: ./dist`.
  - Running `npx tsc --noEmit` in `/home/lucifer/Documents/Projects/Kraveo/backend` completes with **0 errors**.
  - `npx prisma validate` fails with `Error code: P1012: Environment variable not found: DATABASE_URL` because `.env` file does not exist in `backend/`.
  - Package dependencies in `package.json`: `@aws-sdk/client-ec2` (`^3.1106.0`) is present in `dependencies` but is not imported or used anywhere in `src/`.

### 1.2 Prisma Schema (`backend/prisma/schema.prisma`) vs In-Memory Store (`backend/src/store.ts` & `backend/src/types.ts`)

#### Models & Fields Comparison Table:

| Model / Entity | Prisma (`schema.prisma`) | In-Memory Store (`store.ts` / `types.ts`) | Discrepancies & Missing Specs |
|---|---|---|---|
| **User** | Lines 37–49: `id`, `phone`, `name`, `role`, `hostelBlock`, `fcmToken`, `createdAt`, `updatedAt` | Lines 4–10 (`User` interface in `types.ts` lines 13–21): includes `kraveoCoins`, `upiId` (set dynamically in `api.ts` line 82) | Missing `kraveoCoins Int @default(0)` and `upiId String?` in `schema.prisma`. |
| **Vendor** | Lines 51–65: `id`, `name`, `category`, `rating`, `eta`, `bannerUrl`, `address`, `isAcceptingOrders` | Lines 13–56 (`Vendor` interface in `types.ts` lines 23–36): includes `userId`, `totalRatingsCount`, `lat`, `lng`, `bannerImage` | Missing `userId String?`, `totalRatingsCount Int @default(50)`, `lat Float @default(23.0768)`, `lng Float @default(76.8524)`. Field naming mismatch: `bannerUrl` vs `bannerImage`. |
| **MenuItem** | Lines 67–80: `id`, `vendorId`, `name`, `price`, `category`, `description`, `imageUrl`, `isAvailable`, `isVeg` | Lines 120–133 (`MenuItem` interface in `types.ts` lines 38–49): includes `rating`, `ratingCount` | Missing `rating Float? @default(4.5)` and `ratingCount Int? @default(0)` in `schema.prisma`. |
| **Order** | Lines 82–102: `id`, `customerId`, `vendorId`, `driverId`, `totalAmount`, `deliveryFee`, `dropoffHostel`, `dropoffNotes`, `status`, `paymentStatus`, `otpCode` | Lines 135–180 (`Order` interface in `types.ts` lines 58–78): includes `customerName`, `customerPhone`, `vendorName`, `driverName`, `driverPhone`, `isReviewed` | Missing `isReviewed Boolean @default(false)` in `schema.prisma`. Customer/vendor/driver names/phones are currently duplicated on `Order` object in `types.ts`. Enum value mismatch: `schema.prisma` `PaymentStatus` includes `FAILED`, `types.ts` does not. |
| **OrderItem** | Lines 104–112: `id`, `orderId`, `name`, `quantity`, `price` | `types.ts` lines 51–56: `itemId`, `name`, `quantity`, `price` | Prisma model missing `menuItemId String?` reference. |
| **Payment** | Lines 114–124: `id`, `orderId`, `razorpayOrderId`, `razorpayPaymentId`, `amount`, `status`, `createdAt` | Not explicit in `store.ts` | Matches Razorpay workflow requirement. |
| **DriverPartner** | **MISSING IN `schema.prisma`** | Lines 58–117 (`DriverPartner` interface in `types.ts` lines 89–107): `id`, `name`, `phone`, `studentRegNo`, `runnerCode`, `avatarUrl`, `vehicleType`, `vehicleRegNo`, `emergencyPhone`, `dutyStatus`, `ordersToday`, `totalEarningsToday`, `avgCompletionTimeMinutes`, `onTimeRatePercent`, `rating`, `upiId`, `createdAt` | Entire `DriverPartner` model is missing from `schema.prisma`. |
| **ReviewRecord** | **MISSING IN `schema.prisma`** | Line 183 (`ReviewRecord` interface in `types.ts` lines 116–129): `id`, `orderId`, `customerId`, `vendorId`, `driverId`, `driverRating`, `driverTags`, `driverNotes`, `dishReviews`, `dhabaNotes`, `coinsEarned`, `createdAt` | Entire `ReviewRecord` model is missing from `schema.prisma`. |
| **DriverLocation** | Lines 126–133: `driverId`, `driverName`, `lat`, `lng`, `heading`, `lastUpdated` | Lines 185–198: `Map<string, DriverLocation>` | Prisma model exists and matches. |

#### Complete Map of 25 API Routes Currently Relying on `store.ts`:
1. `GET /api/drivers`: Reads `driverPartners` array (`api.ts` lines 13–15).
2. `GET /api/drivers/:id`: Reads `driverPartners` array (`api.ts` lines 17–21).
3. `POST /api/auth/verify-otp`: Reads/writes `users` array (`api.ts` lines 52–99).
4. `POST /api/auth/login`: Reads/writes `users` array (`api.ts` lines 102–130).
5. `GET /api/auth/profile`: Reads `users` array (`api.ts` lines 133–138).
6. `PUT /api/auth/profile`: Reads/writes `users` array (`api.ts` lines 141–153).
7. `POST /api/notifications/register-token`: Reads/writes `users` array (`api.ts` lines 190–200).
8. `GET /api/vendors`: Reads `vendors` array (`api.ts` lines 205–207).
9. `GET /api/vendors/:id`: Reads `vendors` and `menuItems` arrays (`api.ts` lines 209–215).
10. `PATCH /api/vendors/:id/toggle`: Reads/writes `vendors` array (`api.ts` lines 217–223).
11. `GET /api/menus/:vendorId`: Reads `menuItems` array (`api.ts` lines 228–231).
12. `PATCH /api/menus/:itemId/toggle`: Reads/writes `menuItems` array (`api.ts` lines 233–239).
13. `GET /api/orders`: Reads `orders` array (`api.ts` lines 244–253).
14. `GET /api/orders/:id`: Reads `orders` array (`api.ts` lines 255–259).
15. `POST /api/orders`: Reads `vendors`, `menuItems` (via `validateAndCalculateOrder`), writes `orders` array (`api.ts` lines 262–319).
16. `PATCH /api/orders/:id/status`: Reads/writes `orders` array (`api.ts` lines 322–363).
17. `PATCH /api/vendors/:id/status`: Reads/writes `vendors` array (`api.ts` lines 366–379).
18. `PATCH /api/vendors/items/:itemId`: Reads/writes `menuItems` array (`api.ts` lines 382–394).
19. `POST /api/orders/:id/accept-driver`: Reads `orders`, `users`, writes `orders` array (`api.ts` lines 397–423).
20. `GET /api/drivers/locations`: Reads `driverLocations` map (`api.ts` lines 428–431).
21. `POST /api/drivers/location`: Writes `driverLocations` map (`api.ts` lines 433–457).
22. `POST /api/reviews`: Reads/writes `orders`, `users`, `menuItems`, `vendors`, `driverPartners`, `reviews` (`api.ts` lines 464–546).
23. `POST /api/coupons/redeem-coins`: Reads/writes `users` array (`api.ts` lines 449–571).
24. `GET /api/reviews/vendor/:vendorId`: Reads `reviews` array (`api.ts` lines 574–577).
25. `GET /api/reviews/driver/:driverId`: Reads `reviews` array (`api.ts` lines 579–583).
26. **Helper module `backend/src/utils/validation.ts`**: Line 1 imports `menuItems` from `../store` and searches menu items directly in memory (`validateAndCalculateOrder` lines 45).

### 1.3 Razorpay & Gate OTP Logic
- **Razorpay Integration**:
  - `backend/src/services/paymentService.ts` implements `createRazorpayOrder` (lines 22–55) and `verifyRazorpayPaymentSignature` (lines 58–73).
  - API endpoints `/api/payments/create-order` and `/api/payments/verify-signature` exist in `api.ts` (lines 161–186).
  - **No Razorpay Webhook Endpoint**: There is no `POST /api/payments/webhook` route in `api.ts`. If client signature verification drops or fails asynchronously, backend has no automated webhook fallback to handle Razorpay `order.paid` or `payment.authorized` events and update order payment status in database.
- **Gate 4-Digit OTP Logic**:
  - `schema.prisma` line 93 sets `otpCode String @default("1234")`.
  - `notificationService.ts` line 96 defines `triggerStudentArrivalNotification(studentPhone, orderId, otpCode)` which formats push alert: `"Your runner is waiting at the gate. Handshake OTP code: ${otpCode}"`.
  - **Gaps**:
    1. When an order is placed (`POST /api/orders` in `api.ts` lines 283–299), `otpCode` is NOT generated or saved on `newOrder`.
    2. `triggerStudentArrivalNotification` is **never called** anywhere in `api.ts` when status changes to `ARRIVED_AT_GATE`.
    3. `PATCH /api/orders/:id/status` (lines 322–363) allows status transition to `DELIVERED` without prompting or verifying the 4-digit OTP code against `order.otpCode`.

### 1.4 Authentication & Security Controls
- **Universal Master OTP Bypass**:
  - `backend/src/routes/api.ts` line 62:
    ```typescript
    const isValidOtp = (storedData && storedData.otp === otp && Date.now() < storedData.expiresAt) || otp === '4829' || otp === '1234';
    ```
    This allows anyone to authenticate as ANY user phone number using static master OTPs `1234` or `4829`.
- **Unauthenticated Account Creation**:
  - `POST /api/auth/login` (`api.ts` lines 102–130) bypasses OTP verification completely and issues JWT tokens directly given a phone number.
- **JWT & Role Authorization Gaps**:
  - `src/middleware/auth.ts` lines 34–38 contain dev mock token fallback: `token.startsWith('mock_jwt_token_')`.
  - `GET /api/orders` and `GET /api/orders/:id` (`api.ts` lines 244–259) have **NO `requireAuth` middleware**, exposing order records, customer names, phone numbers, and dropoff hostels publicly without authentication.
  - `POST /api/orders`, `POST /api/reviews`, `POST /api/coupons/redeem-coins` use `requireAuth` but lack role restrictions via `requireRole(...)`.

### 1.5 Real-Time Communication (Socket.io & FCM Push Notifications)
- **Socket.io Channels (`backend/src/index.ts` lines 50–69)**:
  - Supports `join_room` socket listener.
  - Broadcast behavior in `api.ts`:
    - `POST /api/orders`: Emits `new_order_alert` to room `vendor_${vendorId}`, `order_updated` to room `order_${newOrder.id}`, and global `io.emit('order_updated', newOrder)`.
    - `PATCH /api/orders/:id/status`: Emits `order_updated` to room `order_${order.id}` and global `io.emit('order_updated', order)`.
    - `POST /api/drivers/location`: Emits `driver_location_update` globally via `io.emit`.
- **FCM Push Notification Triggers (`backend/src/services/notificationService.ts`)**:
  - Initialized using service account `firebase-key.json` (lines 15–30).
  - Triggers implemented: `triggerDhabaAlarmPushNotification` (targets `vendor_${vendorId}`).
  - Un-wired triggers: `triggerStudentArrivalNotification` is defined but never called on `ARRIVED_AT_GATE` status transition. No push alerts are sent to student `fcmToken` during kitchen status updates (`ACCEPTED`, `PREPARING`, `READY_FOR_PICKUP`, `PICKED_UP`, `DELIVERED`).

---

## 2. Logic Chain

1. **Prisma Schema Update Logic**:
   - *Observation*: `store.ts` and `types.ts` manage state fields (`kraveoCoins`, `upiId`, `rating`, `ratingCount`, `totalRatingsCount`, `lat`, `lng`, `isReviewed`) and entire structures (`DriverPartner`, `ReviewRecord`) that do not exist in `schema.prisma`.
   - *Deduction*: Attempting to replace `store.ts` directly with Prisma models without modifying `schema.prisma` will result in TypeScript compilation errors and data loss for driver management, reviews, and loyalty rewards.
   - *Action*: `schema.prisma` must be expanded with `DriverPartner` and `ReviewRecord` models, and missing fields must be added to `User`, `Vendor`, `MenuItem`, and `Order` before updating API endpoints.

2. **API Route Migration Logic**:
   - *Observation*: 25 endpoints in `api.ts` directly mutate arrays in `store.ts`. `src/utils/validation.ts` imports `menuItems` directly from `store.ts`.
   - *Deduction*: Migrating to PostgreSQL requires replacing in-memory mutations with async `prisma.<model>.<query>` calls across all 25 routes, and converting `validateAndCalculateOrder` to accept fetched menu items or execute `prisma.menuItem.findMany`.

3. **Payment & OTP Security Logic**:
   - *Observation*: Master OTPs `1234` and `4829` in `api.ts:62` bypass authentication. Gate OTPs default to `"1234"` and are never validated when order status moves to `DELIVERED`. Razorpay has no webhook handler.
   - *Deduction*: Static OTP bypasses present severe authentication security vulnerabilities. Unvalidated gate OTPs compromise runner-to-student handshake verification. Missing Razorpay webhooks increase risk of unconfirmed payments.
   - *Action*: Remove master OTP bypasses, enforce dynamic 4-digit OTP generation on order creation, send arrival push notification on `ARRIVED_AT_GATE`, require OTP verification on `DELIVERED`, and implement HMAC SHA256 verified `POST /api/payments/webhook`.

4. **Authorization & Privacy Enforcement Logic**:
   - *Observation*: `GET /api/orders` lacks `requireAuth`. Driver locations and order status updates are broadcast globally via `io.emit`.
   - *Deduction*: Customer names, hostel locations, and driver GPS coordinates are exposed to unauthorized clients.
   - *Action*: Add `requireAuth` to order endpoints with customer/vendor/driver ownership filters, and scope Socket.io events strictly to `order_${id}` and `vendor_${id}` rooms.

---

## 3. Caveats

1. **Database Environment**: No `.env` file exists in `backend/` currently. PostgreSQL connection string (`DATABASE_URL`) must be provided in `.env` before running `npx prisma migrate dev`.
2. **Firebase Service Key**: `firebase-key.json` exists in `backend/` root, but actual push notification delivery depends on valid Google Cloud Firebase credentials.
3. **High-Frequency GPS Performance**: Storing real-time driver location updates (`POST /api/drivers/location`) directly in PostgreSQL via Prisma on every tick will create high DB write IOPS. Using Redis or keeping in-memory state with periodic DB sync is recommended if driver density increases.

---

## 4. Conclusion & Actionable Migration Blueprint

### 4.1 Schema Migration (`backend/prisma/schema.prisma`)
The updated Prisma schema must contain:
1. **User**: Add `kraveoCoins Int @default(0)`, `upiId String?`.
2. **Vendor**: Add `userId String?`, `totalRatingsCount Int @default(50)`, `lat Float @default(23.0768)`, `lng Float @default(76.8524)`, rename/alias `bannerUrl` to `bannerImage`.
3. **MenuItem**: Add `rating Float? @default(4.5)`, `ratingCount Int? @default(0)`.
4. **Order**: Add `isReviewed Boolean @default(false)`, `otpCode String` (generated per order).
5. **DriverPartner Model**: Add model matching `DriverPartner` interface.
6. **ReviewRecord Model**: Add model with relations to `Order`, `User`, `Vendor`, and `User` (Driver).

### 4.2 API Endpoint Refactoring Specifications
- **Auth**:
  - Remove `'4829'` and `'1234'` static checks from `POST /api/auth/verify-otp`.
  - In non-production, return `demoOtp` in response body.
  - Require OTP verification for login (deprecate unauthenticated `POST /api/auth/login`).
- **Orders & Gate OTP**:
  - `POST /api/orders`: Generate random 4-digit OTP (`Math.floor(1000 + Math.random() * 9000).toString()`) and store in DB.
  - `PATCH /api/orders/:id/status`: When status transitions to `ARRIVED_AT_GATE`, call `triggerStudentArrivalNotification`.
  - Add `POST /api/orders/:id/verify-gate-otp` (or validate `otp` in status transition to `DELIVERED`).
- **Razorpay Webhooks**:
  - Add `POST /api/payments/webhook` with `express.raw()` body parser and HMAC SHA256 signature check against `x-razorpay-signature`. Transition payment status to `PAID` on `order.paid`.
- **RBAC & Data Privacy**:
  - Add `requireAuth` to `GET /api/orders` and `GET /api/orders/:id`.
  - Scope `io.emit` to room subscribers (`order_${id}`, `vendor_${id}`).

### 4.3 Build Configuration Updates
- Update `package.json` build script to `"build": "prisma generate && tsc"`.
- Remove unused `@aws-sdk/client-ec2` package.

---

## 5. Verification Method

### 5.1 Verification Commands
1. **TypeScript Build Check**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend
   npm run build
   ```
   *Expected result*: `prisma generate` runs successfully (once `.env` is configured), and `tsc` compiles with 0 errors.

2. **Prisma Schema Validation**:
   ```bash
   DATABASE_URL="postgresql://user:pass@localhost:5432/kraveo" npx prisma validate
   ```
   *Expected result*: `The schema at prisma/schema.prisma is valid.`

3. **Authentication Verification**:
   ```bash
   curl -X POST http://localhost:5000/api/auth/verify-otp \
     -H "Content-Type: application/json" \
     -d '{"phone": "9876543210", "otp": "1234"}'
   ```
   *Expected result*: HTTP 400 `Invalid or expired OTP code.` once master OTP bypass is removed.

4. **Order State & Gate OTP Verification**:
   - Create order via `POST /api/orders`, verify 4-digit OTP is generated.
   - Patch order status to `ARRIVED_AT_GATE`, verify FCM push trigger is executed.
   - Attempt status update to `DELIVERED` without correct OTP -> expect HTTP 400 refusal.
