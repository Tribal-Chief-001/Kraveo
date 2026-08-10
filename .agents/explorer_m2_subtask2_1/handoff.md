# Subtask 2 Handoff Report: Backend Prisma ORM & PostgreSQL Persistence Migration

## 1. Observation

Direct examination of the backend codebase revealed the following structural details, file locations, line references, and in-memory persistence pattern:

- **Files Examined**:
  - `backend/prisma/schema.prisma` (203 lines) — Fully defined models: `User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `Payment`, `DriverPartner`, `ReviewRecord`, `DriverLocation` with enums `Role`, `OrderStatus`, `PaymentStatus`, `DutyStatus`.
  - `backend/src/store.ts` (199 lines) — Contains in-memory mock data arrays: `users`, `vendors`, `driverPartners`, `menuItems`, `orders`, `reviews`, and `driverLocations` (Map).
  - `backend/src/routes/api.ts` (798 lines) — Contains **28 API routes** (25 primary routes + 3 auxiliary review/coupon routes). 10 routes currently contain half-implemented `try/catch` fallbacks to `store.ts`, while 18 routes rely entirely on in-memory arrays.
  - `backend/src/utils/validation.ts` (105 lines) — `validateAndCalculateOrder` is currently a **synchronous** function importing `menuItems` directly from `../store`.
  - `backend/src/utils/seedDb.ts` (134 lines) — Currently contains minimal seed data (3 users, 2 vendors, 3 menu items), missing initial driver partners, reviews, order history, and driver locations.
  - `backend/src/types.ts` (131 lines) — Defines TypeScript interfaces for `User`, `Vendor`, `MenuItem`, `OrderItem`, `Order`, `DriverLocation`, `DriverPartner`, `ReviewRecord`, `DishReviewInput`.

- **In-Memory Store Imports Observed**:
  - `api.ts:2`: `import { vendors, menuItems, orders, driverLocations, users, driverPartners, reviews } from '../store';`
  - `validation.ts:1`: `import { menuItems } from '../store';`

- **Fallback Patterns Observed**:
  - `api.ts:209-219` (`GET /vendors`), `221-239` (`GET /vendors/:id`), `252-264` (`GET /menus/:vendorId`), `266-285` (`PATCH /menus/:itemId/toggle`), `290-318` (`GET /orders`), `320-336` (`GET /orders/:id`), `339-441` (`POST /orders`), `444-512` (`PATCH /orders/:id/status`), `515-537` (`PATCH /vendors/:id/status`), `540-564` (`PATCH /vendors/items/:itemId`), `567-615` (`POST /orders/:id/accept-driver`), `620-632` (`GET /drivers/locations`), `634-671` (`POST /drivers/location`).

---

## 2. Logic Chain

1. **Elimination of Fallbacks**:
   - Current routes attempt DB queries in `try` blocks and revert to `store.ts` in `catch` blocks or `if (!dbResult)` blocks. This creates dual-state inconsistency where writes in memory are lost on server restart, and DB state becomes stale.
   - To achieve 100% database persistence as required by `SCOPE.md`, all `store.ts` imports and fallbacks must be deleted from `api.ts` and `validation.ts`. DB query failures should return proper HTTP error status codes (e.g. `404` for missing records, `500` for DB execution errors).

2. **Async Transformation of Validation Engine**:
   - `validateAndCalculateOrder` in `validation.ts` performs synchronous `.find()` on `menuItems`.
   - Querying PostgreSQL requires an `async` function. Converting `validateAndCalculateOrder` to `async` returning `Promise<OrderValidationResult>` requires fetching menu items via `prisma.menuItem.findMany({ where: { id: { in: itemIds }, vendorId } })`.
   - Consequently, callers of `validateAndCalculateOrder` (specifically `POST /orders`) must use `await validateAndCalculateOrder(...)`.

3. **Atomic Multi-Entity Operations**:
   - Route `POST /reviews` modifies 5 distinct entities simultaneously (User `kraveoCoins`, Order `isReviewed`, MenuItem `rating`/`ratingCount`, Vendor `rating`/`totalRatingsCount`, DriverPartner `rating`, and creates `ReviewRecord`).
   - Reconciling in-memory array manipulation with Prisma requires using sequential async Prisma queries or `prisma.$transaction` to ensure atomic state updates.

4. **Complete Seeding Pipeline**:
   - Since `store.ts` in-memory arrays will no longer be used at runtime, `seedDb.ts` must be expanded to seed all initial data from `store.ts` (including users `usr-1` through `usr-9`, vendors `ven-1` through `ven-3`, driver partners `usr-4`, `usr-8`, `usr-9`, menu items `item-1` through `item-7`, orders `ord-101`, `ord-102`, and driver locations).

---

## 3. Caveats

- **Type Mappings (`Json` vs `DishReviewInput[]`)**: `ReviewRecord.dishReviews` is stored as `Json` in Prisma schema, whereas `ReviewRecord` interface in `types.ts` defines `dishReviews: DishReviewInput[]`. When returning reviews from Prisma or creating records, explicit casting (`dishReviews as unknown as Prisma.InputJsonValue`) or type alignment is necessary.
- **Master Dev OTP Codes**: `POST /auth/verify-otp` supports master dev codes `'4829'` and `'1234'` in non-production environments. This logic uses the transient in-memory `otpStore` Map and does not require Prisma DB persistence for OTP tokens, but user profile retrieval/creation during OTP verification must interact directly with `prisma.user`.
- **Driver Partner Identification**: In `store.ts`, `DriverPartner` objects used `id` values matching user IDs (e.g. `'usr-4'`). In `schema.prisma`, `DriverPartner` has a primary key `id` and an optional `@unique` relation `userId`. In queries searching for driver profiles, matching against both `id` and `userId` ensures compatibility.

---

## 4. Conclusion & Complete Migration Blueprint

### Part A: Seeding Strategy (`backend/src/utils/seedDb.ts`)
Update `seedDb.ts` to upsert:
1. **Users**: `usr-1` (Rahul Sharma), `usr-2` (Ananya Verma), `usr-3` (Ram Singh Dhaba Owner), `usr-4` (Vikram Singh Runner), `usr-5` (Super Admin), `usr-6` (Canteen Owner), `usr-7` (Punjabi Kitchen Owner), `usr-8` (Rohan Mehta Runner), `usr-9` (Aman Deep Runner).
2. **Driver Partners**: `usr-4` (runnerCode: `RUN-8042`), `usr-8` (runnerCode: `RUN-8043`), `usr-9` (runnerCode: `RUN-8044`).
3. **Vendors**: `ven-1` (Sharma Highway Dhaba), `ven-2` (Campus Night Canteen), `ven-3` (Singh Punjabi Kitchen).
4. **Menu Items**: `item-1` to `item-3` (`ven-1`), `item-4` to `item-5` (`ven-2`), `item-6` to `item-7` (`ven-3`).
5. **Orders & OrderItems**: `ord-101` (`PICKED_UP`), `ord-102` (`PREPARING`).
6. **Driver Location**: `usr-4` (lat: 23.0772, lng: 76.8535).

---

### Part B: Order Validation Migration (`backend/src/utils/validation.ts`)
Transform `validateAndCalculateOrder` to `async`:
```typescript
import { prisma } from '../db';
import { OrderItem } from '../types';

export interface OrderValidationResult {
  isValid: boolean;
  errorMessage?: string;
  verifiedItems: OrderItem[];
  calculatedSubtotal: number;
  calculatedDeliveryFee: number;
  calculatedTotalAmount: number;
}

export const validateAndCalculateOrder = async (
  vendorId: string, 
  items: { itemId: string; quantity: number }[],
  couponCode?: string
): Promise<OrderValidationResult> => {
  if (!items || items.length === 0) {
    return { isValid: false, errorMessage: 'Cart cannot be empty.', verifiedItems: [], calculatedSubtotal: 0, calculatedDeliveryFee: 25, calculatedTotalAmount: 25 };
  }

  const itemIds = items.map((i) => i.itemId);
  const dbMenuItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, vendorId }
  });

  const menuItemMap = new Map(dbMenuItems.map((item) => [item.id, item]));
  let subtotal = 0;
  const verifiedItems: OrderItem[] = [];

  for (const rawItem of items) {
    if (!rawItem.quantity || rawItem.quantity <= 0) {
      return { isValid: false, errorMessage: `Invalid quantity '${rawItem.quantity}' for item ${rawItem.itemId}.`, verifiedItems: [], calculatedSubtotal: 0, calculatedDeliveryFee: 25, calculatedTotalAmount: 25 };
    }

    const menuItem = menuItemMap.get(rawItem.itemId);
    if (!menuItem) {
      return { isValid: false, errorMessage: `Item '${rawItem.itemId}' is not available at this dhaba.`, verifiedItems: [], calculatedSubtotal: 0, calculatedDeliveryFee: 25, calculatedTotalAmount: 25 };
    }

    if (!menuItem.isAvailable) {
      return { isValid: false, errorMessage: `Item '${menuItem.name}' is currently SOLD OUT.`, verifiedItems: [], calculatedSubtotal: 0, calculatedDeliveryFee: 25, calculatedTotalAmount: 25 };
    }

    const itemTotal = menuItem.price * rawItem.quantity;
    subtotal += itemTotal;
    verifiedItems.push({ itemId: menuItem.id, name: menuItem.name, quantity: rawItem.quantity, price: menuItem.price });
  }

  const deliveryFee = 25;
  const taxAndPackaging = 15;
  let discount = 0;

  if (couponCode) {
    const code = couponCode.trim().toUpperCase();
    if (code === 'VITFIRST' && subtotal >= 100) discount = Math.min(subtotal * 0.20, 50);
    else if (code === 'KRAVEO20' && subtotal >= 80) discount = 20;
    else if (code === 'KRAVEO50' && subtotal >= 150) discount = 50;
  }

  const totalAmount = Math.max(0, subtotal + deliveryFee + taxAndPackaging - discount);
  return { isValid: true, verifiedItems, calculatedSubtotal: subtotal, calculatedDeliveryFee: deliveryFee, calculatedTotalAmount: totalAmount };
};
```

---

### Part C: API Route Query Mapping (`backend/src/routes/api.ts`)

| # | Route | Method | Prisma Model & Query Equivalent | Includes / Special Logic |
|---|-------|--------|--------------------------------|--------------------------|
| 1 | `/drivers` | `GET` | `prisma.driverPartner.findMany()` | `include: { user: true }` |
| 2 | `/drivers/:id` | `GET` | `prisma.driverPartner.findUnique({ where: { id } })` | `include: { user: true }`, return 404 if null |
| 3 | `/auth/send-otp` | `POST` | Uses transient `otpStore` Map | No DB query, send OTP payload |
| 4 | `/auth/verify-otp` | `POST` | `prisma.user.findUnique({ where: { phone } })`<br>`prisma.user.create()` / `prisma.user.update()` | Create or update user profile, issue JWT token |
| 5 | `/auth/login` | `POST` | `prisma.user.findUnique({ where: { phone } })`<br>`prisma.user.create()` | Auto-provision user if not existing, issue JWT token |
| 6 | `/auth/profile` | `GET` | `prisma.user.findUnique({ where: { id: req.user.id } })` | Return user profile or 404 |
| 7 | `/auth/profile` | `PUT` | `prisma.user.update({ where: { id: req.user.id }, data })` | Update name, hostelBlock, upiId, fcmToken |
| 8 | `/payments/create-order` | `POST` | `createRazorpayOrder(orderId, amount)` | Delegate to Razorpay service |
| 9 | `/payments/verify-signature` | `POST` | `prisma.payment.updateMany({ where: { razorpayOrderId }, data: { status: 'PAID' } })` | Verify HMAC signature, set payment PAID |
| 10 | `/notifications/register-token` | `POST` | `prisma.user.update({ where: { id: req.user.id }, data: { fcmToken } })` | Register FCM push token |
| 11 | `/vendors` | `GET` | `prisma.vendor.findMany({ include: { menuItems: true } })` | Return all vendors with menu items |
| 12 | `/vendors/:id` | `GET` | `prisma.vendor.findUnique({ where: { id }, include: { menuItems: true } })` | Map `menu: vendor.menuItems` in response |
| 13 | `/vendors/:id/toggle` | `PATCH` | `prisma.vendor.findUnique()` then `prisma.vendor.update({ data: { isAcceptingOrders: !vendor.isAcceptingOrders } })` | Toggle store status, require role VENDOR/ADMIN |
| 14 | `/menus/:vendorId` | `GET` | `prisma.menuItem.findMany({ where: { vendorId } })` | Fetch vendor's menu items |
| 15 | `/menus/:itemId/toggle` | `PATCH` | `prisma.menuItem.findUnique()` then `prisma.menuItem.update({ data: { isAvailable: !item.isAvailable } })` | Toggle item availability |
| 16 | `/orders` | `GET` | `prisma.order.findMany({ where: whereClause, include: { items: true, vendor: true, customer: true, driver: true }, orderBy: { createdAt: 'desc' } })` | Filter by vendorId, driverId, customerId query params |
| 17 | `/orders/:id` | `GET` | `prisma.order.findUnique({ where: { id }, include: { items: true, vendor: true, customer: true, driver: true } })` | Fetch single order with relations |
| 18 | `/orders` | `POST` | `await validateAndCalculateOrder(...)`<br>`prisma.vendor.findUnique()`<br>`prisma.order.create({ data: { ..., items: { create: ... } }, include: { items: true, vendor: true, customer: true } })` | Server price check, closed Dhaba check, DB insert, WebSockets & FCM alert |
| 19 | `/orders/:id/status` | `PATCH` | `prisma.order.findUnique()` -> state machine check -> `prisma.order.update({ where: { id }, data: { status }, include: { items: true, vendor: true, customer: true, driver: true } })` | Enforce role permissions & state machine transitions, emit Socket event |
| 20 | `/vendors/:id/status` | `PATCH` | `prisma.vendor.update({ where: { id }, data: { isAcceptingOrders } })` | Set Dhaba OPEN/CLOSED status |
| 21 | `/vendors/items/:itemId` | `PATCH` | `prisma.menuItem.update({ where: { id: itemId }, data: updateData })` | Update menu item price or availability |
| 22 | `/orders/:id/accept-driver` | `POST` | `prisma.order.findUnique()` -> driver conflict check -> `prisma.order.update({ where: { id }, data: { driverId, status }, include: { items: true, vendor: true, customer: true, driver: true } })` | Assign runner to order, set ACCEPTED status |
| 23 | `/drivers/locations` | `GET` | `prisma.driverLocation.findMany()` | Fetch active runner GPS coordinates |
| 24 | `/drivers/location` | `POST` | `prisma.driverLocation.upsert({ where: { driverId }, update: ..., create: ... })` | Update runner GPS location, emit Socket event |
| 25 | `/reviews` | `POST` | Multi-step transaction/queries:<br>1. `prisma.order.findUnique()`<br>2. `prisma.user.update({ data: { kraveoCoins: { increment: 10 } } })`<br>3. `prisma.order.update({ data: { isReviewed: true } })`<br>4. Loop & `prisma.menuItem.update()` (recalculate average rating)<br>5. `prisma.vendor.update()` (Bayesian rating formula)<br>6. `prisma.driverPartner.update()` (driver rating)<br>7. `prisma.reviewRecord.create()` | Submit review, update ratings, credit +10 Kraveo Coins |
| 26 | `/coupons/redeem-coins` | `POST` | `prisma.user.findUnique()` -> check coins >= 50 -> `prisma.user.update({ data: { kraveoCoins: { decrement: 50 } } })` | Deduct 50 coins, issue KRAVEO20 coupon |
| 27 | `/reviews/vendor/:vendorId` | `GET` | `prisma.reviewRecord.findMany({ where: { vendorId }, orderBy: { createdAt: 'desc' } })` | Fetch reviews for Dhaba |
| 28 | `/reviews/driver/:driverId` | `GET` | `prisma.reviewRecord.findMany({ where: { driverId }, orderBy: { createdAt: 'desc' } })` | Fetch reviews for driver partner |

---

## 5. Verification Method

To verify the completion of the migration in Subtask 2:

1. **Compilation Check**:
   Run TypeScript build from `backend/` directory:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npm run build
   ```
   *Expected result*: 0 TypeScript compilation errors (`prisma generate && tsc` passes cleanly).

2. **In-Memory Store Reference Elimination Check**:
   Run grep across `backend/src` for store imports:
   ```bash
   grep -rn "from '\.\./store'" /home/lucifer/Documents/Projects/Kraveo/backend/src/
   ```
   *Expected result*: 0 matches in `api.ts` or `validation.ts`.

3. **PostgreSQL Database Seeding Verification**:
   Execute seeding script:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npx prisma db seed
   ```
   *Expected result*: Console outputs `🌱 Seeding PostgreSQL Database with VIT Bhopal Campus Data...` followed by `✅ PostgreSQL Database Seeding Complete!`.
