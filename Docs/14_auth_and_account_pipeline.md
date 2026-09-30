# Kraveo Auth & Account Pipeline (v2, 2026-09-30)

Endpoint contract: `Docs/15_auth_v2_contract.md`. This page explains the moving parts and the decisions.

## Who signs in how
| Actor | Account created by | Sign-in |
|---|---|---|
| Student / any customer | Themselves | **Google Sign-In** (any Gmail, not restricted to VIT mail) |
| Restaurant partner | Kraveo (admin) | **Phone + password** |
| Delivery partner | Kraveo (admin) | **Phone + password** |
| Admin dashboard | `ADMIN_PASSCODE` on the server | passcode |

Phone-OTP/SMS login was removed: no SMS provider, no DLT registration, no OTP brute-force surface.

## Customer sign-up order
Google -> full name (prefilled, editable) + phone number -> "Are you a student?" -> yes: hostel block / no: nothing (the drop point is asked at checkout) -> choose an avatar -> Home.
The phone is not OTP-verified (drivers call it at the gate). Profile pictures are **not** Google photos: the user picks one of 15 built-in avatars; the server stores only `avatarId` (1..15) and every app draws the artwork itself (no image upload, no server load).

## Data per customer (`User`)
`email` (unique), `googleSub` (unique), `name`, `phone` (unique, optional until the profile step), `isStudent`, `hostelBlock`, `avatarId`, `kraveoCoins`, `fcmToken`, `createdAt`. Orders link by `customerId`.
Partners use the same table: `phone` + `passwordHash` (scrypt, salted; never returned by any endpoint). A vendor owns a restaurant through `Vendor.userId`; a driver has a `DriverPartner` row.

## Security rules
- The Google ID token is verified server-side (`google-auth-library`) against `GOOGLE_WEB_CLIENT_ID`; the email must be verified. The account is matched by Google id / email. A Google account whose email belongs to a partner/admin is refused.
- Partner login: same 401 message for unknown phone and wrong password, constant-cost hashing, 5 wrong passwords lock the phone for 15 minutes (in-memory; single PM2 instance).
- `role` can never be chosen by the caller. Partners cannot self-register. Profile updates cannot change role, email, Google id or coins.
- Logout clears the push token (JWTs are stateless, 30 days). Delete account anonymises the row (students only, blocked while an order is live).
- Database indexes were added for the order lists; `GET /orders` is paginated (`limit`, `cursor`).

## Server configuration
- `GOOGLE_WEB_CLIENT_ID` = the **Web** OAuth client id of the Firebase/Google project (from Firebase: Authentication -> Google provider, or `google-services.json` -> `oauth_client` with `client_type: 3`). Comma-separate several ids if needed. Without it `/auth/google` answers 503.
- Create partners: `POST /admin/partners`, or on the server `npm run seed:demo-partners -- /path/out.txt` (demo vendor/driver; passwords go only to that file).

## One-time Google / Firebase setup (owner)
1. Firebase console -> project `kraveo` -> Authentication -> Sign-in method -> enable **Google**.
2. Project settings -> Your apps: add three Android apps `site.kraveo.customer`, `site.kraveo.vendor`, `site.kraveo.driver` with the SHA-1 of the signing key (debug keystore SHA-1 of the build machine for now; a real release keystore is needed before Play Store).
3. Download the three new `google-services.json` and replace `apps/*/android/app/google-services.json`.
4. Google Cloud -> OAuth consent screen: add test users while the app is in "Testing".

## Known gaps
- JWT cannot be revoked before it expires (add a token version later).
- Admin-login lockout keys on `req.ip` (configure `trust proxy`).
- No push notifications yet (no Firebase client in the apps).
