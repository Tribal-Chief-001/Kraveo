import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';

class CustomerApiService {
  static const String _tokenPrefKey = 'kraveo_customer_jwt_token';
  static String? _cachedToken;

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
  static Future<Map<String, dynamic>?> fetchProfile() async {
    final token = await getSavedToken();
    if (token == null || token.isEmpty) return null;

    try {
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/auth/profile'),
        headers: await getAuthHeaders(),
      ).timeout(const Duration(seconds: 10));
      final body = jsonDecode(response.body);
      if (response.statusCode == 200 && body is Map && body['user'] is Map) {
        return Map<String, dynamic>.from(body['user'] as Map);
      }
    } catch (e) {
      debugPrint('⚠️ [Customer API] Session validation failed: $e');
    }

    await clearToken();
    return null;
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

  /// Sends SMS OTP to student phone number
  static Future<bool> sendOtp(String phone) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/auth/send-otp');
      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'phone': phone}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        debugPrint('📱 [Customer API] OTP sent successfully to $phone');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Customer API Notice] Send OTP delayed ($e).');
    }
    return false;
  }

  /// Verifies student 4-digit SMS OTP & stores returned JWT session token
  static Future<String?> verifyOtp(String phone, String otp, {String? name, String? hostelBlock}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/auth/verify-otp');
      final bodyMap = <String, dynamic>{'phone': phone, 'otp': otp, 'role': 'STUDENT'};
      if (name != null) bodyMap['name'] = name;
      if (hostelBlock != null) bodyMap['hostelBlock'] = hostelBlock;

      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(bodyMap),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        final json = jsonDecode(response.body);
        final token = json['token'] as String?;
        if (token != null) {
          await saveToken(token);
        }
        debugPrint('🔑 [Customer API] OTP verified successfully for $phone');
        return token;
      }
    } catch (e) {
      debugPrint('⚠️ [Customer API Notice] Verify OTP delayed ($e).');
    }
    return null;
  }

  /// Places order on AWS EC2 backend with dynamic JWT token
  static Future<bool> placeOrder(Map<String, dynamic> orderPayload) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders');
      final headers = await getAuthHeaders();

      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode(orderPayload),
      ).timeout(const Duration(seconds: 5));

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
      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode(payload),
      ).timeout(const Duration(seconds: 15));
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
      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({'orderId': orderId}),
      ).timeout(const Duration(seconds: 15));
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
      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({
          'razorpayOrderId': razorpayOrderId,
          'razorpayPaymentId': razorpayPaymentId,
          'razorpaySignature': razorpaySignature,
        }),
      ).timeout(const Duration(seconds: 15));
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

      final response = await http.post(
        url,
        headers: headers,
        body: jsonEncode({
          'orderId': orderId,
          'dhabaRating': dhabaRating,
          'driverRating': driverRating,
          'reviewText': reviewText,
        }),
      ).timeout(const Duration(seconds: 5));

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
