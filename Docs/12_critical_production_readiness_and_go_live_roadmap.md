# KRAVEO Platform: Critical Production Audit, Red-Team Analysis & Go-Live Roadmap

**Audit Level:** Brutally Honest / Red-Teaming Technical Examination  
**Monorepo:** `/home/lucifer/Documents/Projects/Kraveo`  
**Target Deployment:** 10,000 Students at VIT Bhopal University (Highway Dhaba Network)  
**Audit Date:** August 2026  

---

## 1. Executive Summary & Honest Reality Scorecard

The previous "100/100" audit reports reflected **compilation cleanliness and test suite pass rates (green tests)** rather than **real-world physical production readiness**. 

When audited line-by-line from a first-principles engineering and red-teaming perspective, the platform is currently a **State-of-the-Art, Highly Polished MVP / Interactive Prototype with a Live PostgreSQL Backend**, but **NOT yet ready to take 10,000 live paid orders without completing critical client-server wiring and third-party infrastructure**.

### Honest Reality Scorecard

| Pillar | Score | Reality Status |
| :--- | :---: | :--- |
| **Backend REST & PostgreSQL DB** | **85 / 100** | **REAL**: 25 Express API routes query Prisma PostgreSQL with atomic transactions. |
| **Backend Security & Webhooks** | **80 / 100** | **REAL**: JWT verification, RBAC guards, constant-time HMAC SHA-256 for Razorpay. |
| **Third-Party Gateways (SMS & FCM)**| **20 / 100** | **MOCKED**: SMS is logged to console; Firebase key is a dummy service account failing OAuth. |
| **Customer App (`apps/customer_app`)** | **55 / 100** | **PARTIAL**: Beautiful UI, but order progress uses local Flutter `Timer.periodic`, mock JWT token, and no native Razorpay SDK. |
| **Vendor App (`apps/vendor_app`)** | **50 / 100** | **PARTIAL**: Loud audio alert & KDS UI works, but incoming orders use sample data, no live Socket/FCM client, no background wake lock. |
| **Driver App (`apps/driver_app`)** | **45 / 100** | **PARTIAL**: 4-step UI works, but active order is hardcoded (`#ord-8492`), OTP is locally verified against `'4829'`, and GPS is simulated arithmetic. |
| **Super Admin (`web/super_admin`)** | **70 / 100** | **PARTIAL**: React UI compiles cleanly; Socket & REST connected, but falls back to mock token `mock_jwt_token_usr-5`. |
| **OVERALL REAL-WORLD GO-LIVE READINESS** | **58 / 100** | **FUNCTIONAL DEMO / INTEGRATED MVP — REQUIRES PRODUCTION WIRING SPRINT** |

---

## 2. Line-by-Line Technical Evidence & Code Vulnerabilities

Here is the exact code-level proof of what is real versus what is simulated:

### A. Customer App (`apps/customer_app`)
1. **Simulated Order Progression**:
   - In [`apps/customer_app/lib/providers/order_provider.dart:91-100`](file:///home/lucifer/Documents/Projects/Kraveo/apps/customer_app/lib/providers/order_provider.dart#L91-L100):
     ```dart
     void _startSimulatedProgression() {
       _statusTimer = Timer.periodic(const Duration(seconds: 8), (timer) { ... });
     }
     ```
     *Impact*: The customer app advances from Placed ➔ Preparing ➔ In Transit ➔ Delivered based on an 8-second phone timer, **not** when the Dhaba cook or runner actually updates the order on the backend!
2. **Hardcoded Mock JWT Token**:
   - In [`apps/customer_app/lib/services/customer_api_service.dart:57`](file:///home/lucifer/Documents/Projects/Kraveo/apps/customer_app/lib/services/customer_api_service.dart#L57):
     ```dart
     'Authorization': 'Bearer mock_jwt_token_usr-1'
     ```
     *Impact*: The backend's `jwt.verify()` rejects `mock_jwt_token_usr-1` with HTTP 401 Unauthorized. The API call silently catches the error, leaving order data only in ephemeral phone memory.
3. **Missing Real-Time Client**:
   - In [`apps/customer_app/pubspec.yaml`](file:///home/lucifer/Documents/Projects/Kraveo/apps/customer_app/pubspec.yaml): `socket_io_client` and `firebase_messaging` are **not installed**.

---

### B. Vendor Dhaba App (`apps/vendor_app`)
1. **Mock Order Queue & Manual Triggers**:
   - In [`apps/vendor_app/lib/screens/vendor_home.dart:36-80`](file:///home/lucifer/Documents/Projects/Kraveo/apps/vendor_app/lib/screens/vendor_home.dart#L36-L80):
     `_orders` is populated with static sample orders (`#ord-8492`, `#ord-8493`, `#ord-8494`).
   - The loud ringing alarm only fires when someone taps a manual test button on the screen, not from an incoming backend WebSocket or FCM push event.
2. **Missing Auth Header in API Service**:
   - In [`apps/vendor_app/lib/services/vendor_api_service.dart:12`](file:///home/lucifer/Documents/Projects/Kraveo/apps/vendor_app/lib/services/vendor_api_service.dart#L12):
     `PATCH /orders/:id/status` is called with no `Authorization` header, causing the backend to return HTTP 401.
3. **Background Audio & Sleep Lock Risk**:
   - In noisy kitchens, tablets lock or screen turns off after 1 minute. Without `wakelock_plus` and an Android Foreground Service, the OS suspends the app and the cook misses orders.

---

### C. Driver Partner App (`apps/driver_app`)
1. **Hardcoded Order & Broken Gate OTP Verification**:
   - In [`apps/driver_app/lib/screens/active_delivery.dart:25-77`](file:///home/lucifer/Documents/Projects/Kraveo/apps/driver_app/lib/screens/active_delivery.dart#L25-L77):
     Order `#ord-8492` is hardcoded.
   - In [`apps/driver_app/lib/widgets/gate_otp_dialog.dart:56`](file:///home/lucifer/Documents/Projects/Kraveo/apps/driver_app/lib/widgets/gate_otp_dialog.dart#L56):
     ```dart
     if (enteredOtp == widget.expectedOtp) // expectedOtp defaults to '4829'
     ```
     *Impact*: When the backend generates a real random OTP (e.g. `7912`), the driver enters `7912` and the app rejects it as invalid because it locally checks against `'4829'`!
2. **Simulated GPS Arithmetic**:
   - In [`apps/driver_app/lib/screens/driver_home.dart:100-109`](file:///home/lucifer/Documents/Projects/Kraveo/apps/driver_app/lib/screens/driver_home.dart#L100-L109):
     ```dart
     final stepOffset = (timer.tick % 6) * 0.0001;
     DriverApiService.updateLocation(baseLat + stepOffset, baseLng + stepOffset);
     ```
     *Impact*: The phone streams mathematical offset coordinates instead of querying the actual GPS chip via `geolocator`.

---

### D. Backend Third-Party Infrastructure (`backend/`)
1. **SMS OTP Gateway**:
   - In [`backend/src/routes/api.ts:78`](file:///home/lucifer/Documents/Projects/Kraveo/backend/src/routes/api.ts#L78):
     `console.log('📲 [SMS OTP Gateway] Dispatched 4-digit SMS OTP...')`
     *Impact*: No physical SMS is sent to the student's SIM card.
2. **Firebase Cloud Messaging Service Account**:
   - In [`backend/firebase-key.json`](file:///home/lucifer/Documents/Projects/Kraveo/backend/firebase-key.json):
     Contains dummy project credentials (`kraveo`). Google OAuth rejects the token exchange (`Unexpected Gaxios Error`).
3. **Database Connection Pool at 10k Scale**:
   - Default Prisma connection pool is 10 connections. 500 simultaneous checkout requests at 11 PM will exhaust the pool without `connection_limit=50` or a connection pooler (PgBouncer).

---

## 3. Red-Teaming & 10k Orders/Day Failure Scenarios

```
┌────────────────────────────────────────────────────────────────────────┐
│               WHAT BREAKS UNDER LIVE 10,000 ORDERS/DAY LOAD            │
│                                                                        │
│ 1. Student Login:       No SMS received on real phone (Logged to stdout)│
│ 2. Order Sync:          Customer app uses 8s timer, ignoring Dhaba KDS  │
│ 3. Gate Delivery:       Driver OTP dialog fails dynamic server PINs    │
│ 4. Kitchen Device Sleep:Tablet locks; cook misses incoming food orders │
│ 5. High Concurrency:    Prisma default 10 connections pool timeout     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Current Status: Achieved Checkpoints vs Yet-to-be-Achieved

### ✅ What Has Genuinely Been Achieved (100% Real)
- [x] **PostgreSQL & Prisma ORM Schema**: Relational models for Users, Vendors, MenuItems, Orders, Payments, Drivers, Locations, Reviews.
- [x] **25 Live Express Endpoints**: Full CRUD logic with Prisma queries, state machine validation, and role checking.
- [x] **Cryptographic Payments**: Razorpay webhook signature verification using `crypto.timingSafeEqual`.
- [x] **Price Recalculation & Anti-Tampering**: Server recalculates dish prices, coupons, packaging, and delivery fees directly from PostgreSQL.
- [x] **Google Stitch UI Design**: Pixel-perfect UI across Customer, Vendor, Driver, and Admin portals.
- [x] **Zero-Error Compilation**: `npx tsc --noEmit` (0 errors), `npm run build` in Super Admin (0 errors), Flutter tests passing.

---

### ⏳ Checkpoints Yet to be Achieved Before Live Deployment

#### Milestone 1: Dynamic Auth & Token Persistence (P0 Blocker)
- [ ] Save the real JWT token returned by `POST /api/auth/verify-otp` into `shared_preferences` in Customer, Vendor, and Driver Flutter apps.
- [ ] Pass the saved `Bearer <token>` in all `http` requests across `CustomerApiService`, `VendorApiService`, and `DriverApiService`.

#### Milestone 2: Real-World Push & SMS Gateways (P0 Blocker)
- [ ] Wire a live Indian SMS Gateway (Fast2SMS / MSG91 / Twilio) in `backend/src/routes/api.ts` with real API credentials.
- [ ] Download and configure the official Google Cloud Firebase Service Account JSON in `backend/firebase-key.json`.

#### Milestone 3: Real-Time Mobile Synchronization (P0 Blocker)
- [ ] Add `socket_io_client: ^2.0.3` to `customer_app`, `vendor_app`, and `driver_app`.
- [ ] Replace `_startSimulatedProgression()` in `CustomerApp` with real-time `order_updated` WebSocket listener.
- [ ] Connect `VendorApp` to `new_order_alert` WebSocket room so incoming orders pop up and ring automatically.
- [ ] Remove hardcoded `'4829'` from `GateOtpDialog` and verify OTP directly against `POST /api/orders/:id/verify-gate-otp`.

#### Milestone 4: Native Hardware & Sensor Integration (P1)
- [ ] Install `geolocator: ^11.0.0` in `driver_app` to stream real GPS coordinates from device hardware.
- [ ] Install `wakelock_plus: ^1.2.0` in `vendor_app` to keep kitchen tablet screens awake 24/7.
- [ ] Add native `razorpay_flutter: ^1.3.7` to `customer_app` to launch the native UPI payment sheet.

#### Milestone 5: Cloud Production Deployment & Scale (P1)
- [ ] Configure `DATABASE_URL` with `connection_limit=50` on AWS EC2 PostgreSQL instance.
- [ ] Run backend under PM2 cluster mode (`pm2 start dist/index.js -i max`).
- [ ] Configure Nginx reverse proxy with SSL (`certbot`) for `https://api.kraveo.in` and `wss://api.kraveo.in`.

---

## 5. Master Go-Live Execution Sprint Plan

```mermaid
graph TD
    A["Phase 1: Dynamic Auth & Token Sync"] --> B["Phase 2: Live SMS & Firebase Keys"]
    B --> C["Phase 3: Socket.io Client Event Integration"]
    C --> D["Phase 4: Hardware Sensors (GPS & WakeLock)"]
    D --> E["Phase 5: AWS Cloud Go-Live & Release APKs"]
```

By completing these 5 focused wiring milestones, the Kraveo platform transitions from an **Integrated Prototype** to a **Battle-Tested, Real-World Production Platform** capable of handling 10,000 orders/day at VIT Bhopal!
