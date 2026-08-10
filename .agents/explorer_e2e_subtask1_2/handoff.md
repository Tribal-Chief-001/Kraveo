# Handoff Report: Explorer 2 — Subtask 1 (Opaque-Box E2E Testing Methodology & Helpers)

**Agent Working Directory:** `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_e2e_subtask1_2`  
**Parent Conversation ID:** `90bf1db1-0774-4e30-9f1a-5b0076840928`  
**Date/Timestamp:** `2026-08-10T01:54:09+05:30`  

---

## 1. Observation

Direct code and specification analysis across the Kraveo codebase revealed the following exact technical facts:

### A. Express REST Routes & Entrypoint Architecture
- **Server Entrypoint (`backend/src/index.ts`)**:
  - Express app created on port `5000` (or `process.env.PORT`).
  - Mounts Socket.io on same HTTP server with `cors: { origin: '*' }` (lines 22-27).
  - Global `app.set('io', io)` exposes Socket.io server to route handlers (line 35).
  - API router mounted at `/api` (line 38). Health check at `GET /health` (line 41).
- **API Router (`backend/src/routes/api.ts`)**:
  - 25+ REST endpoints handling auth (`/api/auth/*`), payments (`/api/payments/*`), vendors (`/api/vendors/*`), menus (`/api/menus/*`), orders (`/api/orders/*`), driver locations (`/api/drivers/*`), and reviews (`/api/reviews/*`).
  - Server-side price recalculation helper `validateAndCalculateOrder()` at line 280 overrides client-submitted price totals.
  - State machine validator `isValidStateTransition()` at line 348 enforces valid `OrderStatus` transitions.

### B. JWT Authentication & Role-Based Access Control (RBAC)
- **Auth Middleware (`backend/src/middleware/auth.ts`)**:
  - `JWT_SECRET`: default `'kraveo_vit_bhopal_super_secret_jwt_key_2026'` (line 13).
  - `generateToken(payload: { id, phone, role })`: signs JWT with 30-day expiration (line 16).
  - `requireAuth`: expects `Authorization: Bearer <token>` header (line 24). Returns `401 Unauthorized` on missing, malformed, or invalid token.
  - `requireRole(...allowedRoles)`: checks `req.user.role` against allowed roles (`STUDENT`, `VENDOR`, `DRIVER`, `ADMIN`). Returns `403 Forbidden` on role mismatch (line 60).
  - Dev mode fallback bypasses currently exist (`mock_jwt_token_...` at line 34; universal OTPs `1234`, `4829` in `api.ts:64`), which must be verified as rejected under hardened production mode (R3 requirement).

### C. Socket.io Real-Time Event Architecture
- **Server Socket Events (`backend/src/index.ts` & `backend/src/routes/api.ts`)**:
  - Socket rooms: `order_${orderId}`, `vendor_${vendorId}` (joined via `socket.emit('join_room', room)`).
  - Server emits `order_updated` to `order_${id}` room and globally upon order creation/status update (lines 312, 361, 421 in `api.ts`).
  - Server emits `new_order_alert` to `vendor_${vendorId}` room (line 312 in `api.ts`).
  - Server emits `driver_location_update` on socket listener or REST POST `/api/drivers/location` (line 456 in `api.ts`).

### D. Razorpay Payment Gateway & Webhook Verification
- **Payment Service (`backend/src/services/paymentService.ts`)**:
  - Secret key: `process.env.RAZORPAY_KEY_SECRET || 'kraveo_razorpay_secret_key_2026'`.
  - Signature validation formula: `HMAC-SHA256(razorpayOrderId + '|' + razorpayPaymentId, keySecret)` (lines 67-70).
  - Endpoint `POST /api/payments/verify-signature`: verifies payment signature payload `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`.
  - Planned Webhook endpoint (`POST /api/payments/webhook` per Milestone 3 & R2 spec): accepts raw JSON body, calculates HMAC-SHA256 using `RAZORPAY_WEBHOOK_SECRET`, compares against header `x-razorpay-signature`, and updates order state from `PENDING` to `PAID`.

### E. Gate OTP Verification Architecture
- **Order Gate OTP (`PROJECT.md:28` & `schema.prisma:93`)**:
  - Orders store `otpCode` (default dynamic 4-digit code generated upon placement).
  - Gate handshake transition to `DELIVERED` (`PATCH /api/orders/:id/status` or `POST /api/orders/:id/verify-gate-otp`) requires `{ status: "DELIVERED", otpCode: "XXXX" }`.
  - Rejects incorrect OTP with `400 Bad Request` or `403 Forbidden`.

### F. Prisma Database Persistence Architecture
- **Database Schema (`backend/prisma/schema.prisma`)**:
  - Models: `User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `Payment`, `DriverLocation`.
  - R1 Requirement (`TEST_INFRA.md:11`): Backend persistence must use PostgreSQL via Prisma ORM with 0 reliance on in-memory arrays (`store.ts`).

---

## 2. Logic Chain

From the direct code findings above, we derive the requirements and architecture for a **100% Opaque-Box E2E Test Suite**:

1. **Definition of Opaque-Box E2E Testing**:
   - **Zero Internal Coupling**: Tests MUST NOT import `store.ts`, route handler functions, or internal Express middleware functions.
   - **Interface Interaction Only**: All test actions execute via external network interfaces: HTTP requests, WebSocket client frames, or direct database queries against the test PostgreSQL database via Prisma client.
   - **Server-As-Blackbox**: The test runner launches or connects to a live backend HTTP/WS server process listening on a test port, issuing real network payloads and asserting network responses and database side-effects.

2. **Analysis of Core Tech Areas & Opaque-Box Assertion Methodologies**:

   - **Express REST Routes**:
     - *Assertion Method*: Issue HTTP requests using Axios/Supertest. Assert exact HTTP status codes (`200`, `201`, `400`, `401`, `403`, `404`), header correctness (JSON content-type, CORS origin/headers), and response body schema validation.
     - *Edge Case Verification*: Verify server-side price recalculation (tampered item prices in request body must be ignored, server calculates correct total). Verify invalid state transitions return `400 Bad Request` with allowed state listings.

   - **Socket.io Real-Time Events**:
     - *Assertion Method*: Connect `socket.io-client` instances to the server URL. Join specific rooms (`order_<id>`, `vendor_<id>`).
     - *Event Verification*: Trigger an API call (e.g. `POST /api/orders` or `PATCH /api/orders/:id/status`), and assert that socket client in room `order_<id>` receives `order_updated` event within a timeout (e.g. 2000ms), while clients outside the room do NOT receive scoped events.

   - **JWT RBAC Verification**:
     - *Assertion Method*: Generate real JWT tokens using the known test secret (`JWT_SECRET`) with specific role payloads (`STUDENT`, `VENDOR`, `DRIVER`, `ADMIN`), OR login via `/api/auth/verify-otp`.
     - *Security Verification*: Issue restricted endpoint requests across roles. Assert `STUDENT` receives `403` on vendor/driver endpoints; unauthenticated requests receive `401`; expired or tampered JWT signatures receive `401`. Assert static universal OTPs (`1234`, `4829`) and mock tokens (`mock_jwt_token_...`) fail under production security configuration.

   - **Razorpay Signature Validation**:
     - *Assertion Method*: Compute valid HMAC SHA-256 signatures in test helper using standard Node `crypto` (`crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex')`).
     - *Payment Verification*: Send valid signature payload to `/api/payments/verify-signature` -> assert `200 OK` and `{ success: true }`. Send tampered signature -> assert `400 Bad Request`. For webhook `POST /api/payments/webhook`, pass raw JSON body buffer, calculate `x-razorpay-signature` over raw body, send request -> assert `200 OK` and verify DB payment status updated to `PAID`.

   - **Gate OTP Verification**:
     - *Assertion Method*: Fetch created order profile (or retrieve student OTP payload via student API). Attempt `PATCH /api/orders/:id/status` to `DELIVERED` with invalid OTP (`9999`) -> assert `400/403` rejection. Attempt status transition with correct 4-digit OTP -> assert `200 OK` and order status `DELIVERED`.

   - **Prisma DB Persistence**:
     - *Assertion Method*: Execute API mutation (`POST /api/orders`). Query test PostgreSQL DB via `PrismaClient` -> assert matching `Order`, `OrderItem`, and `Payment` records exist. Execute server process restart simulation, re-fetch via API or DB query -> assert data remains intact.

3. **Proposed Helper Functions Architecture**:

To make the E2E test suite clean, robust, and 100% opaque-box, we propose 6 modular helper libraries located under `backend/test/helpers/` (or `test/helpers/`):

---

### Helper Proposal 1: HTTP Client Helper (`testHttpClient.ts`)
```typescript
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

export interface TestHttpResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, any>;
}

export class TestHttpClient {
  private client: AxiosInstance;

  constructor(baseUrl: string = process.env.TEST_API_URL || 'http://localhost:5000/api') {
    this.client = axios.create({
      baseURL: baseUrl,
      validateStatus: () => true, // Capture all HTTP status codes without throwing
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  public async get<T = any>(url: string, token?: string, params?: object): Promise<TestHttpResponse<T>> {
    const config: AxiosRequestConfig = { params };
    if (token) config.headers = { Authorization: `Bearer ${token}` };
    const res: AxiosResponse = await this.client.get(url, config);
    return { status: res.status, body: res.data, headers: res.headers };
  }

  public async post<T = any>(url: string, data?: object, token?: string): Promise<TestHttpResponse<T>> {
    const config: AxiosRequestConfig = {};
    if (token) config.headers = { Authorization: `Bearer ${token}` };
    const res: AxiosResponse = await this.client.post(url, data, config);
    return { status: res.status, body: res.data, headers: res.headers };
  }

  public async patch<T = any>(url: string, data?: object, token?: string): Promise<TestHttpResponse<T>> {
    const config: AxiosRequestConfig = {};
    if (token) config.headers = { Authorization: `Bearer ${token}` };
    const res: AxiosResponse = await this.client.patch(url, data, config);
    return { status: res.status, body: res.data, headers: res.headers };
  }

  public async postRawWebhook<T = any>(url: string, rawBody: string | Buffer, signature: string): Promise<TestHttpResponse<T>> {
    const res: AxiosResponse = await this.client.post(url, rawBody, {
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
      },
    });
    return { status: res.status, body: res.data, headers: res.headers };
  }
}
```

---

### Helper Proposal 2: JWT Test Token Helper (`testJwtHelper.ts`)
```typescript
import jwt from 'jsonwebtoken';

export type UserRole = 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN';

export interface JwtPayload {
  id: string;
  phone: string;
  role: UserRole;
}

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'kraveo_vit_bhopal_super_secret_jwt_key_2026';

export const generateTestToken = (payload: JwtPayload, expiresIn: string = '1h', secret: string = TEST_JWT_SECRET): string => {
  return jwt.sign(payload, secret, { expiresIn });
};

export const getStudentTestToken = (id = 'usr-student-e2e', phone = '+919999900001'): string => {
  return generateTestToken({ id, phone, role: 'STUDENT' });
};

export const getVendorTestToken = (id = 'usr-vendor-e2e', phone = '+919999900002'): string => {
  return generateTestToken({ id, phone, role: 'VENDOR' });
};

export const getDriverTestToken = (id = 'usr-driver-e2e', phone = '+919999900003'): string => {
  return generateTestToken({ id, phone, role: 'DRIVER' });
};

export const getAdminTestToken = (id = 'usr-admin-e2e', phone = '+919999900004'): string => {
  return generateTestToken({ id, phone, role: 'ADMIN' });
};
```

---

### Helper Proposal 3: Socket.io Client Test Helper (`testSocketHelper.ts`)
```typescript
import { io as ioClient, Socket } from 'socket.io-client';

export const connectTestSocket = (serverUrl: string = process.env.TEST_WS_URL || 'http://localhost:5000'): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
};

export const waitForSocketEvent = <T = any>(socket: Socket, eventName: string, timeoutMs: number = 3000): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout waiting for Socket.io event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    const listener = (data: T) => {
      clearTimeout(timer);
      socket.off(eventName, listener);
      resolve(data);
    };

    socket.on(eventName, listener);
  });
};

export const joinTestRoom = (socket: Socket, room: string): Promise<void> => {
  socket.emit('join_room', room);
  return new Promise((resolve) => setTimeout(resolve, 100));
};

export const disconnectTestSocket = (socket: Socket): void => {
  if (socket && socket.connected) {
    socket.disconnect();
  }
};
```

---

### Helper Proposal 4: Razorpay Signature Calculation Helper (`testRazorpayHelper.ts`)
```typescript
import crypto from 'crypto';

const TEST_RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'kraveo_razorpay_secret_key_2026';
const TEST_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'kraveo_webhook_secret_2026';

export const calculatePaymentSignature = (
  razorpayOrderId: string,
  razorpayPaymentId: string,
  keySecret: string = TEST_RAZORPAY_SECRET
): string => {
  return crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
};

export const calculateWebhookSignature = (
  rawBody: string | Buffer,
  webhookSecret: string = TEST_WEBHOOK_SECRET
): string => {
  return crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
};
```

---

### Helper Proposal 5: Gate OTP Helper (`testOtpHelper.ts`)
```typescript
export const generate4DigitOtp = (): string => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

export const extractGateOtpFromOrderResponse = (orderResponseBody: any): string | undefined => {
  return orderResponseBody?.data?.otpCode || orderResponseBody?.otpCode;
};
```

---

### Helper Proposal 6: Prisma Database Verification Helper (`testDbHelper.ts`)
```typescript
import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;

export const getTestPrismaClient = (): PrismaClient => {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
};

export const cleanTestDatabase = async (): Promise<void> => {
  const prisma = getTestPrismaClient();
  // Clean tables in reverse dependency order
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.driverLocation.deleteMany();
  await prisma.user.deleteMany();
};

export const disconnectTestDatabase = async (): Promise<void> => {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
};
```

---

## 3. Caveats

1. **Environment Variable Synchronization**:
   - `JWT_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and `DATABASE_URL` must match between the running backend process and the test helper configuration. Tests should fall back gracefully to default test secret constants if environment variables are omitted in local dev.
2. **Asynchronous Socket Timing**:
   - WebSockets are asynchronous. `waitForSocketEvent` must handle timeout cleanly to prevent hung tests. A default timeout of 3000ms is established.
3. **Master OTP Deprecation Verification**:
   - Universal master OTPs (`1234`, `4829`) and mock JWT tokens (`mock_jwt_token_...`) are currently enabled in non-production mode (`NODE_ENV !== 'production'`). Tests verifying security hardening (Milestone 4 / R3 requirement) must run against a server initialized with `NODE_ENV=production` or test the hardened OTP endpoint explicitly.
4. **Database Teardown Safety**:
   - `cleanTestDatabase()` executes `deleteMany()`. Tests MUST be executed against a dedicated test database (e.g. `kraveo_test` PostgreSQL instance) configured via `DATABASE_URL`.

---

## 4. Conclusion

1. **Opaque-Box Architectural Integrity**:
   - The proposed testing methodology and 6 helper modules guarantee 100% opaque-box test execution. Test cases will interact with Kraveo purely through HTTP endpoints, Socket.io events, and database query assertions. No backend internal modules (`store.ts`, route handlers) will be imported into test suites.
2. **Comprehensive Technical Coverage**:
   - The helper functions cover all critical tech areas: Express REST status codes and body schemas, JWT RBAC security checks, real-time Socket.io room isolation, HMAC SHA-256 payment signature calculations, dynamic 4-digit Gate OTP handshakes, and Prisma DB persistence.
3. **Execution Readiness**:
   - The proposed helper library design provides clean, reusable primitives for Explorer 1's harness runner and future implementers writing Tiers 1-4 test cases.

---

## 5. Verification Method

To independently verify this methodology and helper architecture:

1. **Verify Source Files & Specs**:
   - Inspect `backend/src/index.ts`, `backend/src/routes/api.ts`, `backend/src/middleware/auth.ts`, and `backend/src/services/paymentService.ts` to verify routes, secrets, and socket event names.
2. **Verify Helper Implementability**:
   - Compile or type-check the proposed TypeScript helpers using `npx tsc --noEmit` inside `backend/` once created.
3. **Run Health Check & Integration Smoke Test**:
   - Start backend server (`npm run dev` or `npm start` in `backend/`).
   - Execute HTTP GET `/health` to verify status `online`.
