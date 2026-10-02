import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/dish_model.dart';
import '../models/order_model.dart';
import 'vendor_api_service.dart';

/// Why a call to Kraveo did not succeed. Every screen turns one of these into a clear,
/// bilingual message (see `failureMessage`), so no failure is ever silent.
enum ApiFailure {
  /// No internet / DNS / connection refused.
  offline,

  /// No answer in time. The action MAY have reached the server, so the app re-reads the order.
  timeout,

  /// 401: the login is no longer valid (the session gate sends the partner to the login screen).
  unauthorized,

  /// 403 `PARTNER_NOT_APPROVED`: the restaurant was suspended (the session gate shows the status screen).
  notApproved,

  /// Any other 403.
  forbidden,

  /// 404: the order is not (or no longer) visible to this restaurant.
  notFound,

  /// 409: someone else changed the order first (cancelled, expired, accepted on another phone).
  conflict,

  /// 400: the server refused the request (e.g. a step that is not allowed any more).
  invalid,

  /// 429: too many requests; try again shortly.
  rateLimited,

  /// 5xx or an unreadable answer.
  server,
}

class ApiResult<T> {
  const ApiResult.success(this.data, {this.serverTime})
      : failure = null,
        message = null,
        code = null,
        statusCode = null,
        retryAfterSeconds = null;

  const ApiResult.failure(ApiFailure this.failure, {this.message, this.code, this.statusCode, this.retryAfterSeconds})
      : data = null,
        serverTime = null;

  final T? data;
  final ApiFailure? failure;

  /// Server-provided text (`message`), when there is one.
  final String? message;

  /// Server-provided machine code (`code`, e.g. `PARTNER_NOT_APPROVED`, `ALREADY_TAKEN`).
  final String? code;
  final int? statusCode;
  final int? retryAfterSeconds;

  /// The server's clock (HTTP `Date` header), used to keep countdowns honest when the phone's clock is off.
  final DateTime? serverTime;

  bool get ok => failure == null;

  ApiResult<R> cast<R>() => ApiResult<R>.failure(failure!, message: message, code: code, statusCode: statusCode, retryAfterSeconds: retryAfterSeconds);
}

enum OrderScope { active, history }

class OrdersPage {
  const OrdersPage({required this.orders, this.nextCursor, this.skipped = 0});
  final List<OrderModel> orders;
  final String? nextCursor;

  /// Entries that could not be parsed (reported, never shown half-broken).
  final int skipped;
}

/// Everything the restaurant app asks of the Kraveo server. The screens and the order controller
/// only talk to this interface, so tests can drive every state with a fake.
abstract class VendorBackend {
  /// `GET /orders?scope=active|history&limit&cursor` (only PAID orders of this restaurant).
  Future<ApiResult<OrdersPage>> fetchOrders(OrderScope scope, {String? cursor, int limit = 50});

  /// `GET /orders/:id`.
  Future<ApiResult<OrderModel>> fetchOrder(String id);

  /// `PATCH /orders/:id/status` with ACCEPTED | PREPARING | READY_FOR_PICKUP. The data may be null when the
  /// server answered 200 without a readable order (the caller then re-reads the order).
  Future<ApiResult<OrderModel>> updateStatus(String id, OrderStatus status);

  /// `POST /orders/:id/reject` `{reason}` (3-200 characters).
  Future<ApiResult<OrderModel>> reject(String id, String reason);

  /// `GET /vendors/:id` -> `isAcceptingOrders`.
  Future<ApiResult<bool>> fetchStoreOpen(String vendorId);

  /// `PATCH /vendors/:id/status` `{isAcceptingOrders}` -> the value the server saved.
  Future<ApiResult<bool>> setStoreOpen(String vendorId, bool open);

  /// `GET /menus/:vendorId`.
  Future<ApiResult<List<DishModel>>> fetchMenu(String vendorId);

  /// `POST /vendors/:id/items`.
  Future<ApiResult<DishModel>> addDish(String vendorId, {required String name, required String category, required double price});

  /// `PATCH /vendors/items/:itemId` `{isAvailable?, price?}`.
  Future<ApiResult<DishModel>> updateDish(String itemId, {bool? isAvailable, double? price});
}

class HttpVendorBackend implements VendorBackend {
  const HttpVendorBackend({this.timeout = const Duration(seconds: 10)});

  final Duration timeout;

  static String get _base => ApiConfig.baseUrl;

  static Object? _decode(String body) {
    if (body.isEmpty) return null;
    try {
      return jsonDecode(body);
    } catch (_) {
      return null;
    }
  }

  /// The order inside `{data: OrderView}` (also tolerates `{order: ...}` or a bare OrderView).
  static OrderModel? _orderFrom(Object? json) {
    if (json is Map) {
      for (final key in const ['data', 'order']) {
        final inner = json[key];
        if (inner is Map) return OrderModel.fromJson(inner);
      }
      return OrderModel.fromJson(json);
    }
    return null;
  }

  Future<ApiResult<Object?>> _send(String method, String path, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('$_base$path');
    final headers = await VendorApiService.getAuthHeaders();
    final http.Response response;
    try {
      final Future<http.Response> call = switch (method) {
        'GET' => http.get(uri, headers: headers),
        'PATCH' => http.patch(uri, headers: headers, body: jsonEncode(body ?? const {})),
        'POST' => http.post(uri, headers: headers, body: jsonEncode(body ?? const {})),
        _ => throw ArgumentError(method),
      };
      response = await call.timeout(timeout);
    } on TimeoutException {
      return const ApiResult.failure(ApiFailure.timeout);
    } catch (_) {
      // SocketException, ClientException, HandshakeException ... all mean "could not reach Kraveo".
      return const ApiResult.failure(ApiFailure.offline);
    }

    VendorApiService.checkResponse(response);
    final json = _decode(response.body);
    final map = json is Map ? json : const {};
    final message = map['message'] is String ? map['message'] as String : null;
    final code = map['code'] is String ? map['code'] as String : null;
    final status = response.statusCode;

    if (status >= 200 && status < 300) {
      DateTime? serverTime;
      final date = response.headers['date'];
      if (date != null) {
        try {
          serverTime = HttpDate.parse(date);
        } catch (_) {}
      }
      return ApiResult.success(json, serverTime: serverTime);
    }
    final failure = switch (status) {
      400 || 422 => ApiFailure.invalid,
      401 => ApiFailure.unauthorized,
      403 => code == 'PARTNER_NOT_APPROVED' ? ApiFailure.notApproved : ApiFailure.forbidden,
      404 => ApiFailure.notFound,
      409 || 423 => ApiFailure.conflict,
      429 => ApiFailure.rateLimited,
      _ => ApiFailure.server,
    };
    int? retryAfter;
    if (status == 429) {
      final raw = map['retryAfterSeconds'];
      retryAfter = raw is num ? raw.toInt() : int.tryParse(response.headers['retry-after'] ?? '');
    }
    return ApiResult.failure(failure, message: message, code: code, statusCode: status, retryAfterSeconds: retryAfter);
  }

  @override
  Future<ApiResult<OrdersPage>> fetchOrders(OrderScope scope, {String? cursor, int limit = 50}) async {
    final q = <String, String>{'scope': scope.name, 'limit': '$limit', if (cursor != null && cursor.isNotEmpty) 'cursor': cursor};
    final res = await _send('GET', '/orders?${Uri(queryParameters: q).query}');
    if (!res.ok) return res.cast();
    final json = res.data;
    final List<dynamic>? rawList = json is List ? json : (json is Map && json['data'] is List ? json['data'] as List : null);
    if (rawList == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable order list');
    final orders = <OrderModel>[];
    var skipped = 0;
    for (final raw in rawList) {
      final o = OrderModel.fromJson(raw);
      if (o == null) {
        skipped++;
      } else {
        orders.add(o);
      }
    }
    final next = json is Map ? json['nextCursor']?.toString() : null;
    return ApiResult.success(OrdersPage(orders: orders, nextCursor: (next == null || next.isEmpty) ? null : next, skipped: skipped), serverTime: res.serverTime);
  }

  @override
  Future<ApiResult<OrderModel>> fetchOrder(String id) async {
    final res = await _send('GET', '/orders/${Uri.encodeComponent(id)}');
    if (!res.ok) return res.cast();
    final order = _orderFrom(res.data);
    if (order == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable order');
    return ApiResult.success(order, serverTime: res.serverTime);
  }

  @override
  Future<ApiResult<OrderModel>> updateStatus(String id, OrderStatus status) async {
    final res = await _send('PATCH', '/orders/${Uri.encodeComponent(id)}/status', body: {'status': status.wire});
    if (!res.ok) return res.cast();
    return ApiResult.success(_orderFrom(res.data), serverTime: res.serverTime);
  }

  @override
  Future<ApiResult<OrderModel>> reject(String id, String reason) async {
    final res = await _send('POST', '/orders/${Uri.encodeComponent(id)}/reject', body: {'reason': reason});
    if (!res.ok) return res.cast();
    return ApiResult.success(_orderFrom(res.data), serverTime: res.serverTime);
  }

  @override
  Future<ApiResult<bool>> fetchStoreOpen(String vendorId) async {
    final res = await _send('GET', '/vendors/${Uri.encodeComponent(vendorId)}');
    if (!res.ok) return res.cast();
    final json = res.data;
    final data = json is Map ? (json['data'] is Map ? json['data'] as Map : json) : null;
    final open = data?['isAcceptingOrders'];
    if (open is! bool) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable store status');
    return ApiResult.success(open);
  }

  @override
  Future<ApiResult<bool>> setStoreOpen(String vendorId, bool open) async {
    final res = await _send('PATCH', '/vendors/${Uri.encodeComponent(vendorId)}/status', body: {'isAcceptingOrders': open});
    if (!res.ok) return res.cast();
    final json = res.data;
    final saved = json is Map ? (json['isAcceptingOrders'] ?? (json['data'] is Map ? (json['data'] as Map)['isAcceptingOrders'] : null)) : null;
    return ApiResult.success(saved is bool ? saved : open);
  }

  @override
  Future<ApiResult<List<DishModel>>> fetchMenu(String vendorId) async {
    final res = await _send('GET', '/menus/${Uri.encodeComponent(vendorId)}');
    if (!res.ok) return res.cast();
    final json = res.data;
    final List<dynamic>? raw = json is List ? json : (json is Map && json['data'] is List ? json['data'] as List : null);
    if (raw == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable menu');
    return ApiResult.success([
      for (final it in raw)
        if (DishModel.fromJson(it) case final DishModel d) d,
    ]);
  }

  @override
  Future<ApiResult<DishModel>> addDish(String vendorId, {required String name, required String category, required double price}) async {
    final res = await _send('POST', '/vendors/${Uri.encodeComponent(vendorId)}/items', body: {'name': name, 'category': category, 'price': price});
    if (!res.ok) return res.cast();
    final json = res.data;
    final dish = DishModel.fromJson(json is Map ? (json['data'] ?? json['item'] ?? json) : null);
    if (dish == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable dish');
    return ApiResult.success(dish);
  }

  @override
  Future<ApiResult<DishModel>> updateDish(String itemId, {bool? isAvailable, double? price}) async {
    final res = await _send('PATCH', '/vendors/items/${Uri.encodeComponent(itemId)}', body: {
      if (isAvailable != null) 'isAvailable': isAvailable,
      if (price != null) 'price': price,
    });
    if (!res.ok) return res.cast();
    final json = res.data;
    return ApiResult.success(DishModel.fromJson(json is Map ? (json['item'] ?? json['data']) : null));
  }
}
