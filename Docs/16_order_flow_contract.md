# Kraveo Order Flow Contract (v1, 2026-10-01)

One source of truth for the whole order lifecycle: customer app, restaurant app, rider app, backend, dashboard.
**The server is authoritative.** No app may invent an order id, a price, a status or an OTP.
Anything not stated here keeps today's behaviour (see `Docs/15_auth_v2_contract.md` for auth and partner approval).

Order of work: backend first (it defines the truth), then the apps and dashboard against this document.

---------------------------------------------------------------------------------------------------

## 1. Money and status model

### 1.1 Order status (unchanged enum) and who may move it

```
PLACED ──vendor──▶ ACCEPTED ──vendor──▶ PREPARING ──vendor──▶ READY_FOR_PICKUP ──rider──▶ PICKED_UP ──rider──▶ ARRIVED_AT_GATE ──rider+OTP──▶ DELIVERED
   │                  │                    │                       │                         │
   └──────────── CANCELLED (see 1.3) ───────┴───────────────────────┴─────────────────────────┘      (no cancel after ARRIVED_AT_GATE except admin)
```

| Transition | Allowed actor | Extra conditions |
|---|---|---|
| (create) → `PLACED`, `paymentStatus=PENDING` | STUDENT | server recomputes price; vendor APPROVED and open; items available |
| `PLACED` → `ACCEPTED` | VENDOR (owner), ADMIN | **`paymentStatus` must be `PAID`** |
| `ACCEPTED` → `PREPARING` → `READY_FOR_PICKUP` | VENDOR (owner), ADMIN | |
| `READY_FOR_PICKUP` → `PICKED_UP` | the assigned RIDER, ADMIN | order must have `driverId` |
| `PICKED_UP` → `ARRIVED_AT_GATE` | assigned RIDER, ADMIN | server generates the 4-digit OTP |
| `ARRIVED_AT_GATE` → `DELIVERED` | assigned RIDER, ADMIN | correct OTP (see 4) |
| any non-terminal → `CANCELLED` | see 1.3 | |

A rider can **not** move a status the vendor owns, and the vendor can **not** move rider statuses. Skipping a state is refused (409/400).
Terminal: `DELIVERED`, `CANCELLED`. Repeating the current status is an idempotent success.

### 1.2 Payment status and the "paid" invariant

`Order.paymentStatus`: `PENDING → PAID → REFUNDED`, or `PENDING → FAILED → PAID` (retry allowed).

- **The restaurant and riders never see, hear about or can act on an order that is not `PAID`.** (Not in lists, sockets, push, `available` pool.)
- Exactly **one** function `markOrderPaid(...)` performs the PENDING/FAILED → PAID transition. It is called by **both** `POST /payments/verify-signature` and the Razorpay webhook. It must be idempotent and race-safe (guarded update: only the caller that really flipped the row does the side effects). Side effects, once only: `Payment.status=PAID` (+ `razorpayPaymentId`), `Order.paymentStatus=PAID`, `new_order_alert` to the restaurant room, push to the restaurant, `order_updated` to the order room and admins.
- Amount check in paise: the paid amount must equal `Math.round(order.totalAmount*100)`. A mismatch is never marked paid; it is logged (audit log) for the admin.
- A payment that arrives for an order that is already `CANCELLED` (customer closed the app, order expired, vendor rejected) is **refunded automatically** and the order stays `CANCELLED`.
- Razorpay is in **test mode** (`rzp_test_`). Keep the code identical for live mode. Never log secrets or full payloads.

### 1.3 Cancellation, rejection, expiry and refunds

| Case | Who/when | Result |
|---|---|---|
| Customer cancels | STUDENT, only while `PLACED` (paid or not) | `CANCELLED`, `cancelledBy=CUSTOMER`; if paid → refund |
| Restaurant rejects | VENDOR, only while `PLACED` and paid, body `{reason}` (3–200 chars) | `CANCELLED`, `cancelledBy=VENDOR`, refund, customer sees the reason |
| Unpaid order expires | server job, `paymentStatus` ≠ PAID and age > **15 min** | `CANCELLED`, `cancelledBy=SYSTEM`, `cancelReason='Payment not completed'` |
| Restaurant never accepts | server job, `PLACED` + `PAID` and paid > **10 min** ago | `CANCELLED`, `cancelledBy=SYSTEM`, `cancelReason='Restaurant did not respond'`, refund |
| Admin cancels | ADMIN, any non-terminal state, body `{reason}` | `CANCELLED`, `cancelledBy=ADMIN`, refund if paid |
| After `ARRIVED_AT_GATE` | only ADMIN | as above |

Refund = Razorpay refund of the captured payment (full amount) → `Payment.status=REFUNDED`, `Order.paymentStatus=REFUNDED`, `razorpayRefundId` stored, an audit-log entry. A refund that fails (provider error) must **not** be lost: record `refundStatus='FAILED'` + reason, retry on the next job tick, surface it in the admin API (`GET /admin/orders/needs-attention`). Refunds are idempotent (never refund twice).

Expiry/SLA constants live in one config module and are env-overridable for tests: `PAYMENT_WINDOW_MIN=15`, `VENDOR_ACCEPT_WINDOW_MIN=10`.
The job runs every 60 s in the server process (single PM2 instance today; it must also be safe if it runs twice: guarded updates).

---------------------------------------------------------------------------------------------------

## 2. API

All JSON; errors `{ success:false, message, code? , field? }`. Auth: `Authorization: Bearer <jwt>`.
`OrderView` below is the **only** shape an order is returned in (REST *and* sockets). It is built per viewer role by one function `orderView(order, viewerRole, viewerId)`.

### 2.1 OrderView

```jsonc
{
  "id": "uuid",
  "status": "PLACED|ACCEPTED|PREPARING|READY_FOR_PICKUP|PICKED_UP|ARRIVED_AT_GATE|DELIVERED|CANCELLED",
  "paymentStatus": "PENDING|PAID|FAILED|REFUNDED",
  "totalAmount": 245.0, "deliveryFee": 25.0, "subtotal": 205.0, "taxAndPackaging": 15.0, "discount": 0.0,
  "dropoffHostel": "Block 2", "dropoffNotes": "…",
  "createdAt": "ISO", "updatedAt": "ISO", "paidAt": "ISO|null", "acceptedAt": "ISO|null", "pickedUpAt": "ISO|null", "deliveredAt": "ISO|null",
  "cancelledAt": "ISO|null", "cancelledBy": "CUSTOMER|VENDOR|ADMIN|SYSTEM|null", "cancelReason": "string|null",
  "items": [ { "id":"…", "menuItemId":"…", "name":"…", "quantity":2, "price":90.0 } ],
  "vendor": { "id":"…", "name":"…", "address":"…", "lat":0, "lng":0 },
  "customer": { "id":"…", "name":"…", "phone":"…|null", "hostelBlock":"…|null" },   // see visibility rules
  "driver":   { "id":"…", "name":"…", "phone":"…|null" } | null,                     // null until a rider claims it
  "otpCode": "4821"                                                                  // ONLY to the owning customer, ONLY while ARRIVED_AT_GATE
}
```

Visibility rules (enforced in `orderView`, covered by tests):

| Field | STUDENT (owner) | VENDOR (owner) | DRIVER (assigned) | DRIVER (browsing the pool) | ADMIN |
|---|---|---|---|---|---|
| `otpCode` | **yes, only at `ARRIVED_AT_GATE`** | never | **never** | never | yes |
| `customer.phone` | self | **never** | yes, once assigned | **never** | yes |
| `customer.name` | self | first name only | yes, once assigned | never | yes |
| `driver.phone` | yes once assigned | yes once assigned | self | – | yes |
| payment ids / Razorpay data | never | never | never | never | yes (admin API only) |

`subtotal/taxAndPackaging/discount` are derived server-side (`total = subtotal + deliveryFee + taxAndPackaging − discount`) and stored on the order so history never changes if prices change later.

### 2.2 Customer (STUDENT)

- `POST /orders` `{ vendorId, items:[{itemId,quantity}], dropoffHostel, dropoffNotes?, couponCode?, clientRequestId }` → 201 `{ data: OrderView }`.
  `clientRequestId` (uuid made by the app per checkout attempt) makes the call idempotent: same id again returns the same order (200), never a duplicate. Max **3 unpaid open orders** per customer (429/409 otherwise). `dropoffHostel` is validated against the known drop points list (server-side whitelist, same list the app shows).
- `POST /payments/create-order` `{ orderId }` (exists) → Razorpay checkout params. Only for the owner, only while order not terminal and payment not PAID.
- `POST /payments/verify-signature` (exists; uses `markOrderPaid`).
- `GET /orders?limit&cursor&scope=active|history` → paginated `OrderView[]` (own orders). `active` = non-terminal OR delivered/cancelled within the last 10 min (so the app can show the final state).
- `GET /orders/:id` → `OrderView` (own).
- `POST /orders/:id/cancel` `{ reason? }` → `OrderView` (only while `PLACED`; refund if paid).

### 2.3 Restaurant (VENDOR)

- `GET /orders?scope=active|history&limit&cursor` → only **PAID** orders of the owner's restaurant (and cancelled-after-paid ones in history).
- `PATCH /orders/:id/status` `{ status }` with `ACCEPTED | PREPARING | READY_FOR_PICKUP`.
- `POST /orders/:id/reject` `{ reason }` (see 1.3).
- Socket `vendor_<vendorId>`: `new_order_alert` (OrderView) + `order_updated`.

### 2.4 Rider (DRIVER, approved)

- `GET /orders/available` → `OrderView[]` (pool view) — orders that are `PAID`, `status ∈ {ACCEPTED, PREPARING, READY_FOR_PICKUP}`, `driverId = null`, newest-ready first, max 20. Rider must be approved; offline riders get `[]`. Pool view hides customer name/phone.
- `POST /orders/:id/accept-driver` — **atomic claim**: succeeds only if still unassigned, `PAID`, status ∈ {ACCEPTED, PREPARING, READY_FOR_PICKUP}, rider ONLINE and has no other active order (`MAX_ACTIVE_ORDERS_PER_RIDER=1`). Never changes the order status. 409 `{code:'ALREADY_TAKEN'}` if someone else got it.
- `POST /orders/:id/release` — rider gives the job back **before pickup** (`driverId=null`, back into the pool, audit entry). After `PICKED_UP` only ADMIN can reassign.
- `PATCH /orders/:id/status` `{ status }` with `PICKED_UP | ARRIVED_AT_GATE` (assigned rider only).
- `POST /orders/:id/verify-gate-otp` `{ otpCode }` → DELIVERED (see 4).
- `GET /orders?scope=active|history` → the rider's own orders.
- `POST /drivers/location` (exists) → also forwarded to the order room of the rider's **active** order(s) as `rider_location` (customer + admins only; see 3).
- `POST /drivers/duty-status` (exists).
- Sockets: room `drivers` (approved, authenticated riders): `order_available` (pool OrderView), `order_unavailable` `{id}` (claimed/cancelled/refunded).

### 2.5 Admin

- Existing endpoints stay. Add: `POST /admin/orders/:id/cancel` `{reason}` (refund if paid), `GET /admin/orders/needs-attention` (stuck/failed-refund/otp-locked/payment-mismatch orders with a `problem` code), `POST /admin/orders/:id/reset-otp-lock`.
- Existing `PATCH /orders/:id/reassign` stays (rider must be approved).

---------------------------------------------------------------------------------------------------

## 3. Realtime (Socket.io) and the polling fallback

Auth: handshake `auth: { token }` (JWT). **No token → connection refused** (today's behaviour; the customer app currently connects without one and to the wrong URL – that is a bug to fix).

| Room | Who may join (server-checked) | Events |
|---|---|---|
| `admins` | ADMIN | `order_updated`, `new_order_alert`, `driver_location_update`, `partner_application*`, `driver_duty_update` |
| `vendor_<vendorId>` | owner of that vendor | `new_order_alert`, `order_updated` |
| `drivers` | approved DRIVER (joined automatically on connect) | `order_available`, `order_unavailable` |
| `order_<orderId>` | owner customer, owning vendor, assigned rider, ADMIN | `order_updated` (per-viewer `OrderView`, see below), `rider_location` (customer + admin sockets only) |

**`order_updated` is sent per socket, using the viewer's role** (`io.in(room).fetchSockets()` then `socket.emit(...)` with `orderView(order, socket.data.user.role, socket.data.user.id)`). Never broadcast one object to a mixed room – today the OTP leaks to every room member that way.

Apps must not rely on sockets alone: **every app polls its REST list/detail every 15 s while the order screen is visible and on app resume**, merges by `updatedAt`, and treats the socket only as a speed-up. A dropped socket must be invisible to the user.

---------------------------------------------------------------------------------------------------

## 4. Gate OTP

- Generated server-side when the rider marks `ARRIVED_AT_GATE` (CSPRNG, 4 digits), stored on the order, shown **only to the customer** (REST + socket, `ARRIVED_AT_GATE` only).
- Delivery requires the rider to type what the customer tells them: `POST /orders/:id/verify-gate-otp`.
- Constant-time compare. **5 wrong attempts** per order → order flagged `otpLocked` (HTTP 423 `{code:'OTP_LOCKED'}`), shown to admins in `needs-attention`; only an admin can unlock. Wrong-attempt counter in the database (`otpAttempts`), survives restarts.
- Single use: after success the stored OTP is invalidated. The generic `PATCH status → DELIVERED` path must go through exactly the same checks (or be removed for riders). No other route may mark an order delivered for a non-admin.

---------------------------------------------------------------------------------------------------

## 5. Database changes (additive, one migration `20261002_order_flow`)

`Order`: `subtotal Float`, `taxAndPackaging Float`, `discount Float`, `clientRequestId String?` (unique with `customerId`), `paidAt`, `acceptedAt`, `pickedUpAt`, `deliveredAt`, `cancelledAt` (all `DateTime?`), `cancelledBy String?`, `cancelReason String?`, `otpAttempts Int @default(0)`, `otpLocked Boolean @default(false)`, `refundStatus String?` (`NONE|PENDING|DONE|FAILED`), `refundError String?`.
`Payment`: `razorpayRefundId String?`, `refundedAt DateTime?`, `capturedAmountPaise Int?`.
Indexes for the new queries (pool: `[status, driverId, paymentStatus]`; expiry job: `[paymentStatus, createdAt]`). Existing rows get sensible defaults (`subtotal = totalAmount − deliveryFee − 15`, floor 0).
The migration must be rehearsed on a copy of the production dump (see `Docs/` notes in the commit history for how it was done on 2026-10-01).

---------------------------------------------------------------------------------------------------

## 6. App behaviour (all three apps)

Shared: remove every hardcoded/sample/simulated order, id, OTP, timer-driven status progression. Show real empty states. Handle: offline, 401 (login), 403 `PARTNER_NOT_APPROVED`, 409 conflicts, 429, server errors — each with a clear message and no stuck spinner. Never keep a spinner forever: every network call has a timeout and the screen recovers.

### Customer app
1. Cart → checkout: `POST /orders` (with a fresh `clientRequestId`) → get the **server** totals and show them (the local estimate is only a preview; if it differs, show the server's numbers before paying).
2. Payment: `create-order` → Razorpay → on success `verify-signature` → go to tracking. Payment failure/cancel: order stays `PENDING`; show "Payment not completed – try again" with retry on the **same** order and a visible expiry hint (15 min). Back-navigation never creates a second order (idempotency key).
3. Tracking: real `GET /orders/:id` + socket (with token, correct URL `ApiConfig.socketUrl`) + 15 s polling. The OTP shown is the server's, only when `ARRIVED_AT_GATE`. Rider name/phone and live rider position when available. Cancel button only while `PLACED`.
4. On app start / login: restore any active order from `GET /orders?scope=active`. History from `GET /orders?scope=history` (paginated). Remove the fake seeded history. Review flow only for real `DELIVERED` orders.
5. Cancelled/refunded: clear message including the reason and "refund will reach your account in 5–7 working days" wording only when `paymentStatus=REFUNDED`.

### Restaurant app
Real vendor id from the session. Queue from `GET /orders?scope=active` + `new_order_alert` + 15 s polling; new order → alarm + accept/reject dialog (existing UX). Accept → `ACCEPTED`; then Preparing → Ready. Reject needs a reason (quick picks). Show countdown for the 10-minute accept window. Orders never disappear locally unless the server says so. Closing the store does not touch live orders.

### Rider app
Real "offers" from `GET /orders/available` + `order_available` / `order_unavailable` + polling, only while ON DUTY. Accept → atomic claim (handle `ALREADY_TAKEN` gracefully). Active delivery screen driven by the order's real status: go to restaurant → wait for READY (poll) → **Picked up** → **Arrived at gate** (customer phone becomes visible) → enter the OTP the customer tells you → delivered. GPS posts every ~10 s while on duty, always real GPS (remove the fake campus-coordinates fallback or mark location as stale/unavailable instead of faking it). "Release job" before pickup. Earnings/history from real delivered orders (not hardcoded).

### Dashboard
Orders table shows payment status, cancel-by/reason, refund status; admin Cancel (with reason, refunds) and the needs-attention list; live updates use the same `OrderView`.

---------------------------------------------------------------------------------------------------

## 7. Failure modes that must be handled (each one needs a test)

1. Webhook before verify, verify before webhook, duplicate webhooks, concurrent webhook + verify: exactly one set of side effects.
2. Webhook/verify with a wrong amount, unknown order id, order of another customer, forged signature.
3. Payment captured after cancel/expiry → automatic refund, order stays cancelled.
4. Customer double-taps "Pay"/"Place order", loses network mid-checkout, kills the app after paying.
5. Vendor never responds; vendor rejects; vendor accepts an unpaid order (must fail); vendor accepts twice.
6. Two riders claim at the same moment; rider claims an unpaid / cancelled / already-claimed order; rider with an active order claims another; offline or suspended rider claims; rider releases then another claims.
7. Rider tries to deliver without OTP, with a wrong OTP ×5 (lock), replays a used OTP, fetches the OTP over REST or socket (must never see it).
8. Customer cancels after the vendor accepted (refused); cancels twice; cancels someone else's order.
9. Admin cancels in each state (refund exactly once).
10. Refund provider outage → order stays flagged `refundStatus=FAILED`, retried later, visible to admin.
11. Vendor suspended mid-order, rider suspended mid-delivery: existing orders stay readable and the admin can reassign/cancel.
12. Every endpoint: unauthenticated → 401, wrong role → 403, someone else's order → 404/403 (no existence leak), malformed ids/bodies → 400, never 500.
13. Race: expiry job vs. late payment; expiry job vs. vendor acceptance; job running twice.
14. Clock/time: all server timestamps UTC; SLA windows measured on the server only.
