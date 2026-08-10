# 🚀 Kraveo Startup Launch Roadmap: Monorepo to 10k Campus Production Rollout

**Target Location:** VIT Bhopal University Campus & Ashta-Kothri Highway Dhaba Network  
**Goal:** Transition Kraveo from a verified UI prototype to a hardened, 100/100 production-ready campus startup serving 10,000+ students.

---

## 📅 Production Remediation & Launch Blueprint (P0 – P5)

```
[P0: Security & Transport] ➔ [P1: PostgreSQL & DB Migration] ➔ [P2: Payments & OTP Handshake] ➔ [P3: Real-time Client Sync] ➔ [P4: CI/CD & Reliability] ➔ [P5: 10k Student Load Gate]
```

---

## 🔴 Phase P0: Emergency Security Hardening & Transport Layer (Target: Week 1)

### 1. Development Backdoor Removal
- Remove universal hardcoded OTP bypasses (`1234`, `4829`) from `backend/src/routes/api.ts`.
- Remove mock JWT tokens (`mock_jwt_token_usr-5`) across `customer_api_service.dart` and `driver_api_service.dart`.
- Bind SMS Gateway (Twilio / MSG91) to `/api/auth/send-otp` and `/api/auth/verify-otp`.

### 2. Transport & Infrastructure Security
- Obtain SSL/TLS certificate (Let's Encrypt / AWS Certificate Manager) for `api.kraveo.in` and `admin.kraveo.in`.
- Transition live deployment from HTTP to HTTPS (`https://api.kraveo.in`) and WebSocket Secure (`wss://api.kraveo.in`).
- Configure Nginx reverse proxy to disable `X-Powered-By` header and block unauthenticated Socket.io room joins.
- Restrict Express CORS settings from `*` to specific trusted app origins.

### 3. Authorization & Data Privacy Enforcement
- Enforce `authenticateToken` and role-based guards (`requireRole(['VENDOR', 'ADMIN'])`) across all vendor menu toggles and order status mutations.
- Block public GET access to customer phone numbers, delivery addresses, and UPI IDs on `/api/orders` and `/api/drivers`.

---

## 🟠 Phase P1: Database Persistence & Prisma PostgreSQL Engine (Target: Weeks 2–3)

### 1. PostgreSQL Database Migration
- Replace in-memory arrays in `backend/src/store.ts` with live PostgreSQL database managed via **Prisma ORM**.
- Execute schema migrations (`npx prisma migrate deploy`) for the following tables:
  - `User` (id, phone, name, role, hostelBlock, roomNumber, kraveoCoins)
  - `Vendor` (id, name, rating, address, isAcceptingOrders, lat, lng)
  - `MenuItem` (id, vendorId, name, price, isAvailable, isVeg, category)
  - `Order` (id, customerId, vendorId, driverId, status, totalAmount, gateOtp, dropoffHostel)
  - `OrderItem` (id, orderId, menuItemId, name, quantity, price, customizations)
  - `DriverLocation` (driverId, lat, lng, heading, updatedAt)

### 2. Input Validation & Defense Layer
- Implement request payload validation schemas (Zod / Joi) for all POST and PATCH endpoints.
- Clamp review ratings strictly to range `[1, 5]` and sanitize user input text to prevent XSS/injection.
- Implement API rate-limiting (`express-rate-limit`) restricting auth attempts to 5 per minute per IP.

---

## 🟡 Phase P2: Real Payments & Server-Controlled Gate Handshake (Target: Weeks 4–5)

### 1. Razorpay Gateway Integration
- Replace client-side simulated checkout in `apps/customer_app` with native **Razorpay Payment Sheet SDK**.
- Require server-generated `razorpay_order_id` via `POST /api/payments/create-order` before client payment authorization.
- Implement server-side Webhook listener (`POST /api/payments/webhook`) verifying HMAC SHA-256 signatures before setting order state to `PLACED`.

### 2. Server-Side Gate Handshake OTP
- Generate 4-digit numeric OTP server-side upon order creation and encrypt/store in database.
- Require `driver_app` to call `POST /api/orders/:id/verify-otp` with student-provided PIN. Order transitions to `DELIVERED` only upon HTTP 200 verification match.

---

## 🟢 Phase P3: Client Sync, FCM Alerts & Admin Integration (Target: Weeks 6–7)

### 1. Dhaba Ringing Alert Engine & FCM
- Integrate **Firebase Cloud Messaging (FCM)** in `apps/vendor_app` for background high-priority push notifications.
- Ensure audio alarm service (`AudioAlertService`) triggers continuous looping sound on screen lock or app backgrounding.

### 2. Driver GPS Dispatch & Background Location
- Implement background location service in `apps/driver_app` emitting periodic location fixes to `POST /api/drivers/location`.
- Connect driver order queue to live dispatch Socket.io room with race-condition guards preventing multi-driver job claims.

### 3. Super Admin Production Binding
- Replace hardcoded `http://localhost:5000` API URL in `web/super_admin/src/App.tsx` with environment-based configuration (`import.meta.env.VITE_API_BASE_URL`).
- Wire Live Command Center map, Vendor Manager actions, and Analytics panel directly to live backend endpoints.

---

## 🔵 Phase P4: Production Operations & CI/CD Pipelines (Target: Week 8)

### 1. Automated CI/CD Workflows
- Create `.github/workflows/ci.yml` running:
  - Backend TypeScript compilation (`tsc --noEmit`) and Prisma schema validation.
  - Flutter analysis (`flutter analyze`) and unit test suite.
  - Automated release APK generation with production Android signing keys.

### 2. Observability & Backups
- Integrate Sentry for client app crash reporting and backend exception tracking.
- Set up automated daily PostgreSQL database snapshots with 30-day point-in-time recovery.
- Configure PM2 process management with automatic restart and log rotation (`pm2-logrotate`).

---

## 💜 Phase P5: 10,000-Student Concurrency Gate (Target: Week 9+)

Before campus-wide launch at VIT Bhopal University, the system must pass these mandatory launch gates:

- [ ] **Load Testing Gate**: Execute k6 / Artillery load scripts simulating 500 concurrent order placements at peak dinner hours (11 PM - 1 AM) maintaining p95 latency < 200ms.
- [ ] **Security Audit Gate**: Zero critical or high-severity vulnerabilities across authentication, payment webhooks, or API endpoints.
- [ ] **E2E Reconciliation Gate**: 100% agreement between Razorpay payout settlements, order ledger balances, and vendor payouts.
- [ ] **Campus Pilot Gate**: Successful 7-day pilot with 2 highway dhabas and 100 student beta testers across Hostel Blocks 1 & 2.

---

## 💰 Unit Economics & Financial Projection (Campus Scale)

$$\text{Total Order Revenue} = \text{Food Subtotal} + \text{Campus Delivery Fee (₹30)}$$

- **Dhaba Commission**: Kraveo earns 12%–15% commission on dish subtotal from dhabas.
- **Delivery Margin**: ₹30 collected from student ➔ ₹25 paid to runner ➔ ₹5 retained by Kraveo.
- **Unit Economics Example**:
  - Order Subtotal = ₹300
  - Kraveo Dhaba Commission (12%) = ₹36
  - Delivery Fee Margin Retained = ₹5
  - **Kraveo Gross Profit per Order** = **₹41**

At 300 orders/day across VIT Bhopal campus:
- Daily Gross Revenue Retained = ₹12,300
- Monthly Gross Revenue Retained = ₹3,69,000
