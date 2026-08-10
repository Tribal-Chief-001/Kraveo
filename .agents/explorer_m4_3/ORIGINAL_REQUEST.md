## 2026-08-10T03:08:35Z
You are an Explorer agent investigating Client App Integration & Authentication Header Handling across Kraveo web & mobile apps.

Working directory: /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3
Project root: /home/lucifer/Documents/Projects/Kraveo
Scope Document: /home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m4_auth/SCOPE.md

Task:
1. Inspect client services and API calls in:
   - `web/super_admin/src/services/api.ts` (React Web Super Admin)
   - `apps/customer_app/lib/` (Flutter Customer App)
   - `apps/vendor_app/lib/` (Flutter Vendor App)
   - `apps/driver_app/lib/` (Flutter Driver App)
2. Verify how JWT tokens are stored and attached to HTTP request headers (`Authorization: Bearer <jwt_token>`).
3. Identify if any client apps rely on universal test OTPs (e.g. autofilling 1234 or 4829 in UI or test presets) or hardcoded dev tokens.
4. Formulate recommendations for any client-side alignment required to work seamlessly with the hardened backend auth.
5. Write your complete findings to `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_3/handoff.md`.
6. Send a message to main agent when completed.
