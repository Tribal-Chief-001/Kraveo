# BRIEFING — 2026-08-10T03:08:35Z

## Mission
Investigate Client App Integration & Authentication Header Handling across Kraveo web & mobile apps (web/super_admin, customer_app, vendor_app, driver_app).

## 🔒 My Identity
- Archetype: Explorer
- Roles: Teamwork explorer, read-only analyst
- Working directory: /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3
- Original parent: e609f229-3646-49be-9bd2-f4012a22c49d
- Milestone: M4 Auth Hardening

## 🔒 Key Constraints
- Read-only investigation — do NOT implement code changes
- Scope document: /home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m4_auth/SCOPE.md

## Current Parent
- Conversation ID: e609f229-3646-49be-9bd2-f4012a22c49d
- Updated: 2026-08-10T03:08:35Z

## Investigation State
- **Explored paths**:
  - `web/super_admin/src/App.tsx` (Note: `web/super_admin/src/services/api.ts` does not exist; backend calls are directly in `App.tsx`)
  - `apps/customer_app/lib/services/customer_api_service.dart`, `providers/order_provider.dart`, `screens/checkout_screen.dart`, `test/customer_app_test.dart`
  - `apps/vendor_app/lib/services/vendor_api_service.dart`
  - `apps/driver_app/lib/services/driver_api_service.dart`, `screens/driver_home.dart`, `screens/trip_logs.dart`, `widgets/gate_otp_dialog.dart`, `screens/active_delivery.dart`
- **Key findings**:
  - Web Super Admin directly calls fetch in `App.tsx`: sends `Authorization: Bearer mock_jwt_token_usr-5` on order status patch, but no token on vendor status patch or initial fetches. No local auth/JWT storage logic implemented yet.
  - Customer App (`customer_api_service.dart`): sends `Authorization: Bearer mock_jwt_token_usr-1` on order placement and reviews. OTP auth endpoints (`sendOtp`, `verifyOtp`) exist, returning a token, but the returned token is not saved or attached to subsequent API calls.
  - Vendor App (`vendor_api_service.dart`): performs API calls (`updateOrderStatus`, `toggleStoreStatus`, `updateDishStock`) with NO `Authorization` header attached at all.
  - Driver App (`driver_api_service.dart`): sends `Authorization: Bearer mock-driver-token` on `acceptJob`, `updateDeliveryStatus`, and `updateLocation`. Does not store dynamic tokens.
  - Universal OTPs / Test Preset OTPs:
    - Customer login verification via `verifyOtp` passes whatever string input is entered to backend, but mock order models use randomized 4-digit codes, except in `test/customer_app_test.dart` (`'1234'`).
    - Driver App relies on hardcoded test PINs: `GateOtpDialog` has default `expectedOtp = '4829'`, `driver_home.dart` passes `otpCode: '1234'`, `active_delivery.dart` passes `expectedOtp: '4829'`.
- **Unexplored areas**: None, full client sweep complete.

## Key Decisions Made
- Proceeding to compile final findings and write `handoff.md`.

## Artifact Index
- /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3/ORIGINAL_REQUEST.md — Original task prompt
- /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3/progress.md — Progress tracker
- /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3/handoff.md — Handoff report
