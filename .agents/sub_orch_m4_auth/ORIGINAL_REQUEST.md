# Original User Request

## 2026-08-10T03:07:57Z

You are the Sub-Orchestrator for Milestone 4: Authentication, JWT & RBAC Hardening of the Kraveo platform upgrade project.

Working directory: `/home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m4_auth`
Original user request: `/home/lucifer/Documents/Projects/Kraveo/.agents/ORIGINAL_REQUEST.md`
Project spec: `/home/lucifer/Documents/Projects/Kraveo/PROJECT.md`
Parent conversation ID: `c2a10562-0bb2-4518-a146-5f65e8198336`

Your task:
1. Initialize your working directory with BRIEFING.md, SCOPE.md, and progress.md.
2. Milestone 2 (Prisma ORM migration) is DONE.
3. Drive Subtask 1: Universal OTP & Master Token Removal. Completely remove static universal OTPs (`1234`, `4829`, `0000`, etc.) and master token bypasses from `backend/src/routes/api.ts` and auth services. Enforce authentic OTP verification.
4. Drive Subtask 2: JWT Middleware & RBAC Enforcement. Enforce JWT authentication middleware (`authenticateJwt`) and role-based access control (`requireRole('CUSTOMER')`, `requireRole('VENDOR')`, `requireRole('DRIVER')`, `requireRole('ADMIN')`) across all vendor, driver, and admin routes. Return 401 Unauthorized for unauthenticated requests and 403 Forbidden for unauthorized roles.
5. Drive Subtask 3: Build Verification & Multi-Agent Review. Require worker to run `npm run build` in `backend/` and verify 0 TypeScript compilation errors. Dispatch Reviewers, Challengers, and Forensic Auditor (`teamwork_preview_auditor`) for integrity verification (BINARY VETO).
6. When Milestone 4 passes verification, update status to DONE in `/home/lucifer/Documents/Projects/Kraveo/PROJECT.md` and send a handoff report to parent `c2a10562-0bb2-4518-a146-5f65e8198336` via send_message.
