import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

class CustomerApiService {
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
        print('📱 [Customer API] OTP sent successfully to $phone');
        return true;
      }
    } catch (e) {
      print('⚠️ [Customer API Notice] Send OTP delayed ($e).');
    }
    return false;
  }

  /// Verifies student 4-digit SMS OTP
  static Future<String?> verifyOtp(String phone, String otp) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/auth/verify-otp');
      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'phone': phone, 'otp': otp}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        final json = jsonDecode(response.body);
        final token = json['token'] as String?;
        print('🔑 [Customer API] OTP verified successfully for $phone');
        return token;
      }
    } catch (e) {
      print('⚠️ [Customer API Notice] Verify OTP delayed ($e).');
    }
    return null;
  }

  /// Places order on AWS EC2 backend
  static Future<bool> placeOrder(Map<String, dynamic> orderPayload) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock_jwt_token_usr-1',
        },
        body: jsonEncode(orderPayload),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200 || response.statusCode == 201) {
        print('🛍️ [Customer API] Order placed successfully on AWS backend!');
        return true;
      }
    } catch (e) {
      print('⚠️ [Customer API Notice] Order placement sync delayed ($e).');
    }
    return false;
  }

  /// Submits dish & runner review, awarding +10 Kuvera Coins
  static Future<bool> submitReview({
    required String orderId,
    required double dhabaRating,
    required double driverRating,
    required String reviewText,
  }) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/reviews');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock_jwt_token_usr-1',
        },
        body: jsonEncode({
          'orderId': orderId,
          'dhabaRating': dhabaRating,
          'driverRating': driverRating,
          'reviewText': reviewText,
        }),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('⭐️ [Customer API] Review submitted! +10 Kuvera Coins awarded.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Customer API Notice] Review submission delayed ($e).');
    }
    return false;
  }
}
