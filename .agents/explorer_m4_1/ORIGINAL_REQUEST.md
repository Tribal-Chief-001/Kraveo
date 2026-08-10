## 2026-08-10T03:08:35Z
<USER_REQUEST>
You are an Explorer agent investigating static universal OTPs and master token bypasses in the Kraveo backend.

Working directory: /home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_1
Project root: /home/lucifer/Documents/Projects/Kraveo
Scope Document: /home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m4_auth/SCOPE.md

Task:
1. Examine `backend/src/routes/api.ts` and any auth service files in `backend/src/` for static universal test OTPs (such as '1234', '4829', '0000', or any hardcoded OTP strings), master tokens, fallback bypasses, or dev backdoors.
2. Trace the exact flow of `POST /api/auth/send-otp`, `POST /api/auth/verify-otp`, `POST /api/auth/login`, and any token refresh or auth routes.
3. Detail every line of code in `backend/src/routes/api.ts` and related services where universal OTP checks or master token bypasses exist.
4. Formulate a precise, concrete implementation plan for Worker to completely remove all static OTPs and master token bypasses, and enforce authentic OTP generation & verification using DB/redis/store or genuine verification service.
5. Write your complete findings and implementation plan to `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m4_1/handoff.md`.
6. Send a message to main agent when completed.
</USER_REQUEST>
