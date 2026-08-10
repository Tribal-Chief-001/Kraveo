## 2026-08-10T03:11:21+05:30

You are the Worker agent responsible for implementing Milestone 4: Authentication, JWT & RBAC Hardening in the Kraveo platform backend.

Working directory: /home/lucifer/Documents/Projects/Kraveo/.agents/worker_m4_1
Project root: /home/lucifer/Documents/Projects/Kraveo
Scope Document: /home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m4_auth/SCOPE.md
Explorer Reports:
- /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_1/handoff.md
- /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_2/handoff.md

MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Subtask 1: Universal OTP & Master Token Removal
   - In `backend/src/middleware/auth.ts`:
     - Remove the `mock_jwt_token_` bypass from `requireAuth` (lines 33-38). Ensure all Bearer tokens undergo strict `jwt.verify(token, JWT_SECRET)`.
     - Export alias `export const authenticateJwt = requireAuth;`.
   - In `backend/src/routes/api.ts`:
     - In `POST /api/auth/send-otp`: Remove `demoOtp` from returned JSON response payload.
     - In `POST /api/auth/verify-otp`: Remove `isDevMode` and static OTP checks (`otp === '4829' || otp === '1234'`). Enforce authentic OTP verification (`storedData && storedData.otp === otp && Date.now() < storedData.expiresAt`). Delete OTP from store once verified.
     - Remove/deprecate unauthenticated `POST /api/auth/login` route.

2. Subtask 2: JWT Middleware & RBAC Enforcement
   - In `backend/src/routes/api.ts`:
     - Update imports to include `authenticateJwt` and `requireRole`.
     - Apply middleware to the 8 identified endpoints:
       1. `GET /api/drivers` -> `requireAuth, requireRole('ADMIN')`
       2. `GET /api/drivers/:id` -> `requireAuth, requireRole('DRIVER', 'ADMIN')`
       3. `GET /api/orders` -> `requireAuth`
       4. `GET /api/orders/:id` -> `requireAuth`
       5. `POST /api/orders/:id/verify-gate-otp` -> `requireAuth, requireRole('DRIVER', 'ADMIN')`
       6. `PATCH /api/vendors/:id/status` -> `requireAuth, requireRole('VENDOR', 'ADMIN')`
       7. `PATCH /api/vendors/items/:itemId` -> `requireAuth, requireRole('VENDOR', 'ADMIN')`
       8. `GET /api/drivers/locations` -> `requireAuth`

3. Subtask 3: Build Verification & Test Updates
   - Check `backend/test/` (e.g. `backend/test/harness/auth.ts` or test files). If tests use static OTPs (`4829`/`1234`) or `mock_jwt_token_` or `POST /api/auth/login`, update test helpers to use genuine JWT token generation via `generateToken` or real OTP workflow so tests pass cleanly.
   - Run `npm run build` in `backend/` and verify 0 TypeScript compilation errors.
   - Run `npm test` (or Jest test suite) in `backend/` to verify all tests pass.

4. Write a detailed handoff report to `/home/lucifer/Documents/Projects/Kraveo/.agents/worker_m4_1/handoff.md` detailing the changes made, build output, test output, and verification results.
5. Send a message to main agent when completed.
