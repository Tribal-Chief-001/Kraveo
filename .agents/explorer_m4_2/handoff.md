# Handoff Report: JWT Authentication Middleware & RBAC Enforcement Audit

## 1. Observation

Direct code inspection was performed on `backend/src/middleware/auth.ts`, `backend/src/routes/api.ts`, `backend/src/types.ts`, `backend/prisma/schema.prisma`, and `backend/test/harness/auth.ts`.

### A. Middleware Inspection (`backend/src/middleware/auth.ts`)
- **`requireAuth` (lines 21–50)**: Verifies the `Authorization: Bearer <token>` header.
  - Returns `401 Unauthorized` with `{ success: false, message: 'Authentication required. Missing or malformed Bearer token.' }` if missing or malformed (lines 25–28).
  - Decodes token using `jwt.verify(token, JWT_SECRET)`.
  - Attaches decoded payload `{ id, phone, role }` to `req.user` (line 42).
  - Returns `401 Unauthorized` with `{ success: false, message: 'Invalid or expired authentication token.' }` if verification fails (lines 45–48).
  - *Note*: `authenticateJwt` is currently missing as a named export/alias in `auth.ts`.
- **`requireRole` (lines 53–68)**: Enforces Role-Based Access Control.
  - Returns `401 Unauthorized` (`{ success: false, message: 'Unauthorized.' }`) if `req.user` is not attached (lines 55–57).
  - Returns `403 Forbidden` (`{ success: false, message: "Forbidden. Role '...' is not authorized to access this resource." }`) if `req.user.role` is not in `allowedRoles` (lines 59–64).

### B. User Role Definitions
- **Prisma Schema (`backend/prisma/schema.prisma:12–17`)**:
  ```prisma
  enum Role {
    STUDENT
    VENDOR
    DRIVER
    ADMIN
  }
  ```
- **TypeScript Types (`backend/src/types.ts:1`)**:
  ```ts
  export type UserRole = 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN';
  ```
- Note: In system scope documentation, student/customer accounts use the `'STUDENT'` role enum value in the database.

### C. Unprotected & Vulnerable Routes in `backend/src/routes/api.ts`
1. **`PATCH /api/vendors/:id/status` (lines 610–626)**: Defined as `apiRouter.patch('/vendors/:id/status', async (req: Request, res: Response) => ...)` with ZERO auth or role middleware. Allows unauthenticated clients to open/close vendor stores.
2. **`PATCH /api/vendors/items/:itemId` (lines 629–645)**: Defined as `apiRouter.patch('/vendors/items/:itemId', async (req: Request, res: Response) => ...)` with ZERO auth or role middleware. Allows unauthenticated clients to alter menu item prices and stock availability.
3. **`GET /api/orders` (lines 397–416)**: Defined with ZERO auth middleware. Exposes all platform orders, customer dropoff hostels, order items, and total prices to unauthenticated callers.
4. **`GET /api/orders/:id` (lines 418–429)**: Defined with ZERO auth middleware. Allows unauthenticated inspection of order details by ID.
5. **`GET /api/drivers` (lines 15–24)**: Defined with ZERO auth middleware. Exposes all driver profiles, registration numbers, phone numbers, and duty status.
6. **`GET /api/drivers/:id` (lines 26–38)**: Defined with ZERO auth middleware. Allows unauthenticated reading of driver partner details.
7. **`GET /api/drivers/locations` (lines 683–690)**: Defined with ZERO auth middleware. Exposes active driver live GPS coordinates.
8. **`POST /api/orders/:id/verify-gate-otp` (lines 572–607)**: Uses `requireAuth` but lacks `requireRole('DRIVER', 'ADMIN')`. Any non-runner account can invoke gate OTP verification.

---

## 2. Logic Chain

1. **Premise 1**: Middleware `requireAuth` properly validates Bearer JWT tokens and populates `req.user` with `{ id, phone, role }`. In missing/invalid token cases, it returns `401 Unauthorized`.
2. **Premise 2**: Middleware `requireRole(...allowedRoles)` verifies `req.user.role`. If `req.user` is missing, it returns `401`. If `req.user.role` is unauthorized, it returns `403 Forbidden`.
3. **Premise 3**: Inspection of `backend/src/routes/api.ts` revealed that 7 sensitive read/write endpoints completely omit `requireAuth` or `requireRole`, and 1 endpoint lacks role restrictions.
4. **Reasoning Step**:
   - `PATCH /api/vendors/:id/status` and `PATCH /api/vendors/items/:itemId` perform state changes on store availability and item pricing. Without `requireAuth` and `requireRole('VENDOR', 'ADMIN')`, an attacker can modify Dhaba menus and store status without credentials.
   - `GET /api/orders`, `GET /api/orders/:id`, `GET /api/drivers`, `GET /api/drivers/:id`, and `GET /api/drivers/locations` expose platform operational data and personal identifiable information (PII). Attaching `requireAuth` (and `requireRole` where applicable) closes these data leaks.
   - `POST /api/orders/:id/verify-gate-otp` modifies order state to `DELIVERED`. Restricting this endpoint to `requireRole('DRIVER', 'ADMIN')` ensures only authorized runners or admins complete gate delivery handshakes.
5. **Conclusion**: Exporting `authenticateJwt` alias from `backend/src/middleware/auth.ts` and attaching `authenticateJwt` / `requireRole` across the 8 identified routes in `backend/src/routes/api.ts` will achieve complete RBAC enforcement with standard 401/403 HTTP status code compliance.

---

## 3. Caveats

- **Mock Token in Development**: `requireAuth` currently allows fallback tokens starting with `mock_jwt_token_` when `NODE_ENV === 'development'` and `DISABLE_MOCK_AUTH !== 'true'`. In production mode (`NODE_ENV === 'production'`), real JWT tokens are strictly required.
- **Role Mapping**: The system scope references customer role as `CUSTOMER`. In the backend schema and TypeScript types, student/customer accounts are represented by the enum value `'STUDENT'`.
- **Public Endpoints Intentionality**:
  - `POST /api/auth/send-otp`, `POST /api/auth/verify-otp`, `POST /api/auth/login` are intentionally public for authentication.
  - `POST /api/payments/webhook` is intentionally public for Razorpay server-to-server HTTP callbacks (validated by payment signature/payload).
  - `GET /api/vendors`, `GET /api/vendors/:id`, `GET /api/menus/:vendorId`, `GET /api/reviews/vendor/:vendorId`, `GET /api/reviews/driver/:driverId` are intentionally public for unauthenticated menu and store review browsing by prospective student buyers.
- No other caveats.

---

## 4. Conclusion & Route-by-Route Middleware Enforcement Map

### Summary Table: Audit of All 30 API Endpoints in `backend/src/routes/api.ts`

| # | Method | Endpoint Path | Current Protection | Target Protection | Target Roles | Action Required |
|---|--------|---------------|--------------------|-------------------|--------------|-----------------|
| 1 | `GET` | `/api/drivers` | Public (Unprotected) | `requireAuth, requireRole` | `ADMIN` | **ADD `requireAuth, requireRole('ADMIN')`** |
| 2 | `GET` | `/api/drivers/:id` | Public (Unprotected) | `requireAuth, requireRole` | `DRIVER, ADMIN` | **ADD `requireAuth, requireRole('DRIVER', 'ADMIN')`** |
| 3 | `POST` | `/api/auth/send-otp` | Public | Public | Public | None (Auth flow) |
| 4 | `POST` | `/api/auth/verify-otp` | Public | Public | Public | None (Auth flow) |
| 5 | `POST` | `/api/auth/login` | Public | Public | Public | None (Auth flow) |
| 6 | `GET` | `/api/auth/profile` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 7 | `PUT` | `/api/auth/profile` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 8 | `POST` | `/api/payments/create-order` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 9 | `POST` | `/api/payments/verify-signature` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 10 | `POST` | `/api/payments/webhook` | Public | Public | Webhook Caller | None (External Razorpay callback) |
| 11 | `POST` | `/api/notifications/register-token` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 12 | `GET` | `/api/vendors` | Public | Public | Public | None (Customer menu browsing) |
| 13 | `GET` | `/api/vendors/:id` | Public | Public | Public | None (Customer menu browsing) |
| 14 | `PATCH` | `/api/vendors/:id/toggle` | `requireAuth, requireRole` | `requireAuth, requireRole` | `VENDOR, ADMIN` | None (Already protected) |
| 15 | `GET` | `/api/menus/:vendorId` | Public | Public | Public | None (Customer menu browsing) |
| 16 | `PATCH` | `/api/menus/:itemId/toggle` | `requireAuth, requireRole` | `requireAuth, requireRole` | `VENDOR, ADMIN` | None (Already protected) |
| 17 | `GET` | `/api/orders` | Public (Unprotected) | `requireAuth` | Any Authenticated | **ADD `requireAuth`** |
| 18 | `GET` | `/api/orders/:id` | Public (Unprotected) | `requireAuth` | Any Authenticated | **ADD `requireAuth`** |
| 19 | `POST` | `/api/orders` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 20 | `PATCH` | `/api/orders/:id/status` | `requireAuth` | `requireAuth` | Internal Role Checks | None (Already protected) |
| 21 | `POST` | `/api/orders/:id/verify-gate-otp` | `requireAuth` | `requireAuth, requireRole` | `DRIVER, ADMIN` | **ADD `requireRole('DRIVER', 'ADMIN')`** |
| 22 | `PATCH` | `/api/vendors/:id/status` | Public (Unprotected) | `requireAuth, requireRole` | `VENDOR, ADMIN` | **ADD `requireAuth, requireRole('VENDOR', 'ADMIN')`** |
| 23 | `PATCH` | `/api/vendors/items/:itemId` | Public (Unprotected) | `requireAuth, requireRole` | `VENDOR, ADMIN` | **ADD `requireAuth, requireRole('VENDOR', 'ADMIN')`** |
| 24 | `POST` | `/api/orders/:id/accept-driver` | `requireAuth, requireRole` | `requireAuth, requireRole` | `DRIVER, ADMIN` | None (Already protected) |
| 25 | `GET` | `/api/drivers/locations` | Public (Unprotected) | `requireAuth` | Any Authenticated | **ADD `requireAuth`** |
| 26 | `POST` | `/api/drivers/location` | `requireAuth, requireRole` | `requireAuth, requireRole` | `DRIVER, ADMIN` | None (Already protected) |
| 27 | `POST` | `/api/reviews` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 28 | `POST` | `/api/coupons/redeem-coins` | `requireAuth` | `requireAuth` | Any Authenticated | None (Already protected) |
| 29 | `GET` | `/api/reviews/vendor/:vendorId` | Public | Public | Public | None (Store reviews reading) |
| 30 | `GET` | `/api/reviews/driver/:driverId` | Public | Public | Public | None (Driver reviews reading) |

### Concrete Action Plan for Worker

1. **In `backend/src/middleware/auth.ts`**:
   - Export alias `export const authenticateJwt = requireAuth;`.

2. **In `backend/src/routes/api.ts`**:
   - Update middleware import to include `authenticateJwt`:
     `import { generateToken, requireAuth, authenticateJwt, requireRole, AuthenticatedRequest } from '../middleware/auth';`
   - Apply middleware to unauthenticated targets:
     - `apiRouter.get('/drivers', requireAuth, requireRole('ADMIN'), ...)`
     - `apiRouter.get('/drivers/:id', requireAuth, requireRole('DRIVER', 'ADMIN'), ...)`
     - `apiRouter.get('/orders', requireAuth, ...)`
     - `apiRouter.get('/orders/:id', requireAuth, ...)`
     - `apiRouter.post('/orders/:id/verify-gate-otp', requireAuth, requireRole('DRIVER', 'ADMIN'), ...)`
     - `apiRouter.patch('/vendors/:id/status', requireAuth, requireRole('VENDOR', 'ADMIN'), ...)`
     - `apiRouter.patch('/vendors/items/:itemId', requireAuth, requireRole('VENDOR', 'ADMIN'), ...)`
     - `apiRouter.get('/drivers/locations', requireAuth, ...)`

---

## 5. Verification Method

To independently verify the implementation:

1. **Compilation Check**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npm run build
   ```
   *Expected outcome*: 0 TypeScript compilation errors. Output directory `dist/` updated.

2. **Test Suite Verification**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npm test
   ```
   *Expected outcome*: All Jest test cases pass.

3. **HTTP Status Code Verification**:
   - Send `GET /api/orders` without `Authorization` header -> HTTP 401 (`{ success: false, message: 'Authentication required. Missing or malformed Bearer token.' }`).
   - Send `PATCH /api/vendors/ven-1/status` with `STUDENT` JWT token -> HTTP 403 (`{ success: false, message: "Forbidden. Role 'STUDENT' is not authorized to access this resource." }`).
   - Send `PATCH /api/vendors/ven-1/status` with `VENDOR` or `ADMIN` JWT token -> HTTP 200 (`{ success: true, ... }`).
