import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';

class DriverApiService {
  static const String _tokenPrefKey = 'kraveo_driver_jwt_token';
  static String? _cachedToken;

  /// Shown when the server rejects the saved token (HTTP 401) on an authenticated call.
  static const String sessionExpiredMessage = 'Session expired. Please log in again.';

  /// Set by the session gate. Called when any authenticated request comes back 401, so the
  /// app can drop the dead token and return to the login screen.
  static void Function()? onUnauthorized;

  /// Set by the session gate. Called when Kraveo answers 403 PARTNER_NOT_APPROVED, i.e. an admin suspended
  /// this account while the app was open, so the app can re-check its status and move to the status screen.
  static void Function()? onNotApproved;

  /// A 401 on an authenticated call means the JWT is expired or revoked; a 403 with the
  /// PARTNER_NOT_APPROVED code means the account was suspended (or never approved).
  static void _checkUnauthorized(http.Response response) {
    if (response.statusCode == 401) {
      onUnauthorized?.call();
    } else if (response.statusCode == 403 && response.body.contains('PARTNER_NOT_APPROVED')) {
      onNotApproved?.call();
    }
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

  /// Forgets the JWT (memory and disk). Called on logout and on session expiry.
  static Future<void> clearToken() async {
    _cachedToken = null;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_tokenPrefKey);
    } catch (_) {}
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

  /// Verifies dynamic 4-digit Gate Handshake OTP on backend server
  static Future<bool> verifyGateOtp(String orderId, String otpCode) async {
    try {
      final cleanId = orderId.replaceAll('#', '').trim();
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$cleanId/verify-gate-otp');
      final headers = await getAuthHeaders();

      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({'otpCode': otpCode.trim()}),
      ).timeout(const Duration(seconds: 5));

      _checkUnauthorized(response);
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body);
        if (json['success'] == true) {
          debugPrint('🔑 [Driver API] Gate Handshake OTP verified successfully for $cleanId!');
          return true;
        }
      }
    } catch (e) {
      debugPrint('⚠️ [Driver API Notice] Gate OTP server verification delayed ($e).');
    }
    return false;
  }

  /// Driver accepts job assignment on AWS EC2 backend
  static Future<bool> acceptJob(String orderId) async {
    try {
      final cleanId = orderId.replaceAll('#', '').trim();
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$cleanId/accept-driver');
      final headers = await getAuthHeaders();

      final response = await http.post(
        url,
        headers: headers,
      ).timeout(const Duration(seconds: 5));

      _checkUnauthorized(response);
      if (response.statusCode == 200) {
        debugPrint('🛵 [Driver API] Successfully accepted job $orderId on backend.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Driver API Notice] Job acceptance delayed ($e).');
    }
    return false;
  }

  /// Driver updates duty status (ONLINE / OFFLINE) on backend
  static Future<bool> toggleDutyStatus(bool isOnline) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/drivers/duty-status');
      final headers = await getAuthHeaders();

      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({'isOnline': isOnline}),
      ).timeout(const Duration(seconds: 4));

      _checkUnauthorized(response);
      if (response.statusCode == 200) {
        debugPrint('🟢 [Driver API] Duty status synced: ${isOnline ? "ONLINE" : "OFFLINE"}');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Driver API Notice] Duty status sync delayed ($e).');
    }
    return false;
  }

  /// Driver updates delivery status (PICKED_UP -> ARRIVED_AT_GATE -> DELIVERED)
  static Future<bool> updateDeliveryStatus(String orderId, String newStatus, {String? otpCode}) async {
    try {
      final cleanId = orderId.replaceAll('#', '').trim();
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$cleanId/status');
      final headers = await getAuthHeaders();

      final bodyMap = <String, String>{'status': newStatus};
      if (otpCode != null) bodyMap['otpCode'] = otpCode;

      final response = await http.patch(
        url,
        headers: headers,
        body: jsonEncode(bodyMap),
      ).timeout(const Duration(seconds: 5));

      _checkUnauthorized(response);
      if (response.statusCode == 200) {
        debugPrint('🛵 [Driver API] Delivery status updated to $newStatus on backend.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Driver API Notice] Delivery status sync delayed ($e).');
    }
    return false;
  }

  /// Driver location update broadcast (Background GPS Heartbeat)
  static Future<bool> updateLocation(double lat, double lng, {double heading = 0}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/drivers/location');
      final headers = await getAuthHeaders();

      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({'lat': lat, 'lng': lng, 'heading': heading}),
      ).timeout(const Duration(seconds: 4));

      _checkUnauthorized(response);
      if (response.statusCode == 200) {
        debugPrint('📍 [Driver API] Location stream updated: ($lat, $lng)');
        return true;
      }
    } catch (e) {
      // Background location heartbeat fail-safe
    }
    return false;
  }
}
