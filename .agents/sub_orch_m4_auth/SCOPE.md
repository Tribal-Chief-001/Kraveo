# Scope: Milestone 4 - Authentication, JWT & RBAC Hardening

## Architecture
Backend Express service in `backend/src/`:
- `backend/src/routes/api.ts` - Main Express router containing auth endpoints (login, send-otp, verify-otp, refresh) and API routes for vendors, drivers, admin, orders, etc.
- `backend/src/middleware/auth.ts` - JWT authentication (`authenticateJwt`) and role middleware (`requireRole`).
- `backend/src/services/` - Auth services (OTP generation, SMS service, token creation/verification).

## Milestones / Subtasks
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Subtask 1: Universal OTP & Master Token Removal | Remove hardcoded test OTPs ('1234', '4829', '0000', etc.) and master token bypasses from api.ts and auth services. Enforce real OTP verification. | none | PLANNED |
| 2 | Subtask 2: JWT Middleware & RBAC Enforcement | Apply `authenticateJwt` and `requireRole` middleware across vendor, driver, and admin routes. Return 401 Unauthorized for unauthenticated requests and 403 Forbidden for unauthorized roles. | Subtask 1 | PLANNED |
| 3 | Subtask 3: Build Verification & Multi-Agent Review | Run `npm run build` in `backend/` (0 compilation errors), pass Reviewer review, pass Challenger verification, pass Forensic Auditor integrity audit (BINARY VETO). | Subtask 1, Subtask 2 | PLANNED |

## Interface Contracts
### Auth API Endpoint Contracts
- `POST /api/auth/send-otp`: Request body `{ phone: string, role?: string }`. Sends real OTP code via service or stores hash/OTP in store/DB (without returning universal bypass code).
- `POST /api/auth/verify-otp`: Request body `{ phone: string, otp: string }`. Must match stored OTP for phone. Rejects static codes like 1234, 4829, 0000. Returns `{ token: string, user: object }`.
- `Header: Authorization: Bearer <jwt_token>` required on protected routes.
- Role Enforcement:
  - `/api/vendor/*` -> `requireRole('VENDOR')`
  - `/api/driver/*` -> `requireRole('DRIVER')`
  - `/api/admin/*` -> `requireRole('ADMIN')`
  - `/api/customer/*` / customer routes -> `requireRole('CUSTOMER')` (or `authenticateJwt` as appropriate)

## Code Layout
- Router: `backend/src/routes/api.ts`
- Auth Middleware: `backend/src/middleware/auth.ts`
- Auth Controllers/Services: `backend/src/services/auth.ts` or inline helper routines in `api.ts` / `middleware/auth.ts`
