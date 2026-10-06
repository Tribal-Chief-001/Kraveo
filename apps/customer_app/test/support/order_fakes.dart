import 'dart:async';

import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/order_realtime.dart';
import 'package:customer_app/services/payment_gateway.dart';

/// An `OrderView` JSON exactly as contract 2.1 describes it.
Map<String, dynamic> orderJson({
  String id = '7f9c2d1e-0000-4000-8000-000000000001',
  String status = 'PLACED',
  String paymentStatus = 'PENDING',
  double subtotal = 220,
  double deliveryFee = 25,
  double taxAndPackaging = 0,
  double discount = 0,
  double? totalAmount,
  String dropoffHostel = 'Block 2',
  String dropoffNotes = 'Call at the gate',
  DateTime? createdAt,
  DateTime? updatedAt,
  String? cancelledBy,
  String? cancelReason,
  Map<String, dynamic>? driver,
  String? otpCode,
  String vendorId = 'v-real-1',
  String vendorName = 'Sharma Highway Dhaba',
  List<Map<String, dynamic>>? items,
  String refundStatus = 'NONE',
  bool isReviewed = false,
  Map<String, dynamic>? dropoff,
  bool? vendorHasLocation,
}) {
  final created = createdAt ?? DateTime.now().toUtc().subtract(const Duration(minutes: 2));
  return {
    'id': id,
    'status': status,
    'paymentStatus': paymentStatus,
    'totalAmount': totalAmount ?? subtotal + deliveryFee + taxAndPackaging - discount,
    'deliveryFee': deliveryFee,
    'subtotal': subtotal,
    'taxAndPackaging': taxAndPackaging,
    'discount': discount,
    'dropoffHostel': dropoffHostel,
    'dropoffNotes': dropoffNotes,
    'createdAt': created.toIso8601String(),
    'updatedAt': (updatedAt ?? created).toIso8601String(),
    'paidAt': paymentStatus == 'PAID' ? created.toIso8601String() : null,
    'acceptedAt': null,
    'pickedUpAt': null,
    'deliveredAt': status == 'DELIVERED' ? created.toIso8601String() : null,
    'cancelledAt': status == 'CANCELLED' ? created.toIso8601String() : null,
    'cancelledBy': cancelledBy,
    'cancelReason': cancelReason,
    'items': items ??
        [
          {'id': 'oi-1', 'menuItemId': 'm-thali', 'name': 'Paneer Thali', 'quantity': 1, 'price': 115.0},
          {'id': 'oi-2', 'menuItemId': 'm-paratha', 'name': 'Aloo Paratha', 'quantity': 1, 'price': 90.0},
        ],
    'vendorId': vendorId,
    'vendor': {'id': vendorId, 'name': vendorName, 'address': 'Kothri', 'lat': 23.07, 'lng': 76.85, if (vendorHasLocation != null) 'hasLocation': vendorHasLocation},
    if (dropoff != null) 'dropoff': dropoff,
    'customer': {'id': 'u1', 'name': 'Aarav Sharma', 'phone': '+91 9876543210', 'hostelBlock': 'Block 2'},
    'driver': driver,
    if (otpCode != null) 'otpCode': otpCode,
    'payBy': status == 'PLACED' && paymentStatus != 'PAID' ? created.add(const Duration(minutes: 15)).toIso8601String() : null,
    'acceptBy': status == 'PLACED' && paymentStatus == 'PAID' ? created.add(const Duration(minutes: 10)).toIso8601String() : null,
    'refundStatus': refundStatus,
    'isReviewed': isReviewed,
  };
}

OrderModel orderModel({
  String id = '7f9c2d1e-0000-4000-8000-000000000001',
  String status = 'PLACED',
  String paymentStatus = 'PENDING',
  DateTime? createdAt,
  DateTime? updatedAt,
  String? cancelledBy,
  String? cancelReason,
  Map<String, dynamic>? driver,
  String? otpCode,
  double? totalAmount,
}) =>
    OrderModel.tryParse(orderJson(
      id: id,
      status: status,
      paymentStatus: paymentStatus,
      createdAt: createdAt,
      updatedAt: updatedAt,
      cancelledBy: cancelledBy,
      cancelReason: cancelReason,
      driver: driver,
      otpCode: otpCode,
      totalAmount: totalAmount,
    ))!;

/// Scriptable [OrderApi]. Each handler may be replaced per test; calls are recorded.
class FakeOrderApi implements OrderApi {
  final List<CreateOrderRequest> creates = [];
  final List<String> fetchScopes = [];
  final List<String?> fetchCursors = [];
  final List<String> fetchedIds = [];
  final List<String> cancels = [];
  final List<String> paymentStarts = [];
  final List<PaymentProof> verifies = [];
  final List<ReviewRequest> reviews = [];

  /// Server-side orders by idempotency key (to model "same key returns the same order").
  final Map<String, OrderModel> byKey = {};

  Future<OrderResult<OrderModel>> Function(CreateOrderRequest r)? onCreate;
  Future<OrderResult<OrdersPage>> Function(String scope, String? cursor)? onFetchList;
  Future<OrderResult<OrderModel>> Function(String id)? onFetch;
  Future<OrderResult<OrderModel>> Function(String id)? onCancel;
  Future<OrderResult<PaymentSession>> Function(String id)? onCreatePayment;
  Future<OrderResult<OrderModel?>> Function(PaymentProof p)? onVerify;
  Future<OrderResult<ReviewReceipt>> Function(ReviewRequest r)? onReview;

  /// What GET /orders/:id returns when [onFetch] is null.
  final Map<String, OrderModel> server = {};

  @override
  Future<OrderResult<OrderModel>> createOrder(CreateOrderRequest request) async {
    creates.add(request);
    if (onCreate != null) return onCreate!(request);
    final existing = byKey[request.clientRequestId];
    if (existing != null) return OrderResult.ok(existing);
    final o = orderModel(id: 'order-${byKey.length + 1}');
    byKey[request.clientRequestId] = o;
    server[o.id] = o;
    return OrderResult.ok(o);
  }

  @override
  Future<OrderResult<OrdersPage>> fetchOrders({required String scope, int limit = 20, String? cursor}) async {
    fetchScopes.add(scope);
    fetchCursors.add(cursor);
    if (onFetchList != null) return onFetchList!(scope, cursor);
    return const OrderResult.ok(OrdersPage([], null));
  }

  @override
  Future<OrderResult<OrderModel>> fetchOrder(String orderId) async {
    fetchedIds.add(orderId);
    if (onFetch != null) return onFetch!(orderId);
    final o = server[orderId];
    return o == null ? const OrderResult.fail(OrderApiError(OrderErrorKind.notFound, statusCode: 404)) : OrderResult.ok(o);
  }

  @override
  Future<OrderResult<OrderModel>> cancelOrder(String orderId, {String? reason}) async {
    cancels.add(orderId);
    if (onCancel != null) return onCancel!(orderId);
    final o = orderModel(id: orderId, status: 'CANCELLED', cancelledBy: 'CUSTOMER', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 1)));
    server[orderId] = o;
    return OrderResult.ok(o);
  }

  @override
  Future<OrderResult<PaymentSession>> createPayment(String orderId) async {
    paymentStarts.add(orderId);
    if (onCreatePayment != null) return onCreatePayment!(orderId);
    final total = server[orderId]?.totalPaise ?? 24500;
    return OrderResult.ok(PaymentSession(orderId: orderId, keyId: 'rzp_test_x', razorpayOrderId: 'order_rzp_$orderId', amountPaise: total));
  }

  @override
  Future<OrderResult<OrderModel?>> verifyPayment(PaymentProof proof) async {
    verifies.add(proof);
    if (onVerify != null) return onVerify!(proof);
    return const OrderResult.ok(null);
  }

  @override
  Future<OrderResult<ReviewReceipt>> submitReview(ReviewRequest request) async {
    reviews.add(request);
    if (onReview != null) return onReview!(request);
    return const OrderResult.ok(ReviewReceipt(coinsEarned: 10, totalCoins: 130));
  }
}

/// Records socket usage and lets tests push events.
class FakeRealtime implements OrderRealtime {
  static final List<FakeRealtime> created = [];
  FakeRealtime() {
    created.add(this);
  }

  String? token;
  final List<String> joined = [];
  bool disposed = false;
  bool _connected = false;
  void Function(Object?)? _onOrder;
  void Function(Object?)? _onRider;
  void Function()? _onConnected;

  @override
  bool get isConnected => _connected && !disposed;

  @override
  void connect({required String token, required void Function(Object? payload) onOrderUpdated, required void Function(Object? payload) onRiderLocation, required void Function() onConnected}) {
    this.token = token;
    _onOrder = onOrderUpdated;
    _onRider = onRiderLocation;
    _onConnected = onConnected;
  }

  void simulateConnect() {
    _connected = true;
    _onConnected?.call();
  }

  void emitOrder(Object? payload) => _onOrder?.call(payload);
  void emitRider(Object? payload) => _onRider?.call(payload);

  /// What the server answers to join_room.
  bool ackOk = true;

  @override
  void join(String orderId, [void Function(bool ok)? onResult]) {
    joined.add(orderId);
    onResult?.call(ackOk);
  }

  @override
  void dispose() => disposed = true;
}

/// A payment sheet that answers with [next] (or waits for [gate]).
class FakeGateway implements PaymentGateway {
  GatewayResult next = const GatewayResult.success(PaymentProof(razorpayOrderId: 'order_rzp', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig'));
  final List<PaymentSession> opened = [];
  Completer<void>? gate;

  @override
  Future<GatewayResult> pay(PaymentSession session, {String? contact}) async {
    opened.add(session);
    if (gate != null) await gate!.future;
    return next;
  }
}

OrderProvider fakeOrders(FakeOrderApi api, {FakeGateway? gateway, DateTime Function()? clock, String? token = 'jwt-test'}) => OrderProvider(
      api: api,
      gateway: gateway ?? FakeGateway(),
      realtimeFactory: FakeRealtime.new,
      tokenProvider: () async => token,
      clock: clock,
    );
