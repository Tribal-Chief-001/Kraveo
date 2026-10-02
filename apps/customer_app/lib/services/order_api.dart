import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../models/order.dart';
import 'customer_api_service.dart';

/// What went wrong with an order/payment call, already classified for the UI.
enum OrderErrorKind {
  /// No HTTP answer (offline, DNS, connection reset).
  offline,

  /// No answer within the call's timeout.
  timeout,

  /// 401: the session is gone (the app shell already returned to login).
  unauthorized,

  /// 403.
  forbidden,

  /// 404 (also used when the server hides someone else's order).
  notFound,

  /// 409: the order changed meanwhile (e.g. already accepted, already paid).
  conflict,

  /// 429: too many unpaid orders or too many attempts.
  rateLimited,

  /// 400 / 422: the server refused the request (sold out, closed, bad drop point…).
  rejected,

  /// 5xx.
  server,

  /// 2xx with a body we could not understand.
  badResponse,
}

class OrderApiError {
  const OrderApiError(this.kind, {this.statusCode, this.code, this.message, this.order});

  final OrderErrorKind kind;
  final int? statusCode;

  /// Machine code from the server (`{code}`), e.g. `ALREADY_TAKEN`.
  final String? code;

  /// The server's own message when it sent one.
  final String? message;

  /// The order as the server sees it, when the error body carries one (`data`), e.g. a
  /// verify-signature refused with `ORDER_CANCELLED`.
  final OrderModel? order;

  bool get isNetwork => kind == OrderErrorKind.offline || kind == OrderErrorKind.timeout;

  @override
  String toString() => 'OrderApiError($kind, $statusCode, $code, $message)';
}

/// Either a value or an [OrderApiError].
class OrderResult<T> {
  const OrderResult.ok(T this.value) : error = null;
  const OrderResult.fail(OrderApiError this.error) : value = null;

  final T? value;
  final OrderApiError? error;

  bool get ok => error == null;
}

/// One page of `GET /orders`.
class OrdersPage {
  const OrdersPage(this.orders, this.nextCursor);
  final List<OrderModel> orders;
  final String? nextCursor;
}

/// What `POST /payments/create-order` returns, reduced to what Razorpay checkout needs.
class PaymentSession {
  const PaymentSession({required this.orderId, required this.keyId, required this.razorpayOrderId, required this.amountPaise, this.currency = 'INR'});

  /// Kraveo order id.
  final String orderId;
  final String keyId;
  final String razorpayOrderId;
  final int amountPaise;
  final String currency;
}

/// The three values Razorpay hands back on success; the server verifies the signature.
class PaymentProof {
  const PaymentProof({required this.razorpayOrderId, required this.razorpayPaymentId, required this.razorpaySignature});
  final String razorpayOrderId;
  final String razorpayPaymentId;
  final String razorpaySignature;
}

/// The body of `POST /orders` (contract 2.2).
class CreateOrderRequest {
  const CreateOrderRequest({
    required this.vendorId,
    required this.items,
    required this.dropoffHostel,
    required this.dropoffNotes,
    required this.clientRequestId,
    this.couponCode,
  });

  final String vendorId;

  /// `{itemId, quantity}` pairs.
  final List<({String itemId, int quantity})> items;
  final String dropoffHostel;
  final String dropoffNotes;
  final String? couponCode;
  final String clientRequestId;

  Map<String, dynamic> toJson() => {
        'vendorId': vendorId,
        'items': [for (final i in items) {'itemId': i.itemId, 'quantity': i.quantity}],
        'dropoffHostel': dropoffHostel,
        if (dropoffNotes.isNotEmpty) 'dropoffNotes': dropoffNotes,
        if (couponCode != null && couponCode!.isNotEmpty) 'couponCode': couponCode,
        'clientRequestId': clientRequestId,
      };
}

/// A review for a delivered order, in the shape `POST /reviews` accepts today.
class ReviewRequest {
  const ReviewRequest({required this.orderId, required this.driverRating, required this.dishRatings, this.driverTags = const [], this.driverNotes = '', this.dhabaNotes = ''});

  final String orderId;
  final int? driverRating;

  /// menuItemId -> 1..5
  final Map<String, int> dishRatings;
  final List<String> driverTags;
  final String driverNotes;
  final String dhabaNotes;

  Map<String, dynamic> toJson() => {
        'orderId': orderId,
        if (driverRating != null) 'driverRating': driverRating,
        'driverTags': driverTags,
        'driverNotes': driverNotes,
        'dishReviews': [for (final e in dishRatings.entries) {'dishId': e.key, 'rating': e.value}],
        'dhabaNotes': dhabaNotes,
      };
}

class ReviewReceipt {
  const ReviewReceipt({required this.coinsEarned, this.totalCoins});
  final int coinsEarned;

  /// The student's new balance, when the server reports it.
  final int? totalCoins;
}

/// Everything the customer app may ask of the order backend (contract 2.2). The only way the
/// app learns about orders; [HttpOrderApi] is the real implementation, tests use fakes.
abstract class OrderApi {
  Future<OrderResult<OrderModel>> createOrder(CreateOrderRequest request);
  Future<OrderResult<OrdersPage>> fetchOrders({required String scope, int limit = 20, String? cursor});
  Future<OrderResult<OrderModel>> fetchOrder(String orderId);
  Future<OrderResult<OrderModel>> cancelOrder(String orderId, {String? reason});
  Future<OrderResult<PaymentSession>> createPayment(String orderId);

  /// Returns the updated order when the server includes it, otherwise null (still a success).
  Future<OrderResult<OrderModel?>> verifyPayment(PaymentProof proof);
  Future<OrderResult<ReviewReceipt>> submitReview(ReviewRequest request);
}

/// Talks to the real backend through [CustomerApiService.authorizedRequest] (token, timeouts,
/// 401 handling, test client seam).
class HttpOrderApi implements OrderApi {
  const HttpOrderApi();

  static const Duration _write = Duration(seconds: 15);
  static const Duration _read = Duration(seconds: 12);

  @override
  Future<OrderResult<OrderModel>> createOrder(CreateOrderRequest request) =>
      _call('POST', '/orders', body: request.toJson(), timeout: _write, parse: _orderFromBody);

  @override
  Future<OrderResult<OrdersPage>> fetchOrders({required String scope, int limit = 20, String? cursor}) => _call(
        'GET',
        '/orders',
        query: {'scope': scope, 'limit': limit, 'cursor': cursor},
        timeout: _read,
        parse: (body) {
          final data = body['data'];
          if (data is! List) return null;
          final orders = data.map(OrderModel.tryParse).whereType<OrderModel>().toList();
          final next = body['nextCursor'];
          return OrdersPage(orders, next is String && next.isNotEmpty ? next : null);
        },
      );

  @override
  Future<OrderResult<OrderModel>> fetchOrder(String orderId) =>
      _call('GET', '/orders/${Uri.encodeComponent(orderId)}', timeout: _read, parse: _orderFromBody);

  @override
  Future<OrderResult<OrderModel>> cancelOrder(String orderId, {String? reason}) => _call(
        'POST',
        '/orders/${Uri.encodeComponent(orderId)}/cancel',
        body: {if (reason != null && reason.isNotEmpty) 'reason': reason},
        timeout: _write,
        parse: _orderFromBody,
      );

  @override
  Future<OrderResult<PaymentSession>> createPayment(String orderId) => _call(
        'POST',
        '/payments/create-order',
        body: {'orderId': orderId},
        timeout: _write,
        parse: (body) {
          if (body['success'] == false) return null;
          final keyId = (body['key_id'] ?? body['keyId'])?.toString();
          final rzpOrder = (body['order_id'] ?? body['razorpayOrderId'])?.toString();
          final amount = body['amount'] ?? body['amountInPaise'];
          if (keyId == null || keyId.isEmpty || rzpOrder == null || rzpOrder.isEmpty || amount is! num || amount < 100) return null;
          return PaymentSession(orderId: orderId, keyId: keyId, razorpayOrderId: rzpOrder, amountPaise: amount.round(), currency: body['currency']?.toString() ?? 'INR');
        },
      );

  @override
  Future<OrderResult<OrderModel?>> verifyPayment(PaymentProof proof) => _call<OrderModel?>(
        'POST',
        '/payments/verify-signature',
        body: {'razorpayOrderId': proof.razorpayOrderId, 'razorpayPaymentId': proof.razorpayPaymentId, 'razorpaySignature': proof.razorpaySignature},
        timeout: _write,
        // Success may or may not carry the order; both are fine.
        parse: (body) => body['success'] == false ? null : _Maybe(OrderModel.tryParse(body['data'] ?? body['order'])),
      );

  @override
  Future<OrderResult<ReviewReceipt>> submitReview(ReviewRequest request) => _call(
        'POST',
        '/reviews',
        body: request.toJson(),
        timeout: _write,
        parse: (body) {
          if (body['success'] == false) return null;
          final earned = body['coinsEarned'];
          final total = body['totalCoins'];
          return ReviewReceipt(coinsEarned: earned is num ? earned.toInt() : 0, totalCoins: total is num ? total.toInt() : null);
        },
      );

  static OrderModel? _orderFromBody(Map<String, dynamic> body) => OrderModel.tryParse(body['data'] ?? body['order']);

  /// [parse] returns null for an unusable body. For nullable [T], wrap the value in [_Maybe].
  Future<OrderResult<T>> _call<T>(
    String method,
    String path, {
    Map<String, dynamic>? query,
    Object? body,
    required Duration timeout,
    required Object? Function(Map<String, dynamic> body) parse,
  }) async {
    http.Response response;
    try {
      response = await CustomerApiService.authorizedRequest(method, path, query: query, body: body, timeout: timeout);
    } on TimeoutException {
      return const OrderResult.fail(OrderApiError(OrderErrorKind.timeout));
    } on SocketException {
      return const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
    } on http.ClientException {
      return const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
    } catch (e) {
      debugPrint('[Order API] $method $path failed: ${e.runtimeType}');
      return const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
    }

    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) json = Map<String, dynamic>.from(decoded);
    } catch (_) {}

    final status = response.statusCode;
    if (status >= 200 && status < 300) {
      final parsed = parse(json);
      if (parsed == null) {
        debugPrint('[Order API] $method $path: unexpected body (HTTP $status)');
        return OrderResult.fail(OrderApiError(OrderErrorKind.badResponse, statusCode: status));
      }
      return OrderResult.ok((parsed is _Maybe ? parsed.value : parsed) as T);
    }
    return OrderResult.fail(errorFor(status, json));
  }

  /// Classifies a non-2xx answer.
  static OrderApiError errorFor(int status, Map<String, dynamic> body) {
    final m = body['message'];
    final message = m is String && m.trim().isNotEmpty ? m.trim() : null;
    final code = body['code']?.toString();
    final order = OrderModel.tryParse(body['data']);
    final kind = switch (status) {
      401 => OrderErrorKind.unauthorized,
      403 => OrderErrorKind.forbidden,
      404 => OrderErrorKind.notFound,
      409 => OrderErrorKind.conflict,
      429 => OrderErrorKind.rateLimited,
      400 || 422 => OrderErrorKind.rejected,
      423 => OrderErrorKind.conflict,
      _ when status >= 500 => OrderErrorKind.server,
      _ => OrderErrorKind.rejected,
    };
    return OrderApiError(kind, statusCode: status, code: code, message: message, order: order);
  }
}

class _Maybe<T> {
  const _Maybe(this.value);
  final T value;
}

/// Plain-English message for an [OrderApiError]. [action] names what failed ("place your order").
String orderErrorMessage(OrderApiError error, {String action = 'do that'}) {
  final byCode = _codeMessages[error.code];
  if (byCode != null) return byCode;
  switch (error.kind) {
    case OrderErrorKind.offline:
      return 'No internet connection. We couldn\'t $action. Check your connection and try again.';
    case OrderErrorKind.timeout:
      return 'Kraveo is taking too long to answer, so we couldn\'t $action. Please try again.';
    case OrderErrorKind.unauthorized:
      return CustomerApiService.sessionExpiredMessage;
    case OrderErrorKind.forbidden:
      return error.message ?? 'Your account can\'t $action.';
    case OrderErrorKind.notFound:
      return 'We couldn\'t find this order.';
    case OrderErrorKind.conflict:
      return error.message ?? 'This order changed in the meantime. We\'ve loaded its latest status.';
    case OrderErrorKind.rateLimited:
      return error.message ?? 'You already have several unpaid orders. Pay for or cancel one, or wait a minute, then try again.';
    case OrderErrorKind.rejected:
      return error.message ?? 'Kraveo couldn\'t $action. Check your order and try again.';
    case OrderErrorKind.server:
      return 'Kraveo is having trouble right now, so we couldn\'t $action. Please try again in a moment.';
    case OrderErrorKind.badResponse:
      return 'Kraveo sent an answer we couldn\'t read, so we couldn\'t $action. Please try again.';
  }
}

/// Customer-facing wording for the backend's error codes (backend/src/services/orderFlow.ts,
/// routes/orders.ts). Codes that only partners/admins can get fall back to the server message.
const Map<String, String> _codeMessages = {
  'TOO_MANY_UNPAID_ORDERS': 'You already have 3 unpaid orders. Pay for one or cancel it before placing another.',
  'ALREADY_PAID': 'This order is already paid.',
  'PAYMENT_WINDOW_EXPIRED': 'The 15 minutes to pay for this order are over. Please place the order again.',
  'ORDER_CANCELLED': 'This order was cancelled before your payment arrived. The money is refunded to you automatically.',
  'PAYMENT_AMOUNT_MISMATCH': 'The amount paid doesn\'t match this order, so it wasn\'t accepted. Kraveo support will contact you about the money.',
  'DUPLICATE_PAYMENT': 'This order was already paid. Your extra payment will be refunded by Kraveo support.',
  'BAD_SIGNATURE': 'We couldn\'t verify this payment. If money left your account, Kraveo confirms or refunds it automatically.',
  'CANNOT_CANCEL': 'The restaurant has already accepted this order, so it can\'t be cancelled in the app. Please contact Kraveo support.',
  'ORDER_CLOSED': 'This order is already finished or cancelled.',
  'ROLE_NOT_ALLOWED': 'This account can\'t do that in the Kraveo app.',
  'PARTNER_NOT_APPROVED': 'Partner accounts can\'t order in the customer app.',
  'VENDOR_CLOSED': 'This restaurant is closed for new orders right now.',
  'VENDOR_UNAVAILABLE': 'This restaurant isn\'t available right now.',
  'AMOUNT_TOO_SMALL': 'The order total must be at least ₹1.',
  'PROVIDER_UNAVAILABLE': 'The payment service is not responding right now. Please try again in a minute.',
  'NOT_FOUND': 'We couldn\'t find this order.',
};

/// RFC 4122 version-4 UUID from a cryptographically secure source. Used as the per-checkout
/// `clientRequestId` (idempotency key) - never as an order id.
String newClientRequestId([Random? random]) {
  final r = random ?? Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String hex(int from, int to) => b.sublist(from, to).map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}
