-- Push notifications (Docs/18_push_notifications_contract.md, 2026-10-05). Additive only: two new tables and their indexes.
-- User.fcmToken stays in the schema but is no longer read or written by the push code.
BEGIN;

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushLog" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "PushLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_disabledAt_idx" ON "DeviceToken"("userId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushLog_key_key" ON "PushLog"("key");

-- CreateIndex
CREATE INDEX "PushLog_status_nextAttemptAt_idx" ON "PushLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PushLog_createdAt_idx" ON "PushLog"("createdAt");

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
