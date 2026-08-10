# Explorer Handoff Report — Subtask 2 of Milestone 2 (Backend Prisma ORM & PostgreSQL Migration)

## 1. Observation

### 1.1 `backend/src/routes/api.ts`
- **Total Route Definitions**: 28 endpoints (across auth, vendors, menus, orders, driver locations, driver management, reviews, and coupons).
- **In-Memory Fallbacks**: Lines 215-218 (`GET /vendors`), 230-232 (`GET /vendors/:id`), 258-260 (`GET /menus/:vendorId`), 276-278 (`PATCH /menus/:itemId/toggle`), 308-310 (`GET /orders`), 329-331 (`GET /orders/:id`), 383-385 (`POST /orders`), 466-468 (`PATCH /orders/:id/status`), 528-530 (`PATCH /vendors/:id/status`), 553-555 (`PATCH /vendors/items/:itemId`), 594-596 (`POST /orders/:id/accept-driver`), 626-628 (`GET /drivers/locations`), 650-652 (`POST /drivers/location`).
  - *Verbatim snippet from line 215-218*:
    ```ts
    } catch (err) {
      // Fallback to in-memory store if DB is disconnected
    }
    return res.json({ success: true, count: vendors.length, data: vendors });
    ```
- **Synchronous Express Handlers**: Routes like `GET /drivers` (lines 14-16), `GET /drivers/:id` (lines 18-22), `POST /auth/send-otp` (lines 30-50), `POST /auth/verify-otp` (lines 53-103), `POST /auth/login` (lines 106-134), `GET /auth/profile` (lines 137-142), `PUT /auth/profile` (lines 145-157), `PATCH /vendors/:id/toggle` (lines 241-247), `POST /reviews` (lines 678-760), and `POST /coupons/redeem-coins` (lines 763-785) are currently synchronous function signatures `(req: Request, res: Response) => { ... }` that directly access in-memory arrays.
- **Complex Multi-Model Operations in `POST /reviews`**:
  - *Lines 678-760*: Modifies 6 separate data entities synchronously: `User` (kraveoCoins +10), `Order` (isReviewed = true), `MenuItem` (updates rating and ratingCount per dish), `Vendor` (computes Bayesian rating formula `((C * m) + sum) / (C + N)` and increments totalRatingsCount), `DriverPartner` (updates driver rating), and `ReviewRecord` (pushes new record to array).
- **Missing Prisma Integration in Driver & Auth Endpoints**:
  - `GET /drivers` (line 14) and `GET /drivers/:id` (line 18) query `driverPartners` in-memory array directly without any Prisma calls.
  - `POST /auth/verify-otp` (lines 75-92) and `POST /auth/login` (lines 113-125) check and create users in `users` in-memory array.
  - `GET /auth/profile` (line 138) and `PUT /auth/profile` (line 146) read/update `users` array.

### 1.2 `backend/src/utils/validation.ts`
- **Synchronous Menu Lookup**:
  - *Line 1 & 45*:
    ```ts
    import { menuItems } from '../store';
    ...
    const menuItem = menuItems.find((i) => i.id === rawItem.itemId && i.vendorId === vendorId);
    ```
  - `validateAndCalculateOrder` is currently synchronous and imports `menuItems` directly from `../store`.

### 1.3 `backend/src/utils/seedDb.ts`
- **Incomplete Seeding**:
  - Lines 9-41: Only seeds 3 users (`usr-1`, `usr-2`, `usr-3`). Misses `usr-4` (Vikram Singh), `usr-5` (Super Admin), `usr-6` (Canteen Owner), `usr-7` (Singh Kitchen Owner), `usr-8` (Rohan Mehta), `usr-9` (Aman Deep).
  - Lines 44-72: Only seeds 2 vendors (`ven-1`, `ven-2`). Misses `ven-3` (Singh Punjabi Kitchen). `userId` foreign keys are not linked.
  - Lines 75-121: Seeds menu items with IDs `dish-1`, `dish-2`, `dish-3`. Misses `item-1` through `item-7` used in `store.ts` and tests.
  - Does NOT seed any `DriverPartner` records (`schema.prisma` lines 151-173).

### 1.4 `backend/prisma/schema.prisma`
- Enums: `Role` (`STUDENT`, `VENDOR`, `DRIVER`, `ADMIN`), `OrderStatus` (`PLACED`, `ACCEPTED`, `PREPARING`, `READY_FOR_PICKUP`, `PICKED_UP`, `ARRIVED_AT_GATE`, `DELIVERED`, `CANCELLED`), `PaymentStatus` (`PENDING`, `PAID`, `FAILED`, `REFUNDED`), `DutyStatus` (`ONLINE`, `OFFLINE`, `IN_TRANSIT`).
- Models & Relations:
  - `User` has `ordersPlaced`, `ordersDriven`, `driverProfile` (`DriverPartner?`), `vendorsOwned`, `reviewsGiven`, `reviewsReceived`.
  - `Vendor` has `user` (`User?`), `menuItems`, `orders`, `reviews`.
  - `Order` has `customer` (`User`), `vendor` (`Vendor`), `driver` (`User?`), `items` (`OrderItem[]`), `payments` (`Payment[]`), `review` (`ReviewRecord?`).
  - `DriverPartner` has `userId` (`String? @unique`), `dutyStatus` (`DutyStatus`), `runnerCode` (`@unique`).
  - `ReviewRecord` has `dishReviews` (`Json`), `driverTags` (`String[]`).

---

## 2. Logic Chain

1. **Elimination of Fallback Arrays & Contract Enforcement**:
   - Scope requirement states "Zero in-memory array fallbacks. Database records must persist cleanly across restarts."
   - In `api.ts`, all try/catch blocks that fall back to `vendors`, `orders`, `menuItems`, `driverLocations`, etc. must be removed. Route handlers should directly return database query results or fail gracefully with appropriate HTTP error status codes (e.g. 500 Internal Server Error) if the database query fails.

2. **Async Middleware & Handler Signature Conversion**:
   - Because Prisma ORM queries are asynchronous (`Promise`), every Express route handler in `api.ts` that interacts with Prisma must be defined as `async (req: Request, res: Response, next: NextFunction) => { ... }`.
   - Express 4 does not automatically catch unhandled rejected promises in `async` handlers. Therefore, try-catch blocks must wrap Prisma calls and return appropriate error responses (e.g. `res.status(500).json({ success: false, message: err.message })`).

3. **`validation.ts` Transformation to Async Database Querying**:
   - `validateAndCalculateOrder` in `validation.ts` must be converted to an `async` function accepting `(vendorId: string, items: { itemId: string; quantity: number }[], couponCode?: string, prismaClient?: PrismaClient | Prisma.TransactionClient)`.
   - Instead of scanning `menuItems` array, it will execute `await (prismaClient || prisma).menuItem.findMany({ where: { vendorId, id: { in: items.map(i => i.itemId) } } })` to inspect actual database availability and prices.

4. **Multi-Model Atomic Operations via `prisma.$transaction`**:
   - **`POST /reviews`**:
     - Updating `User.kraveoCoins`, `Order.isReviewed`, multiple `MenuItem` ratings, `Vendor` Bayesian rating, `DriverPartner` rating, and creating `ReviewRecord` MUST be wrapped inside `await prisma.$transaction(async (tx) => { ... })`.
     - *Bayesian Rating Calculation*: `const bayesianRating = ((10 * 4.5) + newRatingSum) / (10 + newTotalCount);` using values fetched inside the transaction.
   - **`POST /orders`**:
     - Wrapped in transaction or nested create: `await prisma.order.create({ data: { customerId, vendorId, totalAmount, deliveryFee, dropoffHostel, dropoffNotes, status: 'PLACED', paymentStatus: 'PAID', otpCode, items: { create: verifiedItems.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, menuItemId: i.itemId })) } }, include: { items: true, vendor: true, customer: true } })`.
   - **`POST /orders/:id/accept-driver`**:
     - Update order `driverId` and `status`, plus optionally update driver `dutyStatus` to `IN_TRANSIT` within a transaction.
   - **`POST /payments/verify-signature`**:
     - Verify signature; if valid, update `Payment.status = 'PAID'` and `Order.paymentStatus = 'PAID'` inside a transaction.

5. **Driver Partner Lookup Strategy**:
   - Notice `Order.driverId` references `User.id` (e.g., `'usr-4'`), whereas `DriverPartner` has its own `id` and an optional `userId` (`schema.prisma` line 153).
   - When updating or querying `DriverPartner` by `driverId` (e.g., in `/drivers/:id` or `/reviews`), the query should check both `id` and `userId`:
     `await prisma.driverPartner.findFirst({ where: { OR: [{ id: driverId }, { userId: driverId }] } })`.

6. **Seed Script Realignment (`seedDb.ts`)**:
   - Expand `seedDb.ts` to upsert all users (`usr-1` through `usr-9`), all vendors (`ven-1`, `ven-2`, `ven-3` linked to respective user IDs), all menu items (`item-1` through `item-7`), driver partners (`usr-4`, `usr-8`, `usr-9`), and initial driver location for `usr-4`.
   - Use deterministic IDs (`usr-1`, `ven-1`, `item-1`, etc.) so existing integration tests or frontend mock expectations continue to function seamlessly.

---

## 3. Caveats

1. **OTP Storage**:
   - `const otpStore = new Map<string, { otp: string; expiresAt: number }>()` in `api.ts` is ephemeral in-memory storage for 2FA SMS OTP codes. This is acceptable as OTPs expire in 5 minutes and are not persistent database records. User accounts created upon OTP verification ARE stored in PostgreSQL.
2. **WebSocket Broadcasts Outside Transactions**:
   - Socket.IO emissions (`req.app.get('io')?.emit(...)`) should occur AFTER `prisma.$transaction` successfully commits, ensuring real-time events are only broadcast when database changes are finalized.
3. **JSON Serialization in Prisma**:
   - `ReviewRecord.dishReviews` is defined as `Json` in Prisma schema. When writing `dishReviews`, pass the array directly or cast as `Prisma.InputJsonValue`.
4. **Role String vs Enum Casting**:
   - `User.role` in schema uses Prisma `Role` enum (`STUDENT`, `VENDOR`, `DRIVER`, `ADMIN`). `req.body.role` or `req.user.role` must be asserted or validated against `Role`.

---

## 4. Conclusion & Route Migration Plan

### Detailed Endpoint Migration Map

| # | Endpoint | Method | Models Touched | Primary Prisma Queries / Operations | Notes & Transaction Scope |
|---|---|---|---|---|---|
| 1 | `/drivers` | `GET` | `DriverPartner` | `prisma.driverPartner.findMany()` | Async handler, return list |
| 2 | `/drivers/:id` | `GET` | `DriverPartner` | `prisma.driverPartner.findFirst({ where: { OR: [{ id: id }, { userId: id }] } })` | Fallback search by `id` or `userId` |
| 3 | `/auth/send-otp` | `POST` | Ephemeral `otpStore` | None (ephemeral OTP generation) | Retain 5-min OTP map |
| 4 | `/auth/verify-otp` | `POST` | `User` | `prisma.user.findUnique({ where: { phone } })` + `create`/`update` | Issue JWT token upon success |
| 5 | `/auth/login` | `POST` | `User` | `prisma.user.upsert({ where: { phone }, update: {}, create: { ... } })` | Issue JWT token |
| 6 | `/auth/profile` | `GET` | `User` | `prisma.user.findUnique({ where: { id: req.user.id } })` | `requireAuth` |
| 7 | `/auth/profile` | `PUT` | `User` | `prisma.user.update({ where: { id: req.user.id }, data: { name, hostelBlock, upiId, fcmToken } })` | Update user profile |
| 8 | `/payments/create-order` | `POST` | `Order`, `Payment` | `prisma.order.findUnique` + `prisma.payment.upsert` | Create Razorpay order record |
| 9 | `/payments/verify-signature` | `POST` | `Payment`, `Order` | `prisma.$transaction` updating `Payment` & `Order` status to `PAID` | Verify HMAC signature |
| 10 | `/notifications/register-token` | `POST` | `User` | `prisma.user.update({ where: { id: req.user.id }, data: { fcmToken } })` | Store FCM push token |
| 11 | `/vendors` | `GET` | `Vendor`, `MenuItem` | `prisma.vendor.findMany({ include: { menuItems: true } })` | Remove store fallback |
| 12 | `/vendors/:id` | `GET` | `Vendor`, `MenuItem` | `prisma.vendor.findUnique({ where: { id }, include: { menuItems: true } })` | Format response `{ ...vendor, menu: vendor.menuItems }` |
| 13 | `/vendors/:id/toggle` | `PATCH` | `Vendor` | `prisma.vendor.findUnique` + `prisma.vendor.update` | Toggle `isAcceptingOrders` |
| 14 | `/menus/:vendorId` | `GET` | `MenuItem` | `prisma.menuItem.findMany({ where: { vendorId } })` | Fetch menu by vendor |
| 15 | `/menus/:itemId/toggle` | `PATCH` | `MenuItem` | `prisma.menuItem.findUnique` + `prisma.menuItem.update` | Toggle `isAvailable` |
| 16 | `/orders` | `GET` | `Order`, `OrderItem`, `Vendor`, `User` | `prisma.order.findMany({ where: whereClause, include: { items: true, vendor: true, customer: true, driver: true }, orderBy: { createdAt: 'desc' } })` | Filter by `vendorId`, `driverId`, `customerId` |
| 17 | `/orders/:id` | `GET` | `Order`, `OrderItem`, `Vendor`, `User` | `prisma.order.findUnique({ where: { id }, include: { items: true, vendor: true, customer: true, driver: true } })` | Detailed order lookup |
| 18 | `/orders` | `POST` | `Order`, `OrderItem`, `Vendor`, `MenuItem` | `await validateAndCalculateOrder(...)` then `prisma.order.create({ data: { ..., items: { create: [...] } }, include: { items: true, vendor: true, customer: true } })` | Re-verify dhaba `isAcceptingOrders`, nested order items creation |
| 19 | `/orders/:id/status` | `PATCH` | `Order`, `DriverPartner` | `prisma.order.findUnique` + `isValidStateTransition` + `prisma.$transaction` updating `Order.status` & `DriverPartner` metrics | Enforce state machine transitions |
| 20 | `/vendors/:id/status` | `PATCH` | `Vendor` | `prisma.vendor.update({ where: { id }, data: { isAcceptingOrders } })` | Set store open/closed |
| 21 | `/vendors/items/:itemId` | `PATCH` | `MenuItem` | `prisma.menuItem.update({ where: { id }, data: updateData })` | Update price/availability |
| 22 | `/orders/:id/accept-driver` | `POST` | `Order`, `DriverPartner` | `prisma.$transaction` updating `Order.driverId`, `Order.status`, and `DriverPartner.dutyStatus = 'IN_TRANSIT'` | Prevent double assignment |
| 23 | `/drivers/locations` | `GET` | `DriverLocation` | `prisma.driverLocation.findMany()` | Return active driver GPS locations |
| 24 | `/drivers/location` | `POST` | `DriverLocation` | `prisma.driverLocation.upsert({ where: { driverId }, update: { ... }, create: { ... } })` | Upsert GPS coordinate |
| 25 | `/reviews` | `POST` | `Order`, `User`, `MenuItem`, `Vendor`, `DriverPartner`, `ReviewRecord` | `prisma.$transaction(async (tx) => { ... })` performing 6 model updates atomically | Multi-model atomic review & Kraveo Coins (+10) update |
| 26 | `/coupons/redeem-coins` | `POST` | `User` | `prisma.user.findUnique` + check `kraveoCoins >= 50` + `prisma.user.update({ data: { kraveoCoins: { decrement: 50 } } })` | Deduct 50 coins for `KRAVEO20` coupon |
| 27 | `/reviews/vendor/:vendorId` | `GET` | `ReviewRecord` | `prisma.reviewRecord.findMany({ where: { vendorId } })` | Fetch reviews for Dhaba |
| 28 | `/reviews/driver/:driverId` | `GET` | `ReviewRecord` | `prisma.reviewRecord.findMany({ where: { driverId } })` | Fetch reviews for Runner |

---

## 5. Verification Method

To verify the migration independently:

1. **Schema Generation & TypeScript Build Check**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend
   npx prisma generate
   npm run build
   ```
   Must complete with **0 TypeScript errors** and **0 compilation warnings**.

2. **Database Seeding Verification**:
   ```bash
   npx prisma db push --skip-generate
   npm run seed
   ```
   Must complete cleanly with output: `✅ PostgreSQL Database Seeding Complete!`.

3. **In-Memory Store Isolation Audit**:
   Grep `store.ts` imports across `backend/src/routes/api.ts` and `backend/src/utils/validation.ts`:
   ```bash
   grep -n "from '../store'" backend/src/routes/api.ts backend/src/utils/validation.ts
   ```
   Must return **0 matches** (indicating full removal of `store.ts` imports in production endpoints).
