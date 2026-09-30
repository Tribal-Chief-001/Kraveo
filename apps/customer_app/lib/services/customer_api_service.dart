import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../models/auth_results.dart';

class CustomerApiService {
  static const String _tokenPrefKey = 'kraveo_customer_jwt_token';
  static String? _cachedToken;

  /// Message shown (and thrown) when an authenticated call is rejected with HTTP 401.
  static const String sessionExpiredMessage = 'Session expired, please log in again';

  /// Set by the app shell. Called after the stored token has been cleared because the
  /// backend answered 401 to an authenticated request.
  static void Function()? onUnauthorized;

  /// Test seam: route every request through a fake client.
  @visibleForTesting
  static http.Client? httpClientOverride;

  static Future<http.Response> _get(Uri url, {Map<String, String>? headers, required Duration timeout}) {
    final c = httpClientOverride;
    return (c == null ? http.get(url, headers: headers) : c.get(url, headers: headers)).timeout(timeout);
  }

  static Future<http.Response> _post(Uri url, {Map<String, String>? headers, Object? body, required Duration timeout}) {
    final c = httpClientOverride;
    return (c == null ? http.post(url, headers: headers, body: body) : c.post(url, headers: headers, body: body)).timeout(timeout);
  }

  static Future<http.Response> _put(Uri url, {Map<String, String>? headers, Object? body, required Duration timeout}) {
    final c = httpClientOverride;
    return (c == null ? http.put(url, headers: headers, body: body) : c.put(url, headers: headers, body: body)).timeout(timeout);
  }

  static Future<http.Response> _delete(Uri url, {Map<String, String>? headers, required Duration timeout}) {
    final c = httpClientOverride;
    return (c == null ? http.delete(url, headers: headers) : c.delete(url, headers: headers)).timeout(timeout);
  }

  static Map<String, dynamic> _json(http.Response response) {
    try {
      final body = jsonDecode(response.body);
      if (body is Map) return Map<String, dynamic>.from(body);
    } catch (_) {}
    return const {};
  }

  static String? _msg(Map<String, dynamic> body) {
    final m = body['message'];
    return m is String && m.trim().isNotEmpty ? m.trim() : null;
  }

  /// Central 401 handling for authenticated calls: drop the dead token, tell the app shell.
  /// Returns true when the response was a 401.
  static Future<bool> _rejectIfUnauthorized(http.Response response) async {
    if (response.statusCode != 401) return false;
    await clearToken();
    onUnauthorized?.call();
    return true;
  }

  /// Retrieves stored JWT auth token from SharedPreferences or memory cache
  static Future<String?> getSavedToken() async {
    if (_cachedToken != null && _cachedToken!.isNotEmpty) {
      return _cachedToken;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      _cachedToken = prefs.getString(_tokenPrefKey);
      return _cachedToken;
    } catch (_) {
      return _cachedToken;
    }
  }

  /// Saves JWT token to local persistence
  static Future<void> saveToken(String token) async {
    _cachedToken = token;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_tokenPrefKey, token);
    } catch (_) {}
  }

  /// Clears the persisted student session after logout or token rejection.
  static Future<void> clearToken() async {
    _cachedToken = null;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_tokenPrefKey);
    } catch (_) {}
  }

  /// Validates the stored JWT against the backend and returns the profile.
  /// Returns null when there is no saved token. On 401 the token is cleared and
  /// [onUnauthorized] fires; on network trouble the token is kept so the user is not
  /// logged out just because they opened the app offline.
  static Future<ProfileResult?> fetchProfile() async {
    final token = await getSavedToken();
    if (token == null || token.isEmpty) return null;

    try {
      final response = await _get(
        Uri.parse('${ApiConfig.baseUrl}/auth/profile'),
        headers: await getAuthHeaders(),
        timeout: const Duration(seconds: 10),
      );
      if (await _rejectIfUnauthorized(response)) {
        return const ProfileResult(success: false, statusCode: 401, message: sessionExpiredMessage);
      }
      return _profileResult(response);
    } catch (e) {
      debugPrint('[Customer API] Session validation failed: $e');
      return const ProfileResult(success: false, networkError: true);
    }
  }

  static ProfileResult _profileResult(http.Response response) {
    final body = _json(response);
    final user = body['user'];
    final ok = response.statusCode == 200 && body['success'] != false && user is Map;
    return ProfileResult(
      success: ok,
      statusCode: response.statusCode,
      message: _msg(body),
      user: user is Map ? Map<String, dynamic>.from(user) : null,
      needsProfile: body['needsProfile'] == true,
      field: body['field']?.toString(),
    );
  }

  /// PUT /auth/profile with only the fields that are given. 400 responses carry `field` so the
  /// form can point at the input. [hostelBlock] is only accepted by the server when the student
  /// flag is (or becomes) true; it is cleared server-side when [isStudent] is false.
  static Future<ProfileResult> updateProfile({
    String? name,
    String? phone,
    bool? isStudent,
    String? hostelBlock,
    int? avatarId,
  }) async {
    final payload = <String, dynamic>{
      if (name != null) 'name': name,
      if (phone != null) 'phone': phone,
      if (isStudent != null) 'isStudent': isStudent,
      if (hostelBlock != null) 'hostelBlock': hostelBlock,
      if (avatarId != null) 'avatarId': avatarId,
    };
    try {
      final response = await _put(
        Uri.parse('${ApiConfig.baseUrl}/auth/profile'),
        headers: await getAuthHeaders(),
        body: jsonEncode(payload),
        timeout: const Duration(seconds: 10),
      );
      if (await _rejectIfUnauthorized(response)) {
        return const ProfileResult(success: false, statusCode: 401, message: sessionExpiredMessage);
      }
      return _profileResult(response);
    } catch (e) {
      debugPrint('[Customer API] Update profile failed: $e');
      return const ProfileResult(success: false, networkError: true);
    }
  }

  /// Tells the backend to forget this device's push token. Best-effort: the JWT is stateless,
  /// so callers clear the local session regardless of the outcome. Pass [token] when the local
  /// token may already have been cleared.
  static Future<ActionResult> logout({String? token}) async {
    try {
      final headers = <String, String>{'Content-Type': 'application/json'};
      final t = token ?? await getSavedToken();
      if (t != null && t.isNotEmpty) headers['Authorization'] = t.startsWith('Bearer ') ? t : 'Bearer $t';
      final response = await _post(
        Uri.parse('${ApiConfig.baseUrl}/auth/logout'),
        headers: headers,
        timeout: const Duration(seconds: 5),
      );
      final body = _json(response);
      return ActionResult(success: response.statusCode == 200 && body['success'] != false, statusCode: response.statusCode, message: _msg(body));
    } catch (e) {
      debugPrint('[Customer API] Logout notice failed (ignored): $e');
      return const ActionResult(success: false, networkError: true);
    }
  }

  /// Permanently anonymises the account. 409 means an order is still in progress.
  static Future<ActionResult> deleteAccount() async {
    try {
      final response = await _delete(
        Uri.parse('${ApiConfig.baseUrl}/auth/account'),
        headers: await getAuthHeaders(),
        timeout: const Duration(seconds: 15),
      );
      if (await _rejectIfUnauthorized(response)) {
        return const ActionResult(success: false, statusCode: 401, message: sessionExpiredMessage);
      }
      final body = _json(response);
      return ActionResult(success: response.statusCode == 200 && body['success'] != false, statusCode: response.statusCode, message: _msg(body));
    } catch (e) {
      debugPrint('[Customer API] Delete account failed: $e');
      return const ActionResult(success: false, networkError: true);
    }
  }

  /// Loads the public restaurant catalog, including database-backed menu IDs.
  static Future<List<Map<String, dynamic>>> fetchVendors() async {
    final response = await _get(Uri.parse('${ApiConfig.baseUrl}/vendors'), timeout: const Duration(seconds: 15));
    final body = jsonDecode(response.body);
    if (response.statusCode != 200 || body is! Map || body['data'] is! List) {
      throw Exception(body is Map ? body['message'] ?? 'Unable to load restaurants.' : 'Unable to load restaurants.');
    }
    return (body['data'] as List)
        .whereType<Map>()
        .map((vendor) => Map<String, dynamic>.from(vendor))
        .toList();
  }

  /// Builds authenticated request headers dynamically
  static Future<Map<String, String>> getAuthHeaders() async {
    final token = await getSavedToken();
    final headers = <String, String>{
      'Content-Type': 'application/json',
    };
    if (token != null && token.isNotEmpty) {
      headers['Authorization'] = token.startsWith('Bearer ') ? token : 'Bearer $token';
    }
    return headers;
  }

  /// Exchanges a Google ID token for a Kraveo session. On success the JWT is persisted
  /// before returning.
  static Future<GoogleLoginResult> googleSignIn(String idToken) async {
    try {
      final response = await _post(
        Uri.parse('${ApiConfig.baseUrl}/auth/google'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'idToken': idToken}),
        timeout: const Duration(seconds: 15),
      );
      final body = _json(response);
      final token = body['token'];
      final user = body['user'];
      final ok = response.statusCode == 200 && body['success'] != false && token is String && token.isNotEmpty && user is Map;
      if (!ok) {
        return GoogleLoginResult(success: false, statusCode: response.statusCode, message: _msg(body));
      }
      final userMap = Map<String, dynamic>.from(user);
      if (userMap['role'] != null && userMap['role'] != 'STUDENT') {
        return const GoogleLoginResult(success: false, statusCode: 403, message: 'This Google account can\'t sign in to the Kraveo customer app.');
      }
      await saveToken(token);
      return GoogleLoginResult(
        success: true,
        statusCode: 200,
        token: token,
        user: userMap,
        isNewUser: body['isNewUser'] == true,
        needsProfile: body['needsProfile'] == true,
      );
    } catch (e) {
      debugPrint('[Customer API] Google sign-in failed: $e');
      return const GoogleLoginResult(success: false, networkError: true);
    }
  }

  /// Places order on AWS EC2 backend with dynamic JWT token
  static Future<bool> placeOrder(Map<String, dynamic> orderPayload) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders');
      final headers = await getAuthHeaders();

      final response = await _post(url, headers: headers, body: jsonEncode(orderPayload), timeout: const Duration(seconds: 5));
      if (await _rejectIfUnauthorized(response)) return false;

      if (response.statusCode == 200 || response.statusCode == 201) {
        debugPrint('🛍️ [Customer API] Order placed successfully on AWS backend!');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Customer API Notice] Order placement sync delayed ($e).');
    }
    return false;
  }

  /// Creates the server-authoritative order used as the Razorpay receipt.
  /// The backend recalculates prices from the database; client totals are never trusted.
  static Future<Map<String, dynamic>> createOrder({
    required String vendorId,
    required List<Map<String, dynamic>> items,
    required String dropoffHostel,
    required String dropoffNotes,
    String? couponCode,
  }) async {
    final url = Uri.parse('${ApiConfig.baseUrl}/orders');
    final headers = await getAuthHeaders();
    final payload = <String, dynamic>{
      'vendorId': vendorId,
      'items': items,
      'dropoffHostel': dropoffHostel,
      'dropoffNotes': dropoffNotes,
    };
    if (couponCode != null && couponCode.isNotEmpty) {
      payload['couponCode'] = couponCode;
    }

    try {
      final response = await _post(url, headers: headers, body: jsonEncode(payload), timeout: const Duration(seconds: 15));
      if (await _rejectIfUnauthorized(response)) throw Exception(sessionExpiredMessage);
      final body = jsonDecode(response.body);
      if (response.statusCode == 201 && body is Map && body['data'] is Map) {
        return Map<String, dynamic>.from(body['data'] as Map);
      }
      throw Exception(body is Map ? body['message'] ?? 'Unable to create order.' : 'Unable to create order.');
    } catch (e) {
      debugPrint('⚠️ [Customer API] Create order failed: $e');
      rethrow;
    }
  }

  /// Creates a Razorpay order on the backend. The key ID is safe to return to the app.
  static Future<Map<String, dynamic>> createPaymentOrder(String orderId) async {
    final url = Uri.parse('${ApiConfig.baseUrl}/payments/create-order');
    final headers = await getAuthHeaders();

    try {
      final response = await _post(url, headers: headers, body: jsonEncode({'orderId': orderId}), timeout: const Duration(seconds: 15));
      if (await _rejectIfUnauthorized(response)) throw Exception(sessionExpiredMessage);
      final body = jsonDecode(response.body);
      if (response.statusCode == 200 && body is Map && body['success'] == true) {
        return Map<String, dynamic>.from(body);
      }
      throw Exception(body is Map ? body['message'] ?? 'Unable to start payment.' : 'Unable to start payment.');
    } catch (e) {
      debugPrint('⚠️ [Customer API] Create payment order failed: $e');
      rethrow;
    }
  }

  /// Verifies Razorpay's checkout response on the backend before showing success.
  static Future<void> verifyPayment({
    required String razorpayOrderId,
    required String razorpayPaymentId,
    required String razorpaySignature,
  }) async {
    final url = Uri.parse('${ApiConfig.baseUrl}/payments/verify-signature');
    final headers = await getAuthHeaders();

    try {
      final response = await _post(
        url,
        headers: headers,
        body: jsonEncode({
          'razorpayOrderId': razorpayOrderId,
          'razorpayPaymentId': razorpayPaymentId,
          'razorpaySignature': razorpaySignature,
        }),
        timeout: const Duration(seconds: 15),
      );
      if (await _rejectIfUnauthorized(response)) throw Exception(sessionExpiredMessage);
      final body = jsonDecode(response.body);
      if (response.statusCode == 200 && body is Map && body['success'] == true) {
        return;
      }
      throw Exception(body is Map ? body['message'] ?? 'Payment verification failed.' : 'Payment verification failed.');
    } catch (e) {
      debugPrint('⚠️ [Customer API] Payment verification failed: $e');
      rethrow;
    }
  }

  /// Submits dish & runner review with dynamic JWT token
  static Future<bool> submitReview({
    required String orderId,
    required double dhabaRating,
    required double driverRating,
    required String reviewText,
  }) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/reviews');
      final headers = await getAuthHeaders();

      final response = await _post(
        url,
        headers: headers,
        body: jsonEncode({
          'orderId': orderId,
          'dhabaRating': dhabaRating,
          'driverRating': driverRating,
          'reviewText': reviewText,
        }),
        timeout: const Duration(seconds: 5),
      );
      if (await _rejectIfUnauthorized(response)) return false;

      if (response.statusCode == 200) {
        debugPrint('⭐️ [Customer API] Review submitted! +10 Kraveo Coins awarded.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Customer API Notice] Review submission delayed ($e).');
    }
    return false;
  }
}
