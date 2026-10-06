# CU2 - Customer app: live tracking, realtime, push, history, review

Hunter: CU2. Date: 6 Oct 2026. Read-only review; nothing was built, run or changed. All paths are under `/home/lucifer/Documents/Projects/Kraveo`. Only read: `Docs/bughunt/CU1_customer_flows.md` (not duplicated; cross-references below).

## 1. Scope covered

Read completely (every line), in `apps/customer_app`:
- `lib/providers/order_provider.dart`, `lib/services/{order_api,order_realtime}.dart`, `lib/screens/{live_tracking_screen,order_history_screen}.dart`, `lib/widgets/{animated_rider_map,review_modal,push_permission}.dart`, `lib/widgets/map/*` (all 5 files), `lib/models/{order,drop_point,geo}.dart`, `lib/services/push/*` (all 5), `android/app/src/main/kotlin/site/kraveo/customer/MainActivity.kt`.
- Also (interaction points): `lib/main.dart` (push-tap routing, session wiring), `lib/screens/payment_success_screen.dart`, `lib/screens/checkout_screen.dart:95-300`, `lib/widgets/ui/status_map.dart`, `lib/screens/home_screen.dart` (lifecycle, active bar), `profile_screen.dart` orders card, `AndroidManifest.xml`, `config/api_config.dart`, `kraveo_ui` `KReveal`.
- Tests: `order_provider_test` (names + the polling/socket group), `order_flow_widgets_test` (tracking/history/app groups), `push_app_test` (tap/permission part), `push_service_test` and `order_fixtures_test` and `campus_drop_points_test` (test names, tracking-map group titles), `support/order_fakes.dart`. Not read line by line: the first 300 lines of `order_provider_test`, `push_fakes.dart`, `campus_drop_points_test` bodies other than titles.
- Backend counterparts: `realtime.ts`, `services/orderView.ts`, `services/push/{events,pushService}.ts` (provider/deviceTokens/types only skimmed by name), `services/refundService.ts`, `services/orderFlow.ts:60-180`, `routes/orders.ts` (list/get/cancel), `routes/api.ts` `/reviews`, `middleware/rateLimit.ts`, `config/campus.ts`. Docs 16, 18 (section 9), 19.

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 2 (1 of them SUSPECTED, needs a phone) |
| MEDIUM | 6 |
| LOW | 14 |

## 3. Findings

### HIGH

**CU2-01 - After a restaurant rejection / auto-cancel / admin cancel the screen stays at "refund is being processed" and never turns into "refunded"** - HIGH - CONFIRMED (code trace) - FIX S
- Where: `providers/order_provider.dart:685` (`_pollIds` skips terminal orders), `:717-722` (`_wantedRooms` skips terminal orders), `:726-733` (no wanted rooms -> `_realtime.dispose()`), `:451-455` (`_ingest` calls `_ensurePolling()` + `_syncRealtime()` right after a terminal update). Backend: `services/orderFlow.ts:86-100` (`finishChange` publishes CANCELLED/PAID first, then `await executeRefund`), `services/refundService.ts:77-91` (`recordSuccess` -> `publish` second event).
- Trigger: the demo step "restaurant rejects a paid order" (or the 10-minute no-response cancel, or admin cancel). Customer has the tracking screen open and no other live order.
- What happens: event 1 (`CANCELLED`, `paymentStatus=PAID`, refund PENDING) arrives on the socket; the handler sees the order is terminal, drops it from the wanted rooms and closes the socket in the same call; polling stops too. Event 2 (`REFUNDED`, 1-3 s later) is never received. `_CancelledCard._money` (`live_tracking_screen.dart:530-540`) keeps saying "You paid Rs X. Your refund is being processed." and the title stays "This order was cancelled" instead of "Cancelled and refunded". Only a manual pull-to-refresh, app resume, or the `REFUND_PROCESSED` push (foreground only, `main.dart:103-106` -> `refreshOrder`) fixes it. Customer-initiated cancel is NOT affected (the REST answer already carries the final state, `routes/orders.ts:197-206`).
- Mitigation that exists: foreground push refresh. Per `kraveo-push-notifications-status.md`, no real push has been verified on a real phone yet, so do not rely on it.
- Demo impact: the refund beat of the demo script looks stuck ("being processed") exactly when the presenter wants to show "refunded".
- Minimal fix: treat "terminal AND `paymentStatus==PAID` AND `refundStatus!=FAILED`" (refund pending) as still watched: include it in `_pollIds` and `_wantedRooms`, bounded to about 10 minutes after `updatedAt`. Add a provider test: cancel event with PAID, then a REFUNDED event after the first.

**CU2-02 - The real map is declared "ready" as soon as the platform view exists; a rejected key / missing billing / blocked tiles shows a grey map with no fallback** - HIGH if it happens - SUSPECTED (needs the exact APK on a phone) - FIX S-M
- Where: `widgets/map/google_tracking_map_view.dart:123-127` (`onMapCreated` -> `spec.onReady()`), `widgets/map/tracking_map.dart:127-132` (`_ready` cancels the 6 s timeout and removes the stylised map at `:223`), `MainActivity.kt:12-25` (`mapsAvailable` only checks that the key string is non-blank and that Play services are installed).
- Trigger: the API key rejects the request (package/SHA-1 restriction not matching the APK actually installed, "Maps SDK for Android" not enabled, project billing off, quota), or the phone has no data. The Maps SDK still creates the view and calls `onMapCreated`.
- What happens: the stylised map is removed and the student sees a grey grid (or "For development purposes only") with pins; the 6 s fallback never triggers. Docs/19 promises "never a blank box". Memory `kraveo-maps-campus-status.md`: keys restricted to the debug SHA-1; never verified on a phone; the owner's console screenshot confirming the API restriction is still pending.
- Demo impact: the headline feature (live map) is the first thing the audience sees on the tracking screen.
- Check before the demo: install the exact release APK, track a real PICKED_UP order, confirm tiles load on venue Wi-Fi AND mobile data. If it does not, build without `MAPS_API_KEY` (the app then uses the stylised map safely) - that is the demo-day escape hatch.
- Code fix (optional): an auth failure is not reliably detectable from Dart, so the practical safety net is a way to force the stylised map (build without the key, or a server-side flag). OWNER-INPUT: key restrictions, enabled API and billing in the Google Cloud console.

### MEDIUM

**CU2-03 - Tracking screen for an order the server does not return (push tap on an old/other-account/deleted order, or first load offline) spins forever with no message** - MEDIUM - CONFIRMED - FIX S
- Where: `screens/live_tracking_screen.dart:166-169` (`if (id != null ...) body = spinner`), `providers/order_provider.dart:413-421` (`_refreshOrder` ignores the error and returns null), `:685` (a watched unknown order is polled every 15 s forever), `:717-722` and `:760-768` (the room join is refused and retried on every sync).
- Trigger: tap a notification whose order is not this account's any more (demo phone used for a rehearsal with account A, now signed in as B; DB wiped before the demo; an order from `GET /orders/:id` = 404), or open `LiveTrackingScreen(orderId)` while offline and the order is not in memory (push cold start).
- What happens: centered spinner, no text, no retry button, no pull-to-refresh (`RefreshIndicator` only exists in the other branches). 404/403/offline/timeout all look the same. Back arrow works, so it is a dead end, not a trap.
- Minimal fix: remember the last `OrderApiError` per watched id; if there is no order and an error exists show `KEmptyState` ("We couldn't find this order" / "Couldn't load, Try again") with a button that calls `refreshOrder` and a "Go to my orders" action; stop watching on `notFound`.

**CU2-04 - "Rider is about N min away" and the rider marker freeze and are never marked stale when the rider stops reporting** - MEDIUM - CONFIRMED - FIX S
- Where: `widgets/map/tracking_map.dart:246-253` (ETA is computed only when the notifier fires or the parent rebuilds), `:259-263` (the 2-minute `kStaleFix` check runs only at that moment), `:134-141` (marker kept as long as the last fix exists), `widgets/animated_rider_map.dart:76-80` (the fallback strip's "GPS live / GPS N min ago" is also computed once per build).
- Trigger: PICKED_UP, rider app killed/swiped away (accepted limitation: tracking stops), rider phone offline, or tunnel/dead zone.
- What happens: after the last fix nothing rebuilds (polling only notifies on change), so the ETA line stays "about 3 min away" and the marker stays put indefinitely; the staleness rule is dead code in steady state. The customer is told the rider is minutes away when no position has arrived for 20 minutes. After app resume the old position is also shown until the next fix.
- Minimal fix: a 15-20 s `Timer`/`StreamBuilder` in `_TrackingMapState` that triggers a rebuild; when the fix is older than `kStaleFix` hide the ETA and show "Rider's location not updating" (and optionally dim the marker); apply the same age to `_liveLabel`. Add a widget test with a fake clock advancing past 2 minutes without a new fix (the existing test at `campus_drop_points_test` "a stale fix" only checks the build-time case).

**CU2-05 - The "call" button does not call: it copies the rider's number to the clipboard** - MEDIUM - CONFIRMED - FIX S (adds a dependency) - OWNER-INPUT (accept `url_launcher`)
- Where: `screens/live_tracking_screen.dart:761-775` (phone icon, `Clipboard.setData`, snack "Paste it in your dialer"); `pubspec.yaml` has no `url_launcher`.
- What happens: a phone icon button that looks like "Call rider" only copies the text. During the demo ("rider is at the gate, call him") the presenter taps a call icon and nothing dials. The semantic label says "Copy ...", so it is honest but a downgrade from what a delivery app user expects.
- Minimal fix: `url_launcher` `tel:` with `<queries><intent><action android:name="android.intent.action.DIAL"/>` in the manifest; keep a long-press copy.

**CU2-06 - The app tells the customer to "contact Kraveo support" in six places but nowhere shows how** - MEDIUM - CONFIRMED - FIX S - OWNER-INPUT (placement/copy; the support email is already decided: kraveo.contact@gmail.com)
- Where: `services/order_api.dart:364-367` (`PAYMENT_AMOUNT_MISMATCH`, `DUPLICATE_PAYMENT`, `CANNOT_CANCEL`), `screens/live_tracking_screen.dart:523` and `:536` (refund failed "support has been alerted"), `services/google_auth_service.dart:61`. `grep -rn "kraveo.contact\|mailto" lib` returns nothing.
- Trigger: the restaurant accepted and the student wants to cancel (`CANNOT_CANCEL`), a refund shows "taking longer than usual", or a double charge.
- What happens: dead-end messages; no email, phone, copy button or link anywhere in `lib` (grep for the email, `mailto`, `url_launcher` finds nothing).
- Minimal fix: one reusable "Need help? kraveo.contact@gmail.com [Copy]" line under `_CancelledCard`, in the CANNOT_CANCEL snack action, and on the Me tab.

**CU2-07 - The Google map view is destroyed and re-created when the OTP card appears (rider arrives) and whenever the card list shifts** - MEDIUM - CONFIRMED mechanism, visual effect SUSPECTED - FIX S
- Where: `screens/live_tracking_screen.dart:214-266`: the `ListView(children: [...])` has conditional un-keyed children (`KReveal(index:1, _OtpCard)` is inserted BEFORE the `KReveal(index:2, TrackingMap)` at `:249-252`; also the order-switcher row at `:215-230`, the payment card at `:234-247`). Flutter matches un-keyed children by position, so the slot that held `KReveal(TrackingMap)` gets `KReveal(_OtpCard)` and the `TrackingMap` state (key `tracking-map-<id>`) is disposed; a new one is built one slot later.
- Trigger: rider presses "Arrived at gate" while the customer watches (the moment of the demo that matters), a second live order appearing, payment confirming -> paid.
- What happens: the platform view and its marker animator are dropped and recreated (`_Mode.checking` -> probe -> `loading`, up to 6 s with the stylised strip showing). The customer sees the map flash to the strip and back at the exact moment the OTP appears.
- Minimal fix: give each conditional child a stable `key` (e.g. `ValueKey('map')`, `ValueKey('otp')`) on the `KReveal` wrappers, or build the list from a keyed list.

**CU2-08 - "Kitchen usually delivers in 20-25 min" is an invented default shown as fact on every tracking screen** - MEDIUM - CONFIRMED - OWNER-INPUT - FIX S
- Where: `screens/live_tracking_screen.dart:341-342,380-383`, `models/dhaba.dart:66` (`json['eta'] ?? '25-30 mins'`), `backend/prisma/schema.prisma:89` (`eta @default("20-25 min")` for every vendor), `backend/src/utils/catalog.ts:27` (sent to the app). Also `rupee()` rounding on the cancel confirm/refund text (`:110`, `:532`): cross-reference CU1-07.
- What happens: every live order shows a stopwatch chip with a promise nobody measured, directly above a real "about N min" line that may disagree. It also contradicts the code comments ("no invented distances or timings", `status_map.dart:62`, `animated_rider_map.dart:8`). The hero also reads `DhabaProvider.dhabas`, the Home-filtered list (`listen:false`), so the chip vanishes when a search/category is active and never appears after the catalog loads until the next rebuild.
- Minimal fix: remove the chip until restaurants have a real, owner-set value.

### LOW

- **CU2-09 - A status value from a newer server makes the whole order disappear.** `models/order.dart:305-306` returns null for an unknown `status`; `order_api.dart:201` drops it from lists, `:260` turns a single GET into `badResponse`, `order_provider.dart:787` ignores the socket event. An unknown `paymentStatus` falls back to PENDING (`order.dart:52-57`) and, for a PLACED order, shows "Pay again". Fix: keep an `unknown` status that renders as "Updating..." and never offers payment. CONFIRMED, version-mismatch only.
- **CU2-10 - "Order again" on the cancelled card does not reorder; it only goes back to Home / pops.** `live_tracking_screen.dart:557` passes `_explore` (`:82-88`). A student whose order was rejected expects their cart back. The real Reorder is only in Orders (`order_history_screen.dart:149`, see CU1-06). Fix: rename to "Browse kitchens" or call the reorder helper. CONFIRMED.
- **CU2-11 - OTP card spins forever, with no retry, if the order is ARRIVED_AT_GATE but the copy has no valid code.** `live_tracking_screen.dart:482-487`; the OTP is only parsed if it matches `^\d{4,6}$` (`order.dart:343`). The 15 s poll is the only recovery (pull-to-refresh also works). Cosmetic unless the server has a bug; add "Pull down to refresh" text. CONFIRMED.
- **CU2-12 - "Active" is decided with the phone clock.** `order_provider.dart:266` compares `_clock()` with the server `updatedAt` against 12 minutes. A phone whose clock is more than ~12 minutes fast makes a just-delivered or just-cancelled order vanish from the Track tab at once (Rate/refund card gone, "No active order"); a slow clock resurrects old terminal orders. Fix: trust the server's `scope=active` list (it already limits to 10 minutes) and filter relative to the newest server timestamp. CONFIRMED, device-clock dependent.
- **CU2-13 - AppBar title can overflow at large font scale.** `live_tracking_screen.dart:157-164,203-206`: two text lines in a 68 px toolbar; about 82 px at 2x text. SUSPECTED, only clipped in release.
- **CU2-14 - A push/banner tap pops checkout mid-flow.** `main.dart:138-147` does `popUntil(route.isFirst)` before pushing the order. A tapped local banner (RIDER_AT_GATE/ORDER_CANCELLED of another order) while the student is on checkout or the payment-confirming state closes it; the in-flight pay future finishes with no screen to hand over to. Rare. Fix: do not popUntil when the top route is checkout/payment success; push on top instead.
- **CU2-15 - Pull-to-refresh on Orders is a no-op while "load more" is in flight.** `order_provider.dart:372-376` returns the running `_historyFuture` even for `refresh:true`. LOW.
- **CU2-16 - Review "already reviewed" path does not update the coin balance.** `order_provider.dart:650-655` / `review_modal.dart:115-121`: after a lost first response the second submit pops with "already rated" and `onReviewed` is never called, so Me shows the old coin count until the next profile load. The restaurant is not rated at all (only dishes + rider, server comment `api.ts:938-942`) although the sheet title says "Rate <restaurant>"; note field has no length limit and `dhabaNotes` = tags + note can exceed the server's 300 characters (`review_modal.dart:99`; related CU1-19).
- **CU2-17 - Stylised fallback strip shows "GPS live" in every phase.** `tracking_map.dart:180-188` passes the fix regardless of `_riderPhase`, so while the rider walks to the restaurant (ACCEPTED..READY) the chip appears; contradicts Docs/19 ("never show the rider position outside the arriving phase"; here only a chip, not a position).
- **CU2-18 - Two Google maps can exist at once.** The Track tab (`IndexedStack`, `home_screen.dart:87-92`) builds its `LiveTrackingScreen` offstage from app start, and a pushed `LiveTrackingScreen(orderId)` (checkout, history, push tap) creates a second `TrackingMap`. On a 3-4 GB phone that is two platform views + tile caches. Fix: build the map only when `widget.visible`.
- **CU2-19 - The socket is websocket-only (`order_realtime.dart:47`).** If a campus proxy/firewall blocks WebSocket the socket never connects (`connect_error` is only logged); polling covers only the screen being watched, not the Home bar. SUSPECTED. Cheap fix: allow `['websocket','polling']`.
- **CU2-20 - `_syncRealtime` can get stuck "connecting".** `order_provider.dart:737-741`: `_connecting` is reset only on the normal paths; if `_tokenProvider()` throws (SharedPreferences failure) it stays true for the rest of the session and no socket is ever opened (unawaited future, no log). Wrap in try/finally.
- **CU2-21 - `_CancelledCard` says "No payment was taken" for a cancelled order with PENDING payment even if a late capture is in flight** (`live_tracking_screen.dart:539`; the verify `ORDER_CANCELLED` path shows the refund text, but a network failure there leaves the wrong sentence). Related CU1-26.
- **CU2-22 - NaN passes the coordinate range check if the server ever sends it as a string.** `order.dart:177,204` use `lat.abs() > 90`, false for NaN, and `_numOrNull` parses "NaN". JSON numbers cannot be NaN, so this is theoretical; add `isFinite`.

## 4. Looked hard and found nothing
- OTP secrecy: server builds a per-socket `orderView` (OTP only for the owner at ARRIVED_AT_GATE, `realtime.ts:192-210`, `orderView.ts:129`); the app keeps the code only in `ARRIVED_AT_GATE` copies, never in push, never in logs; no OTP bypass path in the customer app.
- Out-of-order / duplicated / stale socket and REST copies: `isNewerThan` merge by `updatedAt`, equal-timestamp rules, no "un-pay", cancelled wins; late REST answers lose to newer socket events (also tested). A status going backwards is only possible with a newer `updatedAt`.
- Socket lifecycle: JWT in the handshake (not the URL), re-join of all wanted rooms on every reconnect, refused joins retried, watcher counts balanced even for two screens, polling timer and sockets cancelled on logout/dispose, generation counter drops answers from older sessions.
- Idempotent checkout / double-tap pay / payment-success to tracking handoff (`PaymentSuccessScreen` calls `onContinue` once; checkout cleared before navigating): consistent with the backend codes.
- Rider location authorization: server only emits `rider_location` to the owning customer and admins; the app also checks `driverId` against `order.rider.id` (both are User ids, `orderView.ts:84`).
- Push tap/token lifecycle: strict payload validation (unknown event/version/id ignored, no throw), dedupe by message id, tap dropped when signed out and kept while the session is unreachable, register once, re-register on refresh, DELETE before logout then `deleteToken()`, account switch registers the new token; no intent filters beyond the launcher.
- Drop point table (`models/drop_point.dart`) equals `backend/src/config/campus.ts` for all 11 points; legacy names normalise on both sides; the client's extra tolerance ("bh 3") is harmless.
- History pagination: server cursor/`nextCursor` shape matches, de-duplication when a terminal order is also in the list, error footer with retry. There are no filters in the customer app.
- JSON tolerance: lists and single orders parse defensively (missing fields, `{data}` envelopes); no unchecked casts found in the tracking path.

## 5. Top 5 to fix before the demo
1. CU2-01 - keep polling and the room for a cancelled-but-refund-pending order (small, protects the "refund" demo step).
2. CU2-02 - install the exact APK and prove the real map tiles on venue Wi-Fi and mobile data; if not, ship the demo APK without the Maps key (stylised map).
3. CU2-03 - an error state with Retry for an order that cannot be loaded (push tap after a DB reset or account switch).
4. CU2-04 + CU2-07 - re-evaluate ETA/marker staleness on a timer and key the tracking list children so the map does not rebuild when the OTP appears.
5. CU2-05 + CU2-06 - real `tel:` call button and a visible support email wherever the app says "contact Kraveo support".

## 6. Only provable on a real device / server
- Real Google tiles with the debug-signed release APK (CU2-02); whether the platform view is clipped by `ClipRRect` and behaves in the scrolling list (map panning vs page scroll, jank) and the flash at ARRIVED_AT_GATE (CU2-07).
- A real FCM push reaching the phone (none verified so far): foreground refresh on `REFUND_PROCESSED` (the only thing masking CU2-01), `RIDER_AT_GATE` banner while on another screen, cold-start tap routing, token move on account switch.
- Socket behaviour through the venue network (WebSocket allowed? reconnect after the phone sleeps, CU2-19) and the 45 s zombie-socket window after resume.
- Large font scale (1.3x-2x) on 360x640 for the tracking AppBar and chips (CU2-13).
- Behaviour when the rider app is killed during PICKED_UP (CU2-04), and a tapped notification belonging to another account (CU2-03).
