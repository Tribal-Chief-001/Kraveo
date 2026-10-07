import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/order_view.dart';
import 'driver_api_service.dart';

/// Why a call to Kraveo did not succeed. Every screen maps these to a plain-English message.
enum ApiFailure {
  /// No connection at all (DNS, socket, TLS...).
  offline,

  /// Sent, but no answer in time. The server may or may not have acted, so callers re-check.
  timeout,
  unauthorized,

  /// 403 `PARTNER_NOT_APPROVED`: the account was suspended / not approved.
  notApproved,
  forbidden,
  notFound,
  conflict,

  /// 423 `OTP_LOCKED`.
  locked,
  badRequest,
  rateLimited,
  server,

  /// 2xx with a body the app cannot read.
  badResponse,
}

class ApiResult<T> {
  const ApiResult.ok(this.value)
      : failure = null,
        statusCode = 200,
        code = null,
        message = null,
        attemptsLeft = null;

  const ApiResult.fail(this.failure, {this.statusCode, this.code, this.message, this.attemptsLeft}) : value = null;

  final T? value;
  final ApiFailure? failure;
  final int? statusCode;

  /// Machine code from the server body (`ALREADY_TAKEN`, `OTP_LOCKED`, ...), upper case.
  final String? code;

  /// The server's own human message, when it sent one.
  final String? message;

  /// Wrong-OTP responses may say how many tries remain.
  final int? attemptsLeft;

  bool get ok => failure == null;

  /// Network trouble rather than a decision by the server.
  bool get isNetwork => failure == ApiFailure.offline || failure == ApiFailure.timeout;
}

class OrderPage {
  const OrderPage(this.orders, this.nextCursor);
  final List<OrderView> orders;
  final String? nextCursor;
}

/// Everything the rider app asks of the order API (contract section 2.4). Tests use a fake.
abstract class RiderOrdersApi {
  /// `GET /orders/available?groups=1`: the open pool (pool view: no customer name/phone). `groups=1` tells Kraveo this
  /// app understands combined (multi-restaurant) orders (Docs/22): each is ONE entry, carrying `group`.
  Future<ApiResult<List<OrderView>>> fetchAvailable();

  /// `GET /orders?scope=active`: this rider's live orders (plus ones finished in the last 10 min).
  Future<ApiResult<List<OrderView>>> fetchActive();

  /// `GET /orders?scope=history`: paginated.
  Future<ApiResult<OrderPage>> fetchHistory({String? cursor, int limit = 30});

  /// `GET /orders/:id`.
  Future<ApiResult<OrderView>> fetchOrder(String id);

  /// `POST /orders/:id/accept-driver` (atomic claim).
  Future<ApiResult<OrderView?>> claim(String id);

  /// `POST /orders/:id/release` (before pickup only).
  Future<ApiResult<OrderView?>> release(String id);

  /// `PATCH /orders/:id/status` with `PICKED_UP` or `ARRIVED_AT_GATE`.
  Future<ApiResult<OrderView?>> updateStatus(String id, OrderStatus status);

  /// `POST /orders/:id/verify-gate-otp`.
  Future<ApiResult<OrderView?>> verifyGateOtp(String id, String code);

  /// `POST /drivers/duty-status`. Value: the server's `dutyStatus` string.
  Future<ApiResult<String?>> setDuty(bool online);

  /// `POST /drivers/location`.
  Future<ApiResult<void>> postLocation(double lat, double lng, {double heading = 0});
}

/// The real HTTP implementation. Uses `package:http` top-level functions, so tests can swap the
/// client with `http.runWithClient`. Every call is bounded by a timeout: no endless spinners.
class HttpRiderOrdersApi implements RiderOrdersApi {
  HttpRiderOrdersApi({String? baseUrl, this.timeout = const Duration(seconds: 10)}) : _base = baseUrl ?? ApiConfig.baseUrl;

  final String _base;
  final Duration timeout;

  Uri _u(String path, [Map<String, String>? query]) => Uri.parse('$_base$path').replace(queryParameters: query);

  static String _id(String id) => Uri.encodeComponent(id.trim());

  Future<ApiResult<Object?>> _send(String method, Uri url, {Object? body}) async {
    try {
      final headers = await DriverApiService.getAuthHeaders();
      final encoded = body == null ? null : jsonEncode(body);
      final Future<http.Response> call = switch (method) {
        'GET' => http.get(url, headers: headers),
        'PATCH' => http.patch(url, headers: headers, body: encoded),
        _ => http.post(url, headers: headers, body: encoded),
      };
      final res = await call.timeout(timeout);
      DriverApiService.checkAuthResponse(res);
      Object? json;
      try {
        json = res.body.isEmpty ? null : jsonDecode(res.body);
      } catch (_) {
        json = null;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) return ApiResult.ok(json);
      return _failure(res.statusCode, json);
    } on TimeoutException {
      return const ApiResult.fail(ApiFailure.timeout);
    } catch (_) {
      // SocketException, ClientException, HandshakeException...: no way to reach Kraveo.
      return const ApiResult.fail(ApiFailure.offline);
    }
  }

  static ApiResult<Object?> _failure(int status, Object? json) {
    final map = json is Map ? json : const {};
    final code = map['code']?.toString().toUpperCase();
    final message = map['message']?.toString();
    final left = _int(map['attemptsLeft'] ?? map['attemptsRemaining'] ?? map['remainingAttempts']);
    final ApiFailure kind;
    if (status == 401) {
      kind = ApiFailure.unauthorized;
    } else if (status == 403 && code == 'PARTNER_NOT_APPROVED') {
      kind = ApiFailure.notApproved;
    } else if (status == 423 || code == 'OTP_LOCKED') {
      kind = ApiFailure.locked;
    } else if (status == 403) {
      kind = ApiFailure.forbidden;
    } else if (status == 404) {
      kind = ApiFailure.notFound;
    } else if (status == 409) {
      kind = ApiFailure.conflict;
    } else if (status == 429) {
      kind = ApiFailure.rateLimited;
    } else if (status >= 400 && status < 500) {
      kind = ApiFailure.badRequest;
    } else {
      kind = ApiFailure.server;
    }
    return ApiResult.fail(kind, statusCode: status, code: code, message: message, attemptsLeft: left);
  }

  static int? _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}');

  static ApiResult<T> _carry<T>(ApiResult<Object?> r) =>
      ApiResult.fail(r.failure, statusCode: r.statusCode, code: r.code, message: r.message, attemptsLeft: r.attemptsLeft);

  /// `{data: X}`, `{order: X}`, or X itself.
  static Object? _payload(Object? json) {
    if (json is Map) {
      if (json.containsKey('data')) return json['data'];
      if (json.containsKey('order')) return json['order'];
      if (json.containsKey('orders')) return json['orders'];
    }
    return json;
  }

  ApiResult<List<OrderView>> _list(ApiResult<Object?> r) {
    if (!r.ok) return _carry(r);
    final p = _payload(r.value);
    if (p is! List) return const ApiResult.fail(ApiFailure.badResponse);
    return ApiResult.ok(OrderView.parseList(p));
  }

  /// A successful action. The body should carry the updated order, but a 2xx without one is still
  /// a confirmed success; the caller then re-reads the order.
  ApiResult<OrderView?> _maybeOrder(ApiResult<Object?> r) {
    if (!r.ok) return _carry(r);
    return ApiResult.ok(OrderView.tryParse(_payload(r.value)));
  }

  @override
  Future<ApiResult<List<OrderView>>> fetchAvailable() async => _list(await _send('GET', _u('/orders/available', {'groups': '1'})));

  @override
  Future<ApiResult<List<OrderView>>> fetchActive() async => _list(await _send('GET', _u('/orders', {'scope': 'active', 'limit': '20'})));

  @override
  Future<ApiResult<OrderPage>> fetchHistory({String? cursor, int limit = 30}) async {
    final r = await _send('GET', _u('/orders', {'scope': 'history', 'limit': '$limit', if (cursor != null) 'cursor': cursor}));
    if (!r.ok) return _carry(r);
    final p = _payload(r.value);
    if (p is! List) return const ApiResult.fail(ApiFailure.badResponse);
    final next = r.value is Map ? (r.value as Map)['nextCursor']?.toString() : null;
    return ApiResult.ok(OrderPage(OrderView.parseList(p), (next == null || next.isEmpty) ? null : next));
  }

  @override
  Future<ApiResult<OrderView>> fetchOrder(String id) async {
    final r = await _send('GET', _u('/orders/${_id(id)}'));
    if (!r.ok) return _carry(r);
    final o = OrderView.tryParse(_payload(r.value));
    return o == null ? const ApiResult.fail(ApiFailure.badResponse) : ApiResult.ok(o);
  }

  @override
  Future<ApiResult<OrderView?>> claim(String id) async => _maybeOrder(await _send('POST', _u('/orders/${_id(id)}/accept-driver')));

  @override
  Future<ApiResult<OrderView?>> release(String id) async => _maybeOrder(await _send('POST', _u('/orders/${_id(id)}/release')));

  @override
  Future<ApiResult<OrderView?>> updateStatus(String id, OrderStatus status) async =>
      _maybeOrder(await _send('PATCH', _u('/orders/${_id(id)}/status'), body: {'status': status.wire}));

  @override
  Future<ApiResult<OrderView?>> verifyGateOtp(String id, String code) async =>
      _maybeOrder(await _send('POST', _u('/orders/${_id(id)}/verify-gate-otp'), body: {'otpCode': code.trim()}));

  @override
  Future<ApiResult<String?>> setDuty(bool online) async {
    final r = await _send('POST', _u('/drivers/duty-status'), body: {'isOnline': online});
    if (!r.ok) return _carry(r);
    final v = r.value;
    return ApiResult.ok(v is Map ? v['dutyStatus']?.toString() : null);
  }

  @override
  Future<ApiResult<void>> postLocation(double lat, double lng, {double heading = 0}) async {
    final r = await _send('POST', _u('/drivers/location'), body: {'lat': lat, 'lng': lng, 'heading': heading});
    return r.ok ? const ApiResult.ok(null) : _carry(r);
  }
}
