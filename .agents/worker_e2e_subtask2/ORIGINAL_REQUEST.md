## 2026-08-10T03:10:12Z

You are the Worker subagent assigned to E2E Subtask 2: Tier 2 (Boundary & Corner Cases) for the Kraveo platform upgrade.

Working directory: `/home/lucifer/Documents/Projects/Kraveo/.agents/worker_e2e_subtask2`
Project directory: `/home/lucifer/Documents/Projects/Kraveo`
Backend directory: `/home/lucifer/Documents/Projects/Kraveo/backend`
Test infra spec: `/home/lucifer/Documents/Projects/Kraveo/TEST_INFRA.md`
Harness directory: `/home/lucifer/Documents/Projects/Kraveo/backend/test/harness`

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Initialize your working directory `.agents/worker_e2e_subtask2/` with `BRIEFING.md` and `progress.md`.
2. Inspect the test harness in `backend/test/harness/` (`app.ts`, `db.ts`, `auth.ts`, `socket.ts`) and existing Tier 1 test cases in `backend/test/e2e/tier1_feature_coverage.test.ts`.
3. Create Tier 2 Test Cases (at least 30 boundary/error test cases, 5 per feature across Features 1-6) under `backend/test/e2e/tier2_boundary_corner.test.ts`:
   - Feature 1: Database Persistence & Query (5 boundary/error cases: non-existent IDs 404, invalid items array 400, max string lengths, foreign key constraint handling, missing fields).
   - Feature 2: Razorpay Payment Webhooks (5 boundary/error cases: invalid HMAC signature 400/401, negative/zero amount, non-existent order ID, missing fields, duplicate webhook event).
   - Feature 3: Server-Side 4-Digit Gate Handshake OTP Verification (5 boundary/error cases: invalid 4-digit code 400, malformed length/non-numeric OTP, premature state transition to DELIVERED before ARRIVED_AT_GATE, re-verification after delivery, script/injection input).
   - Feature 4: Removal of Universal OTPs & JWT/RBAC Auth Enforcement (5 boundary/error cases: malformed JWT signature 401, expired JWT, unauthorized role elevation 403, master OTP bypass 1234/4829 rejection, missing Auth header 401).
   - Feature 5: Real-time Socket.io & FCM Multi-Persona Sync (5 boundary/error cases: invalid room joins, malformed location payloads, socket disconnect/reconnect handling, empty FCM token, missing payload fields).
   - Feature 6: Transport Security, CORS & Cleartext Traffic Guards (5 boundary/error cases: unauthorized origin CORS handling, disallowed HTTP methods, non-JSON Content-Type rejection, non-existent route 404 guard, malformed request handling).
4. Make any necessary minor adjustments in `backend/src/routes/api.ts` or middleware to cleanly handle error status codes (400, 401, 403, 404) if any edge case needs proper error response formatting.
5. Run `npm test` in `backend/` and verify that ALL test suites (Tier 1 + Tier 2 = 60 tests) execute and pass cleanly.
6. Write a handoff report at `.agents/worker_e2e_subtask2/handoff.md` summarizing the boundary test cases created, test command, and execution results.
7. Send a message to parent sub-orchestrator `c2a10562-0bb2-4518-a146-5f65e8198336` (or current caller) notifying completion.
