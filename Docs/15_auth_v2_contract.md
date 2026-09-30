# Auth v2 contract (Google for students, phone + password for partners)

Base URL: `https://api.kraveo.site/api` (socket: `https://api.kraveo.site`). All JSON. Protected routes use `Authorization: Bearer <jwt>`.
Phone OTP / SMS login is REMOVED (`/auth/send-otp`, `/auth/verify-otp` no longer exist).

## User object (same everywhere)
```
user: { id, name, email|null, phone|null, role: 'STUDENT'|'VENDOR'|'DRIVER'|'ADMIN',
        isStudent: bool|null, hostelBlock: string|null, avatarId: int|null, kraveoCoins: int }
```

## Student (customer app) - Google Sign-In
`POST /auth/google` `{ idToken }`  (idToken = Google ID token from the google_sign_in plugin)
- 200 `{ success, token, user, isNewUser, needsProfile }`
- 401 `{ success:false, message }` token invalid / wrong audience / email not verified
- 403 `{ success:false, message }` this Google email belongs to a partner/admin account

`GET /auth/profile` -> 200 `{ success, user, needsProfile }` (401 when the token is expired)

`PUT /auth/profile` `{ name?, phone?, isStudent?, hostelBlock?, avatarId? }` -> 200 `{ success, user, needsProfile }`, 400 `{ success:false, message, field }`
- name: 2-60 letters/space/.'- ; phone: 10-digit Indian mobile starting 6-9 (app may send `+91`/spaces; server normalises to `+91 XXXXXXXXXX`);
  avatarId: 1..15; isStudent: true/false; hostelBlock: one of the campus drop points (`Block 1`..`Block 6`, `Girls Gate 1`, `Girls Gate 2`, `VIT Main Gate`), only accepted when isStudent=true (cleared when false).
- `needsProfile` = STUDENT and ( real name missing OR phone missing OR avatarId missing OR isStudent is null OR (isStudent and hostelBlock missing) ).
- Sign-up order in the app: Google -> name + phone -> "are you a student?" (yes: hostel block; no: skip, delivery point is asked at checkout) -> avatar -> Home.

`POST /auth/logout` -> 200 (clears push token). `DELETE /auth/account` (students) -> 200, 409 when an order is in progress.

## Partners (vendor and driver apps) - phone + password
Accounts are created by Kraveo (admin). No self sign-up.
`POST /auth/partner-login` `{ phone, password, role:'VENDOR'|'DRIVER' }`
- 200 `{ success, token, user:{id,name,phone,role,avatarId}, vendor?:{id,name,isAcceptingOrders}, driver?:{id,runnerCode} }`
- 401 `{ success:false, message:'Wrong phone or password.' }` (identical for unknown phone and wrong password)
- 403 `{ success:false, message }` account exists but with a different role
- 429 `{ success:false, message, retryAfterSeconds }` 5 wrong passwords lock that phone for 15 minutes
`POST /auth/logout` works for partners too. The token lasts 30 days; on any 401 the app must return to its login screen.

## Admin
`POST /auth/admin-login` (unchanged). `POST /admin/partners` `{ role, name, phone, password, vendorId? }` creates a partner; `GET /admin/partners` lists them.
