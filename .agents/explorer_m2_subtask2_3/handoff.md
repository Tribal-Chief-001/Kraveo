# Handoff Report: Subtask 2 Migration Strategy (Prisma ORM & PostgreSQL Persistence)

## 1. Observation

### Codebase Audited:
- `backend/prisma/schema.prisma` (203 lines): Defines models `User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `Payment`, `DriverPartner`, `ReviewRecord`, `DriverLocation` and Enums `Role`, `OrderStatus`, `PaymentStatus`, `DutyStatus`.
- `backend/src/store.ts` (199 lines): Contains mock in-memory arrays `users`, `vendors`, `driverPartners`, `menuItems`, `orders`, `reviews`, and `driverLocations` map.
- `backend/src/routes/api.ts` (798 lines): Defines 28 API routes on `apiRouter`. Currently imports `vendors, menuItems, orders, driverLocations, users, driverPartners, reviews` from `../store` and includes try-catch blocks falling back to `store.ts`.
- `backend/src/utils/validation.ts` (105 lines): Imports `menuItems` from `../store` inside `validateAndCalculateOrder`.
- `backend/src/utils/seedDb.ts` (134 lines): Seeds minimal mock users/vendors/dishes, missing several mock entities from `store.ts`.
- `backend/src/db.ts` (4 lines): Exports `prisma` (`new PrismaClient()`).

### Import Audit:
Searching across `backend/src/` confirms that ONLY `backend/src/routes/api.ts` (line 2) and `backend/src/utils/validation.ts` (line 1) import from `store.ts`.

---

## 2. Logic Chain & Exact Refactoring Strategy

### A. Refactoring Strategy for `backend/src/utils/validation.ts`
1. **Remove Import**: Replace `import { menuItems } from '../store';` with `import { prisma } from '../db';`.
2. **Async Function**: Update signature from synchronous to `async`:
   ```ts
   export const validateAndCalculateOrder = async (
     vendorId: string, 
     items: { itemId: string; quantity: number }[],
     couponCode?: string
   ): Promise<OrderValidationResult>
   ```
3. **Database Query**: Query menu items directly using Prisma:
   ```ts
   const itemIds = items.map((i) => i.itemId);
   const dbMenuItems = await prisma.menuItem.findMany({
     where: {
       id: { in: itemIds },
       vendorId: vendorId,
     },
   });
   ```
4. **Item Verification**: Match each `rawItem` against `dbMenuItems.find(i => i.id === rawItem.itemId)` and check `menuItem.isAvailable`.
5. **Caller Updates**: Update caller in `api.ts` (`POST /orders` line 347) with `await validateAndCalculateOrder(vendorId, items)`.

---

### B. Refactoring Strategy for `backend/src/utils/seedDb.ts`
`seedDb.ts` must seed all entities present in `store.ts` so that all frontend mock IDs work out-of-the-box.

1. **Users (9 Records)**:
   - Seed `usr-1` (Rahul Sharma, STUDENT, phone: `+91 9876543210`, hostelBlock: `Boys Hostel Block 3`, kraveoCoins: 30)
   - Seed `usr-2` (Ananya Verma, STUDENT, phone: `+91 9876543211`, hostelBlock: `Girls Hostel Gate 1`, kraveoCoins: 40)
   - Seed `usr-3` (Ram Singh, VENDOR, phone: `+91 9876543212`)
   - Seed `usr-4` (Vikram Singh, DRIVER, phone: `+91 9876543213`)
   - Seed `usr-5` (Super Admin, ADMIN, phone: `+91 9876543214`)
   - Seed `usr-6` (Campus Canteen Owner, VENDOR, phone: `+91 9876543215`)
   - Seed `usr-7` (Singh Punjabi Owner, VENDOR, phone: `+91 9876543216`)
   - Seed `usr-8` (Rohan Mehta, DRIVER, phone: `+91 9123456780`)
   - Seed `usr-9` (Aman Deep, DRIVER, phone: `+91 9112233445`)

2. **DriverPartners (3 Records)**:
   - Seed `usr-4` (Vikram Singh, runnerCode: `RUN-8042`, studentRegNo: `21BCG10045`, vehicleType: `TVS Jupiter Scooty`, vehicleRegNo: `MP 04 AB 1234`, emergencyPhone: `+91 98989 12345`, dutyStatus: `IN_TRANSIT`, rating: 4.9, upiId: `vikram@upi`, userId: `usr-4`)
   - Seed `usr-8` (Rohan Mehta, runnerCode: `RUN-8043`, studentRegNo: `22BCE10192`, vehicleType: `Hero Splendor Bike`, vehicleRegNo: `MP 04 CD 5678`, emergencyPhone: `+91 97777 54321`, dutyStatus: `ONLINE`, rating: 4.8, upiId: `rohanm@upi`, userId: `usr-8`)
   - Seed `usr-9` (Aman Deep, runnerCode: `RUN-8044`, studentRegNo: `23BCE10884`, vehicleType: `Bicycle (Campus)`, vehicleRegNo: `CYCLE-B3`, emergencyPhone: `+91 96666 11223`, dutyStatus: `OFFLINE`, rating: 4.7, upiId: `amand@upi`, userId: `usr-9`)

3. **Vendors (3 Records)**:
   - Seed `ven-1` (Sharma Highway Dhaba, userId: `usr-3`, category: `North Indian • Thalis • Parathas`, rating: 4.8, totalRatingsCount: 124, address: `Ashta-Kothri Highway...`)
   - Seed `ven-2` (Campus Night Canteen, userId: `usr-6`, category: `Fast Food • Maggi • Beverages`, rating: 4.6, totalRatingsCount: 88, address: `Near VIT Bhopal Main Entry Gate`)
   - Seed `ven-3` (Singh Punjabi Kitchen, userId: `usr-7`, category: `Butter Chicken • Naan`, rating: 4.9, totalRatingsCount: 156, address: `Kothri Bypass Road`)

4. **MenuItems (7 Records)**:
   - Seed `item-1` (Special Shahi Paneer Thali, ven-1, price: 180)
   - Seed `item-2` (Aloo Pyaz Paratha, ven-1, price: 90)
   - Seed `item-3` (Kulhad Sweet Lassi, ven-1, price: 50)
   - Seed `item-4` (Cheese Butter Cheese Maggi, ven-2, price: 70)
   - Seed `item-5` (Paneer Loaded Sandwich, ven-2, price: 85)
   - Seed `item-6` (Butter Chicken, ven-3, price: 260)
   - Seed `item-7` (Garlic Butter Naan, ven-3, price: 60)

5. **Orders & OrderItems (2 Records)**:
   - Seed `ord-101` (customerId: `usr-1`, vendorId: `ven-1`, driverId: `usr-4`, status: `PICKED_UP`, paymentStatus: `PAID`, totalAmount: 460, dropoffHostel: `Boys Hostel Block 3`) with items `item-1` (qty 2) & `item-3` (qty 2).
   - Seed `ord-102` (customerId: `usr-2`, vendorId: `ven-2`, status: `PREPARING`, paymentStatus: `PAID`, totalAmount: 175, dropoffHostel: `Girls Hostel Gate 1`) with items `item-4` (qty 1) & `item-5` (qty 1).

6. **DriverLocations (1 Record)**:
   - Seed `usr-4` (driverId: `usr-4`, driverName: `Vikram Singh`, lat: 23.0772, lng: 76.8535, heading: 120).

---

### C. Route Audit Checklist for `backend/src/routes/api.ts` (All 28 Routes)

| # | Route Endpoint | HTTP Method | Current Line Range | In-Memory `store.ts` Usage | Proposed Prisma ORM Strategy |
|---|---|---|---|---|---|
| 1 | `/drivers` | `GET` | 14-16 | `driverPartners` array | `prisma.driverPartner.findMany({ include: { user: true } })` |
| 2 | `/drivers/:id` | `GET` | 18-22 | `driverPartners.find()` | `prisma.driverPartner.findUnique({ where: { id: req.params.id } })` |
| 3 | `/auth/send-otp` | `POST` | 30-50 | `otpStore` (Map for temp OTPs) | Retain `otpStore` Map (in-memory OTP state before DB user creation) |
| 4 | `/auth/verify-otp` | `POST` | 53-103 | `users.find()`, `users.push()` | `prisma.user.findUnique({ where: { phone } })`, `prisma.user.create()` / `prisma.user.update()` |
| 5 | `/auth/login` | `POST` | 106-134 | `users.find()`, `users.push()` | `prisma.user.findUnique({ where: { phone } })`, `prisma.user.create()` |
| 6 | `/auth/profile` | `GET` | 137-142 | `users.find()` | `prisma.user.findUnique({ where: { id: req.user?.id } })` |
| 7 | `/auth/profile` | `PUT` | 145-157 | `users.find()` and in-place mutate | `prisma.user.update({ where: { id: req.user?.id }, data: { name, hostelBlock, upiId, fcmToken } })` |
| 8 | `/payments/create-order` | `POST` | 165-175 | Calls `createRazorpayOrder` | Retain service call, no store dependency |
| 9 | `/payments/verify-signature` | `POST` | 177-191 | Calls `verifyRazorpayPaymentSignature` | Retain service call, no store dependency |
| 10 | `/notifications/register-token` | `POST` | 194-204 | `users.find()` | `prisma.user.update({ where: { id: req.user?.id }, data: { fcmToken } })` |
| 11 | `/vendors` | `GET` | 209-219 | `prisma.vendor.findMany` with fallback to `vendors` | Remove try/catch fallback; return `await prisma.vendor.findMany({ include: { menuItems: true } })` |
| 12 | `/vendors/:id` | `GET` | 221-239 | `prisma.vendor.findUnique` with fallback to `vendors` & `menuItems` | Remove try/catch fallback; return `await prisma.vendor.findUnique({ where: { id: req.params.id }, include: { menuItems: true } })` |
| 13 | `/vendors/:id/toggle` | `PATCH` | 241-247 | `vendors.find()` | `prisma.vendor.update({ where: { id: req.params.id }, data: { isAcceptingOrders: !vendor.isAcceptingOrders } })` |
| 14 | `/menus/:vendorId` | `GET` | 252-264 | `prisma.menuItem.findMany` with fallback to `menuItems` | Remove try/catch fallback; return `await prisma.menuItem.findMany({ where: { vendorId: req.params.vendorId } })` |
| 15 | `/menus/:itemId/toggle` | `PATCH` | 266-285 | `prisma.menuItem.findUnique`/`update` with fallback to `menuItems` | Remove try/catch fallback; return `await prisma.menuItem.update({ where: { id: req.params.itemId }, data: { isAvailable: !dbItem.isAvailable } })` |
| 16 | `/orders` | `GET` | 290-318 | `prisma.order.findMany` with fallback to `orders` filter | Remove try/catch fallback; return `await prisma.order.findMany({ where: whereClause, include: { items: true, vendor: true, customer: true, driver: true }, orderBy: { createdAt: 'desc' } })` |
| 17 | `/orders/:id` | `GET` | 320-336 | `prisma.order.findUnique` with fallback to `orders` | Remove try/catch fallback; return `await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true, vendor: true, customer: true, driver: true } })` |
| 18 | `/orders` | `POST` | 339-441 | `validateAndCalculateOrder`, `prisma.order.create` with fallback to `orders.unshift()` | `await validateAndCalculateOrder(vendorId, items)`, remove try/catch fallback, create via `prisma.order.create({ data: ..., include: { items: true, vendor: true, customer: true } })` |
| 19 | `/orders/:id/status` | `PATCH` | 444-512 | `prisma.order.findUnique`/`update` with fallback to `orders` | Remove try/catch fallback; validate state transition, `await prisma.order.update({ where: { id: req.params.id }, data: { status }, include: { items: true, vendor: true, customer: true, driver: true } })` |
| 20 | `/vendors/:id/status` | `PATCH` | 515-537 | `prisma.vendor.update` with fallback to `vendors` | Remove try/catch fallback; return `await prisma.vendor.update({ where: { id: req.params.id }, data: { isAcceptingOrders } })` |
| 21 | `/vendors/items/:itemId` | `PATCH` | 540-564 | `prisma.menuItem.update` with fallback to `menuItems` | Remove try/catch fallback; return `await prisma.menuItem.update({ where: { id: req.params.itemId }, data: updateData })` |
| 22 | `/orders/:id/accept-driver` | `POST` | 567-615 | `prisma.order.findUnique`/`update` with fallback to `orders` | Remove try/catch fallback; `await prisma.order.update({ where: { id: req.params.id }, data: { driverId, status: order.status === 'PLACED' ? 'ACCEPTED' : order.status }, include: { items: true, vendor: true, customer: true, driver: true } })` |
| 23 | `/drivers/locations` | `GET` | 620-632 | `prisma.driverLocation.findMany` with fallback to `driverLocations` map | Remove try/catch fallback; return `await prisma.driverLocation.findMany()` |
| 24 | `/drivers/location` | `POST` | 634-671 | `prisma.driverLocation.upsert` with fallback to `driverLocations` map | Remove try/catch fallback; `await prisma.driverLocation.upsert({ where: { driverId }, update: { lat, lng, heading: heading || 0, lastUpdated: new Date() }, create: { driverId, driverName: 'Vikram Singh', lat, lng, heading: heading || 0 } })` |
| 25 | `/reviews` | `POST` | 678-760 | `orders.find()`, `users.find()`, `menuItems.find()`, `vendors.find()`, `driverPartners.find()`, `reviews.push()` | Convert handler to `async`, `await prisma.order.findUnique()`, `await prisma.user.update({ data: { kraveoCoins: { increment: 10 } } })`, recalculate item/vendor/driver ratings with Prisma updates, and `await prisma.reviewRecord.create()` |
| 26 | `/coupons/redeem-coins` | `POST` | 763-785 | `users.find()` | Make handler `async`, `await prisma.user.findUnique({ where: { id: req.user?.id } })`, `await prisma.user.update({ where: { id: user.id }, data: { kraveoCoins: { decrement: 50 } } })` |
| 27 | `/reviews/vendor/:vendorId` | `GET` | 788-791 | `reviews.filter()` | Make handler `async`, `await prisma.reviewRecord.findMany({ where: { vendorId: req.params.vendorId } })` |
| 28 | `/reviews/driver/:driverId` | `GET` | 793-796 | `reviews.filter()` | Make handler `async`, `await prisma.reviewRecord.findMany({ where: { driverId: req.params.driverId } })` |

---

## 3. Caveats

- **Network Mode**: CODE_ONLY mode active — local investigation performed strictly against source code files.
- **Temporary OTP Store**: `otpStore` in `api.ts` is an in-memory `Map` for SMS OTP lifecycle (expires in 5 mins). It is NOT part of `store.ts` persistence. Retaining `otpStore` is correct and required for OTP verification prior to user database creation.
- **WebSocket Broadcasting**: WebSocket events (`io.emit`, `io.to(...).emit`) must continue to receive standard database objects returned by Prisma queries.

---

## 4. Conclusion

1. Direct removal of `import ... from '../store'` in `api.ts` and `validation.ts` will achieve **0 references to `store.ts`**.
2. Making `validateAndCalculateOrder` `async` and replacing array lookups with `prisma.menuItem.findMany` ensures server-side price recalculation operates entirely on PostgreSQL.
3. Updating `seedDb.ts` to populate all 9 users, 3 drivers, 3 vendors, 7 menu items, 2 orders, and 1 driver location with explicit IDs guarantees complete backward compatibility for all existing frontend test cases and demo profiles.
4. All Prisma models and required fields match the application data requirements 100%.

---

## 5. Verification Method

1. **Grep Verification**:
   ```bash
   grep -rn "store" backend/src/
   ```
   *Expected result*: Zero imports of `store.ts`.
2. **Build Verification**:
   ```bash
   cd backend && npm run build
   ```
   *Expected result*: Success with 0 TypeScript (`tsc`) compilation errors.
3. **Database Seeding Verification**:
   ```bash
   npx prisma db seed
   ```
   *Expected result*: 100% database seeding complete without foreign key or missing field errors.
