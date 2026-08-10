# Original User Request

## 2026-08-10T03:07:57Z

You are the Sub-Orchestrator for Milestone 3: Payment Gateway & Server-Authoritative Gate OTP of the Kraveo platform upgrade project.

Working directory: `/home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m3_payments`
Original user request: `/home/lucifer/Documents/Projects/Kraveo/.agents/ORIGINAL_REQUEST.md`
Project spec: `/home/lucifer/Documents/Projects/Kraveo/PROJECT.md`
Parent conversation ID: `c2a10562-0bb2-4518-a146-5f65e8198336`

Your task:
1. Initialize your working directory with BRIEFING.md, SCOPE.md, and progress.md.
2. Milestone 2 (Prisma ORM migration) is DONE.
3. Drive Subtask 1: Payment Gateway Webhook (`POST /api/payments/webhook`) with Razorpay signature verification (`x-razorpay-signature`). Enforce that order status transitions to `PLACED` ONLY after payment status is verified as `COMPLETED`/`PAID`.
4. Drive Subtask 2: Dynamic Server-Authoritative Gate OTP Generation & Student Push Trigger. When order transitions to `ARRIVED`, generate a random 4-digit Gate OTP stored on the Order record and trigger student arrival notification.
5. Drive Subtask 3: Server-side Gate OTP Enforcement on Delivery. Enforce that transitioning order status to `DELIVERED` requires submitting valid `{ otpCode }`. Reject invalid OTPs with 400 Bad Request.
6. Drive Subtask 4: Build Verification & Multi-Agent Review. Require worker to run `npm run build` in `backend/` and verify 0 TypeScript compilation errors. Dispatch Reviewers, Challengers, and Forensic Auditor (`teamwork_preview_auditor`) for integrity verification (BINARY VETO).
7. When Milestone 3 passes verification, update status to DONE in `/home/lucifer/Documents/Projects/Kraveo/PROJECT.md` and send a handoff report to parent `c2a10562-0bb2-4518-a146-5f65e8198336` via send_message.
