import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

class VendorApiService {
  /// Updates Order Status on backend (e.g. PREPARING -> READY_FOR_PICKUP)
  static Future<bool> updateOrderStatus(String orderId, String newStatus) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/orders/$orderId/status');
      final response = await http.patch(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'status': newStatus}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('🌐 [Vendor API] Successfully synced order $orderId status to $newStatus on AWS EC2 backend.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Vendor API Notice] AWS EC2 sync delayed ($e). Action preserved locally.');
    }
    return false;
  }

  /// Toggles Dhaba Store OPEN / CLOSED status on backend
  static Future<bool> toggleStoreStatus(String vendorId, bool isAcceptingOrders) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/vendors/$vendorId/status');
      final response = await http.patch(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'isAcceptingOrders': isAcceptingOrders}),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('🏪 [Vendor API] Successfully updated store status to ${isAcceptingOrders ? "OPEN" : "CLOSED"} on AWS backend.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Vendor API Notice] Store status sync delayed ($e).');
    }
    return false;
  }

  /// Updates Dish Stock Availability (IN STOCK / SOLD OUT) or Price on backend
  static Future<bool> updateDishStock(String itemId, {bool? isAvailable, double? price}) async {
    try {
      final url = Uri.parse('${ApiConfig.baseUrl}/vendors/items/$itemId');
      final bodyMap = <String, dynamic>{};
      if (isAvailable != null) bodyMap['isAvailable'] = isAvailable;
      if (price != null) bodyMap['price'] = price;

      final response = await http.patch(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(bodyMap),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        print('📦 [Vendor API] Dish $itemId stock/price updated successfully on backend.');
        return true;
      }
    } catch (e) {
      print('⚠️ [Vendor API Notice] Dish stock sync delayed ($e).');
    }
    return false;
  }
}
