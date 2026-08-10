# Scope: Milestone 1 — E2E Testing Suite (Dual Track)

## Scope Description
Build an opaque-box, requirement-driven E2E test suite covering Tiers 1-4 for the Kraveo platform upgrade according to TEST_INFRA.md and ORIGINAL_REQUEST.md.
When the test suite is complete and verified with exit code 0, publish TEST_READY.md at project root.

## Architecture
- Category-Partition, BVA, Pairwise, and Application-level test cases in `backend/test/e2e/` (or `backend/test/`).
- Test runner: TypeScript / Node test runner executing via `npm test` or `npx ts-node` in `backend/`.
- Must test: Prisma DB persistence, Razorpay webhooks, 4-digit Gate OTP, JWT RBAC security (removal of 1234/4829), real-time Socket.io/FCM updates, base URL & CORS configs.

## Milestones & Subtasks
| # | Task | Scope | Status |
|---|------|-------|--------|
| 1 | Test Harness & Tier 1 (Feature Coverage) | Create test runner harness & 30 happy path feature tests | DONE |
| 2 | Tier 2 (Boundary & Corner Cases) | Create ≥30 boundary/error test cases | IN_PROGRESS |
| 3 | Tier 3 (Cross-Feature Combinations) | Create ≥6 pairwise integration test cases | PLANNED |
| 4 | Tier 4 (Real-World Application Scenarios) | Create ≥5 application-level E2E workflow tests | PLANNED |
| 5 | Suite Execution & Publish TEST_READY.md | Execute full test suite (exit code 0) & create root TEST_READY.md | PLANNED |
