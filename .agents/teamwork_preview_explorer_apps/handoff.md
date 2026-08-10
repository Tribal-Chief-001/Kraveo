# Handoff Report — Kraveo Mobile Applications (Customer, Vendor, Driver)

## 1. Observation

### Auth & Security
- **Hardcoded OTP Codes**:
  - Found hardcoded PIN `4829` in `driver_app/lib/screens/active_delivery.dart:77`, `driver_app/lib/screens/trip_logs.dart:26`, `driver_app/lib/widgets/gate_otp_dialog.dart:12,119`, and test files `driver_app/test/driver_app_test.dart:15,48`.
  - Found mock OTP `1234` in `customer_app/test/customer_app_test.dart:238`, `driver_app/lib/screens/driver_home.dart:56`, and vehicle registration number `driver_app/lib/screens/runner_id_card_screen.dart:156`.
  - Found mock random OTP generator (4-digit random string `1000..9999`) in `customer_app/lib/providers/order_provider.dart:59`.
- **JWT Token Handling**:
  - `customer_app/lib/services/customer_api_service.dart` line 38 extracts `token` on `verifyOtp` response, but headers for `placeOrder` (line 56) and `submitReview` (line 84) hardcode `'Authorization': 'Bearer mock_jwt_token_usr-1'`.
  - `driver_app/lib/services/driver_api_service.dart` line 14, 39, 62 hardcodes `'Authorization': 'Bearer mock-driver-token'`.
  - `vendor_app/lib/services/vendor_api_service.dart` passes `{'Content-Type': 'application/json'}` without any Authorization header.
- **Secure Token Storage**:
  - No `flutter_secure_storage` or `shared_preferences` package found in any of the 3 `pubspec.yaml` files. Tokens are ephemeral and not persisted across sessions.

### Gate Handshake OTP UI/UX
- **Driver App**:
  - `driver_app/lib/widgets/gate_otp_dialog.dart` provides a 4-digit PIN input dialog (`TextField` array) with auto-focus shifting. Default `expectedOtp` parameter is `'4829'`. Dialog displays `'Order ${widget.orderId} • Demo PIN: 4829'` on screen.
  - Triggered during Step 4 ("Arrived at Gate") of `ActiveDeliveryScreen` (`driver_app/lib/screens/active_delivery.dart:338`).
- **Customer App**:
  - `customer_app/lib/screens/live_tracking_screen.dart:222-378` features a prominent "GATE HANDSHAKE SECURITY OTP" card displaying the order's `otpCode` in individual digit boxes with a "Copy OTP" button.
  - Also contains an inline text input and `VERIFY` button calling `orderProvider.verifyGateHandshakeOtp(_otpInputController.text)`.

### Payment Integration (Customer App)
- **Razorpay**:
  - Neither `razorpay_flutter` nor any Razorpay SDK is present in `customer_app/pubspec.yaml`.
  - `customer_app/lib/screens/checkout_screen.dart:28-34` presents a UI list of mock options: `PhonePe UPI`, `Google Pay UPI`, `Paytm UPI`, `CRED UPI`, `Cash on Gate Delivery`.
  - On checkout button press, `_handlePlaceOrder` presents a modal bottom sheet displaying `UPI Payment Successful! Authorized ₹<amount> via <Method>`, immediately setting order state to placed without network gateway interaction.

### Real-Time Updates (Socket.io & FCM)
- **Dependencies**:
  - No `socket_io_client`, `firebase_core`, or `firebase_messaging` packages in `pubspec.yaml` for any app.
- **Backend URLs**:
  - `ApiConfig` in all 3 apps defines socket URL (`http://3.110.189.80` / `http://10.0.2.2:5000`), but no WebSocket connection or listener logic exists in `lib/`.
- **FCM**:
  - `android/app/google-services.json` files exist in all 3 app directories (pointing to `kraveo.firebasestorage.app`), but FCM initialization, background message handlers, or token registration are not implemented in Flutter code.
- **Location & Order Status Tracking**:
  - `driver_app/lib/services/driver_api_service.dart:55` contains HTTP POST `updateLocation` (`/api/drivers/location`) and `updateDeliveryStatus` (`/api/orders/$id/status`), operating via HTTP REST calls.
  - Customer app relies on local state `orderProvider.advanceActiveOrderStatus()` for demo progression.

### Configuration & Security
- **Base URLs**:
  - Production base URL is `http://3.110.189.80/api` (HTTP cleartext IP address, unencrypted).
  - Local base URL is `http://10.0.2.2:5000/api`.
  - `isProduction` flag is hardcoded to `true` in `customer_app`, `driver_app`, `vendor_app` `lib/config/api_config.dart`.
- **Cleartext Traffic Permissions**:
  - `android/app/src/main/AndroidManifest.xml` in all 3 apps explicitly enables cleartext traffic via `android:usesCleartextTraffic="true"`.
  - No custom `network_security_config.xml` or HTTPS domain pinning is configured.
- **CORS / Network**:
  - Apps send standard JSON HTTP requests with 4 to 5-second timeouts.

### Build & Test Setup
- **Dependencies (`pubspec.yaml`)**:
  - `customer_app`: `flutter`, `cupertino_icons`, `http`, `provider`, `google_fonts`.
  - `driver_app`: `flutter`, `cupertino_icons`, `http`.
  - `vendor_app`: `flutter`, `cupertino_icons`, `http`, `audioplayers`, `permission_handler`.
- **Test Executions**:
  - `customer_app`: `flutter test` passed (16 tests passed).
  - `driver_app`: `flutter test` passed (3 tests passed).
  - `vendor_app`: `flutter test` passed (4 tests passed).
- **Static Analysis (`flutter analyze`)**:
  - All 3 apps return exit code `1` due to warnings/info lints (44 issues in `customer_app`, 15 in `driver_app`, 28 in `vendor_app`). Issues are mostly `prefer_const_constructors`, `avoid_print`, and `unused_import` (e.g. `active_delivery.dart`, `vendor_home.dart`).

---

## 2. Logic Chain

1. **Auth & Security Risk**:
   - Hardcoded PINs (`4829`, `1234`) and mock tokens (`mock_jwt_token_usr-1`, `mock-driver-token`) remain embedded directly within UI widgets and API services.
   - Without secure storage (`flutter_secure_storage`), tokens cannot persist securely across app restarts, forcing fallback to hardcoded mock tokens for REST requests.
2. **Gate Handshake Verification UI**:
   - The UI components (`GateOtpDialog` for driver and live tracking OTP box for customer) are fully designed visually. However, `GateOtpDialog` falls back to `widget.expectedOtp` (`'4829'`) rather than fetching the live generated OTP from backend or order model.
3. **Payment Integration Gap**:
   - Checkout process simulates payment via local bottom sheet popups without invoking Razorpay SDK or backend payment order creation endpoints (`/api/payments/create-order`).
4. **Real-time Synchronization Gap**:
   - Order tracking and location updates rely on HTTP REST polling and manual UI state advances. Socket.io and FCM packages are omitted from `pubspec.yaml`, leaving real-time socket events unhandled on mobile client platforms.
5. **Security Configuration**:
   - Using `http://3.110.189.80` with `android:usesCleartextTraffic="true"` over unencrypted HTTP exposes API requests (containing tokens and student PII) to network eavesdropping.
6. **Build & Test State**:
   - Unit and widget test suites execute cleanly and cover core logic (Cart math, OTP dialogs, audio alerts). `flutter analyze` flags non-critical lint warnings and `avoid_print` statements.

---

## 3. Caveats

- iOS manifests (`Info.plist`) were not evaluated as the current focus is Android manifest configs.
- No live backend connection test was executed (CODE_ONLY mode restriction). All REST calls were evaluated statically and via unit test suites.

---

## 4. Conclusion

The Kraveo mobile applications (`customer_app`, `vendor_app`, `driver_app`) present robust UI/UX flows and 100% passing test suites for local widget and provider behavior. However, production readiness requires:
1. Replacing hardcoded demo OTPs (`4829`/`1234`) and mock tokens with live API authentication and `flutter_secure_storage`.
2. Integrating `razorpay_flutter` into `customer_app` checkout.
3. Adding `socket_io_client` and `firebase_messaging` to enable real-time order/location updates.
4. Upgrading API endpoints to HTTPS and restricting cleartext traffic in Android manifests.
5. Addressing `flutter analyze` lints across all three repositories.

---

## 5. Verification Method

To verify these findings:
1. Search for hardcoded OTP strings:
   `grep -rn "4829" /home/lucifer/Documents/Projects/Kraveo/apps`
   `grep -rn "1234" /home/lucifer/Documents/Projects/Kraveo/apps`
2. Search for hardcoded JWT tokens:
   `grep -rn "mock" /home/lucifer/Documents/Projects/Kraveo/apps`
3. Run test suites for all 3 applications:
   - `cd customer_app && flutter test`
   - `cd driver_app && flutter test`
   - `cd vendor_app && flutter test`
4. Run static analysis:
   - `cd customer_app && flutter analyze`
   - `cd driver_app && flutter analyze`
   - `cd vendor_app && flutter analyze`
