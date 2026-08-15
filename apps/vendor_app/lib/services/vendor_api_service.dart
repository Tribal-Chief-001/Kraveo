import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';

class VendorApiService {
  static const String _tokenPrefKey = 'kraveo_vendor_jwt_token';
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

  /// Updates Order Status on backend (e.g. PREPARING -> READY_FOR_PICKUP)
  static Future<bool> updateOrderStatus(String orderId, String newStatus) async {
    try {
      final cleanId = orderId.replaceAll('#', '').trim();
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$cleanId/status');
      final headers = await getAuthHeaders();

      final response = await http.patch(
        url,
        headers: headers,
        body: jsonEncode({'status': newStatus}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        debugPrint('🌐 [Vendor API] Successfully synced order $orderId status to $newStatus on AWS EC2 backend.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Vendor API Notice] AWS EC2 sync delayed ($e). Action preserved locally.');
    }
    return false;
  }

  /// Toggles Dhaba Store OPEN / CLOSED status on backend
  static Future<bool> toggleStoreStatus(String vendorId, bool isAcceptingOrders) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/vendors/$vendorId/status');
      final headers = await getAuthHeaders();

      final response = await http.patch(
        url,
        headers: headers,
        body: jsonEncode({'isAcceptingOrders': isAcceptingOrders}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        debugPrint('🏪 [Vendor API] Successfully updated store status to ${isAcceptingOrders ? "OPEN" : "CLOSED"} on AWS backend.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Vendor API Notice] Store status sync delayed ($e).');
    }
    return false;
  }

  /// Updates Dish Stock Availability (IN STOCK / SOLD OUT) or Price on backend
  static Future<bool> updateDishStock(String itemId, {bool? isAvailable, double? price}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/vendors/items/$itemId');
      final headers = await getAuthHeaders();

      final bodyMap = <String, dynamic>{};
      if (isAvailable != null) bodyMap['isAvailable'] = isAvailable;
      if (price != null) bodyMap['price'] = price;

      final response = await http.patch(
        url,
        headers: headers,
        body: jsonEncode(bodyMap),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        debugPrint('📦 [Vendor API] Dish $itemId stock/price updated successfully on backend.');
        return true;
      }
    } catch (e) {
      debugPrint('⚠️ [Vendor API Notice] Dish stock sync delayed ($e).');
    }
    return false;
  }

  /// Fetches pending active orders for vendor from backend API
  static Future<List<dynamic>> fetchIncomingOrders(String vendorId) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/vendors/$vendorId/orders?status=PLACED');
      final headers = await getAuthHeaders();

      final response = await http.get(url, headers: headers).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        debugPrint('📡 [Vendor API] Fetched ${data.length} active orders from backend.');
        return data;
      }
    } catch (e) {
      debugPrint('⚠️ [Vendor API Notice] Fetching incoming orders delayed ($e).');
    }
    return [];
  }
}

