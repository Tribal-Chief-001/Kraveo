# Adversarial review: multi-restaurant order groups (commit 2586e4d, Docs/22)

Reviewer: read-only line-by-line review (no jest/build run). Scope read in full: orderGroups.ts, groupLock.ts, orderFlow.ts, orderView.ts,
orderMaintenance.ts, paymentReconcile.ts, refundService.ts, routes/orders.ts (+ payments/webhook/needs-attention), push/events.ts + pushService.ts,
realtime.ts, finance.ts, validation.ts, pricing.ts, settings.ts, settlement.ts locking, api.ts (review/delete-account order writers), migration + schema, test titles.

## Verdict

No BLOCKER and no HIGH found. I could not construct a trace in which a customer pays less than the group total, a paid group is cancelled without
exactly one refund, a sibling carries refundStatus, a child is locked before its group, or a vendor/driver/other student reads data they must not.
Findings below are MEDIUM/LOW hardening, ops and test-gap items. Several of the agent's "open risks" are actually safe (see section "Checked and OK").

## Summary table

| # | Sev | Status | Area | One line |
|---|-----|--------|------|----------|
| 1 | MEDIUM | CONFIRMED | rider/ops | Admin reassign (and pool push) can hand a group to a rider whose app does not know groups; no capability gate |
| 2 | MEDIUM | CONFIRMED | restaurant flow | Nobody is pushed when the LAST restaurant accepts: already-accepted kitchens learn "you may cook" only by socket/polling |
| 3 | LOW | CONFIRMED | pricing/settings | Lowering `extraRestaurantFee` max 500 -> 200 makes a stored fees row > 200 invalid, and the WHOLE fees group silently falls back to defaults |
| 4 | LOW | CONFIRMED | abuse | Review route pays 10 coins and moves the rider rating once per CHILD: 5x per delivery of a 5-restaurant group |
| 5 | LOW | CONFIRMED | privacy | Sibling cancel reason embeds the rejecting restaurant's / admin's free text; other restaurants and their staff read it |
| 6 | LOW | CONFIRMED | push | `NEW_DELIVERY` for a group goes to every idle rider including old rider apps (they see nothing in the pool; nuisance only) |
| 7 | LOW | CONFIRMED | locking | Locks are taken before the authorisation check, now on group + N rows (lock-contention DoS by any logged-in user who knows an id) |
| 8 | LOW | SUSPECTED | locking | Review route locks a child row without the group row (violates the stated rule); exotic deadlock with claim of a delivered group |
| 9 | LOW | CONFIRMED | realtime | `MAX_ORDER_ROOMS_PER_SOCKET = 10` is now reachable by two 5-restaurant groups; oldest child rooms silently dropped |
| 10 | LOW | CONFIRMED | robustness | Cancel by customer/admin/vendor returns "already cancelled, no-op" based on the NAMED child only; a partial group (manual DB edit) can never be repaired through the API |
| 11 | LOW | CONFIRMED | ops/needs-attention | `DELIVERY_OVERDUE` for a group uses the primary's `pickedUpAt`; a rider waiting for the 2nd kitchen raises it falsely |
| 12 | INFO | CONFIRMED | agent's open risk | Settlement `FOR UPDATE` vs group transaction deadlock: cannot form a cycle (one child per restaurant per group). Not a risk |
| 13 | INFO | - | tests | Test gaps list at the end |

## Findings

### 1. MEDIUM: group can reach a rider app that cannot handle it
- Where: `orderFlow.ts:840-876` (reassignOrder), `push/events.ts:107-118` (idleRiders) and `:215-218` (group NEW_DELIVERY), `routes/orders.ts:439-450`.
- Trigger: admin reassigns a combined order to any approved rider, or the group NEW_DELIVERY push (all idle riders, no app version filter) is tapped on an old rider app.
- What happens: the pool (`GET /orders/available` without `?groups=1`) and sockets correctly hide groups, and the old driver app does not open an order by push orderId
  (`apps/driver_app/lib/services/push/push_controller.dart`, push only refreshes), so the self-claim route is closed. The ADMIN route is not: `reassignOrder` has no
  "rider app understands groups" check. An old app then holds two children as two unrelated orders, `ARRIVED_AT_GATE` answers 409 `GROUP_NOT_PICKED_UP` until both stops are picked,
  the second restaurant is invisible in the old UI -> order stuck until support intervenes. No money loss (admin cancel refunds).
- Fix: store a rider capability (e.g. `DriverPartner.supportsGroups`, set when the app sends `?groups=1`/socket `groups`) and refuse `RIDER_NO_GROUPS` in reassign + skip those riders in group `idleRiders`. Size: ~25 lines + test. Cheaper stopgap: runbook line "never assign groups before every rider updated", plus deploy the rider APK before enabling `maxRestaurantsPerOrder > 1` (default is 3 = ON at deploy; consider shipping with default 1 and switching on after the apps are out).

### 2. MEDIUM: kitchens are not pushed when the group becomes cookable
- Where: `orderFlow.ts:144-149` (acceptedFlipped is socket only), `push/events.ts:208-228` (no event for it).
- Trigger: restaurant A accepts at minute 1, B at minute 6. A's phone app is backgrounded.
- What happens: A's "Start cooking" turns on only through `order_updated` socket / polling. A background-killed vendor app gets nothing; food starts late, customer waits. B's accept does not extend A's 10 min auto-cancel (A is ACCEPTED, only PLACED children expire), so no loss of money, only latency.
- Fix: new push event `GROUP_READY_TO_COOK` per child (key per child order id) sent from `pushEventsForGroupChange` when `groupAllAccepted` flips, size ~20 lines + app handling. Or at minimum document it.

### 3. LOW: `extraRestaurantFee` max lowered 500 -> 200 can reset all fees to defaults
- Where: `pricing.ts` validateFees (`LIMITS.maxExtraRestaurantFee`), `settings.ts:53-58` (loadAll).
- Trigger: production `AppSetting` row `fees` has `extraRestaurantFee` > 200 (it was an unused placeholder before Docs/22, default 15, so unlikely).
- What happens: the stored row fails validation, `loadAll` logs one console.error and uses `cloneDefaults('fees')` for the whole group (baseFee 25, free-fee/small-order rules, lines, gst) with no alert; every order and quote is then priced on defaults.
- Fix: before deploy run `SELECT value->'extraRestaurantFee' FROM "AppSetting" WHERE key='fees'` (read-only). Hardening: on invalid stored row clamp the offending key instead of dropping the group. 5 lines.

### 4. LOW: reviews pay and rate per child
- Where: `routes/api.ts:935` (`kraveoCoins +10`), `:972` (`(rating*20 + new)/21`), reviews are per `orderId`, children are separate `DELIVERED` orders.
- Trigger: customer reviews each of 5 children of one delivery.
- What happens: 50 coins (= one KRAVEO20 coupon, Rs 20) and 5 rider-rating updates for one physical delivery; the customer can swing a rider's rating 5x faster. Not new money, but a new multiplier on a cheap group.
- Fix: award coins and rider rating only on the primary child's review (or once per `groupId`). ~8 lines.

### 5. LOW: cancel reason of a sibling leaks text across restaurants
- Where: `orderFlow.ts:606-607` (`groupSiblingReason`), `:665`; vendor view returns `cancelReason` via `buildView` (`orderView.ts:148`, spread at `:225`).
- Trigger: restaurant B rejects with reason "Out of paneer, call 98xxxxxxxx" (up to 200 chars) or admin writes an internal note.
- What happens: restaurant A's order card and push show "Another restaurant in your order could not take it: Out of paneer, call 98xxxxxxxx". Contract promises vendors see no other restaurant's data.
- Fix: for VENDOR view of a cascaded sibling (`cancelledBy SYSTEM` + prefix) return only the prefix without the tail. ~4 lines in orderView VENDOR branch.

### 6. LOW: group NEW_DELIVERY to old rider apps
- See 1. Old apps ignore it (pool is empty of groups) but riders get "2 restaurants to BH2. Tap to accept." and find nothing. Fix with the capability flag from 1.

### 7. LOW: lock before authorisation
- Where: `orderFlow.ts:388-390` (createPaymentForOrder), `:630-632` (cancelInTx CUSTOMER), `:912-914` (verifyGateOtp) all run after `lockOrderInTx` took group + children FOR UPDATE.
- Trigger: any logged-in student/rider loops `POST /payments/create-order` / `POST /orders/:id/cancel` / verify-otp with a victim's child id.
- What happens: each call locks the victim's whole group for the duration of the round trip, stalling vendors/riders; before groups it was one row. Cancel is rate limited (5 per 10 min), create-order and verify-gate-otp are not covered by a specific rule I could see.
- Fix: authorisation pre-check on a plain read (`customerId` / `driverId`) before the transaction for these three entry points, or add a per-user rate rule on create-order. ~10 lines.

### 8. LOW (suspected): review route breaks "never lock a child before its group"
- Where: `routes/api.ts:911` locks `Order` row `FOR UPDATE`, then `:935` updates User and `:972` updates DriverPartner (rider row).
- Trigger: customer submits a review for a delivered child at the same instant the same rider (or a malicious client) calls `accept-driver` on a child of that delivered group: claim holds rider row, waits for the child row (held by review); review waits for the rider row. PG kills one with 40P01 -> 500 once. Needs delivered group + two exact-time calls; no state corruption.
- Fix: in the review route lock via `lockOrderInTx` (group first) or drop the row lock in favour of a conditional `updateMany({isReviewed:false})`. ~6 lines.

### 9. LOW: socket room cap
- Where: `realtime.ts:38` `MAX_ORDER_ROOMS_PER_SOCKET = 10`. A customer with two active 5-restaurant groups hits it; the LRU silently drops the oldest children rooms, so tracking of the oldest group falls back to polling. Fix: raise to 20 (or count rooms per group). 1 line.

### 10. LOW: cancel idempotency keyed on the named child
- Where: `orderFlow.ts:632, 638, 642` (`if (order.status === 'CANCELLED') return unchanged`).
- Trigger: group in a partial state (child A CANCELLED, B live) created by a manual DB edit or an older buggy deploy. Every API cancel via A is a "success, nothing changed", via B works. Admin has no way to finish via A.
- Fix: base the no-op on `(group ?? [order]).every(terminal)`; cascade the rest. ~3 lines. Not reachable by current code (all writes are in one locked tx).

### 11. LOW: false `DELIVERY_OVERDUE`
- Where: `routes/orders.ts:619` uses the child's own `pickedUpAt`. Primary picked up first, rider waits 25 min for the second kitchen -> primary row flagged. Cosmetic noise for admins. Fix: for a group use the max `pickedUpAt` of the children when not all PICKED_UP, or skip until all picked. 3 lines.

### 12. INFO: settlement vs group transaction deadlock (the agent's "open risk")
Settlement locks `Order` rows of ONE vendor (`ORDER BY deliveredAt, id FOR UPDATE`, `settlement.ts:125-134`) and a group transaction only needs rows of its own group. A group contains at most one child per restaurant (`DUPLICATE_RESTAURANT`), so a settlement transaction can never hold a row of group G that the G transaction waits on while also waiting for a row G holds. A cycle needs two shared rows; there is at most one. Also `cancelSettlement` (`settlement.ts:423`) is the same shape. No action.

## Checked and OK (traced, no bug)

Money
- Payment amount: `createPaymentForOrder` (payable = group total on primary), `markOrderPaid` expected, `confirmAndMarkPaid`, reconcile, maintenance extras, needs-attention and push refund all use `payableAmount`; sibling create-order = 409 `PAY_VIA_GROUP` after the owner check; Razorpay order amount is fixed server side so underpaying is impossible; `p.amount` fallback equals expected.
- Late/mid-cancel payment: group lock serialises verify, webhook, reconcile, cancel, expiry; `group.some(CANCELLED)` -> primary `refundStatus PENDING`, siblings only `paymentStatus PAID`, vendors never see (paidAt stays null, `isVendorVisible`).
- One refund: only `cancelInTx` (`:667`) and the late path (`:486`) set `refundStatus`, both on the primary; lease/provider-list/`recordSuccess` guards unchanged; siblings flip to REFUNDED/PAID in the same locked tx as the primary (`refundService.ts:83-101, 294-311`). `retry-refund` on a sibling id is a 409 (no row with FAILED). Maintenance `due` query cannot select siblings.
- Duplicate payment on a paid/refunded group refunds the extra payment id only; AMOUNT_MISMATCH rows stay flagged (not auto-refunded), compared with the group total.
- Split: `largestRemainderSplit` integer math safe (< 2^53, no near-integer float division), discount share <= child subtotal, `baseP >= 0` asserted, quote and place share one code path.
- Coupons: one use through child 0, VITFIRST counts earlier non-cancelled orders before the group rows exist, customer row lock serialises, replaced/cancelled group frees the code.

Locking
- Every path that mutates grouped rows goes through `lockOrderInTx` / `lockGroupRows` (group, then children `ORDER BY id`): withOrderLock users, claim (rider first), reassign (target rider first), recordSuccess, applyRefundEvent. Single-statement writers (refund lease, recordFailure, retry-refund reset) hold one row. placeGroup/placeOrder take User then groups, nothing takes a group then User except none. Release takes no rider lock (no cycle with claim). No `order.update` outside orderFlow/refund except the review route (finding 8).
- `SELECT ... ORDER BY id FOR UPDATE` locks in sorted order (LockRows above Sort); all callers use the same SQL.

Cancellation
- All cancel entry points (customer route x2, vendor reject, admin x2, expiry unpaid, expiry no-response, replace by new single/group checkout) end in `cancelInTx`; group cancel updates every non-terminal child in one tx, audit rows after commit, push dedupe through primary-addressed events.
- No-response expiry after all kitchens accepted cannot cancel (no PLACED child); cooking cannot start before all accepted (`GROUP_WAITING`), so a kitchen that already cooks is only hit by an admin cancel.

Authorisation / visibility
- `/order-groups/:id` and list: owner or admin, others (incl. vendors/riders) 404, malformed 400. Vendor view: only `{size, allAccepted}`, own money only. Pool view hides customer and notes; non-primary children return 404 to pool riders; sockets: `order_available/unavailable` only to `groups:1` sockets; `canJoin` order rooms use the same `orderView` check.
- Claim: rider approved + on duty + not busy (distinct group count) + all children PAID and in a pool state + all or nothing (`claimed.count` check, rolled back otherwise).

Rider flow
- Release only while no child PICKED_UP; arrive needs all PICKED_UP and writes one code on all children in one statement; OTP attempts/lock mirrored, retry-after-delivery by per-child proof, reset lock mirrored; reassign moves the whole group and excludes the group itself from the target's busy count.

Pricing/validation
- 5 restaurants, duplicates, hard cap 10 entries, items/lines/quantity caps reused from the single path, `vendorId` regex, non-object bodies handled, no price from the client.

Regression of single orders
- `groupId` null paths unchanged: pool query `OR [{groupId:null}]`, `COUNT(DISTINCT COALESCE(groupId,id))` equals plain count, sweep `groupId:null`, `orderView` emits no `group` key, finishChange single branch identical, `isAbandonedOrder` falls back to the old function.

Migration
- Additive, nullable columns, no default/backfill, FK validate + index build on a small table; `lock_timeout 5s` makes it fail safe, same header pattern as the previous two migrations. Caveat: `ORDER_VIEW_INCLUDE` now joins `group` in EVERY order read, so the migration MUST be applied before the new backend starts (otherwise all order endpoints 500).

## Test gaps (what to add)
1. Group with a settlement run + OTP retry in parallel (document finding 12 with a test).
2. Concurrent new checkout replacing an unpaid group while its payment is being captured (verify + replace + expiry).
3. Review of every child of one delivery (coins, rider rating) and review vs claim race (findings 4, 8).
4. Vendor view of a cascaded sibling must not contain the other restaurant's reason text (finding 5).
5. Reassign/pool push to a rider that never sent `groups` (finding 1/6).
6. `fees` row with `extraRestaurantFee` 250 stored: assert behaviour (finding 3).
7. Partial group created by direct SQL: customer/admin cancel through either child ends fully cancelled (finding 10).
8. Two active 5-restaurant groups with one socket (room cap, finding 9).
9. Lock-before-auth: foreign student calling create-order/cancel/verify-otp on a group must not wait behind or block the owner (finding 7).
10. `maxRestaurantsPerOrder` lowered to 1 while unpaid/paid groups exist: they must still pay, cancel, deliver.
11. Deploy-order test: running the new code against a DB without the migration fails loudly at boot (health check), not per request.
