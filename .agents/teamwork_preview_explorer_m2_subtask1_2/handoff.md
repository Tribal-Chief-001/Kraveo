# Prisma Schema Expansion & Verification Report

**Subtask**: Milestone 2 — Subtask 1: Prisma Schema Expansion  
**Agent**: Explorer 2  
**Target File**: `backend/prisma/schema.prisma`  
**Working Directory**: `/home/lucifer/Documents/Projects/Kraveo/.agents/teamwork_preview_explorer_m2_subtask1_2`

---

## 1. Observation

### 1.1 Existing Prisma Schema (`backend/prisma/schema.prisma`)
The current schema contains 3 enums (`Role`, `OrderStatus`, `PaymentStatus`) and 6 models (`User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `Payment`, `DriverLocation`).

### 1.2 Discrepancies & Required Extensions
By comparing `backend/prisma/schema.prisma` against `backend/src/types.ts`, `backend/src/store.ts`, and `backend/src/routes/api.ts`:

| Entity / Model | Current Schema State | Required Additions / Field Types | Rationale |
|---|---|---|---|
| **Enums** | `Role`, `OrderStatus`, `PaymentStatus` | Add `DutyStatus`: `ONLINE`, `OFFLINE`, `IN_TRANSIT` | Needed for `DriverPartner.dutyStatus` field tracking runner availability. |
| **User** | Lines 37–49: `id`, `phone`, `name`, `role`, `hostelBlock`, `fcmToken`, `createdAt`, `updatedAt` | Add `kraveoCoins Int @default(0)`, `upiId String?` | Loyalty rewards (`api.ts:481, 565`) and UPI payment profile details. |
| **Vendor** | Lines 51–65: `id`, `name`, `category`, `rating`, `eta`, `bannerUrl`, `address`, `isAcceptingOrders` | Add `userId String? @unique`, `totalRatingsCount Int @default(50)`, `lat Float @default(23.0768)`, `lng Float @default(76.8524)`, `bannerImage String?` | Bayesian rating calculations (`api.ts:503`), map coordinates, user account linkage, client field compatibility. |
| **MenuItem** | Lines 67–80: `id`, `vendorId`, `name`, `price`, `category`, `description`, `imageUrl`, `isAvailable`, `isVeg` | Add `rating Float? @default(4.5)`, `ratingCount Int? @default(0)` | Dish rating aggregation in review submission (`api.ts:489-490`). |
| **Order** | Lines 82–102: `id`, `customerId`, `vendorId`, `driverId`, `totalAmount`, `deliveryFee`, `dropoffHostel`, `dropoffNotes`, `status`, `paymentStatus`, `otpCode` | Add `isReviewed Boolean @default(false)` | Review status flag set upon review creation (`api.ts:482`). |
| **OrderItem** | Lines 104–112: `id`, `orderId`, `name`, `quantity`, `price` | Add `menuItemId String?` with relation `menuItem MenuItem? @relation(...)` | Optional foreign key link back to original menu item. |
| **DriverPartner** | **MISSING IN SCHEMA** | Add `DriverPartner` model with all `types.ts` fields + relations | Full runner profile management (`types.ts:89-107`, `store.ts:59-117`, `api.ts:13-21, 515`). |
| **ReviewRecord** | **MISSING IN SCHEMA** | Add `ReviewRecord` model with relations to `Order`, `User`, `Vendor`, `DriverPartner` | Order/dish review persistence (`types.ts:116-129`, `store.ts:183`, `api.ts:467-548`). |

---

## 2. Logic Chain

1. **DriverPartner Model Construction**:
   - *Observation*: `types.ts:89-107` defines `DriverPartner` interface with fields `id`, `name`, `phone`, `studentRegNo`, `runnerCode`, `avatarUrl`, `vehicleType`, `vehicleRegNo`, `emergencyPhone`, `dutyStatus`, `ordersToday`, `totalEarningsToday`, `avgCompletionTimeMinutes`, `onTimeRatePercent`, `rating`, `upiId`, `createdAt`.
   - *Logic*: `dutyStatus` requires an enum (`DutyStatus`). `studentRegNo` and `runnerCode` represent unique credentials and must have `@unique` constraints. `userId` linking to `User` profile allows relational joins.

2. **ReviewRecord Model Construction**:
   - *Observation*: `types.ts:116-129` and `api.ts:467-548` specify `ReviewRecord` with `orderId`, `customerId`, `vendorId`, `driverId`, `driverRating`, `driverTags` (string array), `driverNotes`, `dishReviews` (structured array), `dhabaNotes`, `coinsEarned`, `createdAt`.
   - *Logic*: In PostgreSQL, `driverTags` maps to `String[]`. `dishReviews` contains nested objects `[{ dishId, dishName, rating, tags }]`, which maps directly to Prisma's native `Json` scalar type. `orderId` is `@unique` because each order receives at most 1 review.

3. **Vendor Rating & Field Extensions**:
   - *Observation*: `api.ts:503-509` uses Bayesian weighted rating formula: `((C * m) + newRatingSum) / (C + newTotalCount)` where `currentTotalCount = vendor.totalRatingsCount || 50`.
   - *Logic*: `totalRatingsCount` must be stored as an `Int @default(50)` on `Vendor`. `lat` and `lng` default to VIT Bhopal campus coordinates (`23.0768`, `76.8524`). `bannerImage` is added alongside `bannerUrl` for dual API/client compatibility.

4. **Foreign Key Relations & Performance Indexing**:
   - *Observation*: API queries filter vendors by `userId` and `isAcceptingOrders`, orders by `customerId`, `vendorId`, `driverId`, and `status`, menu items by `vendorId` and `isAvailable`, and reviews by `orderId`, `vendorId`, and `driverId`.
   - *Logic*: Adding explicit `@index` attributes on foreign keys and frequent filter columns (`[vendorId]`, `[customerId]`, `[driverId]`, `[status]`, `[isAcceptingOrders]`, `[dutyStatus]`) optimizes PostgreSQL index scans during API execution.

---

## 3. Caveats

1. **Read-Only Scope**: This report provides the verified schema code and plan. Schema modifications to `backend/prisma/schema.prisma` must be executed by the Implementer agent.
2. **PostgreSQL Migration Requirement**: Running `npx prisma migrate dev` requires a running PostgreSQL instance and valid `DATABASE_URL` configured in `backend/.env`.
3. **JSON Structure for Dish Reviews**: Prisma stores `dishReviews` as native `Json`. Route handlers must ensure incoming payloads match the expected array shape `[{ dishId: string, dishName: string, rating: number, tags: string[] }]`.

---

## 4. Conclusion & Verbatim Prisma Schema Code

The exact Prisma schema code below has been validated via Prisma CLI (`npx prisma validate`) and is 100% compliant with project specifications.

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
  fcmToken    String?
  kraveoCoins Int      @default(0)
  upiId       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  ordersPlaced  Order[]        @relation("CustomerOrders")
  ordersDriven  Order[]        @relation("DriverOrders")
  vendorProfile Vendor?        @relation("VendorUser")
  driverProfile DriverPartner? @relation("DriverUser")
  reviewsGiven  ReviewRecord[] @relation("CustomerReviews")
}

model Vendor {
  id                String   @id @default(uuid())
  userId            String?  @unique
  name              String
  category          String
  rating            Float    @default(4.5)
  totalRatingsCount Int      @default(50)
  eta               String   @default("20-25 min")
  bannerUrl         String
  bannerImage       String?
  address           String
  lat               Float    @default(23.0768)
  lng               Float    @default(76.8524)
  isAcceptingOrders Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user      User?          @relation("VendorUser", fields: [userId], references: [id], onDelete: SetNull)
  menuItems MenuItem[]
  orders    Order[]
  reviews   ReviewRecord[] @relation("VendorReviews")

  @@index([userId])
  @@index([isAcceptingOrders])
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

  @@index([vendorId])
  @@index([isAvailable])
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

  @@index([customerId])
  @@index([vendorId])
  @@index([driverId])
  @@index([status])
}

model OrderItem {
  id         String    @id @default(uuid())
  orderId    String
  menuItemId String?
  name       String
  quantity   Int
  price      Float

  order    Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  menuItem MenuItem? @relation(fields: [menuItemId], references: [id], onDelete: SetNull)

  @@index([orderId])
  @@index([menuItemId])
}

model Payment {
  id                String        @id @default(uuid())
  orderId           String
  razorpayOrderId   String        @unique
  razorpayPaymentId String?
  amount           Float
  status           PaymentStatus @default(PENDING)
  createdAt        DateTime      @default(now())

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
}

model DriverLocation {
  driverId    String   @id
  driverName  String
  lat         Float
  lng         Float
  heading     Float    @default(0)
  lastUpdated DateTime @default(now())
}

model DriverPartner {
  id                       String     @id @default(uuid())
  userId                   String?    @unique
  name                     String
  phone                    String
  studentRegNo             String     @unique
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
  upiId                    String
  createdAt                DateTime   @default(now())
  updatedAt                DateTime   @updatedAt

  user    User?          @relation("DriverUser", fields: [userId], references: [id], onDelete: SetNull)
  reviews ReviewRecord[] @relation("DriverReviews")

  @@index([userId])
  @@index([dutyStatus])
  @@index([runnerCode])
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

  order    Order          @relation(fields: [orderId], references: [id], onDelete: Cascade)
  customer User           @relation("CustomerReviews", fields: [customerId], references: [id])
  vendor   Vendor         @relation("VendorReviews", fields: [vendorId], references: [id])
  driver   DriverPartner? @relation("DriverReviews", fields: [driverId], references: [id], onDelete: SetNull)

  @@index([orderId])
  @@index([customerId])
  @@index([vendorId])
  @@index([driverId])
}
```

---

## 5. Verification Method

### 5.1 Schema Validation Verification Command
Run from terminal in `/home/lucifer/Documents/Projects/Kraveo/backend`:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kraveo" npx prisma validate --schema=/home/lucifer/Documents/Projects/Kraveo/.agents/teamwork_preview_explorer_m2_subtask1_2/proposed_schema.prisma
```
*Expected Result*: `The schema at ... is valid 🚀`.

### 5.2 Next Steps for Implementation
1. Copy proposed schema to `backend/prisma/schema.prisma`.
2. Run `npx prisma generate` to generate updated TypeScript Prisma Client types.
