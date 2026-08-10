# Scope: Milestone 1 — E2E Testing Suite (Dual Track)

## Scope Description
Build an opaque-box, requirement-driven E2E test suite covering Tiers 1-4 for the Kraveo platform upgrade according to TEST_INFRA.md and ORIGINAL_REQUEST.md.
When the test suite is complete, publish TEST_READY.md at project root.

## Architecture
- Category-Partition, BVA, Pairwise, and Application-level test cases in `backend/test/e2e/` or root `test/`.
- Must test: Prisma DB persistence, Razorpay webhooks, 4-digit Gate OTP, JWT RBAC security (removal of 1234/4829), real-time Socket.io/FCM updates, base URL & CORS configs.

## Milestones & Subtasks
| # | Task | Scope | Status |
|---|------|-------|--------|
| 1 | Test Harness & Tier 1 (Feature Coverage) | Create test runner & ≥30 happy path feature tests | PLANNED |
| 2 | Tier 2 (Boundary & Corner Cases) | Create ≥30 boundary/error test cases | PLANNED |
| 3 | Tier 3 (Cross-Feature Combinations) | Create pairwise integration test cases | PLANNED |
| 4 | Tier 4 (Real-World Application Scenarios) | Create application-level E2E workflow tests | PLANNED |
| 5 | Publish TEST_READY.md | Create root TEST_READY.md with summary | PLANNED |
