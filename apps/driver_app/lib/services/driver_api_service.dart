import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

class DriverApiService {
  /// Driver accepts job assignment on AWS EC2 backend
  static Future<bool> acceptJob(String orderId) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$orderId/accept-driver');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-driver-token',
        },
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('🛵 [Driver API] Successfully accepted job $orderId on backend.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Driver API Notice] Job acceptance delayed ($e).');
    }
    return false;
  }

  /// Driver updates delivery status (PICKED_UP -> ARRIVED_AT_GATE -> DELIVERED)
  static Future<bool> updateDeliveryStatus(String orderId, String newStatus, {String? otpCode}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$orderId/status');
      final bodyMap = <String, String>{'status': newStatus};
      if (otpCode != null) bodyMap['otpCode'] = otpCode;

      final response = await http.patch(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-driver-token',
        },
        body: jsonEncode(bodyMap),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('🛵 [Driver API] Delivery status updated to $newStatus on backend.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Driver API Notice] Delivery status sync delayed ($e).');
    }
    return false;
  }

  /// Driver location update broadcast
  static Future<bool> updateLocation(double lat, double lng, {double heading = 0}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/drivers/location');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock-driver-token',
        },
        body: jsonEncode({'lat': lat, 'lng': lng, 'heading': heading}),
      ).timeout(const Duration(seconds: 4));

      if (response.statusCode == 200) {
        return true;
      }
    } catch (e) {
      // Background location heartbeat
    }
    return false;
  }
}
