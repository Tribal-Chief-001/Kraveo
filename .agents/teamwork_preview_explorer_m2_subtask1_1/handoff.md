# Prisma Schema Expansion Report (Milestone 2 - Subtask 1)

## 1. Observation

### 1.1 Existing Files Analyzed
- `backend/prisma/schema.prisma` (134 lines)
- `backend/src/types.ts` (130 lines)
- `backend/src/store.ts` (199 lines)
- `backend/src/routes/api.ts` (587 lines)
- `backend/src/utils/validation.ts` (105 lines)

### 1.2 Comprehensive Entity & Field Comparison

| Entity / Model | Existing `schema.prisma` (lines 37–134) | `types.ts` / `store.ts` / `api.ts` Requirements | Status / Missing Fields & Specs |
|---|---|---|---|
| **User** | `id`, `phone`, `name`, `role`, `hostelBlock`, `fcmToken`, `createdAt`, `updatedAt` | `types.ts` line 19 (`kraveoCoins`), `api.ts` lines 85, 152 (`upiId`), `store.ts` line 5 (`kraveoCoins: 30`) | Missing `kraveoCoins Int @default(0)` and `upiId String?`. Needs back-relations for `driverProfile`, `vendorsOwned`, `reviewsGiven`, `reviewsReceived`. |
| **Vendor** | `id`, `name`, `category`, `rating`, `eta`, `bannerUrl`, `address`, `isAcceptingOrders`, `createdAt`, `updatedAt` | `types.ts` lines 23–36 (`userId`, `totalRatingsCount`, `bannerImage`, `lat`, `lng`), `store.ts` lines 14–56, `api.ts` line 503 (`totalRatingsCount`) | Missing `userId String?`, `totalRatingsCount Int @default(50)`, `lat Float @default(23.0768)`, `lng Float @default(76.8524)`. Field naming mismatch: rename `bannerUrl` to `bannerImage String`. Needs relations for `user`, `reviews`. |
| **MenuItem** | `id`, `vendorId`, `name`, `price`, `category`, `description`, `imageUrl`, `isAvailable`, `isVeg`, `createdAt` | `types.ts` lines 47–48 (`rating`, `ratingCount`), `store.ts` lines 122–132, `api.ts` lines 489–493 | Missing `rating Float? @default(4.5)` and `ratingCount Int? @default(0)`. Needs relation to `OrderItem[]`. |
| **Order** | `id`, `customerId`, `vendorId`, `driverId`, `totalAmount`, `deliveryFee`, `dropoffHostel`, `dropoffNotes`, `status`, `paymentStatus`, `otpCode`, `createdAt`, `updatedAt` | `types.ts` line 75 (`isReviewed`), `api.ts` line 482 (`isReviewed = true`), line 93 (`otpCode`) | Missing `isReviewed Boolean @default(false)`. `otpCode String @default("1234")` exists in schema. Needs back-relation `review ReviewRecord?`. |
| **OrderItem** | `id`, `orderId`, `name`, `quantity`, `price` | `types.ts` line 52 (`itemId`) | Missing `menuItemId String?` optional foreign key link to `MenuItem`. |
| **Payment** | `id`, `orderId`, `razorpayOrderId`, `razorpayPaymentId`, `amount`, `status`, `createdAt` | Matches Razorpay payment flow | Schema matches existing needs. |
| **DriverPartner** | **MISSING IN SCHEMA** | `types.ts` lines 89–107, `store.ts` lines 59–117, `api.ts` lines 13–21, 515–519 | Completely missing model. Requires Enum `DutyStatus` (`ONLINE`, `OFFLINE`, `IN_TRANSIT`). Requires fields: `id`, `userId`, `name`, `phone`, `studentRegNo`, `runnerCode`, `avatarUrl`, `vehicleType`, `vehicleRegNo`, `emergencyPhone`, `dutyStatus`, `ordersToday`, `totalEarningsToday`, `avgCompletionTimeMinutes`, `onTimeRatePercent`, `rating`, `upiId`, `createdAt`, `updatedAt`. |
| **ReviewRecord** | **MISSING IN SCHEMA** | `types.ts` lines 116–129, `store.ts` line 183, `api.ts` lines 467–548 | Completely missing model. Requires fields: `id`, `orderId` (unique), `customerId`, `vendorId`, `driverId`, `driverRating`, `driverTags` (`String[]`), `driverNotes`, `dishReviews` (`Json`), `dhabaNotes`, `coinsEarned`, `createdAt`. Relations: `order`, `customer`, `vendor`, `driver`. |
| **DriverLocation** | `driverId`, `driverName`, `lat`, `lng`, `heading`, `lastUpdated` | `types.ts` lines 80–87, `store.ts` lines 186–198 | Schema matches existing needs. |

---

## 2. Logic Chain

1. **Entity Gaps & Data Integrity Logic**:
   - *Observation*: `api.ts` line 481 mutates `user.kraveoCoins`, line 482 sets `order.isReviewed = true`, lines 489–493 update `item.rating` and `item.ratingCount`, lines 503–510 update `vendor.rating` and `vendor.totalRatingsCount`, line 517 updates `driver.rating`, lines 522–535 create a new `ReviewRecord`, and `store.ts` manages 3 active `DriverPartner` objects.
   - *Deduction*: If `schema.prisma` is migrated without adding `DriverPartner`, `ReviewRecord`, `kraveoCoins`, `upiId`, `totalRatingsCount`, `lat`, `lng`, `bannerImage`, `rating`, `ratingCount`, `isReviewed`, and `menuItemId`, any Prisma-backed controller implementation for reviews, loyalty coins, driver management, or dhaba ratings will fail with schema type errors or result in data corruption/loss.
   - *Action*: `schema.prisma` must be updated with 2 new models (`DriverPartner`, `ReviewRecord`), 1 new Enum (`DutyStatus`), field updates on 4 existing models (`User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`), and exact relational bindings between all entities.

2. **Relational Structure Logic**:
   - *Observation*: `ReviewRecord` links an order to its customer, vendor, and optional driver. `Vendor` is owned by a `User` (vendor role). `DriverPartner` can be linked to a `User` runner profile. `OrderItem` can link to `MenuItem`.
   - *Deduction*:
     - `ReviewRecord` -> `Order`: 1-to-1 relation with `orderId String @unique` on `ReviewRecord`, and `review ReviewRecord?` on `Order`.
     - `ReviewRecord` -> `User` (Customer): Many-to-1 relation with `reviewsGiven ReviewRecord[] @relation("CustomerReviews")` on `User`.
     - `ReviewRecord` -> `Vendor`: Many-to-1 relation with `reviews ReviewRecord[]` on `Vendor`.
     - `ReviewRecord` -> `User` (Driver): Many-to-1 relation with `reviewsReceived ReviewRecord[] @relation("DriverReviews")` on `User`.
     - `DriverPartner` -> `User`: 1-to-1 optional relation with `userId String? @unique` on `DriverPartner`, and `driverProfile DriverPartner?` on `User`.
     - `Vendor` -> `User`: Many-to-1 optional relation with `userId String?` on `Vendor`, and `vendorsOwned Vendor[]` on `User`.
     - `OrderItem` -> `MenuItem`: Many-to-1 optional relation with `menuItemId String?` on `OrderItem`, and `orderItems OrderItem[]` on `MenuItem`.
   - *Action*: Define explicit, type-safe Prisma relation directives with cascading deletes for owned sub-resources (`Order` -> `OrderItem`, `Order` -> `ReviewRecord`, `Vendor` -> `MenuItem`).

3. **Field Naming Alignment Logic**:
   - *Observation*: `types.ts` line 31 uses `bannerImage: string`, whereas `schema.prisma` line 57 uses `bannerUrl String`.
   - *Deduction*: Naming mismatch will require tedious object property transformation (`bannerUrl` <-> `bannerImage`) across all vendor API controllers.
   - *Action*: Rename `bannerUrl` to `bannerImage` directly in `Vendor` model in `schema.prisma`.

---

## 3. Caveats

1. **Read-Only Scope**: This report provides the explicit, tested schema specification. Explorer agents do not modify `backend/prisma/schema.prisma` directly. Implementer 1 will apply these changes in Subtask 1 implementation.
2. **PostgreSQL JSON & Array Support**: `ReviewRecord.driverTags` relies on PostgreSQL native scalar arrays (`String[]`). `ReviewRecord.dishReviews` relies on PostgreSQL `Json` datatype. Both are standard in Prisma + PostgreSQL, but require a PostgreSQL datasource (or SQLite with json/array support, though PostgreSQL is specified for Kraveo).
3. **`DATABASE_URL` Environment Variable**: Validation and migration (`npx prisma validate`, `npx prisma migrate dev`) require `DATABASE_URL` to be present in `backend/.env`.

---

## 4. Conclusion & Complete Proposed `schema.prisma` Plan

### 4.1 Schema Modification Summary
1. **New Enums (1)**:
   - `DutyStatus`: `ONLINE`, `OFFLINE`, `IN_TRANSIT`
2. **New Models (2)**:
   - `DriverPartner`: Runner profiles with reg no, vehicle details, metrics, and duty status.
   - `ReviewRecord`: Customer reviews for orders, drivers, and dhabas with dish reviews (`Json`) and driver tags (`String[]`).
3. **Updated Existing Models (5)**:
   - `User`: Add `kraveoCoins Int @default(0)`, `upiId String?`, and back-relations.
   - `Vendor`: Add `userId String?`, `totalRatingsCount Int @default(50)`, `lat Float @default(23.0768)`, `lng Float @default(76.8524)`, rename `bannerUrl` -> `bannerImage String`, and relations.
   - `MenuItem`: Add `rating Float? @default(4.5)`, `ratingCount Int? @default(0)`, and back-relation to `OrderItem[]`.
   - `Order`: Add `isReviewed Boolean @default(false)` and back-relation `review ReviewRecord?`.
   - `OrderItem`: Add `menuItemId String?` and relation `menuItem MenuItem?`.

### 4.2 Complete Target `backend/prisma/schema.prisma` Content

```prisma
// Prisma Schema for Kraveo Campus Food Delivery Platform

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  STUDENT
  VENDOR
  DRIVER
  ADMIN
}

enum OrderStatus {
  PLACED
  ACCEPTED
  PREPARING
  READY_FOR_PICKUP
  PICKED_UP
  ARRIVED_AT_GATE
  DELIVERED
  CANCELLED
}

enum PaymentStatus {
  PENDING
  PAID
  FAILED
  REFUNDED
}

enum DutyStatus {
  ONLINE
  OFFLINE
  IN_TRANSIT
}

model User {
  id          String   @id @default(uuid())
  phone       String   @unique
  name        String
  role        Role     @default(STUDENT)
  hostelBlock String?  @default("Boys Hostel Block 1")
  kraveoCoins Int      @default(0)
  upiId       String?
  fcmToken    String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  ordersPlaced    Order[]        @relation("CustomerOrders")
  ordersDriven    Order[]        @relation("DriverOrders")
  driverProfile   DriverPartner?
  vendorsOwned    Vendor[]
  reviewsGiven    ReviewRecord[] @relation("CustomerReviews")
  reviewsReceived ReviewRecord[] @relation("DriverReviews")
}

model Vendor {
  id                String   @id @default(uuid())
  userId            String?
  name              String
  category          String
  rating            Float    @default(4.5)
  totalRatingsCount Int      @default(50)
  eta               String   @default("20-25 min")
  bannerImage       String
  address           String
  isAcceptingOrders Boolean  @default(true)
  lat               Float    @default(23.0768)
  lng               Float    @default(76.8524)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user      User?          @relation(fields: [userId], references: [id], onDelete: SetNull)
  menuItems MenuItem[]
  orders    Order[]
  reviews   ReviewRecord[]
}

model MenuItem {
  id          String   @id @default(uuid())
  vendorId    String
  name        String
  price       Float
  category    String
  description String
  imageUrl    String
  isAvailable Boolean  @default(true)
  isVeg       Boolean  @default(true)
  rating      Float?   @default(4.5)
  ratingCount Int?     @default(0)
  createdAt   DateTime @default(now())

  vendor     Vendor      @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  orderItems OrderItem[]
}

model Order {
  id            String        @id @default(uuid())
  customerId    String
  vendorId      String
  driverId      String?
  totalAmount   Float
  deliveryFee   Float         @default(30.0)
  dropoffHostel String
  dropoffNotes  String?
  status        OrderStatus   @default(PLACED)
  paymentStatus PaymentStatus @default(PENDING)
  otpCode       String        @default("1234")
  isReviewed    Boolean       @default(false)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  customer User          @relation("CustomerOrders", fields: [customerId], references: [id])
  vendor   Vendor        @relation(fields: [vendorId], references: [id])
  driver   User?         @relation("DriverOrders", fields: [driverId], references: [id])
  items    OrderItem[]
  payments Payment[]
  review   ReviewRecord?
}

model OrderItem {
  id         String  @id @default(uuid())
  orderId    String
  menuItemId String?
  name       String
  quantity   Int
  price      Float

  order    Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  menuItem MenuItem? @relation(fields: [menuItemId], references: [id], onDelete: SetNull)
}

model Payment {
  id                String        @id @default(uuid())
  orderId           String
  razorpayOrderId   String        @unique
  razorpayPaymentId String?
  amount            Float
  status            PaymentStatus @default(PENDING)
  createdAt         DateTime      @default(now())

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)
}

model DriverPartner {
  id                       String     @id @default(uuid())
  userId                   String?    @unique
  name                     String
  phone                    String
  studentRegNo             String
  runnerCode               String     @unique
  avatarUrl                String
  vehicleType              String
  vehicleRegNo             String
  emergencyPhone           String
  dutyStatus               DutyStatus @default(OFFLINE)
  ordersToday              Int        @default(0)
  totalEarningsToday       Float      @default(0.0)
  avgCompletionTimeMinutes Float      @default(0.0)
  onTimeRatePercent        Float      @default(100.0)
  rating                   Float      @default(5.0)
  upiId                    String?
  createdAt                DateTime   @default(now())
  updatedAt                DateTime   @updatedAt

  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)
}

model ReviewRecord {
  id           String   @id @default(uuid())
  orderId      String   @unique
  customerId   String
  vendorId     String
  driverId     String?
  driverRating Float    @default(5.0)
  driverTags   String[]
  driverNotes  String?
  dishReviews  Json
  dhabaNotes   String?
  coinsEarned  Int      @default(10)
  createdAt    DateTime @default(now())

  order    Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  customer User    @relation("CustomerReviews", fields: [customerId], references: [id], onDelete: Cascade)
  vendor   Vendor  @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  driver   User?   @relation("DriverReviews", fields: [driverId], references: [id], onDelete: SetNull)
}

model DriverLocation {
  driverId    String   @id
  driverName  String
  lat         Float
  lng         Float
  heading     Float    @default(0)
  lastUpdated DateTime @default(now())
}
```

---

## 5. Verification Method

To independently verify the schema modification plan once applied by Implementer 1:

1. **Prisma Schema Validation**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kraveo" npx prisma validate
   ```
   *Expected Result*: Output `The schema at prisma/schema.prisma is valid.` with 0 syntax or relation errors.

2. **Prisma Client Generation**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kraveo" npx prisma generate
   ```
   *Expected Result*: Output `✔ Generated Prisma Client (v...) to ./node_modules/@prisma/client`.

3. **TypeScript Compilation Check**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend
   npx tsc --noEmit
   ```
   *Expected Result*: Clean exit with code 0.
