# DR - Delivery Partner app (apps/driver_app) - read-only bug hunt, 6 Oct 2026

Hunter: DR. Read-only. Nothing was run (no tests, builds, devices). Everything is traced in code; items that need a phone or the live server are labelled SUSPECTED. Backend line numbers are for the working tree as it is today (another agent is patching it, so re-check before fixing).

## 1. Scope covered

Read line by line:
- App: `lib/main.dart`, `lib/config/*`, `lib/models/*` (drop_point, geo, order_view, partner_session), `lib/session/session_controller.dart`, `lib/state/rider_controller.dart` (all 1122 lines), every file in `lib/services` (driver_api_service, rider_orders_api, rider_socket, location_source, navigation, partner_auth_service, push/*), every screen (login, signup, application_status, driver_home, driver_home_screen, active_delivery, earnings_history, trip_logs, runner_id_card), every widget (duty_toggle, swipe_accept_card, pipeline_stepper, gate_otp_dialog, earnings_card, support_sheet, account_sheet, notifications_banner, map/*, ui/*), `android/app/src/main` (manifest, MainActivity.kt, res), `android/app/build.gradle.kts`, `android/*.gradle.kts`, `pubspec.yaml`, plus the merged release manifest in `build/` and the geolocator_android 4.6.2 service/notification source in the pub cache.
- Shared UI: `packages/kraveo_ui` slide_confirm, button, pressable, glass_nav, misc (KAnimatedNumber, KEmptyState, showKSheet).
- Backend counterparts: `routes/orders.ts` (all), `services/orderFlow.ts` (all), `services/orderView.ts`, `realtime.ts`, `routes/partners.ts` (all), `routes/api.ts` 55-125, 215-280, 415-440, `services/orderMaintenance.ts`, `middleware/{auth,rateLimit}.ts`, `utils/{http,names,phone}.ts`, `services/{password,loginLimiter}.ts`, `services/push/events.ts`, `config/{orderFlow,campus}.ts`; Docs 16/18 (section 9)/19 by grep and the rider sections; earlier reports BE1, BE2, VE (read in full, not duplicated).
- Tests read in full: `support/*`, `rider_controller_test`, `rider_api_test`, `driver_tracking_test`, `widget_test`, `driver_app_test`, `signup_flow_test` lines 296-495.

NOT read line by line (titles/greps only): `test/auth_test.dart`, `signup_flow_test.dart` 1-295, `campus_navigation_test.dart`, `delivery_map_card_test.dart`, `push_app_test.dart`, `push_controller_test.dart`, `push_payload_test.dart`; `.idea/*`, launch drawables, `values-night/styles.xml`; backend `routes/devices.ts`, `services/push/{pushService,provider}.ts`.

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 3 |
| MEDIUM | 9 |
| LOW | 8 |

No way found to steal, double-claim, deliver without the OTP, or see another rider's data from this app; the server decides every status and the app never knows the OTP. The happy path (sign up, approval, duty on, offer, accept, pick up, arrive, code, delivered) is wired correctly against the real backend contract. The HIGHs are demo-scene breakers on side paths: the OTP lock never clears on the rider's phone after an admin reset, "fix and re-apply" shows a false error, and the support / emergency number is a placeholder.

## 3. Findings

### HIGH

**DR-01 - After an admin resets the OTP lock the rider's phone stays locked until the app is killed** - HIGH - CONFIRMED
- Where: `lib/state/rider_controller.dart:126,140,871,889-897` (`_lockedIds` is only ever added to, never removed), `lib/screens/active_delivery.dart:95,179,190-195,226-233` (locked = no "Enter customer's code" button, only "Call Kraveo support"). Backend `orderFlow.ts:690-698` (reset sets `otpLocked=false`, new code, new `updatedAt`, pushes `order_updated` to the rider). The rider view never carries `otpLocked` (orderView.ts:146-151), so the app cannot learn it.
- Trigger: demo scene "customer reads a code, rider types 5 wrong codes -> locked; admin presses Reset OTP lock in the dashboard; rider enters the NEW code".
- What happens: the order copy updates, but `activeLocked` stays true. The red banner "Too many wrong codes. Do not hand over the food until Kraveo support unlocks it" stays, the keypad button is replaced by "Call Kraveo support", and even `verifyOtp()` returns `locked` at line 871 without asking the server. Only killing and reopening the app (memory is reset) shows the keypad again. The rider has no hint to do that.
- Demo impact: the "OTP lock + admin reset" step cannot finish on the rider phone without an app restart.
- Minimal fix (S): remember the server `updatedAt` when the lock was set and clear the lock when any newer copy of that order arrives (socket or poll), because a locked order is not modified by further attempts (423 returns before any write) so a newer `updatedAt` means an admin acted; or drop the local short-circuit and show "Try the code again" next to "Call support" (a 423 from the server is free, it consumes no attempt). Add a controller test "locked -> newer copy -> unlocked".
- OWNER-INPUT: no.

**DR-02 - "Update details and apply again" (and "Change my details") shows "Kraveo is having trouble" although the server accepted it** - HIGH - CONFIRMED (same root cause as VE-01; it hits the rider app too)
- Where: `lib/services/partner_auth_service.dart:223-246` (`resubmit` -> `_signupResult`; a 200 without a readable `user` becomes `SignupFailure.server`), `lib/models/partner_session.dart:96-98,116-118` (`fromMeJson` needs `json['user']`), backend `routes/partners.ts:382-388` (PUT /partner/application answers `{success, approvalStatus, rejectionReason, driver}` with NO `user`). The fake in `signup_flow_test.dart:319` returns a ready-made session, so the test never sees the real shape.
- Trigger: a rider is REJECTED (admin gave a reason) or still PENDING, edits the form, taps "Send again".
- What happens: the server really resets the application to PENDING and pings the dashboard; the app answers with the red box "Kraveo is having trouble. Please try again in a moment." and keeps the form open. Within 20 s the status screen underneath flips to "Thanks! We are checking your details" while the form is still on top. Tapping again repeats the same false error.
- Demo impact: the "admin rejects the rider, rider fixes the plate and re-applies" scene looks broken on stage.
- Minimal fix (S): backend adds `user:{id,name,phone,role,avatarId}` to the PUT response (same as /partner/me); app side, treat a 200 with no readable user as success, `popUntil(first)` and call `refreshApproval()`. Add an HTTP-level test with the real response body.
- OWNER-INPUT: no.

**DR-03 - The support / emergency number is a placeholder (+91 98765 43214) and sits behind the red siren button** - HIGH - CONFIRMED
- Where: `lib/config/support_config.dart:8` (the file says "UNVERIFIED ... Replace it before release"), used by `widgets/support_sheet.dart:50-51`, `screens/driver_home.dart:235` (siren icon, label "Emergency campus support"), `screens/active_delivery.dart:232,441` (locked delivery, cancelled order). The login screen says "Forgot password? Ask Kraveo support." with no number at all (`login_screen.dart:302`); the status screens say "Ask Kraveo support" (`application_status_screen.dart:92,233`) with no number either.
- Trigger: any rider (or the audience) taps the siren, a locked delivery or a cancelled order.
- What happens: a big "Kraveo support +91 98765 43214" (an obviously sequential number) is shown. A rider in a real emergency copies a number nobody may answer.
- Demo impact: visible in two taps; and a safety label on a fake number is a honesty problem.
- Minimal fix (S): put the real, staffed number in `SupportConfig.phone` (the vendor app has its own copy of the same placeholder, VE-07). Show the number on the login and status screens too. OWNER-INPUT: yes (the number).

### MEDIUM

**DR-04 - The "Call" buttons never call; the customer cannot be dialled from the delivery screen** - MEDIUM - CONFIRMED
- Where: `widgets/support_sheet.dart:7-9,28-41` (comment "The app has no dialer plugin" is stale: `url_launcher` is a dependency, `pubspec.yaml`, and `services/navigation.dart` already launches external intents), `screens/active_delivery.dart:343-348` (button labelled "Call" opens a "Copy number" sheet).
- Trigger: rider at the gate taps "Call" next to the customer's phone.
- What happens: a sheet with the number and "Copy number"; the rider must leave the app, open the dialer, paste. Same for the siren/support.
- Demo impact: the audience expects a dialer; with one hand on a bike it is slow.
- Fix (S): `launchUrl(Uri(scheme: 'tel', path: number))` through the existing `UrlNavigationLauncher`, keep "Copy number" as the fallback. `tel:` needs no `<queries>` entry for `launchUrl`.

**DR-05 - Runner ID pass shows "ID verified" and "SCAN AT HOSTEL GATE" over a fake QR code** - MEDIUM - CONFIRMED (the code says so itself)
- Where: `widgets/ui/pass_qr.dart:3-6` ("visual placeholder, not a scannable QR code"), `screens/runner_id_card_screen.dart:102-105,135-137`; also reachable from the Home header and the account sheet. The badge reads "ID verified" for every approved rider. The test `driver_app_test.dart:419-430` even asserts the placeholder rider ("Vikram Singh", "RUN-8042") renders.
- Trigger: the presenter or a guest opens the pass and a security guard (or phone) scans it.
- What happens: random squares seeded from the runner code; nothing scans. The text promises a gate scan and a verification.
- Demo impact: looks premium, fails the first time someone scans it. Misleading UI.
- Fix (S): remove the QR block and "ID verified" until a gate-verification payload exists, or label it "Show this pass; the guard checks the code RUN-xxxx". OWNER-INPUT: yes (is a gate scan planned?).

**DR-06 - Going off duty (or logging out) while carrying food stops all location sharing: the customer's live map and the dashboard lose the rider** - MEDIUM - CONFIRMED in code; OWNER-INPUT (policy)
- Where: `rider_controller.dart:286-311` (`_stopLocation()` at 291 whatever `_active` is; message "Please still finish the delivery" at 306-308), `stopForLogout` 350-357, server `partners.ts:333-349` (OFFLINE even with an active order; `refreshRiderDuty` in `orderFlow.ts:108-121` only flips ONLINE<->IN_TRANSIT, never OFFLINE), `realtime.ts:259` (no dashboard broadcast while OFFLINE). Docs/19 s.4 says "no sends when OFFLINE", so this is the contract, but the consequence is not handled.
- Trigger: rider with an active delivery taps the big duty switch (the largest control on Home) or logs out and back in (after re-login duty is OFF; nothing asks them to turn it on, the Home card just says "In progress").
- What happens: the foreground service stops, no more `POST /drivers/location`; the order is still PICKED_UP; customer tracking freezes at the last point, admin map drops the rider, dashboard shows OFFLINE for a rider with food.
- Demo impact: "admin watches the live map" shows the rider vanish mid-delivery after one accidental tap.
- Fix (S-M): keep sharing while `_active != null` regardless of the duty switch (stop only when no job), or ask "You are carrying an order, stay on duty?" before turning off; after a restore with an active job, auto-resume sharing. OWNER-INPUT: yes (is "off duty" allowed with a job?).

**DR-07 - The phone and the server can disagree about duty, and the app never re-reads it (silent "ON DUTY, receiving orders" with no orders; or "OFF" while the dashboard says ONLINE)** - MEDIUM - CONFIRMED
- Where: (a) `routes/api.ts:422-431` (logout on ANY phone sets the rider OFFLINE and drops the `drivers` room) vs `rider_controller.dart:552-573` (`refreshOffers` treats the empty `[]` that `orders.ts:162` returns for OFFLINE as "no orders") - phone A keeps the green ON DUTY switch, GPS posts that nobody sees, and never gets an offer or a push; the only place the app reacts is the claim error `RIDER_OFFLINE` (line 632). (b) `rider_controller.dart:331-333` (on a network failure while restoring "on duty" after a restart the app sets itself OFF and writes the preference false) while the server still says ONLINE: dashboard counts an "online" rider, `NEW_DELIVERY` pushes keep ringing (`push/events.ts` `idleRiders` uses server state), the app shows OFF. The test `rider_controller_test.dart:87-93` asserts exactly this. (c) `_pendingOffSync` (line 103) is memory only: a rider who went off with no internet and then was killed leaves the server ONLINE for good.
- Trigger: (a) two phones / emulator + phone with one account, one logs out; (b) app reopened on a weak network (very common on a campus); (c) rider switches off in a dead zone and closes the app.
- Demo impact: "rider goes on duty" scene on a second device shows no offers although the dashboard says ONLINE, or an "online" count that does not match the phones.
- Fix (S): on `pollNow` read `dutyStatus` (add it to a cheap GET, e.g. `/drivers/:id` already returns it for the rider) and mirror it; do not clear the saved duty preference on a network failure, retry the ON in `pollNow`; persist `_pendingOffSync`.

**DR-08 - An accepted job is orphaned when the rider logs out, goes offline or loses the phone; nothing returns it to the pool** - MEDIUM - CONFIRMED; OWNER-INPUT (business rule)
- Where: `driver_home.dart:167-179` (logout confirm warns, does not release), `api.ts:422-431` (logout only sets OFFLINE), `orderFlow.ts:564-575` (release is rider-initiated only), `orderMaintenance.ts` (never touches rider-held orders), `orders.ts:483-486` (needs-attention only flags a held order after it is READY_FOR_PICKUP for 15 min). Pool visibility is `driverId = null` (orders.ts:164) so no other rider ever sees it.
- Trigger: rider accepts an order (any time from ACCEPTED), then logs out, closes the app, or the phone dies. Also the cheating rider who "accepts and sits".
- What happens: the order stays assigned to an offline rider; the customer waits; the admin learns only at READY+15 min.
- Demo impact: a rehearsed demo that ends with "log out" while an order is accepted leaves a stuck order for the next run.
- Fix (S-M): when a rider logs out or goes off duty with a job still before pickup, release it automatically (server side in logout/duty-status), and add a needs-attention rule for "rider offline holding an order".

**DR-09 - After a fresh login the app has none of the rider's vehicle/plate/UPI/emergency details; "Update details" opens blank and silently changes the vehicle to Bike** - MEDIUM - CONFIRMED (mirror of VE-02)
- Where: backend `routes/api.ts:256` (partner-login selects only `id, runnerCode, approvalStatus, rejectionReason` for the driver) vs app `partner_session.dart:80-92`; `session_controller.dart:151-171` (`refreshApproval` stores the fuller `/partner/me` profile but only notifies when approval or reason changed); `main.dart:171-179` (`onEdit: () => _openSignup(existing: me)` captures the stale `me` from the last build); `signup_screen.dart:32` (unknown vehicle defaults to "Bike").
- Trigger: a PENDING/REJECTED rider logs in (second phone, next day, after "Session expired"), opens "Change my details" / "Update details and apply again".
- What happens: status card shows "VEHICLE -", the form has an empty plate, vehicle chip "Bike" even for a Cycle rider (a Cycle rider then needs a plate or must re-pick). Sign-up and cold-start restore are fine (they use /partner/me).
- Fix (S): add the four fields to the driver select at api.ts:256 (or call `fetchProfile` right after login), and notify in `refreshApproval` when any detail changed.

**DR-10 - A suspended rider is told "Session expired", mid-delivery included; the test for this path simulates something the server never sends** - MEDIUM - CONFIRMED
- Where: backend `partners.ts:475-478` (suspension bumps `tokenVersion`, kills sockets; old token gets 401 `TOKEN_REVOKED`), app `main.dart:139-156` (snackbar "Session expired. Please log in again."), `session_controller.dart:165-167` (`expire()` from `refreshApproval` shows nothing at all), test `signup_flow_test.dart:375-398` (models suspension as `/partner/me` 200 SUSPENDED + 403 PARTNER_NOT_APPROVED, which never happens).
- Trigger: admin suspends a rider who is on duty or carrying food (demo scene "admin suspends").
- What happens: within <=15 s the rider is thrown to the login with "Session expired"; only after logging in does the "Your account is paused" screen appear. The in-progress order (with the OTP step) disappears from the phone; the order stays assigned to the suspended rider (admin sees RIDER_NOT_APPROVED) and must be reassigned.
- Fix (S): after a revoked session show "Your session ended; log in to see your account status"; fix the test to use 401. Procedurally: reassign the order before suspending.

**DR-11 - GPS quality is never checked: no staleness watchdog, "approximate" or mock locations are posted as truth** - MEDIUM - CONFIRMED in code; device effect SUSPECTED
- Where: `location_source.dart:104-105,121` (only lat/lng/heading are kept: no accuracy, no timestamp, no `isMocked`), `location_source.dart:117-134` (the wrapper controller never completes when the plugin stream ends, so `onDone` never reaches `_trackLost`), `rider_controller.dart:163` (`lastFixAt` exists but nothing reads it), `driver_home.dart:466-469` (the green line "Live location is being shared" stays as long as the state is `ok`), backend `realtime.ts:239-251` (accepts any valid world coordinate).
- Trigger: Android 12+ rider picks "Approximate" in the permission dialog (campus is < 1 km wide; an approximate fix is off by hundreds of metres to kilometres); GPS stalls indoors or the OEM freezes the service; a rider uses a fake-GPS app.
- What happens: the customer map and dashboard show the rider in the wrong place while the rider's phone says everything is fine. A stalled stream is never noticed.
- Fix (S): keep `accuracy`, `timestamp`, `isMocked` in `LocationReading`; show "Finding your location..." when no fix for 45 s; treat accuracy > 150 m as "weak GPS" with a hint to choose Precise; forward `out.close()` from the stream's `onDone`. Server: optionally ignore fixes far from campus.

**DR-12 - `mapsAvailable()` may be false on every Android 11+ phone, so the real map never appears even with a key** - MEDIUM - SUSPECTED (needs a device)
- Where: `MainActivity.kt:41-53` (`getPackageInfo("com.google.android.gms")`), merged manifest `<queries>` (only `com.google.android.apps.maps` plus the intents; no `com.google.android.gms`). If package visibility hides Play services, the call throws and the app silently shows the plain distance card (graceful, but the "map" demo feature is gone).
- Trigger: any Android 11+ phone with a build that has the Maps key.
- Fix (S): add `<queries><package android:name="com.google.android.gms"/></queries>`; confirm once on the demo phone that the map shows. Also confirm the Maps key is restricted to package `site.kraveo.driver` + the debug-signing SHA-1 in the Google console. OWNER-INPUT: console.

**DR-13 - Test gaps: several tests pin the wrong behaviour or never meet the real server shape** - MEDIUM (test quality) - CONFIRMED
- `rider_controller_test.dart:87-93` asserts that a failed duty restore clears the saved duty (DR-07). `signup_flow_test.dart:319,375-398` use a fake session / a 403 the server never sends (DR-02, DR-10). `driver_app_test.dart:178-193,300-313` encode the sticky lock (DR-01) and nothing tests an unlock. No test for: a poll that was in flight when a job was released/finished (DR-14), duty OFF with an active job (DR-06), the real `PUT /partner/application` body, a rider logging in with the real partner-login body (DR-09), `release` response shape. `fake_rider.dart` uses legacy drop names ("Block 2", "Girls Gate 1") only. `widget_test.dart` only checks that the widget exists.

### LOW

**DR-14 - A poll that was already in flight can resurrect a job the rider just released or delivered** - LOW - CONFIRMED by trace, timing-dependent
- Where: `rider_controller.dart:689-718` (the list `r.value` is read after `await`, then `if (_active == null && live.isNotEmpty) _setActive(live.first)` at 715 uses a snapshot older than the rider's own action), `release` 949-958, `_finish` 780-800.
- Trigger: the 15 s poll is on the wire while the rider confirms Release or the OTP (a few hundred ms window, longer on slow networks).
- What happens: the released/delivered order reappears as the active job (old status), then the next poll fixes it with a second "moved away from you" or a duplicate "Delivered" card.
- Fix (S): ignore a `fetchActive` result that started before the last local action (compare timestamps like `_removedAt` does), or skip `_setActive` for ids released/finished in the last minute.

**DR-15 - "On duty" is saved per phone, not per rider, and survives a session expiry or suspension: the next login goes on duty by itself** - LOW - CONFIRMED
- Where: `rider_controller.dart:79,209,213` (pref `kraveo_driver_duty_online`), only `stopForLogout` (350-357) clears it; `session_controller.dart:174-183` (`expire()` does not). Trigger: token expires or admin suspends while on duty, then a different rider (or the same one, unaware) logs in on that phone: `start()` re-sends duty ON and starts GPS sharing without a tap. Fix (S): clear the key in `_clearAll()` or key it by user id.

**DR-16 - Easy mis-taps on the offer card: an X that hides the order for the whole session, and a one-tap Accept under the slider** - LOW - CONFIRMED
- Where: `swipe_accept_card.dart:78-90` (48 dp X next to the status chip, no undo), `rider_controller.dart:583-587` (`_dismissed` is never cleared, not even when the order becomes READY or the rider goes off/on duty), `swipe_accept_card.dart:130` ("Accept with one tap" directly under the slide, which defeats the slide).
- What happens: a hidden order never returns until the app is restarted (rider sees "waiting for orders" with an unattended order in the pool); an accidental accept blocks the rider (MAX one active order) until they find Release. Fix (S): clear `_dismissed` when going on duty again / after 10 min, move X away from the chip, drop the one-tap button or keep it only for accessibility services.

**DR-17 - A finished-delivery notice hides the next job** - LOW - CONFIRMED. `active_delivery.dart:38-45` shows the notice before any new order; `driver_home.dart:138-141` jumps to the Active tab after accepting. After delivering order 1, going Home and accepting order 2 opens the "Delivered" card for order 1; the rider must tap "OK, got it" to see order 2. Fix (S): clear the notice when a new job is set (`_setActive`).

**DR-18 - "Restaurant location not set - call the restaurant", but the rider is never given the restaurant's phone** - LOW - CONFIRMED. `active_delivery.dart:127-131`; `orderView.ts:75` (the rider view has no vendor phone). Likely for a restaurant that signed up without a GPS pin. Fix (S): copy "Ask Kraveo support" (or expose the vendor phone to the assigned rider; OWNER-INPUT).

**DR-19 - Login token and profile are in plain SharedPreferences and the app allows Android backup** - LOW - CONFIRMED. `driver_api_service.dart:48-54`; no `android:allowBackup` in `AndroidManifest.xml` or the merged manifest (default true), so the 30-day JWT can leave the phone via `adb backup`/cloud restore. Same as VE-06. Fix (S): `android:allowBackup="false"` and exclude the prefs (or `flutter_secure_storage`).

**DR-20 - Home shows "DELIVERY FEES TODAY ₹0" when the history call failed** - LOW - CONFIRMED. `rider_controller.dart:1058-1062` leaves `_historyLoaded=false`; `driver_home.dart:259-265` renders zeros with no error hint (only the Earnings tab says so). Fix (S): show "-" or a retry hint on the hero when `historyError && !historyLoaded`.

**DR-21 - The OTP keypad stays on top of a cancelled or moved order** - LOW - CONFIRMED. `active_delivery.dart:88-98` (`barrierDismissible:false` dialog) while the notice replaces the screen under it; further digits answer "This delivery is no longer on your phone" (rider_controller.dart:869) and only the X closes it. Fix (S): `Navigator.pop` the dialog when `controller.active` becomes null.

## 4. Looked hard and found nothing

- Two riders racing for one order, "MAX one active order", accept of an unpaid/cancelled order: server row locks (`claimOrder`), the app only trusts the server answer; offline/timeout re-reads `GET /orders?scope=active` before saying anything (`rider_controller.dart:657-666`).
- Slide cannot double-fire; claim/advance/OTP calls are guarded by `_claimingId`/`_actionBusy`/`_isVerifying`; a repeated PICKED_UP / ARRIVED / correct OTP is an idempotent success on the server.
- OTP handling: 4 digits, only the server checks, tries left shown, 5 wrong = 423, local lock does not call the server again, `otpCode` is dropped when parsing, no OTP in logs or pushes.
- Socket + poll + push duplicates: orders are merged by `updatedAt` with a status-rank tie-break; `_removedAt` stops a late poll from bringing back an order removed over the socket; foreground pushes only trigger one poll; push taps are de-duplicated for 30 s.
- Stale or missing data never wipes the screen (`activeStale`, `offersStale`), and a missing active order is confirmed with `GET /orders/:id` before it is removed (reassigned/cancelled notices are accurate).
- Rider cannot see another rider's order or the customer before assignment: pool view has no customer, no notes; `GET /orders/:id` and room joins re-check `driverId`.
- Navigation: URLs are built only for valid coordinates, a placeholder restaurant pin (`hasLocation:false`) is never navigated to, three fallbacks (google.navigation, geo, https), a message when none opens; no deep links or exported components besides the launcher activity.
- Foreground service wiring: manifest has FINE/COARSE, FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION, POST_NOTIFICATIONS; geolocator 4.6.2 declares `foregroundServiceType="location"`; the duty channel is created LOW first (an existing channel keeps its importance); stream is cancelled on duty off, logout, dispose (`unawaited(sub.cancel())`) which stops the service and the notification; location is not requested until duty ON; no background-location permission is needed because the service is started while the app is on screen.
- Sign-up validation (name, 10-digit 6-9 phone, 8-char password, plate for Bike/Scooter only, emergency number must differ, UPI shape) matches the server rules; phone/password limits and error fields map to the right inputs; double submit is blocked.
- Earnings: all rider fees are the flat Rs 25 (`validation.ts:59`), sums use the device's local day (IST on phones), only DELIVERED orders count, no rounding problem today.
- Release APK config: https production URL const, cleartext only in the debug manifest, no literal Maps key in the repo (injected by Gradle), Firebase package name matches `site.kraveo.driver`.

## 5. Top 5 to fix before the demo

1. DR-01: unlock the rider's keypad after an admin reset (S). Otherwise the "OTP lock" scene needs an app restart.
2. DR-02: make "Send again" succeed (backend adds `user` to the PUT response, app treats 200 as success) (S).
3. DR-03: put the real support number in `SupportConfig.phone` and show it on login/status screens (S, OWNER-INPUT).
4. DR-06 + DR-07: keep location sharing while a job is active, and re-read duty from the server so a second phone or a bad network cannot leave the rider "ON" with no offers or "OFF" while the dashboard says ONLINE (S-M). If there is no time: brief the presenter (one phone per rider account, never log out or toggle duty with a live order, reopen the app on good network).
5. DR-05 (and DR-04 if time): remove the fake QR / "ID verified" claim; make "Call" open the dialer (S each).

## 6. What can only be proven on a real device / server

- Whether the geolocator foreground service survives screen-off for several minutes on the owner's phone (battery saver, Doze when stationary at a gate), that the "Kraveo - you are on duty" notification is actually visible (a phone that ran an older build may already hold the channel at importance NONE), and behaviour on Android 13/14/16 when notifications or "Precise" location are denied.
- Whether starting the stream after the first `read()` can fail when the rider locks the phone within a couple of seconds of going on duty (Android 12+ foreground-service start restrictions); the code falls back to the 10 s timer, but the timer is not reliable with the screen off.
- DR-12 (package visibility of Play services) and whether the Google map really draws with the build's key, and that the key is restricted in the Google console.
- Push timing: `NEW_DELIVERY` is pushed only when the restaurant marks READY (`push/events.ts`, READY_FOR_PICKUP case); an order that is only ACCEPTED/PREPARING reaches a locked phone only through the socket, so a rider with the screen off hears nothing until READY (by design, but say it in the demo script).
- Real socket reconnect behaviour on flaky networks (BE1-11), the 20 s worst-case spinner on Accept/OTP when the network is slow (10 s call + 10 s re-check), and DR-14 timing.
- Two-phone, same-account behaviour (DR-07a) and the full admin flows (reset OTP, suspend, reassign) against the live dashboard.
