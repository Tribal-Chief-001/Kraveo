# Handoff Report: Universal OTP & Master Token Bypass Removal Investigation

## 1. Observation
- **File**: `backend/src/routes/api.ts`
  - Line 43: `const otpStore = new Map<string, { otp: string; expiresAt: number }>();`
    - In-memory `Map` used for storing OTPs instead of Redis or DB persistence. Lost upon server restart and isolated per process instance.
  - Lines 53-54:
    ```typescript
    // Generate 4-digit secure OTP (or use static demo OTP 4829 in dev)
    const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
    ```
    - Math.random() generates OTPs.
  - Line 64:
    ```typescript
    demoOtp: process.env.NODE_ENV !== 'production' ? generatedOtp : undefined
    ```
    - Leakage of generated OTP in API response payload when `NODE_ENV !== 'production'`.
  - Lines 78-81 in `POST /api/auth/verify-otp`:
    ```typescript
    const isDevMode = process.env.NODE_ENV !== 'production' && process.env.REQUIRE_REAL_OTP !== 'true';
    const isValidOtp =
      (storedData && storedData.otp === otp && Date.now() < storedData.expiresAt) ||
      (isDevMode && (otp === '4829' || otp === '1234'));
    ```
    - Hardcoded static OTP fallback bypass allowing any login using `'4829'` or `'1234'` whenever `REQUIRE_REAL_OTP !== 'true'` or `NODE_ENV !== 'production'`.
  - Lines 127-158 in `POST /api/auth/login`:
    ```typescript
    apiRouter.post('/auth/login', async (req: Request, res: Response) => {
      ...
      let user = await prisma.user.findUnique({ where: { phone } });
      if (!user) { ... }
      const token = generateToken({ id: user.id, phone: user.phone, role: user.role });
      return res.json({ success: true, token, user });
    });
    ```
    - Complete authentication bypass endpoint. Allows issuing valid JWT tokens for any user phone number without requiring ANY OTP verification or password!
- **File**: `backend/src/middleware/auth.ts`
  - Lines 34-38 in `requireAuth` middleware:
    ```typescript
    // Allow mock fallback tokens for initial developer client convenience if in development
    if (process.env.NODE_ENV === 'development' && process.env.DISABLE_MOCK_AUTH !== 'true' && token.startsWith('mock_jwt_token_')) {
      const userId = token.replace('mock_jwt_token_', '');
      req.user = { id: userId, phone: '+91 9876543210', role: 'ADMIN' };
      return next();
    }
    ```
    - Master token bypass mechanism: Any token beginning with `mock_jwt_token_` automatically bypasses JWT verification and grants full `ADMIN` role privileges if `DISABLE_MOCK_AUTH !== 'true'`.

---

## 2. Logic Chain
1. **Security Vulnerability in `POST /api/auth/verify-otp`**:
   - The conditional check `(isDevMode && (otp === '4829' || otp === '1234'))` allows authentication without verifying the generated OTP stored in `otpStore`.
   - If an attacker supplies `4829` or `1234`, verification passes regardless of whether an OTP was dispatched or what its actual value was.
   - Leakage of `demoOtp` in `POST /api/auth/send-otp` response allows unauthenticated users to read generated OTPs directly from HTTP responses.

2. **Critical Backdoor in `POST /api/auth/login`**:
   - The route accepts `{ phone, role }` and immediately issues a signed JWT token and creates/fetches the user without verifying possession of the phone number via OTP or any secret.
   - This bypasses all authentication controls completely.

3. **Master Token Flaw in `backend/src/middleware/auth.ts`**:
   - The `requireAuth` function checks `token.startsWith('mock_jwt_token_')`.
   - If true, it assigns `req.user = { id: userId, phone: '+91 9876543210', role: 'ADMIN' }` and invokes `next()`.
   - This allows any request with `Authorization: Bearer mock_jwt_token_xxx` to execute protected endpoints with full `ADMIN` authorization.

4. **In-Memory Store Limits**:
   - `otpStore` is a process-local `Map`. In multi-instance / scaled environments, OTPs requested on instance A cannot be verified on instance B.
   - Storing OTPs in Redis or Database ensures persistence across restarts and multi-node scalability.

---

## 3. Caveats
- Existing frontend or automated test suites might be passing `mock_jwt_token_` or using static OTPs (`4829`/`1234`) or calling `POST /api/auth/login`.
- When removing these dev backdoors, any dev scripts or automated tests relying on `4829` or `mock_jwt_token_` will fail unless updated or unless tests use a dedicated test helper / real OTP verification flow.
- A database table or Redis cache for storing OTPs (e.g. `OtpStore` model in Prisma or Redis connection) will need to be verified or created if DB-backed OTP storage is used. Alternatively, an in-memory store cleanly isolated without backdoors can serve single-instance setups if DB/Redis is not configured, but DB/Redis is strongly recommended for production.

---

## 4. Conclusion & Concrete Implementation Plan

### Goal
Completely remove all static OTPs, master token bypasses, demo OTP exposure, and unauthenticated login routes. Enforce strict, authentic OTP generation and verification.

### Detailed Step-by-Step Remediation Plan for Worker:

#### Step 1: Clean Up `backend/src/middleware/auth.ts`
- Remove the `mock_jwt_token_` check from `requireAuth` (lines 33–38).
- Ensure `jwt.verify(token, JWT_SECRET)` is strictly enforced for ALL incoming Bearer tokens without exception.

```typescript
// Replace lines 33-38 in backend/src/middleware/auth.ts:
// REMOVE:
// if (process.env.NODE_ENV === 'development' && process.env.DISABLE_MOCK_AUTH !== 'true' && token.startsWith('mock_jwt_token_')) { ... }
```

#### Step 2: Clean Up `backend/src/routes/api.ts` - `POST /api/auth/send-otp`
- Remove `demoOtp` from the returned JSON response in `POST /api/auth/send-otp` (line 64).
- Ensure generated OTPs are securely stored in `otpStore` (or DB/Redis) with expiration timestamp.

```typescript
// In POST /api/auth/send-otp:
return res.json({
  success: true,
  message: `OTP sent successfully to +91 ${phone}. Valid for 5 minutes.`
});
```

#### Step 3: Clean Up `backend/src/routes/api.ts` - `POST /api/auth/verify-otp`
- Remove `isDevMode` static OTP checks (`otp === '4829' || otp === '1234'`).
- Enforce that `otp` MUST match `storedData.otp` and `Date.now() < storedData.expiresAt`.
- Delete OTP from store immediately after successful verification to prevent replay attacks.

```typescript
// In POST /api/auth/verify-otp:
const storedData = otpStore.get(phone);
if (!storedData || storedData.otp !== otp || Date.now() >= storedData.expiresAt) {
  return res.status(400).json({ success: false, message: 'Invalid or expired OTP code. Please try again.' });
}
```

#### Step 4: Remove Unauthenticated `POST /api/auth/login` Route
- Remove or deprecate `POST /api/auth/login` from `backend/src/routes/api.ts` (lines 127–158) so that authentication can ONLY occur via `POST /api/auth/verify-otp`.

---

## 5. Verification Method

To independently verify the removal of universal OTPs and master token bypasses:

1. **Build Check**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npm run build
   ```
   Must compile with 0 TypeScript errors.

2. **Test Universal OTP Rejection**:
   - Send `POST /api/auth/send-otp` with `{ "phone": "9876543210" }`.
   - Send `POST /api/auth/verify-otp` with `{ "phone": "9876543210", "otp": "4829" }` or `"1234"`.
   - Expected Result: `400 Bad Request` with message `"Invalid or expired OTP code. Please try again."`

3. **Test Master Token Rejection**:
   - Send `GET /api/auth/profile` with header `Authorization: Bearer mock_jwt_token_usr-1`.
   - Expected Result: `401 Unauthorized` with message `"Invalid or expired authentication token."`

4. **Test Direct Login Endpoint Removal**:
   - Send `POST /api/auth/login` with `{ "phone": "9876543210" }`.
   - Expected Result: `404 Not Found` (or route removed).
