# E2E Test Infra: Kraveo Platform Upgrade

## Test Philosophy
- Opaque-box, requirement-driven end-to-end testing suite.
- Derived directly from user requirements in ORIGINAL_REQUEST.md.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial + Real-World Workloads.

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Database Persistence & Query (No in-memory fallback) | R1 | 5 | 5 | ✓ |
| 2 | Razorpay Payment Webhooks & Server-Authoritative Status | R2 | 5 | 5 | ✓ |
| 3 | Server-Side 4-Digit Gate Handshake OTP Verification | R2 | 5 | 5 | ✓ |
| 4 | Removal of Universal OTPs & JWT/RBAC Auth Enforcement | R3 | 5 | 5 | ✓ |
| 5 | Real-time Socket.io & FCM Multi-Persona Sync | R4 | 5 | 5 | ✓ |
| 6 | Transport Security, CORS & Cleartext Traffic Guards | R5 | 5 | 5 | ✓ |

## Test Architecture
- Test runner location: `backend/test/` or root `test/` suite
- Standardized test reporting publishing `TEST_READY.md` upon completion

## Coverage Thresholds
- Tier 1 (Feature Coverage): ≥30 test cases
- Tier 2 (Boundary & Corner Cases): ≥30 test cases
- Tier 3 (Cross-Feature Combinations): ≥6 test cases
- Tier 4 (Real-World Application Scenarios): ≥5 realistic application scenario tests
- Total minimum: ~71 test cases
