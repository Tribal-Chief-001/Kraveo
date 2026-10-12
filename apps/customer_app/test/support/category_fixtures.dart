// Managed-category payloads copied from REAL backend responses (Docs/23 section 8.4, produced by
// backend/test/e2e/categories_admin.test.ts against PostgreSQL). Ids differ per run; shapes do not.
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// `GET /api/categories?for=home` (two rows from the contract, plus the admin order in sortOrder).
Map<String, dynamic> realHomeCategories() => {
      'success': true,
      'count': 2,
      'data': [
        {
          'id': '72077a2d-9b97-48de-9956-8d0167228f34',
          'name': 'Biryani',
          'nameHi': 'बिरयानी',
          'icon': 'biryani',
          'forRestaurants': true,
          'forDishes': true,
          'showOnHome': true,
          'sortOrder': 25,
          'restaurantCount': 1,
          'dishCount': 1,
        },
        {
          'id': '02236158-229f-48fc-9fe8-4b1220e74ed7',
          'name': 'North Indian',
          'nameHi': null,
          'icon': 'restaurant',
          'forRestaurants': true,
          'forDishes': true,
          'showOnHome': true,
          'sortOrder': 26,
          'restaurantCount': 1,
          'dishCount': 0,
        },
      ],
    };

/// A JSON answer like the real server's: UTF-8 with the charset in the header (Hindi names survive).
http.Response jsonResponse(Object? body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(body is String ? body : jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// One category row in the real shape.
Map<String, dynamic> categoryRow(String name, int sortOrder, {String icon = 'restaurant', bool dishes = true, bool home = true}) => {
      'id': 'cat-${name.toLowerCase().replaceAll(' ', '-')}',
      'name': name,
      'nameHi': null,
      'icon': icon,
      'forRestaurants': true,
      'forDishes': dishes,
      'showOnHome': home,
      'sortOrder': sortOrder,
      'restaurantCount': 1,
      'dishCount': 1,
    };

Map<String, dynamic> categoriesBody(List<Map<String, dynamic>> rows) => {'success': true, 'count': rows.length, 'data': rows};

/// `GET /api/vendors/:id` for a restaurant with two categories (contract section 8.4), menu trimmed to one dish.
Map<String, dynamic> realVendorWithCuisines() => {
      'id': 'sh-ven-1',
      'name': 'Shree Dhaba',
      'category': 'North Indian • Biryani',
      'rating': 4.5,
      'totalRatingsCount': 0,
      'eta': '25-35 mins',
      'bannerImage': 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
      'address': 'Kothri',
      'isAcceptingOrders': true,
      'lat': null,
      'lng': null,
      'cuisines': [
        {'id': '02236158-229f-48fc-9fe8-4b1220e74ed7', 'name': 'North Indian', 'icon': 'restaurant'},
        {'id': '72077a2d-9b97-48de-9956-8d0167228f34', 'name': 'Biryani', 'icon': 'biryani'},
      ],
      'tags': ['North Indian', 'Biryani'],
      'menuItems': [
        {
          'id': '0e4af759-820a-4859-9135-ccb08af7b0b0',
          'vendorId': 'sh-ven-1',
          'name': 'Chicken Biryani',
          'price': 180,
          'category': 'Biryani',
          'categoryId': '72077a2d-9b97-48de-9956-8d0167228f34',
          'description': '',
          'imageUrl': 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
          'isAvailable': true,
          'isVeg': true,
          'rating': 4.5,
          'ratingCount': 0,
        },
      ],
    };

Map<String, dynamic> vendorJson(String id, String name,
        {String category = 'Campus kitchen', List<Map<String, dynamic>>? cuisines, List<String>? tags, List<Map<String, dynamic>> menu = const []}) =>
    {
      'id': id,
      'name': name,
      'category': category,
      'rating': 4.5,
      'eta': '20-25 min',
      'bannerImage': '',
      'isAcceptingOrders': true,
      'address': 'Kothri',
      if (cuisines != null) 'cuisines': cuisines,
      if (tags != null) 'tags': tags,
      'menuItems': menu,
    };

Map<String, dynamic> dishJson(String id, String vendorId, String name, String category) =>
    {'id': id, 'vendorId': vendorId, 'name': name, 'price': 120, 'category': category, 'description': 'd', 'imageUrl': '', 'isAvailable': true, 'isVeg': true};

/// A fake server: `/vendors` and `/categories?for=...` answer what the fields say, anything else 404.
class FakeCatalogServer {
  List<Map<String, dynamic>> vendors = [];

  /// Per `for` value: the answer (a status code + raw body). Missing = 404 like an old server.
  final Map<String, http.Response> categories = {};
  final List<String> categoryRequests = [];

  void answer(String forWhat, Object? body, {int status = 200}) =>
      categories[forWhat] = jsonResponse(body, status);

  MockClient get client => MockClient((req) async {
        final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
        if (path == '/vendors') return jsonResponse({'success': true, 'data': vendors});
        if (path == '/categories') {
          final forWhat = req.url.queryParameters['for'] ?? '';
          categoryRequests.add(forWhat);
          return categories[forWhat] ?? http.Response('{"success":false}', 404);
        }
        return http.Response('{"success":false}', 404);
      });
}
