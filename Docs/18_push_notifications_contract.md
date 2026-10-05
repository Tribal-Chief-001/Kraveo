# Push notifications contract (FCM) - 5 Oct 2026

Goal: a restaurant with a locked phone hears a new order, a rider hears a new delivery, a customer learns each status change, even when the app is closed. Push is an ADDITION: Socket.io and polling stay exactly as they are (Docs/16). Nothing in the order/payment engine may change behaviour because of push. A push failure must never fail, delay or roll back an order transition.

Firebase project: `kraveo` (number 41420312884). Android package ids: `site.kraveo.customer`, `site.kraveo.vendor`, `site.kraveo.driver`. Each app already has `android/app/google-services.json` and the `com.google.gms.google-services` Gradle plugin.

## 1. Rules (apply to every part)

1. No OTP, no password, no phone number, no address in any push title/body/data. The gate OTP is shown only inside the customer app ("Your rider is at the gate - open Kraveo to see your code").
2. No topics. Every push goes to specific device tokens that belong to specific users, looked up server-side at send time. The old `vendor_<id>` topic path and the OTP-in-text arrival push are removed.
3. Sending is fire-and-forget AFTER the DB transaction has committed. Errors are logged (event type, order id, error code only - never token, title, body) and never thrown into the caller.
4. Idempotent: the same (order, event, user) is sent at most once even if the transition code runs twice (webhook + verify-signature + reconciliation all call `markOrderPaid`). Use a unique key in the DB, not memory.
5. Retries: failed sends retry (transient FCM errors: UNAVAILABLE, INTERNAL, QUOTA_EXCEEDED, network) with backoff from the existing 60 s maintenance job, at most 5 attempts and only while the event is still useful (NEW_ORDER / NEW_DELIVERY: 10 min; status events: 30 min). Dead tokens (UNREGISTERED, INVALID_ARGUMENT/invalid registration token, SENDER_ID_MISMATCH) are disabled immediately, not retried.
6. Tests never touch Firebase: the sender is an injectable provider (`setPushProvider`, same style as `setPaymentProvider`); the real provider is not constructed when `NODE_ENV==='test'`.
7. Missing/invalid Firebase credentials at boot = push disabled with ONE clear warning line, server still starts and works (do not fail boot). Credentials come from `FIREBASE_KEY_PATH` (file, preferred) or `FIREBASE_SERVICE_ACCOUNT` (JSON string, fallback). Never log either.
8. Additive DB migration only (new tables, no destructive change). `User.fcmToken` stays in the schema but is no longer read or written by new code.

## 2. Data model (new)

`DeviceToken`: id, userId (FK User, cascade), token (unique), app (`CUSTOMER|VENDOR|DRIVER`), platform (`android`), appVersion (string, nullable), createdAt, lastSeenAt, disabledAt (nullable), disabledReason (nullable). Index on (userId, disabledAt).

`PushLog`: id, key (unique: `${orderId}:${event}:${userId}`), orderId, userId, event, status (`PENDING|SENT|FAILED|SKIPPED`), attempts, lastError (code only), nextAttemptAt, createdAt, sentAt. Index on (status, nextAttemptAt). `SKIPPED` = user has no active device.

## 3. API (all `requireAuth`, rate limited like other write routes)

- `POST /devices` body `{ token: string(20..4096), app: "CUSTOMER"|"VENDOR"|"DRIVER", platform?: "android", appVersion?: string(<=32) }` -> `{success:true}`. Upsert by token: if the token exists for another user, it MOVES to the caller (shared phone / re-login) and is re-enabled; `lastSeenAt` updated. The `app` must match the caller's role (STUDENT->CUSTOMER, VENDOR->VENDOR, DRIVER->DRIVER) else 403 `ROLE_NOT_ALLOWED`. A user may have at most 10 active tokens (oldest disabled).
- `DELETE /devices` body `{ token }` -> `{success:true}` (idempotent; only the owner can remove; unknown token is also success). Called on logout.
- Account deletion and partner suspension disable the user's tokens (a suspended vendor/rider gets no pushes).

## 4. Events and recipients (server decides; client never chooses)

| Event key | Trigger (existing code path) | Recipient devices | Priority | Title / body (final copy) |
|---|---|---|---|---|
| `NEW_ORDER` | order becomes PLACED+PAID (`markOrderPaid`, first time only) | the vendor's owner user, app VENDOR | high | "New order" / "<n> item(s) - Rs <total>. Tap to accept." |
| `ORDER_CANCELLED_VENDOR` | cancelled after paid (customer/admin/system) | vendor owner | high | "Order cancelled" / "Order #<ref> was cancelled." |
| `NEW_DELIVERY` | order becomes READY_FOR_PICKUP and unclaimed (pool) | every approved, ONLINE rider with no active order | high | "New delivery" / "<vendor> to <block>. Tap to accept." |
| `DELIVERY_ASSIGNED` | admin reassign to a specific rider | that rider | high | "Delivery assigned" / "<vendor> to <block>." |
| `DELIVERY_CANCELLED` | order cancelled while a rider holds it | that rider | high | "Delivery cancelled" / "Order #<ref> was cancelled." |
| `ORDER_ACCEPTED` | ACCEPTED | customer, app CUSTOMER | normal | "Order accepted" / "<vendor> is preparing your food." |
| `ORDER_READY` | READY_FOR_PICKUP | customer | normal | "Food is ready" / "Waiting for a rider." |
| `ORDER_PICKED_UP` | PICKED_UP | customer | high | "On the way" / "<rider first name> picked up your order." |
| `RIDER_AT_GATE` | ARRIVED_AT_GATE | customer | high | "Your rider is at the gate" / "Open Kraveo to see your code." |
| `ORDER_DELIVERED` | DELIVERED | customer | normal | "Delivered" / "Enjoy your meal! Rate your order." |
| `ORDER_CANCELLED` | CANCELLED (any actor) | customer | high | "Order cancelled" / "<reason>. <refund line if paid>" (reason max 80 chars, refund line: "Your refund is on its way." only when paid) |
| `REFUND_PROCESSED` | refund DONE | customer | normal | "Refund processed" / "Rs <amount> is on its way to your account (5-7 working days)." |

PREPARING is not pushed (noise). Admin dashboard is not pushed (it has sockets).

Message shape (all events): FCM HTTP v1 via firebase-admin, `token`, `android.priority` high|normal, `android.ttl` (NEW_ORDER/NEW_DELIVERY 120 s, others 1 h), `android.collapseKey` = `${event}:${orderId}`, `android.notification.channelId` per section 5, `notification.title/body`, and `data` (strings only): `{ event, orderId, v: "1" }` plus nothing else. Both a `notification` block (so Android shows it even when the Flutter engine is dead) and `data` (so the app can route taps and update state).

## 5. Android channels (created by the app at startup, ids are part of the contract)

- Customer: `order_updates` (importance default, sound default), `order_attention` (high; RIDER_AT_GATE, ORDER_CANCELLED, ORDER_PICKED_UP).
- Vendor: `new_orders` (IMPORTANCE_HIGH, bundled alarm sound from `res/raw`, alarm audio usage, vibration, bypass DND request, lock-screen visibility public, full-screen intent for NEW_ORDER), `order_updates` (default).
- Driver: `new_deliveries` (IMPORTANCE_HIGH, bundled sound), `order_updates` (default).
- Server maps event -> channelId exactly as above.

A channel's sound is fixed once created. The ids above must not change after release (new sound = new channel id).

## 6. App behaviour (all three)

- Dependencies: `firebase_core`, `firebase_messaging`, `flutter_local_notifications` (versions that resolve with Flutter 3.44 / Dart 3.12 and AGP in this repo). Background handler is a top-level `@pragma('vm:entry-point')` function; it must not touch UI or app state, only (vendor) trigger the alarm notification if needed.
- Initialise Firebase defensively: if `Firebase.initializeApp` throws (bad config, no Play Services), the app must still start and work with sockets/polling; log once.
- Permission (Android 13+ `POST_NOTIFICATIONS`): ask at a sensible moment, never on first frame. Customer: after the first successful order payment or at first checkout open, with a one-line reason; Vendor/Driver: right after login/approval, with an explanation, plus a persistent in-app banner when notifications are blocked ("Turn on notifications or you will miss orders") with a button that opens the system settings.
- Token lifecycle: after login (and on app start with a session) get the FCM token and `POST /devices`; on `onTokenRefresh` re-register; on logout `DELETE /devices` BEFORE clearing the session (best effort; never block logout on network failure) and `deleteToken()`; a 401 on register is ignored (session handling already exists).
- Foreground messages: do not show a duplicate banner when the app already updates via socket; just refresh the relevant provider once (or ignore). Vendor foreground NEW_ORDER still triggers the existing in-app loud alarm.
- Tap handling (cold start, background, foreground-tapped local notification): customer -> LiveTracking for `orderId`; vendor -> kitchen queue (and the incoming-order dialog if the order is still PLACED); driver -> pool or the active delivery. Unknown/invalid payload -> just open the app home. Must not crash if the user is logged out (then show login).
- Vendor alarm: bundled audio asset (no network), plays the full duration, `USE_FULL_SCREEN_INTENT` flow for NEW_ORDER on lock screen, never silently dropped. Honest limits to show in-app: Android cannot deliver to a force-stopped app and OEM battery savers may delay; show a one-time "allow background/unrestricted battery" prompt with the settings intent.
- Driver: push wakes the app; GPS foreground-service work is OUT OF SCOPE for this change (separate task) - do not add location behaviour here.
- All user-visible strings plain English like the rest of the app. Tests with a fake messaging layer (no Firebase) for: token registration/refresh/logout, permission-denied state, tap routing from each payload, malformed payload safety, no duplicate registration.

## 7. Backend structure

- `services/push/` : `types.ts`, `provider.ts` (`PushProvider` interface, `setPushProvider`, real FCM provider using firebase-admin, no-op when unconfigured), `events.ts` (event -> recipients, copy, channel, priority), `pushService.ts` (`notifyOrderEvent(orderId, event, opts)`: resolve recipients, upsert `PushLog` row by unique key, send, update status; `retryDuePushes()` for the maintenance job), `deviceTokens.ts`.
- Hooks: call `notifyOrderEvent` after commit from the existing transition functions (`markOrderPaid`, `advanceStatus`, `cancelOrder`, `claimOrder` not needed, `reassignOrder`, `verifyGateOtp` for delivered, refund completion in `refundService`) via `finishChange` or next to the existing socket emits - wrapped so it can never throw.
- Remove from `notificationService.ts`: topic sending, OTP body, `triggerDhabaAlarmPushNotification`, `triggerStudentArrivalNotification` (replace call sites). Keep exported names only if other code needs them, otherwise delete.
- `orderMaintenance` (60 s job) also calls `retryDuePushes()` and prunes `PushLog` older than 14 days and `DeviceToken` disabled for more than 60 days.
- Tests (jest, fake provider): token register/move/limit/role mismatch/delete; every event -> right recipients and payload shape; no OTP/phone in any payload (assert across all events); idempotency under double `markOrderPaid`; transient failure -> retried then SENT; dead token -> disabled; no devices -> SKIPPED; suspended partner gets nothing; push provider throwing never changes the order result; unconfigured provider = no-op. The existing 382 tests must still pass unchanged.

## 8. Release / ops (owner + Claude)

1. Owner rotates the Firebase service-account key (the old one was exposed in a chat transcript on 5 Oct 2026): Firebase console > Project settings > Service accounts > Generate new private key; save it to a local file; delete the old key. Claude copies it to the server (`FIREBASE_KEY_PATH`, chmod 600), removes the `FIREBASE_SERVICE_ACCOUNT` env var from PM2, restarts with `--update-env`, `pm2 save`.
2. Apps are built as 1.5.0+9, installed on real phones, and tested with the app killed and the screen locked (vendor alarm, rider new delivery, customer each status).
3. Backend is deployed first (additive migration + routes), apps after. Old APKs keep working (they simply never register a token).

## 9. Changes after implementation and review (5 Oct 2026) - these override the text above

- Token length limit is 20..2048 characters (a unique index cannot hold more); real FCM tokens are about 160.
- A customer who cancels their own order is NOT pushed `ORDER_CANCELLED` (they pressed the button); the refund push still follows. The vendor is not pushed `ORDER_CANCELLED_VENDOR` for their own rejection.
- `INVALID_ARGUMENT` from FCM is a dead token only when its message says "registration token"; otherwise it is `INVALID_PAYLOAD` (that push fails, the token stays). `SENDER_ID_MISMATCH` never disables tokens (it means our own credentials are wrong).
- No FCM `collapseKey` is sent (FCM limits active collapse keys per device); idempotency is the `PushLog.key`. Every message carries `android.notification.tag = order_<orderId>` so a newer push for the same order replaces the older banner. `visibility` is `public`; urgent events use notification priority `max`.
- New `NEW_ORDER_REMINDER` (server-side event, travels on the wire as `data.event = NEW_ORDER`, same channel and routing): while a paid order is still PLACED the restaurant is nudged once per minute (claim key has a minute bucket), starting one minute after payment, only if the first push was really delivered, up to the 10 minute auto-cancel. Reason: the system plays the channel alarm sound once per push; the app's data-only full-screen alarm path is not used because the backend sends a `notification` block (a notification message is the path that works with a killed app).
- Sweep (every 60 s tick, bounded to about 15 s, never overlaps itself): re-sends a NEW_ORDER whose PushLog row was never written (process killed between commit and insert) and tells riders who became idle after an order reached the pool.
- Boot check: a dry-run send proves FCM accepts the key; the log shows "push credentials verified with FCM" or the error code. `FIREBASE_KEY_PATH` unreadable = push OFF (no silent fallback to an inline key).
- Vendor app: the in-app loop alarm only rings while the app is on screen (the notification rings in the background); `showWhenLocked` / `turnScreenOn` were removed so a locked kitchen phone never shows the dashboard over the keyguard. `USE_FULL_SCREEN_INTENT` was already declared before push and is unused by the notification path; remove it or justify it in the Play declaration.
- Driver and customer "Turn on notifications" buttons open the app's notification settings when there is no permission dialog (Android 7-12) instead of doing nothing.
- Known limits (accepted): logout without a successful `DELETE /devices` leaves the token bound until the next login on that phone (a token moves to the new user on registration); a timed-out send can still arrive later and then be retried (rare duplicate banner); Android never delivers to a force-stopped app; OEM battery savers can delay pushes.
