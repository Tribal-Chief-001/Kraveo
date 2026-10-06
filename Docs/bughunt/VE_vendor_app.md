# VE - Restaurant Partner app (apps/vendor_app) - read-only bug hunt, 6 Oct 2026

Hunter: VE. Read-only. Nothing was run (no tests, builds, devices). Everything below is traced in code; items that need a phone are labelled SUSPECTED. Code state read: vendor_app at commit 64838bb (clean working tree); backend as it is in the working tree today (it is being patched by another agent, so a backend finding may already be fixed when you read this: re-check `partners.ts` and `api.ts` first).

## 1. Scope covered

Read line by line: `lib/main.dart`, `lib/config/api_config.dart`, `lib/models/{dish_model,order_model,partner_session}.dart`, `lib/session/session_controller.dart`, every file in `lib/services` (partner_auth_service, vendor_api_service, vendor_backend, order_queue_controller, order_queue_service, order_socket, audio_alert_service, menu_stock_controller, failure_messages, location/{campus_geo,location_capture,location_scope,vendor_location_api}, push/{push_controller,local_alarm_notifications,firebase_push_messaging,push_background,push_message,push_permissions,push_ports,device_registry}), every screen (login, signup, application_status, vendor_home, vendor_home_screen, kitchen_queue, stock_manager, sales_analytics), every widget (incoming_order_dialog, order_card, stock_card, add_dish_modal, location_flow, location_sheet, push_status_cards, all of `widgets/ui/*`), `android/app/src/main/AndroidManifest.xml`, debug manifest, `MainActivity.kt`, `build.gradle.kts`, `res/raw` (keep.xml and the alarm: 20.0 s mono ogg, byte-identical to `assets/audio`), `pubspec.yaml`.

Backend counterparts read: `routes/orders.ts` 1-360 (list, detail, reject, status), `services/orderView.ts` (whole), `services/orderFlow.ts` 330-520 (markOrderPaid, advanceStatus, cancel), `routes/partners.ts` 1-540, `routes/api.ts` 215-300 and 560-860 (partner login, vendors, menus, vendor status, items, analytics), `utils/{validation,catalog,names}.ts`, `config/campus.ts`, `services/vendorLocation.ts`, `realtime.ts` 1-260, `middleware/{auth,rateLimit}.ts`, `routes/devices.ts`; Docs 16, 18 (section 9), 20; BE1/BE2 reports; council `vend.md`.

Tests: read in full `test/support/{fakes,signed_in}.dart`, `order_queue_controller_test`, `vendor_backend_test`, `audio_alert_service_test`, `menu_stock_controller_test`, `vendor_home_flow_test`, `vendor_app_test`, parts of `signup_flow_test` (296-335, 355-494) and `vendor_layout_test` (1-70). For the other test files (`auth_test`, `push_app_flow_test`, `push_controller_test`, `push_message_test`, `order_model_test`, `location_*`, `restaurant_location_app_test`, `signup_location_test`, `support/push_fakes`, `support/location_fakes`) I read test titles only, not bodies. NOT read: `test/fixtures/*.json`, `.idea`, build outputs, the kraveo_ui package beyond `KButton`, `KPressable`, `showKSheet`.

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 1 |
| MEDIUM | 10 |
| LOW | 10 |

No security hole found in the app: the server decides every price, status, deadline and visibility rule, and the app never shows the customer phone or the OTP. The one HIGH is a contract mismatch that makes "fix a rejected application" look broken. The MEDIUMs are mostly "what the owner sees when something changes under the app" (suspend, admin cancel, empty new restaurant) and demo traps.

Earlier-audit (council `vend.md`) items, status now: VE-01 push, VE-02 alarm asset, VE-05 manifest, VE-08 permissions are FIXED in code (device proof still needed). STILL OPEN and re-confirmed in code: VE-03 (veg flag), VE-06 (backup/plain token), VE-07 (placeholder helpline, does not dial), VE-09 (price rounding), VE-10 (earnings), VE-11 (30-day token, no refresh), VE-12 (menu), VE-13 (dead takeover, see VE-03 below: it is worse than the council thought), VE-14 (wake lock), VE-15, VE-16 (prep chips local), VE-17 (`_storeOpen ?? true`), VE-18, VE-20 (text clamp). VE-04 (debug-signed) is accepted.

## 3. Findings

### HIGH

**VE-01 - "Update details and apply again" always shows "Kraveo is having trouble" although the server accepted it** - HIGH - CONFIRMED
- Where: `lib/services/partner_auth_service.dart:219-258` (`resubmit` -> `_signupResult`, lines 242-246), `lib/models/partner_session.dart:96-99,176-187` (a session needs `json['user']`), backend `routes/partners.ts:353-389` (PUT /partner/application answers `{success, approvalStatus, rejectionReason, vendor}` with NO `user`; the e2e test `partner_approval.test.ts:196-202` only checks those three keys).
- Trigger: a restaurant is REJECTED (or still PENDING and taps "Change my details"), edits the form, taps "Update details and apply again" / "Send again".
- What happens: server returns 200 and really resets the application to PENDING (and pings the admin dashboard "resubmitted"). The app parses the 200 with `PartnerSession.fromMeJson` -> `fromUserJson(null)` -> null -> `SignupFailure.server`. The form shows the red box "Kraveo is having trouble. Please try again in a moment." and stays open. Within 20 s the status screen under the form flips to "pending" by its poll, but the form on top keeps the error. Every extra tap re-notifies the admin. The test `signup_flow_test.dart:300-331` uses `FakeAuth.onResubmit` returning a session, so it passes for the wrong reason; the "API layer" group (403-470) has no HTTP test for `resubmit`.
- Demo impact: the "admin rejects, owner fixes and re-applies" scene looks broken on stage.
- Fix: backend (S): add `user: {id, name, phone, role, avatarId}` to the PUT response (same shape as /partner/me). App (S, defensive): on a 200 from `resubmit` with no readable user, treat it as success and call `refreshApproval()`. Add an HTTP-level test with the real response shape.
- Size S. OWNER-INPUT: no.

### MEDIUM

**VE-02 - After a fresh login the app does not know the restaurant's address, category or FSSAI; "Update details" opens blank and then wipes the FSSAI/category on file** - MEDIUM - CONFIRMED
- Where: backend `routes/api.ts:253` (partner-login selects only `id, name, isAcceptingOrders, approvalStatus, rejectionReason` + location columns; `/partner/me` and sign-up return the full `vendorView`), app `partner_session.dart:102-122` (reads `vendor['category'|'address'|'fssaiNumber']` -> null), `session_controller.dart:125-134` (stores it), `session_controller.dart:176-183` (`refreshApproval` stores the full copy but only notifies when approval/reason/location changed), `application_status_screen.dart:206-210,214-225`, `signup_screen.dart:38-50,117-118`.
- Trigger: a PENDING or REJECTED owner logs in (second phone, next day, after "Session expired"), then opens "Change my details" / "Update details and apply again".
- What happens: the "Kitchen" and "Serves" rows on the status screen are missing; the edit form has an empty address (must be retyped), no category chip, and the FSSAI field is hidden because its prefill is empty. On submit the form sends `category: ''` and `fssaiNumber: ''`; the server merges `{...existing, ...body}` (`partners.ts:~371`), so the category goes back to "Campus kitchen" and the FSSAI number on file is erased unless the owner re-adds it (a rejection reason is often exactly "FSSAI does not match"). A normal app restart repairs it (`restore()` uses /partner/me), a login does not.
- Demo impact: visible on the rejected-then-fix path; silent data loss.
- Fix: add `category: true, address: true, fssaiNumber: true` to the select at `api.ts:253` (S), or call `fetchProfile` right after login. Also let `refreshApproval` notify when name/address/category/FSSAI change, and send only the fields the owner edited.
- Size S. OWNER-INPUT: no.

**VE-03 - A suspended / password-reset restaurant gets "Session expired", and a takeover left open can become a dead full-screen that cannot be closed** - MEDIUM - CONFIRMED (path); the race is SUSPECTED
- Where: backend `routes/partners.ts:473-478` (SUSPENDED bumps `tokenVersion` and disconnects sockets; `partner_approval.test.ts:226-227` asserts the old token then gets `401 TOKEN_REVOKED`), app `main.dart:140-147` (`_onSessionChanged` only clears statics), `main.dart:182-186,197-214` (only these two paths `popUntil`), `session_controller.dart:167-227` (`refreshApproval` -> `expire()` with no pop), `incoming_order_dialog.dart:171-175` (`PopScope(canPop:false)`), `order_queue_controller.dart:432-434` (a disposed controller answers `ignored`), `incoming_order_dialog.dart:133,160`.
- Trigger: the "New order" takeover is open (typical: order arrives, cook walks away, phone locks). The admin suspends the restaurant (or resets its password). The cook unlocks the phone: on resume two calls race, `refreshApproval()` (main.dart:189-194) and the order poll. If the profile call's 401 wins, `expire()` swaps in the login screen without popping routes; the takeover route stays on the root navigator over the login screen with a disposed controller. Accept/Decline do nothing, back is blocked: the only way out is killing the app. If the poll's 401 wins, `_handleUnauthorized` pops correctly (50/50).
- Also: the owner is told "Session expired" instead of "Your account is paused"; the paused screen only appears after logging in again. The test `signup_flow_test.dart:377-401` simulates suspension as `/partner/me` 200 SUSPENDED plus a 403 PARTNER_NOT_APPROVED, which is not what the server does (it answers 401), so the "moves to the status screen" path is never real.
- Demo impact: "admin suspends the restaurant" on stage is a plausible scene; the restaurant phone may freeze on a dead takeover.
- Fix (S): in `_onSessionChanged`, when status leaves signedIn or approval != approved, call `Navigator.of(context).popUntil((r) => r.isFirst)` (as 401 does) and let the dialog close itself when `controller.isDisposed`. Show "Your session ended; log in to see your account status" on the login screen after a revocation. Fix the tests to use the real 401.
- Size S. OWNER-INPUT: no.

**VE-04 - When Kraveo (admin) cancels an order the kitchen is already cooking, the app gives no alert: the card just disappears** - MEDIUM - CONFIRMED in code, device effect SUSPECTED
- Where: `order_queue_controller.dart:334-343,345-357` (a cancelled copy is merged silently; the order moves to `finished`), `kitchen_queue.dart:86-103` (Active tab only lists kitchen states), `push_controller.dart:397-402` (a foreground push only reloads), `order_card.dart:205-208`. Docs 16 allows admin cancel in any non-terminal state; the customer can cancel only while PLACED.
- Trigger: demo step "refund of a cancelled order" done on an ACCEPTED/PREPARING order, or any support cancel.
- What happens: foreground: no sound, no snackbar, the card vanishes and the Active count drops; the cook keeps cooking food nobody will collect. Background: only a quiet "Order cancelled" notification (channel `order_updates`) which stays in the tray after the app is opened.
- Fix (S-M): when a kitchen-state order becomes CANCELLED with `cancelledBy != VENDOR`, show a modal/snackbar ("Order #XXXXXX was cancelled by Kraveo. Stop cooking.") with one short sound, and cancel the tray notification.
- Size S-M. OWNER-INPUT: no.

**VE-05 - The "Add a dish" form cannot say veg / non-veg, has no photo, and a mistyped dish cannot be fixed or removed** - MEDIUM - CONFIRMED (BE2-12, council VE-03/VE-12 still open)
- Where: `widgets/add_dish_modal.dart:45-61` and `services/vendor_backend.dart:277-285` (sends only name, category, price), backend `utils/validation.ts` (`isVeg` defaults true) and `routes/api.ts` (stock Unsplash photo; PATCH accepts only `isAvailable` and `price`; no DELETE).
- Trigger: the owner on stage adds "Chicken Biryani" or types "Panner".
- What happens: the customer app shows the green veg mark and a stock food photo; the typo is permanent (only hideable with the sold-out switch).
- Fix: S for the veg switch (a `VStockSwitch`-style "Veg / Non-veg" chip sent as `isVeg`, backend already validates it). Edit/delete needs backend routes (M). For tomorrow: type dishes carefully and add only veg dishes.
- Size S (veg) / M (edit-delete). OWNER-INPUT: copy only.

**VE-06 - A freshly approved restaurant is CLOSED with an empty menu, nothing tells the owner what to do next, and the store can be opened with zero dishes** - MEDIUM - CONFIRMED (BE2-11 is the server half)
- Where: `partners.ts` sign-up creates `isAcceptingOrders:false`; `vendor_home.dart:481-489,252-269` (hero says CLOSED; opening is one tap with no check), `stock_manager.dart:188-198` (empty-state text only on the Menu tab), `kitchen_queue.dart:134-152` ("No orders right now" on the first screen after approval).
- Trigger: demo scene "new restaurant signs up, admin approves".
- What happens: the owner lands on an empty Orders tab; if they tap OPEN first, customers see an open restaurant with no dishes.
- Fix (S): a first-run card on Orders while the menu is empty or the store is closed ("1. Add a dish  2. Tap OPEN"), and a confirm ("You have no dishes yet") when opening an empty store. Script for tomorrow: approve -> owner adds dish -> owner taps OPEN -> refresh customer app.
- Size S. OWNER-INPUT: copy.

**VE-07 - Sign-up tells the owner to "log in" when the number belongs to another Kraveo app** - MEDIUM - CONFIRMED (BE2-01 is the root cause)
- Where: `screens/signup_screen.dart:150-151` ("This number already has an account. Go back and log in."), backend `partners.ts` 409, `api.ts` partner-login (a student row has no password -> 401 "Wrong phone or password").
- Trigger: the presenter used the same mobile in the customer app profile, then signs the demo restaurant up with it.
- What happens: sign-up blocked; following the advice leads to "Wrong phone or password" for a password the owner just never set.
- Fix (S): text "This number is already used by another Kraveo account (for example the customer app). Use a different number." Operationally: one distinct number per role on the run sheet. (The Hindi-name rejection in BE2-02 is already patched in `utils/names.ts` in the working tree; the form's own owner-name check is only length >= 2, `signup_screen.dart:83`, so the server message is what the owner sees.)
- Size S. OWNER-INPUT: the policy of one number across apps.

**VE-08 - The only help number is a placeholder and "Call helpline" does not dial** - MEDIUM - CONFIRMED (council VE-07/M-16 still open)
- Where: `vendor_home.dart:292-305` (snackbar only), `:353-368` (`+91 98765 43214`, the same digits as the demo super-admin and the driver app's self-labelled UNVERIFIED constant), `login_screen.dart:328`, `application_status_screen.dart:273` ("ask Kraveo support" with no contact), `failure_messages.dart:22` ("Call Kraveo to cancel it"). `url_launcher` is already a dependency (used for Maps) but no `tel:` anywhere.
- Trigger: any owner or audience member taps "Call helpline" or needs help after Accept.
- What happens: a fake-looking number appears in a snackbar; nothing dials; a stuck accepted order has no in-app exit.
- Fix (S): one config constant with the real number, `launchUrl(Uri.parse('tel:...'))` for the button, show it on login/pending/suspended and the CANNOT_REJECT message. Docs 17 A4 already waits for the number.
- Size S. OWNER-INPUT: YES (the real support number).

**VE-09 - Money on the restaurant's screens is inconsistent and the Earnings number moves by itself** - MEDIUM - CONFIRMED (council VE-10/VE-09 still open)
- Where: `incoming_order_dialog.dart:281` and `order_card.dart:173` (giant "Order total" = customer total incl. delivery fee and packaging, e.g. Rs 245), `sales_analytics.dart:33,41-45,143` (earnings = food `subtotal` only, "before Kraveo fees"; counts every paid non-cancelled order, so a PLACED order inside the 10-minute window is added and later subtracted if it expires; discounts ignored), `vendor_ui.dart:27-30` (`formatRupees` rounds to whole rupees: 49.50 shows Rs 50, 245.15 shows Rs 245).
- Trigger: look at the takeover (Rs 245) and then the Earnings tab (Rs 205) on the same test order; or let an unanswered order expire.
- What happens: the owner cannot tell what they will be paid; the headline number changes after the fact; paise are hidden although the server allows 2 decimals.
- Fix (S): show "Food Rs 205 / Total paid by customer Rs 245" on the takeover, count only accepted-or-later orders (or show "waiting for answer" separately), print paise when not a whole number. Settlement terms are undecided (council D-1).
- Size S. OWNER-INPUT: YES (what the restaurant is paid, who bears the coupon).

**VE-10 - The Back button on the Orders screen silently exits the app, which stops the in-app alarm, the socket and the poll** - MEDIUM - effect SUSPECTED (nothing intercepts Back: CONFIRMED)
- Where: `grep PopScope lib` finds only `incoming_order_dialog.dart:171`; `vendor_home.dart` and `main.dart` have none.
- Trigger: a rushed cook presses Back (or swipes back) on the home screen.
- What happens: Android finishes the activity; with a non-cached Flutter engine the Dart side (timers, socket, wake lock) goes away. Orders are then reachable only by FCM (`new_orders` channel, 20 s alarm, then once a minute). On a cheap phone with battery saver this is the typical "I never heard it" path; the screen also no longer stays awake.
- Fix (S): wrap the home in `PopScope(canPop:false)` with "Press Back again to exit" (or a confirm sheet), same style as logout.
- Size S. OWNER-INPUT: no.

**VE-11 - The in-app alarm is silent while the app is "inactive", and FCM may also stay silent in that window** - MEDIUM - SUSPECTED (needs a phone)
- Where: `vendor_home.dart:110-119` (`setAppInForeground(state == resumed)`), `order_queue_controller.dart:494-513`, Docs 18 section 9 (system notification rings in the background; the in-app loop only when on screen).
- Trigger: a new order arrives while the Android notification shade is pulled down, a system permission dialog is open (the notification and location prompts appear right after approval), a call overlay or split-screen focus change is active. Flutter reports `inactive` (not `resumed`) in all of these.
- What happens: `_appInForeground` is false -> no in-app sound, and because the activity is still the visible app, FCM normally hands the message to `onMessage` instead of showing a notification (`push_controller.dart:397-402` only reloads). The order is on screen but nothing rings until the app is `resumed` again.
- Fix (S): treat `inactive` like foreground for the alarm (`setAppInForeground(state == resumed || state == inactive)`); screen-off still goes inactive -> hidden -> paused, so the double-ring protection stays.
- Size S. OWNER-INPUT: no.

### LOW

**VE-12 - Price sheet silently changes prices and closes without a message on bad input** - LOW - CONFIRMED (council VE-09). `stock_card.dart:208` prefills `toStringAsFixed(0)`, `:216-222` saves whatever parses and closes; a dish at 49.50 becomes 50 if the owner just taps "Save price". Invalid or empty text (also Devanagari digits from a Hindi keyboard, `double.tryParse` returns null) closes the sheet with no feedback. `menu_stock_controller.dart:79-85` ignores `price <= 0` silently; the stepper (`stock_card.dart:114`) has no ceiling (server refuses above 10 000 with a toast and rolls back). Fix: exact prefill, disable Save when unchanged/invalid with an inline message. Size S.

**VE-13 - Menu state can be stale or out of order** - LOW - CONFIRMED (council VE-12). `menu_stock_controller.dart:60-77`: two quick toggles can complete out of order and `_confirmedStock` keeps the older answer; the menu loads once (`stock_manager.dart:34`) and on pull-to-refresh only, so a second phone's or the dashboard's change never appears; "Item out of stock" as a reject reason (`incoming_order_dialog.dart:17-22`) does not mark the dish sold out. `addDish(inStock:false)` creates the dish available first and flips it after (`menu_stock_controller.dart:116`), a short window where customers can order it. Fix: serialise per dish, reload on resume/tab open, offer "mark these dishes sold out" after such a reject. Size S-M.

**VE-14 - "Ready in 10/15/20/30 min" is only a local reminder** - LOW - CONFIRMED (council VE-16). `incoming_order_dialog.dart:457-469`, `order_queue_controller.dart:463,537-543`: not sent to the server; the customer and rider never see it; the card turns red "LATE" against it; another phone uses 15. Fix: relabel "My reminder" or send it (M). OWNER-INPUT.

**VE-15 - The wake lock is never released** - LOW - CONFIRMED (council VE-14). `vendor_home.dart:66,121-125` only `enable()`; after logout/expiry the login screen keeps the screen on. Fix: `WakelockPlus.disable()` in `dispose`. Size S.

**VE-16 - Token and session sit in plain SharedPreferences with Auto Backup on; logout does not revoke the JWT** - LOW - CONFIRMED (council VE-06). `AndroidManifest.xml:16-20` has no `android:allowBackup="false"`; `vendor_api_service.dart:9,49-55`; backend `/auth/logout` only clears `fcmToken` (`api.ts:422-436`), so a copied 30-day token survives logout (no refresh path either, council VE-11). Fix: `allowBackup=false` (S); secure storage (M).

**VE-17 - GPS: a rough fix is accepted, and outside 3 km the owner cannot proceed** - LOW - CONFIRMED rule, device effect SUSPECTED. `location_capture.dart:144-148`, `location_sheet.dart:161-179`, `vendorLocation.ts` (accuracy up to 5000 m accepted): with Android's "approximate location" permission the fix is km-wide and "Save anyway" still stores it, while the warning says riders go "a little away". Opposite problem: `location_sheet.dart:138,407-417` rejects anything over 3 km from the campus centre with "Go to your kitchen", which is a dead end for a rehearsal elsewhere (use "Not now" / "Continue without"; admin can type coordinates). Fix: refuse > ~250 m (retry only) and mention "or ask Kraveo to set it". Size S. OWNER-INPUT: the 3 km rule.

**VE-18 - On a slow start the saved login cannot reach the home screen** - LOW - CONFIRMED. `main.dart:224-225`, `session_controller.dart:112-114`: if `/partner/me` times out (10 s) the app shows "Can't reach Kraveo" with Retry although the stored session is approved and the home screen already copes with offline polls. Fix: open the home with the stored session when it is approved. Size S-M.

**VE-19 - Wording and fixture drift** - LOW. Vendor app says "Cooking" for PREPARING, every other app and the dashboard say "Preparing" (`order_card.dart:253`); test fixtures still use hostel "Block 2" (`test/support/fakes.dart:35,52`) while orders now carry BH1..GH2, so no test exercises a real drop point string; `pubspec.yaml` description is stale. Size S.

**VE-20 - Manifest leftovers** - LOW. `USE_FULL_SCREEN_INTENT` and `FOREGROUND_SERVICE` are declared but unused (`AndroidManifest.xml:5,6`; Docs 18 section 9 already says remove or justify), `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` needs a Play justification. No demo effect (sideloaded debug-signed APK). Size S.

**VE-21 - Tests that pass for the wrong reason / missing cases** - LOW. (a) `resubmit` only through `FakeAuth` (VE-01). (b) Suspension simulated with the wrong server behaviour (VE-03). (c) `FakeBackend.updateDish` always returns `success(null)` (`test/support/fakes.dart:193-197`), so the real `{item:{...}}` answer parsing and the confirmed-price paths in `menu_stock_controller` are never exercised. (d) `AudioAlertService` is tested with a fake player; the real `AudioPlayersAlarmPlayer.isActive`, audio focus and volume are untested. (e) No test for: a kitchen-state order cancelled by admin (VE-04), a session change while the takeover is open (VE-03), `inactive` lifecycle with a waiting order (VE-11), PLACED counted in earnings (VE-09), price prefill (VE-12), Back at root (VE-10). (f) Layout tests run at 1.0 and 1.3 only, which is also the cap because the app clamps text scale (`main.dart:79`, council VE-20). Size S-M.

## 4. Looked hard and found nothing

- Customer phone / OTP exposure: server `orderView` VENDOR branch blanks both; the app shows only the first name and the rider's phone (contract allows).
- Authz: a restaurant cannot read/act on another's orders or dishes (server checks owner on every route); the app sends no vendor id in the body for location.
- Double taps: Accept/Reject/Start/Ready are guarded twice (`_working` in the dialog, `_busy` in the controller) and the alarm pauses while an answer is in flight.
- Two orders at once: queued one dialog at a time by deadline; alarm continues until both are answered; duplicates from socket + poll + push collapse by id and `updatedAt`.
- Missed orders after reconnect: `onConnected` refresh + 15 s poll + resume refresh + refetch of live orders missing from the list; 429 pauses polling but sockets/FCM continue.
- Accept/reject with timeouts: the cancel is committed before the (slow) refund (`orderFlow.ts` cancelInTx then finishChange), so the app's 10 s timeout followed by a refetch correctly turns into success.
- Alarm start/stop: generation counter, watchdog and beep fallback are consistent; stops on cancel, expiry, answered on another phone, logout and dispose.
- Mirrored campus pins in `campus_geo.dart` equal `config/campus.ts`; Maps link is a plain https search URL built from numbers (no injection); no deep links or exported components besides MainActivity.
- No tokens or order data are logged by the app; notification payloads carry only `{event, orderId, v}`.
- Dashboard map popups use `textContent`, so a hostile restaurant name/dish name from this app cannot inject markup.
- A DB blip returns 503 (not 401), so it cannot log a cook out.

## 5. Top 5 to do before the demo

1. VE-01 + VE-02 (one backend select/response edit plus one defensive app line): make "fix a rejected application" work; if you do not fix it, do not demo the rejection path.
2. VE-03 + VE-04 (S): pop routes whenever the session leaves "approved", and alert the kitchen when Kraveo cancels an order in progress. Otherwise avoid "admin suspends" and "admin cancels an accepted order" on the restaurant phone, or keep the app closed and explain.
3. Run sheet for the restaurant scene (VE-06, VE-07, VE-05): distinct mobile per role (never the presenter's customer number), approve -> add one VEG dish -> tap OPEN -> refresh the customer app; decide the real support number (VE-08) or do not open the Help sheet.
4. VE-10 + VE-11 (S each) or the phone checklist: do not press Back; keep the app foreground and avoid pulling the shade or leaving a permission dialog open when the order is placed; set the alarm volume (Help sheet -> "Test the order alarm"), notifications allowed, battery "Unrestricted".
5. VE-09: decide what the Earnings tab means before showing it (or skip the tab on stage); show Food vs Total on the takeover.

## 6. What can only be proven on a real device / server

- That the bundled 20 s alarm actually rings from a locked, idle phone through the `new_orders` channel (channel sound is fixed once created: check the phone was not on an older build with a different channel), the once-a-minute reminders, DND behaviour, and Android 7-9 phones (no channels: default sound only).
- Alarm volume (alarm stream is not raised by the app), audio focus with a call/YouTube, and what Flutter reports (`inactive` vs `resumed`) with the shade down (VE-11).
- What Back does on the target phones (VE-10) and how OEM battery savers treat the app afterwards.
- Real GPS accuracy indoors/outdoors, "approximate location" permission behaviour, geolocator without Play Services (VE-17).
- Socket through nginx (websocket-only transport), FCM end to end, notification permission on Android 13+, and the stale tray notification after Accept.
- Hindi keyboard digits in the price field (VE-12) and the 360x640 look of the takeover with a long note on a real cheap phone.
- Whether the backend patch for VE-01/VE-02 landed (re-read `partners.ts` PUT /partner/application and `api.ts` partner-login before the demo).
