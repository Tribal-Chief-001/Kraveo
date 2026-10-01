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
`POST /auth/admin-login` (unchanged). `GET /admin/partners` lists partner accounts (with `approvalStatus`).

## Partner approval (added 2026-10-01)
Restaurants and riders can create their own account in the app; an admin approves it in the dashboard.
Accounts created by an admin are approved straight away. `approvalStatus` is `PENDING | APPROVED | REJECTED | SUSPENDED`
(accounts that existed before this feature are `APPROVED`).

### Partner side
- `POST /auth/partner-signup` `{ role:'VENDOR'|'DRIVER', name, phone, password, ... }` -> 201 `{ token, approvalStatus:'PENDING', user, vendor? | driver? }`
  - VENDOR extras: `restaurantName`*, `address`*, `category`, `fssaiNumber` (14 digits, optional).
  - DRIVER extras: `vehicleType`* (`Bike|Scooter|Cycle|On foot`), `vehicleRegNo` (required unless Cycle/On foot), `emergencyPhone`, `upiId`.
  - 400 `{ field, message }`, 409 `{ field:'phone' }` (number already has an account), 429 (3 tries per phone per hour, 80 per hour overall).
  - The new restaurant starts closed (`isAcceptingOrders:false`). The rider gets a `runnerCode`. Riders are not VIT students: there is no student registration number.
- `GET /partner/me` -> `{ user, approvalStatus, rejectionReason, vendor? | driver? }`. The apps poll this while pending.
- `PUT /partner/application` (only while `PENDING` or `REJECTED`) same fields as sign-up minus phone/password -> sets `PENDING` again.
- `POST /auth/partner-login` now also returns `approvalStatus` and `rejectionReason`. Pending, rejected and suspended partners **can** log in (so the app can show where they stand).
- Everything a partner does in the field returns **403 `{ code:'PARTNER_NOT_APPROVED', approvalStatus, message }`** until approved: store toggles, menu edits, order status changes, accepting an order, sharing location, verifying the gate OTP.
- Customers only see `APPROVED` restaurants (`GET /vendors`, `/vendors/:id`, `/menus/:id`); `POST /orders` refuses others. Admins and the owner still see their own.

### Admin side (ADMIN token)
- `GET /admin/applications?status=PENDING|APPROVED|REJECTED|SUSPENDED|ALL&kind=VENDOR|DRIVER` -> `{ counts, data:[{ id, kind, userId, name, phone, status, rejectionReason, selfSignup, appliedAt, vendor? | driver? }] }`
- `POST /admin/partners/:kind/:id/status` `{ status:'APPROVED'|'REJECTED'|'SUSPENDED', reason? }` (`kind` = `vendor|driver`; a reason is required for REJECTED and SUSPENDED; REJECTED only from PENDING; SUSPENDED only from APPROVED; suspending closes a restaurant / puts a rider offline).
- `POST /admin/partners` `{ role, name, phone, password, ...fields }` creates an approved partner. VENDOR with `restaurantName` creates the restaurant too (or pass `vendorId` to link an existing one). Returns `profileId`.
- `POST /admin/partners/:userId/reset-password` `{ password }` (no SMS reset exists, so a partner who forgets asks the admin).
- `GET /admin/audit-log` the latest admin actions (approvals, suspensions, resets, creations).
- `GET /admin/customers?search=&limit=&cursor=` -> `{ total, nextCursor, data:[{ ...profile, ordersCount, totalSpent, lastOrderAt }] }` (deleted accounts hidden unless `includeDeleted=1`).
- `GET /admin/customers/:id` -> profile, `stats`, and the latest 30 orders with items, rider and payment ids.
- Socket events to the `admins` room: `partner_application` (new or re-sent application) and `partner_application_updated`.
