# Handoff Report: Client App Integration & Authentication Header Handling

## 1. Observation

### Target 1: React Web Super Admin (`web/super_admin/`)
* **File Structure**: `web/super_admin/src/services/api.ts` does **not exist**. All backend API calls are located directly in `web/super_admin/src/App.tsx`.
* **API Calls & Headers**:
  * Line 172-175: Initial fetches for orders, vendors, drivers (`fetch('http://localhost:5000/api/orders')`, etc.) omit `Authorization` headers completely.
  * Line 255-260 (`handleStatusChange`): `PATCH http://localhost:5000/api/orders/${orderId}/status` passes hardcoded `'Authorization': 'Bearer mock_jwt_token_usr-5'`.
  * Line 279-283 (`handleToggleVendor`): `PATCH http://localhost:5000/api/vendors/${vendorId}/status` omits `Authorization` header.
* **Token Storage**: No token persistence (`localStorage`/`sessionStorage` or state management) exists in `web/super_admin`.

### Target 2: Flutter Customer App (`apps/customer_app/lib/`)
* **API Calls & Headers**: Located in `apps/customer_app/lib/services/customer_api_service.dart`:
  * `sendOtp(phone)` & `verifyOtp(phone, otp)`: `POST /api/auth/send-otp` and `POST /api/auth/verify-otp`. `verifyOtp` receives `{ token: string }` from backend but returns it without persisting it.
  * `placeOrder(orderPayload)` (Line 56): Uses hardcoded `'Authorization': 'Bearer mock_jwt_token_usr-1'`.
  * `submitReview(...)` (Line 84): Uses hardcoded `'Authorization': 'Bearer mock_jwt_token_usr-1'`.
* **Token Storage**: No persistent local storage (`shared_preferences` or `flutter_secure_storage`) is configured in `pubspec.yaml` or implemented in Dart code.
* **OTP Handling**:
  * `OrderProvider` (Line 59): Generates random 4-digit OTPs (`(1000 + random.nextInt(9000)).toString()`) for customer order gate handshake.
  * `customer_app_test.dart` (Line 238): Static test OTP `'1234'` used in UI split bill modal test.

### Target 3: Flutter Vendor App (`apps/vendor_app/lib/`)
* **API Calls & Headers**: Located in `apps/vendor_app/lib/services/vendor_api_service.dart`:
  * `updateOrderStatus(orderId, newStatus)` (Line 10-14): `PATCH /api/orders/:id/status` has NO `Authorization` header.
  * `toggleStoreStatus(vendorId, isAcceptingOrders)` (Line 30-34): `PATCH /api/vendors/:id/status` has NO `Authorization` header.
  * `updateDishStock(itemId, ...)` (Line 54-58): `PATCH /api/vendors/items/:id` has NO `Authorization` header.
* **Token Storage**: No authentication flow or token storage mechanism exists in `vendor_app`.

### Target 4: Flutter Driver App (`apps/driver_app/lib/`)
* **API Calls & Headers**: Located in `apps/driver_app/lib/services/driver_api_service.dart`:
  * `acceptJob(orderId)` (Line 14): Uses hardcoded `'Authorization': 'Bearer mock-driver-token'`.
  * `updateDeliveryStatus(orderId, newStatus, {otpCode})` (Line 39): Uses hardcoded `'Authorization': 'Bearer mock-driver-token'`.
  * `updateLocation(lat, lng, ...)` (Line 62): Uses hardcoded `'Authorization': 'Bearer mock-driver-token'`.
* **Token Storage**: No token persistence implemented.
* **Test/Universal OTP Usages**:
  * `apps/driver_app/lib/widgets/gate_otp_dialog.dart`:
    * Line 12: Default parameter `this.expectedOtp = '4829'`.
    * Line 119-125: UI dialog helper text explicitly displays `'Order ${widget.orderId} • Demo PIN: 4829'`.
  * `apps/driver_app/lib/screens/active_delivery.dart`:
    * Line 77: `_triggerGateOtp()` opens `GateOtpDialog` passing hardcoded `expectedOtp: '4829'`.
  * `apps/driver_app/lib/screens/driver_home.dart`:
    * Line 56: `_completeJob()` calls `DriverApiService.updateDeliveryStatus('ord-101', 'DELIVERED', otpCode: '1234');`.
  * `apps/driver_app/lib/screens/trip_logs.dart`:
    * Line 26: Sample trip log model uses `otpCode: '4829'`.

---

## 2. Logic Chain

1. **Backend RBAC Hardening Impact**: The backend is enforcing strictly checked JWT tokens signed with secrets and requiring valid user roles (`VENDOR`, `DRIVER`, `ADMIN`, `CUSTOMER`). Unauthenticated or malformed requests return `401 Unauthorized`, and mismatched role tokens return `403 Forbidden`.
2. **Current Client App Deficiencies**:
   * **Missing Headers**: `vendor_app` API requests currently send 0 headers. As soon as `requireRole('VENDOR')` is attached to backend vendor endpoints, every single request from `vendor_app` will immediately fail with `401 Unauthorized`.
   * **Hardcoded Mock Tokens**: `customer_app`, `driver_app`, and `super_admin` send static mock strings (`mock_jwt_token_usr-1`, `mock-driver-token`, `mock_jwt_token_usr-5`). Backend JWT validation (`jwt.verify()`) will reject these mock strings as invalid JWT format/signature, resulting in `401 Unauthorized`.
   * **Missing Auth Flow & Token Storage**: None of the client apps currently save the JWT returned during login/verify-otp (e.g. into `SharedPreferences` or `localStorage`) or inject it dynamically into HTTP request headers.
   * **Hardcoded OTP Presets**: `driver_app` UI components (`GateOtpDialog`, `active_delivery.dart`, `driver_home.dart`) rely on hardcoded fallback OTPs `'4829'` and `'1234'`. When real OTP verification is required during gate handshake, these hardcoded fallbacks will fail if the actual customer order OTP is different.

---

## 3. Caveats

* `web/super_admin/src/services/api.ts` mentioned in the initial prompt does not exist in the repository; `web/super_admin/src/App.tsx` contains the active `fetch` requests.
* Flutter apps rely on basic `http` package without an HTTP Interceptor pattern (like `dio`), so header injection is done manually in individual static service methods.

---

## 4. Conclusion

All 4 client applications currently fail compatibility with a hardened backend due to:
1. Complete omission of `Authorization` headers in `vendor_app` and parts of `super_admin`.
2. Usage of static non-JWT mock token strings (`mock_jwt_token_usr-1`, `mock-driver-token`, `mock_jwt_token_usr-5`) in `customer_app`, `driver_app`, and `super_admin`.
3. Lack of client-side token persistence (Secure Storage / SharedPreferences / localStorage).
4. Reliance on hardcoded test OTPs (`'4829'`, `'1234'`) in `driver_app` UI components.

---

## 5. Verification Method

1. **Inspect files**:
   * Web Super Admin: `web/super_admin/src/App.tsx` (lines 172-175, 255-260, 279-283)
   * Customer App: `apps/customer_app/lib/services/customer_api_service.dart` (lines 56, 84)
   * Vendor App: `apps/vendor_app/lib/services/vendor_api_service.dart` (lines 12, 32, 56)
   * Driver App: `apps/driver_app/lib/services/driver_api_service.dart` (lines 14, 39, 62)
   * Driver OTP Dialog & UI: `apps/driver_app/lib/widgets/gate_otp_dialog.dart` (lines 12, 119) & `apps/driver_app/lib/screens/active_delivery.dart` (line 77)
2. **Grep Commands**:
   * `grep -rn "Authorization" apps/ web/`
   * `grep -rn "Bearer" apps/ web/`
   * `grep -rn "4829" apps/ web/`

---

## 6. Recommendations for Client-Side Alignment

1. **Token Storage & State Management**:
   * **Flutter Apps (`customer_app`, `vendor_app`, `driver_app`)**: Add `shared_preferences` or `flutter_secure_storage` to `pubspec.yaml`. Store the `token` string returned from `POST /api/auth/verify-otp` or login endpoints upon successful authentication.
   * **Web Super Admin (`super_admin`)**: Store authenticated admin JWT in `localStorage` or React AuthContext state upon admin login.
2. **Dynamic Header Injection**:
   * Pass the dynamically retrieved JWT token from storage into API services.
   * Header format across all 4 clients: `'Authorization': 'Bearer ${storedJwtToken}'`.
   * Add `Authorization` headers to all `vendor_app` API calls (`updateOrderStatus`, `toggleStoreStatus`, `updateDishStock`).
3. **Remove Hardcoded Dev Tokens & Universal Test OTPs**:
   * Remove `mock_jwt_token_usr-1`, `mock-driver-token`, and `mock_jwt_token_usr-5` string literals from service methods.
   * Update `GateOtpDialog` in `driver_app` to receive the real order's expected OTP dynamically from order data rather than defaulting to `'4829'`.
   * Update `driver_home.dart` `_completeJob()` to pass the actual active order OTP instead of hardcoded `'1234'`.
