# Multi-restaurant orders (order groups) - contract (7 Oct 2026)

Binding for backend, dashboard, customer app, restaurant app, rider app. Builds on Docs/16 (order flow), Docs/18 (push), Docs/21 (pricing, settlement).
Owner decisions (settled): a customer can order from several nearby restaurants in ONE checkout, ONE payment, ONE rider, ONE gate handover. Each extra restaurant adds a flat fee (default Rs 15, admin setting `fees.extraRestaurantFee`). It takes longer; that is accepted. Maximum restaurants per order is an admin setting (`fees.maxRestaurantsPerOrder`, default 3, allowed 1..5; 1 switches the feature off). Whole order is cancelled and fully refunded if ANY restaurant cannot or does not accept (partial refunds are out of scope).

## 0. Design in one paragraph (why it is safe)

A group is an `OrderGroup` row plus N ordinary child `Order` rows (one per restaurant, `groupId` set, `groupIndex` 0..N-1). Every child is a normal order for its restaurant: same state machine, vendor view, settlement, finance, push. The existing single-restaurant path (`POST /orders`) is NOT changed in behaviour. The customer pays ONCE: the Razorpay `Payment` row belongs to the PRIMARY child (`groupIndex = 0`) and its amount is the GROUP total. Money code that used `order.totalAmount` for "what the customer pays for this payment" uses ONE helper `payableAmount(order)` instead (= group total for the primary child of a group, = totalAmount for every other order). Refund code needs no change except marking the siblings when the primary's refund completes. All group-level transitions (paid, cancel, claim, release, arrive, deliver) are done in ONE transaction that locks the group row first and then the children in id order.

## 1. Data model (additive migration `20261011_order_groups`, no backfill needed)

`OrderGroup`: `id`, `customerId`, `clientRequestId` (unique per customer), `dropoffHostel`, `dropoffNotes?`, `couponCode?`, `discount Float`, `subtotal Float` (food, customer prices), `feeTotal Float` (all fees), `totalAmount Float` (= subtotal + feeTotal - discount, what the customer pays), `restaurantCount Int`, `feeBreakdown Json?`, `createdAt`. Relation `customer`, `orders Order[]`.
`Order`: `groupId String?` (FK to OrderGroup, ON DELETE SET NULL is NOT used: RESTRICT; groups are never deleted), `groupIndex Int?` (0 = primary = the child that carries the payment and the base fee). Index on `groupId`. Unique (`groupId`, `groupIndex`).
Child money (so settlement and finance keep working per child, sums are exact in paise):
- `subtotal`, `vendorSubtotal`, `commissionTotal`: the child's own food as today.
- `deliveryFee`: child 0 = base fee part (after free/small-order rules computed on the COMBINED subtotal), every other child = `extraRestaurantFee`. `taxAndPackaging` = 0.
- `discount`: the group's coupon discount split across children proportional to child subtotal, in paise, largest-remainder so the parts add up exactly; `couponCode` only on child 0 (single-use rules count it once).
- `totalAmount` = child subtotal + child fee - child discount (the child's true share). Sum of children `totalAmount` == `OrderGroup.totalAmount` exactly (paise integers, assert in code and tests).
- `Payment.amount` of the group payment = `OrderGroup.totalAmount`; `Payment.orderId` = child 0.

## 2. The one money helper

`payableAmount(order)`: if `order.groupId` and `order.groupIndex === 0` -> the group's `totalAmount`; else `order.totalAmount`. Every place in payment code that computes expected/charged paise from `order.totalAmount` must use it (known places: `createPaymentForOrder`, `markOrderPaid` expectedPaise, `paymentReconcile` expected x2, `orderMaintenance` duplicate-payment check, `routes/orders.ts` ~464, `push/events.ts` refund amount). Grep `totalAmount` again at the end; every remaining use must be deliberate (display, finance, settlement). A sibling (`groupIndex > 0`) can never be paid on its own: `POST /payments/create-order` for it answers 409 `PAY_VIA_GROUP` (the app uses the primary id, returned as `payOrderId`).

## 3. Locking rule (deadlock freedom)

Every mutation of a grouped order first locks `OrderGroup` row `FOR UPDATE`, then the order rows it needs `FOR UPDATE` in ascending id order (rider row before orders, as today). Implement inside `withOrderLock`: read `groupId` (immutable) without lock; if set, lock the group first, then the order; group-level helpers (`lockGroup(tx, groupId)` returns the children, locked, sorted by id). Single orders keep the exact current locking. Document this in code. No code path may lock a child before its group.

## 4. API

### 4.1 Quote (new, also fixes the "app guesses the fee" limitation)
`POST /api/orders/quote` (STUDENT) `{ restaurants: [{ vendorId, items:[{itemId,quantity}] }], couponCode? }` (1..max restaurants; one entry = a normal single order quote) -> `{ success, data: { restaurantCount, subtotal, fees: { total, base, extraRestaurants, extraRestaurantFee, lines? }, discount, couponCode, total, perRestaurant:[{ vendorId, vendorName, subtotal, fee }], maxRestaurants } }`. Writes nothing, rate limited, same validation as placing (vendors open and approved, items valid, coupon eligibility reported as a clear error). The total MUST equal what placing the same cart would charge (test this property across random carts).
`GET /api/pricing/config` is NOT added: the quote is the source of truth.

### 4.2 Place a group
`POST /api/order-groups` (STUDENT) `{ restaurants:[{vendorId, items:[{itemId,quantity}]}], dropoffHostel, dropoffNotes?, couponCode?, clientRequestId }`.
- 2..`maxRestaurantsPerOrder` DISTINCT vendors (1 -> 400 `USE_SINGLE_ORDER`, more than max -> 400 `TOO_MANY_RESTAURANTS`, feature off -> 400 `MULTI_DISABLED`); every vendor approved and accepting orders, every item valid, same drop point whitelist, same coupon rules (min subtotal on the COMBINED food subtotal, VITFIRST only for a first order).
- Idempotent by `clientRequestId` exactly like `POST /orders` (same id + same content -> 200 replay; same id + different content -> 409 `CLIENT_REQUEST_MISMATCH`); child orders get derived request ids `g:<clientRequestId>:<index>` so the existing unique (customerId, clientRequestId) keeps holding and cannot collide with single orders.
- One transaction: lock the customer row (as today), replace abandoned unpaid checkouts (the customer's own stale unpaid single orders at these vendors AND stale unpaid groups containing these vendors, using the existing `isAbandonedCheckout` rules, cancelled as WHOLE groups), unpaid-limit counts a group as ONE open order (`MAX_UNPAID_OPEN_ORDERS` counts distinct `COALESCE(groupId, id)`), create the group and all children with the money split of section 1.
- Pricing: refactor `validateAndCalculateOrder` (utils/validation.ts) into reusable parts WITHOUT changing any single-order result (all existing tests must stay green): per-restaurant item validation + commission snapshot, then one group-level fee calculation (`computeFees` already knows `extraRestaurantFee`; free-fee-above and small-order rules apply to the COMBINED food subtotal), coupon on the combined subtotal.
- 201 `{ success, data: GroupView }`, `GroupView = { id, status, paymentStatus, total, subtotal, feeTotal, discount, couponCode, restaurantCount, dropoffHostel, dropoffNotes, createdAt, payOrderId, orders: OrderView[] (viewer-specific, ordered by groupIndex) }`.
- `GET /api/order-groups/:id` (owner STUDENT, ADMIN; a VENDOR/DRIVER gets 404 here, they use the order endpoints) -> same `GroupView`. `GET /api/order-groups?scope=active|history` (owner) optional but include if cheap.
- Group `status` (derived, not stored): CANCELLED if every child is cancelled; DELIVERED if every child delivered; otherwise the status of the LEAST advanced non-cancelled child, with `AWAITING_RESTAURANTS` while any child is PLACED. `paymentStatus` = primary child's.

### 4.3 Payment
Unchanged endpoints (`POST /payments/create-order {orderId}` with the PRIMARY id, `POST /payments/verify-signature`, webhook, reconcile). Behaviour change only through `payableAmount` and the cascade:
- `markOrderPaid` on the primary: in the SAME transaction (group locked, children locked in id order) flip the primary AND all siblings `paymentStatus -> PAID`, `paidAt = now`; side effects (`new_order_alert`, push to each restaurant, sockets) for EVERY child, once, only by the caller that flipped it. If the group is already cancelled (any child CANCELLED) the payment is recorded and refunded (existing LATE_PAYMENT_REFUND path; primary carries `refundStatus=PENDING`; siblings stay cancelled).
- Amount mismatch / duplicate payment / unknown payment paths: unchanged semantics, evaluated against `payableAmount`.
- Refund: only the primary has `refundStatus` and a Payment row; siblings NEVER get `refundStatus = PENDING` (the refund worker would fail on a payment-less order). When the primary's refund completes (`recordSuccess`), in the same transaction set every sibling `paymentStatus = REFUNDED`; the refund push goes once to the customer. Refund amount = the group payment's captured amount (full).
- Failed refunds stay visible in `needs-attention` through the primary; the problem text mentions the group and its restaurants.

### 4.4 Cancellation (all paths cascade)
Every cancel path (customer cancel, restaurant reject, admin cancel, system expiry: unpaid 15 min, restaurant did not respond 10 min, "replaced by a newer order") on ANY child cancels the WHOLE group in one transaction: all non-terminal children -> `CANCELLED`, `cancelledAt` now; the child that triggered it keeps the real `cancelledBy` and reason; siblings get `cancelledBy = SYSTEM` and reason `Another restaurant in your order could not take it: <reason>` (<= 200 chars). A refund is needed iff the group is paid -> only the primary gets `refundStatus = PENDING` (once). Rules per actor (the same as today, applied to the group):
- Customer: allowed only while EVERY child is `PLACED` (else 409 `CANNOT_CANCEL`, text unchanged).
- Restaurant reject: only its own child while `PLACED` and paid (as today); the cascade does the rest. Restaurants whose child was already ACCEPTED/PREPARING get the normal cancelled-order push/socket ("Cancelled: another restaurant could not take this order").
- Admin: any state except DELIVERED; whole group.
- Idempotent (cancelling an already cancelled group is a no-op success), race safe (group lock), audit rows: one `ORDER_GROUP_CANCELLED` for the group plus the normal per-order rows.
- A cancelled sibling is not refunded separately and never double refunded (one payment, one refund).

### 4.5 Restaurant side (a child is an ordinary order)
- `ACCEPTED -> PREPARING` for a grouped child is allowed only when EVERY sibling is at least `ACCEPTED` and none is cancelled (so nobody starts cooking while another restaurant may still reject). Otherwise 409 `GROUP_WAITING` with the plain message "Waiting for the other restaurant(s) in this combined order to accept." Everything else about vendor transitions is unchanged.
- Vendor `OrderView` gains `group: { size, allAccepted }` (no other restaurant's name, no totals, no customer price: the visibility rules of Docs/21 stay). Vendor earnings, settlement, "You earn" are per child as today.
- The restaurant accept timeout (10 min) is per child; one timeout cancels the group.

### 4.6 Rider side (same endpoints, group aware)
- `OrderView.group` for DRIVER (assigned) and ADMIN and STUDENT: `{ id, index, size, primary, stops:[{ orderId, index, status, vendor:{name,address,lat,lng}, itemCount }] }` (customer name/phone rules unchanged).
- Pool (`GET /orders/available`): grouped children are returned only when the request carries `?groups=1` (new rider app); old app builds never see them. One entry per group (the primary child's pool OrderView + `group`), and the group is pool-eligible only when EVERY child is `PAID`, `ACCEPTED`/`PREPARING`/`READY_FOR_PICKUP`, none cancelled, none assigned. Sockets: `order_available` once per group when the last child becomes eligible, `order_unavailable` for the primary id when claimed/cancelled. Push `NEW_DELIVERY_AVAILABLE`-style event once per group.
- `POST /orders/:id/accept-driver` with any child id of a group: atomic claim of ALL children (all-or-nothing, rider locked first, `MAX_ACTIVE_ORDERS_PER_RIDER` counts the group as one active delivery, i.e. count distinct `COALESCE(groupId,id)` of the rider's active orders). 409 `ALREADY_TAKEN` as today.
- `POST /orders/:id/release`: releases the whole group, only while NO child is `PICKED_UP`.
- `PATCH /orders/:id/status`: `PICKED_UP` is per child (only when that child is `READY_FOR_PICKUP`, as today). `ARRIVED_AT_GATE` for any child of a group is a GROUP action: allowed only when EVERY child is `PICKED_UP`; it moves all children to `ARRIVED_AT_GATE` and writes ONE new OTP identical on all children; the customer push `RIDER_AT_GATE` is sent once (only for the primary child). Nobody can move a grouped child to `ARRIVED_AT_GATE` or `DELIVERED` individually.
- `POST /orders/:id/verify-gate-otp` on any child of a group verifies the group OTP and delivers ALL children atomically (each gets `deliveredAt`, `otpCode='USED'`, its own `otpProof`); wrong attempts and the 5-attempt lock apply to the whole group (counter and lock mirrored on all children, so `reset-otp-lock` on any child resets the group). Retry of the same correct code after delivery -> idempotent success as today. Customer push `ORDER_DELIVERED` once.
- `POST /admin/orders/:id/reassign`: moves the whole group; the target rider must have no other active delivery (the group's own children are excluded from the count); unassign refused once any child is picked up.
- `refreshRiderDuty`: rider is IN_TRANSIT while carrying any active child.
- Rider location forwarding already loops over the rider's active orders; make sure it still reaches every child's order room.
- `finance /riders` and by-day delivery counts: one delivery per group (`COUNT(DISTINCT COALESCE("groupId", id))`).

### 4.7 Admin
- Orders list/detail: `OrderView.group` is included; admin can open the group via `GET /order-groups/:id`. `POST /admin/orders/:id/cancel` cancels the whole group (the response says how many orders). Needs-attention items for a group child carry `groupId`.
- Settings: `fees.maxRestaurantsPerOrder` (integer 1..5, default 3) added to the validated `fees` group (backwards compatible default when missing); `extraRestaurantFee` allowed range 0..200.
- Settlement, commission, finance revenue: per child, unchanged (the group fee parts are the children's `deliveryFee`, so `feesCollected` stays correct; `customerPaid` sums to the group total).

### 4.8 Push (Docs/18 additions, all idempotent per order+event)
Restaurant events unchanged per child. Customer: at most ONE push per group for PICKED_UP-all/at-gate, delivered, cancelled and refund processed (sent from the primary child; per-child "restaurant accepted" pushes may name the restaurant). Riders: one new-delivery push per group. No push ever carries the OTP.

## 5. Customer app (Kraveo)

- Cart holds several restaurants (grouped by restaurant, per-restaurant subtotal, remove/clear per restaurant). Adding from a different restaurant no longer wipes the cart; at the max restaurants a clear message explains it (`maxRestaurants` comes from the quote; before the first quote assume 3). One restaurant in the cart -> the existing `POST /orders` flow, byte-for-byte as today. Two or more -> `POST /order-groups`.
- Checkout bill from `POST /orders/quote` (debounced, shown while loading as the local estimate marked "estimate"): items subtotal, "Delivery & service fee", "Extra restaurant fee (x N)" line, coupon, total; the pay button shows the server total; the existing "Updated total" notice remains the safety net. This also replaces the hard-coded Rs 25 estimate for single orders.
- Payment: opens Razorpay for the PRIMARY order id (`payOrderId`), amount = group total; same retry/cancel/expired handling as today, but cancelling/expiry applies to the whole group (copy: "This cancels your whole order").
- Tracking: one screen for the group: a row per restaurant with its status chip, ONE rider card, ONE OTP card at the gate, ONE total; history shows ONE card per group (merge by `group.id`; a lone old child without `group` stays as today). Cancel button only while every restaurant is still PLACED. Sockets: join each child's order room.
- Works against old servers? No: groups need the new server; with `maxRestaurants` 1 or a 404 on quote/groups the app falls back to single-restaurant behaviour.

## 6. Rider app (Delivery Partner)
- Pool card: "2 restaurants" badge, the stop names, total distance hint as today; accept claims the group.
- Active delivery: stop list (restaurant, address, items, status); "Picked up" per stop enabled when that stop is `READY_FOR_PICKUP` (shows "Waiting for kitchen" otherwise); after all stops are picked up the existing "Arrived at gate" and OTP steps run ONCE for the group. Release is offered only before the first pickup. Map shows all stop pins + the drop point. Sends `?groups=1`.
- Old single-order screens/behaviour unchanged.

## 7. Restaurant app
Order card for a grouped child: small note "Combined order - waiting for the other restaurant(s)" and the "Start cooking" button disabled while `group.allAccepted` is false (server also refuses with `GROUP_WAITING`); a cancelled child shows the server cancel reason. No other change.

## 8. Dashboard
Orders: "Group of N" badge, sibling list with statuses and links, group total, cancel-whole-group confirm text. Settings: `maxRestaurantsPerOrder` and `extraRestaurantFee` fields with the plain explanation. Finance: nothing new (per child). Needs-attention shows the group.

## 9. Rules for every part (same as Docs/21 section 9 plus)
- NO behaviour change for single-restaurant orders: all existing backend (816), dashboard (428), customer (322), vendor (459), driver (347) tests keep passing unchanged except where this document says a rule changes (list each).
- Money in paise integers, the sum of child parts equals the group total exactly (property test with random carts, discounts, 2..5 restaurants).
- Tests with real Postgres for: placing (validation, idempotency, mismatch, limits, abandoned replace, coupon rules), quote == charge, payment (paid cascade, mismatch, duplicate, late payment after cancel, webhook + verify race, reconcile), refund (once, retry after provider failure, siblings marked), every cancel path + cascade + races (reject vs customer cancel vs expiry vs payment arrival at the same time), vendor GROUP_WAITING, pool visibility (old vs new riders), atomic claim race between two riders, release, per-stop pickup, arrive-needs-all-picked, OTP wrong/lock/retry/reset, admin reassign/cancel, push dedupe, finance/settlement per child with a group fixture, rider delivery counts, vendor visibility (no other restaurant data, no customer price), deadlock test (parallel mixed operations on one group never hang).
- Deploy order: backend (migration additive) first; old apps keep working (they never create groups; old riders never see groups; old customer apps may display children as separate orders, which is acceptable); then dashboard; then the new APKs.
