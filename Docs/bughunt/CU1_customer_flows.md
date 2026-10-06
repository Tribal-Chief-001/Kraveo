# CU1 - Customer app, demo path (sign-in to checkout to history to profile)

Hunter: CU1. Date: 6 Oct 2026. Read-only review; nothing was built, run or changed. All paths are under `/home/lucifer/Documents/Projects/Kraveo`.

## 1. Scope covered

Read completely (every line):
- `apps/customer_app/lib`: `main.dart`, `config/*`, `models/*` (all 8), `providers/{session,cart,dhaba,order}_provider.dart`, `services/{customer_api_service,google_auth_service,payment_gateway,order_api}.dart`, `screens/{auth,profile_setup,profile,home,dhaba_menu,checkout,payment_success,order_history}_screen.dart`, `widgets/{cart_sheet,coupon_box,customization_modal,dhaba_card,split_bill_modal,delivery_confirm_sheet,review_modal,push_permission}.dart`, `widgets/ui/*` (all except the unused `otp_boxes.dart`, read only to line 60), `models/order.dart` (needed for the state machine).
- `apps/customer_app/android/app/build.gradle.kts`, `AndroidManifest.xml`, `MainActivity.kt`, `gradle.properties`, `google-services.json` (structure only), the merged release manifest under `build/`, `pubspec.yaml`.
- `packages/kraveo_ui`: `button`, `pressable`, `misc` (KAnimatedNumber, KChoiceChip, showKSheet, KEmptyState), `glass_nav`, `kraveo_theme`, `tokens`, `typography`, `avatar` (first 260 lines).
- Server code used to verify contracts: `backend/src/utils/validation.ts` (pricing and coupons), `utils/catalog.ts` (vendor and menu public view), `services/orderFlow.ts` (idempotency replay), `routes/orders.ts` (POST /orders), `routes/api.ts` (/vendors, /auth/profile, /auth/account, /reviews), `config/campus.ts`.
- Tests: `customer_app_test`, `widget_test`, `ui_screens_test` (first 200 lines), `order_flow_widgets_test` (checkout group), `account_flow_test` (API/session parts), test names of `campus_drop_points_test` and `order_provider_test`.

Not read: `live_tracking_screen.dart`, map widgets, `services/push/*`, `order_realtime.dart` (CU2); `animated_rider_map`, `widgets/map/*`; `kraveo_ui` avatar art, `skeleton`, `status_pill`, `slide_confirm`, `card`; the bodies of `campus_drop_points_test`, `order_provider_test`, `push_*_test`, `order_fixtures_test`.

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 (but see CU1-05: if the Google client is not configured, the demo cannot start) |
| HIGH | 5 |
| MEDIUM | 10 |
| LOW | 12 |

## 3. Findings

### HIGH

**CU1-01 - Coupons are decided on the phone with different rules than the server; the advertised ones fail at checkout** - HIGH - CONFIRMED - OWNER-INPUT (coins/coupon policy)
- Where: `apps/customer_app/lib/providers/cart_provider.dart:123-179` (client rules), `widgets/coupon_box.dart:439-456` (one-tap "Try VITFIRST: 20% off your first order", always shown), `screens/home_screen.dart:371-433` (promo card), vs `backend/src/utils/validation.ts:21-54` (server rules).
- Trigger: a customer who already has any non-cancelled order (the demo account after a rehearsal) taps the VITFIRST promo, applies it in the cart, pays. Or anyone types KRAVEO20 (the client accepts it for a subtotal of 80 or more; the server needs 50 coins redeemed through `POST /coupons/redeem-coins`, which the app never calls) or KRAVEO50 a second time (once per customer on the server).
- What happens: cart and checkout show "VITFIRST applied. You save ₹36" and "Pay ₹184". On Pay, `POST /orders` answers 400 `COUPON_NOT_APPLICABLE` ("VITFIRST is only for your first order." / "KRAVEO20 needs 50 Kraveo Coins..."). The app shows it as a red snackbar and notice, and the student must scroll to the coupon box in the summary and tap Remove before paying again. The error text for an unknown code even suggests "Try VITFIRST or KRAVEO20".
- Demo impact: the first visible coupon in the demo fails live. The Home hero promo says "FIRST ORDER" to everybody.
- Minimal fix: (a) show the promo and the VITFIRST chip only when the student has no orders (`orders.history.isEmpty && hasLoadedHistory`), (b) on `COUPON_NOT_APPLICABLE` auto-remove the coupon (`cart.removeCoupon()`), keep the checkout on screen and show a one-line "Coupon removed: <server reason>. Total is now ₹X", (c) drop KRAVEO20 from the client and from the hint text until a redeem screen exists. Size: S-M.
- Test note: `test/customer_app_test.dart` ("Promo Code KRAVEO20 - Flat ₹20 OFF calculation") asserts the broken client-side behaviour as correct.

**CU1-02 - Failed, slow or empty catalog shows invented restaurants; no error, no retry** - HIGH - CONFIRMED
- Where: `providers/dhaba_provider.dart:24-272` (hard-coded "Sharma Highway Dhaba", "FC Night Mess" ... with Unsplash photos, 4.8/4.9 ratings, fake ids `ven-1..4`), `:327-357` (`loadCatalog` returns silently on `vendors.isEmpty` or any exception), `screens/home_screen.dart:49-54` (skeleton for at most 4 s, then the fake list), `:57` and no `RefreshIndicator` anywhere on Home.
- Trigger: backend slow or restarting (the other agent is patching it now), venue Wi-Fi above 4 s, `/vendors` returns 0 approved restaurants, or the 15 s timeout fires.
- What happens: after 4 s Home lists four restaurants that do not exist, with fake ratings and "Open till 3 AM" tags. Tapping one opens a menu with fake dishes; the student can fill the cart. When the live data finally arrives the lists are replaced (`_menuItems.clear()`), the open menu turns into "Menu coming soon", the cart still holds fake items, and checkout refuses with "This kitchen's live menu hasn't loaded" (`checkout_screen.dart:153-156`) even though it did load. If the load failed, nothing ever retries until the app is restarted. When `vendors.isEmpty` the previous live ids stay in `_liveVendorIds` while the fake list is shown.
- Demo impact: on a bad network the audience sees restaurants that are not in the admin dashboard and an unrecoverable cart.
- Minimal fix: delete the built-in catalog (or show it only under a debug flag); on failure show `KEmptyState` "Can't load kitchens" with a Try again button; add pull-to-refresh; on empty list say "No kitchens are open right now". Size: S-M. The tests that rely on the fake catalog (`customer_app_test` "initial list of dhabas == 4", `ui_screens_test` Home test) must inject a catalog instead.

**CU1-03 - The catalog is loaded once and never refreshed (open/closed, sold-out, new restaurant)** - HIGH - CONFIRMED
- Where: `loadCatalog` is called only from `home_screen.dart:51` (initState). `HomeScreen._lifecycle.onResume` (`:34-36`) refreshes orders only. `DhabaMenuScreen` takes a snapshot `widget.dhaba` (`dhaba_menu_screen.dart:24`).
- Trigger: a restaurant marks a dish sold out or closes during the demo (the vendor-app part of the demo script), or a new restaurant is approved after the customer app was opened.
- What happens: the customer app still shows ADD on the sold-out dish and "Open" on the closed kitchen. At checkout the server answers "Item 'X' is currently SOLD OUT." or `VENDOR_CLOSED`; the student cannot fix the menu without killing the app. The new approved restaurant never appears.
- Minimal fix: reload the catalog on app resume, on pull-to-refresh, when a menu opens, and after any `INVALID_ITEMS`/`VENDOR_CLOSED` error. Size: S.

**CU1-04 - Any non-401 error from `GET /auth/profile` at app start signs the student out** - HIGH - CONFIRMED
- Where: `services/customer_api_service.dart:101-133` (a 502/503/500/429 is returned as `success:false, networkError:false`), `providers/session_provider.dart:104-120` (`restore()` treats everything except `networkError` as "token no good": `clearToken(); _endSession()`).
- Trigger: open the app while the backend is restarting or redeploying (nginx 502 HTML page, Prisma outage, rate limit 429). The existing test only covers a thrown exception (`account_flow_test.dart:427`).
- What happens: the saved token is deleted and the student lands on the Google welcome screen with no explanation; the sign-in must be repeated (and fails too if the backend is still down). With the backend being patched right before the demo this is likely.
- Minimal fix: in `restore()` clear the token only for 401/403/404; for status 429 and 5xx (and unparseable bodies) set `SessionStatus.unreachable` like a network error. Size: S.

**CU1-05 - Google sign-in may not work in the shipped build: `google-services.json` has no Android OAuth client for `site.kraveo.customer`** - HIGH - SUSPECTED (needs a device) - OWNER-INPUT (Firebase/Cloud console)
- Where: `android/app/google-services.json`: for package `site.kraveo.customer` the `oauth_client` list contains only the type-3 (web) client, no type-1 entry with a certificate hash. The release APK is debug-signed (accepted), so the debug SHA-1 (`60:FA:23:...`, see memory `kraveo-maps-campus-status`) must be registered as an Android OAuth client for this package, and the web client id must be the audience the backend expects (`GOOGLE_WEB_CLIENT_ID`).
- What happens if it is not registered: Credential Manager returns "no credential" or developer error; the app maps this to "Google sign-in isn't set up correctly in this build" (`google_auth_service.dart:61`) and the demo cannot start.
- Check: sign in once on the exact APK that will be demoed, with a Google account that was never used before, before the demo. Size: console work only.

### MEDIUM

**CU1-06 - Reorder looks the kitchen up in the *filtered* Home list and wipes the cart without asking** - MEDIUM - CONFIRMED
- Where: `screens/order_history_screen.dart:150` uses `dhabaProvider.dhabas`, a getter that applies the Home search text, category chip and "favourites only" (`dhaba_provider.dart:289-319`); `:159` calls `cart.clearCart()` before knowing anything can be added.
- Trigger: on Home tap the heart (favourites only) or a category chip or type a search, go to Orders, tap Reorder on a delivered order whose kitchen is filtered out.
- What happens: "Sharma... isn't taking orders in the app right now." (false). The existing cart (maybe from another kitchen) is already gone. Even without filters, the existing cart is silently replaced.
- Fix: look up in an unfiltered accessor (e.g. `dhabaProvider.byId(id)`); ask with `showKConfirm` if the cart is non-empty. Size: S. No test covers Reorder.

**CU1-07 - Money is displayed in whole rupees but charged in paise** - MEDIUM - CONFIRMED
- Where: `widgets/ui/format.dart:5` (`rupee()` = `value.round()`), `KAnimatedNumber(decimals: 0)` for "To pay" (`bill_breakdown.dart:77`), vs server `round2` and Razorpay amount in paise (`validation.ts:150-166`, `payment_gateway.dart:222`); the server accepts menu prices with 2 decimals (`catalog.ts` `priceProblem`).
- Trigger: VITFIRST on a subtotal that is not a multiple of 5 (e.g. ₹188: discount 37.6, total 188+25+15-37.6 = ₹190.40), or any dish priced like ₹99.50.
- What happens: the bill shows "-₹38", "To pay ₹190" and the Pay button "Pay ₹190"; the Razorpay sheet then shows ₹190.40, and the rows rounded one by one (188, 25, 15, -38) sum to 190 only by luck in other carts. The student sees two different amounts on the same order.
- Fix: one formatter that shows paise when the amount has any (`₹165.40`), used everywhere including `KAnimatedNumber(decimals: 2)` when needed. Size: S.

**CU1-08 - "Min ₹99", delivery fee, ETA and 4.5 rating on every restaurant are invented client defaults and "Min" is never enforced** - MEDIUM - CONFIRMED - OWNER-INPUT
- Where: `models/dhaba.dart:325-326,366,367,371,372` (defaults 25, 99, 4.5, "25-30 mins"), `widgets/dhaba_card.dart:369`, `screens/dhaba_menu_screen.dart:147`; the server `publicVendorView` (`backend/src/utils/catalog.ts`) sends no `minOrder` or `deliveryFee`; the DB defaults give every new restaurant rating 4.5 and eta "20-25 min".
- What happens: every kitchen says "Min ₹99" but a ₹40 cart pays normally (neither client nor server checks it); the card advertises a rating and ETA nobody measured.
- Fix: remove "Min" and the rating/ETA chips until real data exists, or enforce the minimum on both sides. Size: S. Needs the owner's decision.

**CU1-09 - Home category chips are hard-coded and do not match what live restaurants contain** - MEDIUM - CONFIRMED logic, data-dependent
- Where: `dhaba_provider.dart:14-22,296-301` (chips Night Mess/Thalis/Fast Food/Beverages/North Indian/Parathas filter on the restaurant's `category` text or `tags`); live vendors have no `tags` (server never sends them) and free-text categories (default "North Indian • Campus Dhaba").
- What happens: tapping most chips shows "No kitchens match" although the kitchens sell those dishes.
- Fix: build the chips from live menu item categories (the menu screen already does) or remove them. Size: S.

**CU1-10 - Double-tap on Pay can stack two "Confirm your delivery point" sheets or confirm the point by accident** - MEDIUM - SUSPECTED (device)
- Where: `screens/checkout_screen.dart:103-138`. `_busy` is only set later (`:159`, `:195`), after `await showConfirmDeliveryPoint(...)` (`:129`).
- Trigger: double-tap the Pay button (nervous presenter). The second tap lands on the sliding-up sheet, whose footer ("Confirm and pay"/"Cancel") sits where the Pay button was, or opens a second sheet.
- What happens: the point is confirmed without the student reading it (defeats the confirmation), or two sheets are stacked and one stays open after the first completes. No duplicate order (the provider de-duplicates, `order_provider.dart:465`).
- Fix: set a `_confirming` flag before `showConfirmDeliveryPoint` and ignore taps; keep the sheet's primary button disabled for the first ~400 ms. Size: S.

**CU1-11 - No quantity limit in the app; the server limit (20 per dish) surfaces as a raw message with an internal id** - MEDIUM - CONFIRMED
- Where: `cart_provider.dart` `incrementItem`/`addItem` (no cap), `KAddButton` (`+` always enabled); server `MAX_ITEM_QUANTITY = 20` (`validation.ts:60`) answers `Invalid quantity '21' for item <uuid>.`, shown verbatim by `orderErrorMessage` (`order_api.dart:349`).
- Trigger: tap + 21 times on a dish, then Pay.
- Fix: cap at 20 in `CartProvider` with a snackbar; map `INVALID_ITEMS` to a friendly text and reload the catalog. Size: S.

**CU1-12 - Retrying a lost `POST /orders` after editing the delivery note ends in a dead end (409 CLIENT_REQUEST_MISMATCH)** - MEDIUM - CONFIRMED by code
- Where: `order_provider.dart:49` (`cartKey` has no notes; the attempt only re-keys for a changed drop point at `:477`), server `orderFlow.ts:135-171` (replay needs identical notes) and `mismatch()`.
- Trigger: first `POST /orders` times out after the server committed; student edits the note in the field and taps Pay again.
- What happens: same `clientRequestId` with different notes -> 409 "This checkout id was already used for a different order. Start a new checkout." Every further tap fails the same way until the cart changes or the app restarts (no `_codeMessages` entry, no re-key).
- Fix: store the notes in `_CheckoutAttempt` and re-key like the drop point; map the code to a re-key + retry. Size: S.

**CU1-13 - Coins promise a discount the app cannot give** - MEDIUM - CONFIRMED - OWNER-INPUT
- Where: `profile_screen.dart:258,275` ("50 coins = ₹20 off"), `review_modal.dart:137`, `order_history_screen.dart:296` ("Rate this order to earn Kraveo Coins"), vs `widgets/ui/coins_toggle.dart:35` ("Paying with coins is coming soon") and no client call to `POST /coupons/redeem-coins`.
- What happens: coins are earned (+10 per review) but there is no way to spend them; the Me card and the cart contradict each other.
- Fix: until redeem exists, reword the Me card to "Coins: coming soon" and the review prompt to "Thanks"; or build the redeem flow. Size: S (copy) / M (flow).

**CU1-14 - Cart and checkout are memory-only; process death (or a long UPI app round-trip) loses the cart and the Razorpay result** - MEDIUM - SUSPECTED (device)
- Where: `cart_provider.dart` (no persistence), `order_provider.dart:146,580` (`_paymentSubmittedAt` in memory), `payment_gateway.dart` (callback tied to the live process).
- What happens: if Android kills the app while the student is in the payment sheet or a UPI app (common on 3-4 GB phones), after return the cart is empty and there is no "you were paying" state; the order shows as unpaid until the webhook lands. The server side (webhook, `DUPLICATE_PAYMENT`) protects the money; the student only sees "Payment not completed".
- Fix: keep as known limitation but make Orders/Track show "Confirming your payment" for unpaid orders younger than a few minutes. Cross-check with CU2 (tracking screen). Size: M.

**CU1-15 - Small-screen/large-text gaps on checkout and the success screen** - MEDIUM/LOW - SUSPECTED (device)
- Where: `checkout_screen.dart:337-357,360-383` (footer in `bottomNavigationBar` with notice + button + caption; no height cap; with the keyboard open on 360x640 and 1.3x-2x text the body keeps ~100-150 px), `payment_success_screen.dart:76-138` (a plain `Column`, no scroll: about 480 px of content at 1x, roughly 610 px at 2x text, overflows 360x640 at 2x or in landscape).
- No test: `ui_screens_test` uses 1.3x only and never opens checkout with a keyboard.
- Fix: wrap the success column in `SingleChildScrollView`; make the footer notice scroll with the body when the keyboard is open. Size: S.

### LOW

- **CU1-16** Closed-kitchen ADD buttons are dead (no feedback): `add_stepper.dart:214` sets `onTap: null` when `enabled` is false, so the snackbar in `dhaba_menu_screen.dart:52-55` is unreachable; only the banner above explains. Fix: always call `onAdd`.
- **CU1-17** Profile setup traps the hardware back button on step 1 (`profile_setup_screen.dart:214-218`): back does nothing, cannot leave the app with back. LOW UX.
- **CU1-18** Client name rule is stricter than the server and rejects names Google fills in: it forbids digits and the typographic apostrophe (D’Souza), the server allows both (`utils/names.ts:9` vs `profile_setup_screen.dart:25`). The student sees "Use letters only" under a name Google just gave us.
- **CU1-19** Review sheet pre-selects 5 stars and positive tags ("Super fast", "Polite runner", "Hot & fresh", "Delicious taste") and sends those tags as the kitchen's notes (`review_modal.dart:38-45,99`); note fields have no length limit while the server caps at 300 (`api.ts:844`), so a long note fails with a generic message. Pre-filled praise rewarded with coins skews ratings.
- **CU1-20** Split bill: "Split among 1 roommates", unbounded count, per-person amounts are rounded so people-times-share may not equal the total (`split_bill_modal.dart:285-303`).
- **CU1-21** Wording drift: "runner" (auth, sign-up, checkout, picker, 14 places) vs "rider" (tracking, 188 places) vs "delivery partner"; "kitchen", "restaurant", "dhaba" and "Dhaba" (server message "This Dhaba is currently CLOSED") used for the same thing.
- **CU1-22** Favourites are in memory only and seeded with demo ids (`dhaba_provider.dart:11-12`, `isFavorite` from the server is ignored), so hearts vanish on restart.
- **CU1-23** Home tab back button leaves the app from Orders/Me/Track instead of returning to the Home tab (`home_screen.dart:87`, no `PopScope`).
- **CU1-24** Late 401 from an old session clears the *new* user's token: `_rejectIfUnauthorized` (`customer_api_service.dart:58-63`) does not check which token was used. Needs logout + quick login of another account with a request still in flight, so rare.
- **CU1-25** Hygiene/security: JWT in plain SharedPreferences and `allowBackup` not disabled (`AndroidManifest.xml` application tag, merged manifest has no `allowBackup=false`); Razorpay adds NFC, USE_BIOMETRIC, READ_BASIC_PHONE_STATE permissions to the merged manifest (privacy-policy and Play data-safety relevance); `gradle.properties:1` sets `-Xmx8G` on a 7.4 GB laptop (swap thrash during the APK build); `widgets/ui/otp_boxes.dart` is dead code from the old phone-OTP login.
- **CU1-26** Cancel-order confirm at checkout says "Nothing has been paid for this order" (`checkout_screen.dart:233`) even after a Razorpay failure where the bank may have debited; the server refunds a late capture, the wording is wrong. Also the footer says "pay by UPI" while cards work.
- **CU1-27** `rupee()` prints no thousands separator and legacy-saved order drop points (e.g. "Block 3") are shown raw in history (`order_history_screen.dart:264`) next to new "BH3" ones. Cosmetic.

## 4. Looked hard and found nothing
- Client-trusted prices: totals, delivery fee, tax and coupon discount are recomputed on the server (`validation.ts`); the client sends only ids and quantities; the Razorpay amount comes from the server and is compared with the order total before the sheet opens (`order_provider.dart:548-555`).
- Idempotent checkout, double-tapped `placeOrder`/`payForOrder`, back-navigation into an unpaid order, payment cancelled/failed/confirming/duplicate/closed outcomes: the state machine in `order_provider.dart` is consistent with the backend codes and tested.
- Price differs from the estimate: shown before any payment ("Updated total").
- Logout / account switch: cart, coins, favourites, search, orders, checkout key, local drop point, Google account and cached token are all reset; user-state wipe happens on 401 as well.
- Legacy hostels: `normalizeDropPoint` matches the server table; "VIT Main Gate" and unknown values force an explicit choice and are never sent.
- Hard-coded URLs and keys: only `https://api.kraveo.site`; no secrets in lib or manifest (Maps key injected at build). Exported components in the release manifest are the launcher activity plus standard Firebase/Play/Razorpay receivers. No tokens or PII in `debugPrint`.
- 401 mid-checkout: pushed routes are popped and a clear snackbar shown; the order survives on the server.

## 5. Top 5 to fix before the demo
1. CU1-04 - make `restore()` survive 5xx/429 (stops "logged out" after a backend restart).
2. CU1-02 + CU1-03 - remove the fake catalog, add an error state, refresh on resume/pull-to-refresh.
3. CU1-01 - show VITFIRST only to students with no orders, drop KRAVEO20, auto-remove a coupon the server refuses.
4. CU1-05 - prove Google sign-in on the exact APK with a fresh Google account (and register the debug SHA-1 if missing).
5. CU1-10 and CU1-07 - guard the Pay double-tap, show paise consistently.

## 6. Only provable on a real device / server
- Google sign-in with the debug-signed release APK and a never-used account (CU1-05).
- Razorpay sheet: card and `success@razorpay` in test mode, the pay-cancel-retry loop, return from a UPI app after process death (CU1-14), contact prefill with the "+91 98765 43210" format.
- Double-tap timing on Pay (CU1-10), keyboard over the delivery-note field and footer on 360x640 at 1.3x/2x (CU1-15), landscape on the success screen.
- Real `/vendors` data: vendor categories, closed kitchens, sold-out items, restaurants with no menu.
- Behaviour at app start while the backend restarts (CU1-04) and on slow Wi-Fi at the venue (CU1-02).
- Push-permission sheet appearing over checkout the first time (`push_permission.dart`, once per install).
