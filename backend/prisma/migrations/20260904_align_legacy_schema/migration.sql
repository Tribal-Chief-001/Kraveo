-- Bring the legacy db-push schema into line with the Prisma schema without
-- dropping existing vendor records or requiring a destructive reset.

CREATE TYPE "DutyStatus" AS ENUM ('ONLINE', 'OFFLINE', 'IN_TRANSIT');

ALTER TABLE "MenuItem"
  ADD COLUMN "rating" DOUBLE PRECISION DEFAULT 4.5,
  ADD COLUMN "ratingCount" INTEGER DEFAULT 0;

ALTER TABLE "Order"
  ADD COLUMN "isReviewed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "OrderItem"
  ADD COLUMN "menuItemId" TEXT;

ALTER TABLE "User"
  ADD COLUMN "kraveoCoins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "upiId" TEXT;

ALTER TABLE "Vendor"
  ADD COLUMN "bannerImage" TEXT,
  ADD COLUMN "lat" DOUBLE PRECISION NOT NULL DEFAULT 23.0768,
  ADD COLUMN "lng" DOUBLE PRECISION NOT NULL DEFAULT 76.8524,
  ADD COLUMN "totalRatingsCount" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "userId" TEXT;

UPDATE "Vendor"
SET "bannerImage" = COALESCE("bannerUrl", '')
WHERE "bannerImage" IS NULL;

ALTER TABLE "Vendor"
  ALTER COLUMN "bannerImage" SET NOT NULL,
  DROP COLUMN "bannerUrl";

CREATE TABLE "DriverPartner" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "studentRegNo" TEXT NOT NULL,
  "runnerCode" TEXT NOT NULL,
  "avatarUrl" TEXT NOT NULL,
  "vehicleType" TEXT NOT NULL,
  "vehicleRegNo" TEXT NOT NULL,
  "emergencyPhone" TEXT NOT NULL,
  "dutyStatus" "DutyStatus" NOT NULL DEFAULT 'OFFLINE',
  "ordersToday" INTEGER NOT NULL DEFAULT 0,
  "totalEarningsToday" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "avgCompletionTimeMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "onTimeRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  "rating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  "upiId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DriverPartner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewRecord" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "driverId" TEXT,
  "driverRating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  "driverTags" TEXT[],
  "driverNotes" TEXT,
  "dishReviews" JSONB NOT NULL,
  "dhabaNotes" TEXT,
  "coinsEarned" INTEGER NOT NULL DEFAULT 10,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverPartner_userId_key" ON "DriverPartner"("userId");
CREATE UNIQUE INDEX "DriverPartner_runnerCode_key" ON "DriverPartner"("runnerCode");
CREATE UNIQUE INDEX "ReviewRecord_orderId_key" ON "ReviewRecord"("orderId");

ALTER TABLE "Vendor"
  ADD CONSTRAINT "Vendor_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DriverPartner"
  ADD CONSTRAINT "DriverPartner_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReviewRecord"
  ADD CONSTRAINT "ReviewRecord_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRecord"
  ADD CONSTRAINT "ReviewRecord_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRecord"
  ADD CONSTRAINT "ReviewRecord_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRecord"
  ADD CONSTRAINT "ReviewRecord_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
