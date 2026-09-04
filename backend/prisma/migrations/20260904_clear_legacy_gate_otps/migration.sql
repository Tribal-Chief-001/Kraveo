-- Existing installations may contain the historic universal gate OTP.
UPDATE "Order" SET "otpCode" = NULL WHERE "otpCode" = '1234';
ALTER TABLE "Order" ALTER COLUMN "otpCode" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "otpCode" DROP NOT NULL;
