# Kraveo Auth & Account Pipeline (v1, 2026-09-30)

## 1. Who can sign in and how
| Actor | How the account is created | Login |
|---|---|---|
| Student (customer app) | Self-registers with phone + OTP | Phone OTP |
| Restaurant partner (vendor app) | Created by Kraveo ops (admin dashboard / DB) | Phone OTP, role VENDOR |
| Delivery partner (driver app) | Created by Kraveo ops | Phone OTP, role DRIVER |
| Admin (dashboard) | `ADMIN_PASSCODE` on the server | Passcode (no phone flow) |

**Rule:** a phone number can only ever self-register as STUDENT. `role` in the request is only used to check that the caller is using the right app; an unknown number asking for VENDOR/DRIVER/ADMIN gets 403 and no row is created. (Before this change any caller could register as ADMIN.)

## 2. Student journey
1. **Enter phone** (10 digits, starts 6-9) -> `POST /auth/send-otp`.
2. **Enter 4-digit code** -> `POST /auth/verify-otp`. Response: `token` (JWT, 30 days), `user`, `isNewUser`, `needsProfile`.
3. **First time only - "Almost there"**: full name + drop point (hostel block/gate) -> `PUT /auth/profile`. Cannot be skipped (`needsProfile` stays true while the name is the placeholder "VIT Student").
4. **Me tab**: name, masked phone, coins, drop point (editable), Log out, Delete account.
5. **Logout**: `POST /auth/logout` (clears the push token) + delete the token on the phone.
6. **Delete account**: `DELETE /auth/account`. Blocked (409) while an order is in progress. Otherwise the row is anonymised (name "Deleted user", phone `deleted:<id>`), orders/payments keep their foreign key. The same number can sign up again as a fresh account.

## 3. What we store per student (table `User`)
`phone` (unique, `+91 XXXXXXXXXX`), `name`, `hostelBlock`, `kraveoCoins`, `role`, `fcmToken` (push, set by the app later), `upiId` (optional), `createdAt`. Nothing else is collected in v1 on purpose (fewer fields = more completed sign-ups). Candidates for later (needs a migration): VIT registration number, VIT email.
Orders live in `Order`/`OrderItem`/`Payment`, linked to the user by `customerId`.

## 4. OTP rules (`backend/src/services/otpService.ts`)
- 4-digit code, 5 min validity, stored **in server memory** (single PM2 instance; move to Postgres/Redis before clustering).
- Resend cooldown 30 s; max 5 codes per number per hour; global cap 400 codes/hour (protects the SMS bill).
- 5 wrong guesses lock the number for 15 min. Requesting a new code does **not** reset the counter.
- Numbers are normalised (`98765 43210`, `+919876543210`, `09876543210` all map to `+91 9876543210`); existing accounts stored as `+91 XXXXXXXXXX` are matched on their last 10 digits.
- Phone numbers are masked in responses and logs; the SMS body is logged only outside production.

## 5. Is OTP "live"? (honest status)
- **Code path: yes. Real SMS: no** until an SMS provider key is set on the server.
- In `NODE_ENV=production` with no provider, `send-otp` now returns **503** ("couldn't send the code") instead of pretending success. Previously it only printed the code in `pm2 logs`.
- Provider options (see `smsService.ts`): Fast2SMS `FAST2SMS_API_KEY` with `FAST2SMS_ROUTE=q` (Quick SMS, no DLT, about Rs 5/SMS) or `otp` (service route, cheaper, fixed templates) - confirm current rates/limits on Fast2SMS before relying on them; MSG91 / Twilio need DLT/sender setup. Nothing was tested against a real provider.

## 6. Demo mode (for live demos before SMS exists)
Off by default. On the server `.env`:
```
DEMO_MODE=true
DEMO_LOGIN_PHONES=9000000021,9000000022
DEMO_LOGIN_OTP=2468        # optional, default 1234
```
Only the listed numbers skip SMS and accept the fixed code. Every other number behaves normally. The server prints a warning at startup while it is on. **Turn it off after the demo.**

## 7. Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /auth/send-otp | 200, 400 bad number, 429 cooldown/limit (`retryAfterSeconds`), 503 SMS down |
| POST | /auth/verify-otp | 200, 400 wrong/expired (`attemptsLeft`), 429 locked, 403 wrong app/role |
| GET | /auth/profile | `{user, needsProfile}` (never returns `fcmToken`) |
| PUT | /auth/profile | validates `name` (2-60 letters), `hostelBlock` (campus list), `upiId`; ignores role/coins/phone |
| POST | /auth/logout | clears `fcmToken` |
| DELETE | /auth/account | students only, 409 if order in progress |

## 8. Known gaps
- JWT is stateless for 30 days: logout cannot revoke a stolen token (add a token version later).
- Admin-login rate limit keys on `req.ip`; behind Nginx/Vercel every caller may share one IP (`trust proxy` not configured).
- Push tokens are not sent by any app yet (no Firebase client), so `fcmToken` stays empty.
