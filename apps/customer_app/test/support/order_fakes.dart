import 'dart:async';

import 'package:customer_app/models/order.dart';
import 'package:customer_app/models/order_group.dart';
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
  Map<String, dynamic>? group,
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
    if (group != null) 'group': group,
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

// ---- combined orders (Docs/22 section 10: real shapes) ---------------------------------------------

/// `OrderView.group` of a customer's child order (Docs/22 10.4). [stops] = (orderId, status, vendor name, item count).
Map<String, dynamic> groupRefJson({
  required String id,
  required int index,
  required List<({String orderId, String status, String vendor, int items})> stops,
}) =>
    {
      'id': id,
      'index': index,
      'size': stops.length,
      'primary': index == 0,
      'stops': [
        for (var i = 0; i < stops.length; i++)
          {
            'orderId': stops[i].orderId,
            'index': i,
            'status': stops[i].status,
            'vendor': {'name': stops[i].vendor, 'address': 'Gate ${i + 1}', 'lat': 23.0768, 'lng': 76.8524},
            'itemCount': stops[i].items,
          },
      ],
    };

/// The two restaurants used by the combined-order tests: Kitchen 1 (primary, base fee Rs 25) and
/// Kitchen 2 (extra restaurant fee Rs 15). Items 180 + 90, coupon KRAVEO50 (-50): total 260, like the
/// backend's real quote in Docs/22 10.2. [statuses] = the status of each child, in order.
List<Map<String, dynamic>> groupChildrenJson({
  String groupId = 'grp-1',
  List<String> statuses = const ['PLACED', 'PLACED'],
  String paymentStatus = 'PENDING',
  List<String?> cancelledBy = const [null, null],
  List<String?> cancelReasons = const [null, null],
  String refundStatus = 'NONE',
  String? otpCode,
  Map<String, dynamic>? driver,
  DateTime? updatedAt,
  List<String> ids = const ['gx-order-1', 'gx-order-2'],
  List<String> vendorIds = const ['gx-ven-1', 'gx-ven-2'],
  List<String> vendorNames = const ['Kitchen 1', 'Kitchen 2'],
}) {
  final stops = [for (var i = 0; i < ids.length; i++) (orderId: ids[i], status: statuses[i], vendor: vendorNames[i], items: i == 0 ? 2 : 1)];
  // money per child as the backend splits it: totals 190 + 70 = 260 (discount 50 split 40 / 10)
  const subtotals = [180.0, 90.0];
  const fees = [25.0, 15.0];
  const discounts = [40.0, 10.0];
  return [
    for (var i = 0; i < ids.length; i++)
      orderJson(
        id: ids[i],
        status: statuses[i],
        paymentStatus: paymentStatus,
        subtotal: subtotals[i],
        deliveryFee: fees[i],
        discount: discounts[i],
        dropoffHostel: 'BH2',
        dropoffNotes: 'Room 214',
        vendorId: vendorIds[i],
        vendorName: vendorNames[i],
        cancelledBy: cancelledBy[i],
        cancelReason: cancelReasons[i],
        refundStatus: refundStatus,
        otpCode: otpCode,
        driver: driver,
        updatedAt: updatedAt,
        items: i == 0
            ? [
                {'id': 'oi-a', 'menuItemId': 'm-thali', 'name': 'Paneer Thali', 'quantity': 1, 'price': 90.0},
                {'id': 'oi-b', 'menuItemId': 'm-paratha', 'name': 'Aloo Paratha', 'quantity': 1, 'price': 90.0},
              ]
            : [
                {'id': 'oi-c', 'menuItemId': 'm-roll', 'name': 'Paneer Roll', 'quantity': 1, 'price': 90.0},
              ],
        group: groupRefJson(id: groupId, index: i, stops: stops),
      ),
  ];
}

/// `data` of `POST /order-groups` / `GET /order-groups/:id` (Docs/22 10.3).
Map<String, dynamic> groupViewJson({
  String id = 'grp-1',
  List<Map<String, dynamic>>? orders,
  String status = 'AWAITING_RESTAURANTS',
  String paymentStatus = 'PENDING',
  double total = 260,
}) {
  final kids = orders ?? groupChildrenJson(groupId: id, paymentStatus: paymentStatus);
  return {
    'id': id,
    'status': status,
    'paymentStatus': paymentStatus,
    'total': total,
    'subtotal': 270,
    'feeTotal': 40,
    'discount': 50,
    'couponCode': 'KRAVEO50',
    'restaurantCount': kids.length,
    'dropoffHostel': 'BH2',
    'dropoffNotes': 'Room 214',
    'createdAt': DateTime.now().toUtc().toIso8601String(),
    'payOrderId': kids.first['id'],
    'orders': kids,
  };
}

/// The real `data` of `POST /orders/quote` for 2 restaurants + KRAVEO50 (Docs/22 10.2).
Map<String, dynamic> quoteJson({int count = 2, int max = 3, double total = 260}) => {
      'restaurantCount': count,
      'subtotal': 270,
      'fees': {'total': 40, 'base': 25, 'baseWaived': false, 'extraRestaurants': count - 1, 'extraRestaurantFee': 15, 'extraTotal': 15.0 * (count - 1)},
      'discount': 50,
      'couponCode': 'KRAVEO50',
      'total': total,
      'perRestaurant': [
        {'vendorId': 'gx-ven-1', 'vendorName': 'Kitchen 1', 'subtotal': 180, 'fee': 25},
        {'vendorId': 'gx-ven-2', 'vendorName': 'Kitchen 2', 'subtotal': 90, 'fee': 15},
      ],
      'maxRestaurants': max,
    };

/// A group as the app holds it: [groupChildrenJson] parsed.
List<OrderModel> groupChildren({String groupId = 'grp-1', List<String> statuses = const ['PLACED', 'PLACED'], String paymentStatus = 'PENDING', String refundStatus = 'NONE', List<String?> cancelledBy = const [null, null], List<String?> cancelReasons = const [null, null], String? otpCode, Map<String, dynamic>? driver, DateTime? updatedAt}) => [
      for (final j in groupChildrenJson(groupId: groupId, statuses: statuses, paymentStatus: paymentStatus, refundStatus: refundStatus, cancelledBy: cancelledBy, cancelReasons: cancelReasons, otpCode: otpCode, driver: driver, updatedAt: updatedAt)) OrderModel.tryParse(j)!,
    ];

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
  final List<CreateGroupRequest> groupCreates = [];
  final List<QuoteRequest> quotes = [];
  final List<String> fetchedGroups = [];

  /// Server-side orders by idempotency key (to model "same key returns the same order").
  final Map<String, OrderModel> byKey = {};

  Future<OrderResult<OrderModel>> Function(CreateOrderRequest r)? onCreate;
  Future<OrderResult<OrdersPage>> Function(String scope, String? cursor)? onFetchList;
  Future<OrderResult<OrderModel>> Function(String id)? onFetch;
  Future<OrderResult<OrderModel>> Function(String id)? onCancel;
  Future<OrderResult<PaymentSession>> Function(String id)? onCreatePayment;
  Future<OrderResult<OrderModel?>> Function(PaymentProof p)? onVerify;
  Future<OrderResult<ReviewReceipt>> Function(ReviewRequest r)? onReview;
  Future<OrderResult<OrderGroupView>> Function(CreateGroupRequest r)? onCreateGroup;
  Future<OrderResult<OrderGroupView>> Function(String id)? onFetchGroup;
  Future<OrderResult<OrderQuote>> Function(QuoteRequest r)? onQuote;

  /// Server-side groups by idempotency key / by id (default createGroup / fetchGroup).
  final Map<String, OrderGroupView> groupByKey = {};
  final Map<String, OrderGroupView> groupServer = {};

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
  Future<OrderResult<OrderGroupView>> createGroup(CreateGroupRequest request) async {
    groupCreates.add(request);
    if (onCreateGroup != null) return onCreateGroup!(request);
    final existing = groupByKey[request.clientRequestId];
    if (existing != null) return OrderResult.ok(existing);
    final g = OrderGroupView.tryParse(groupViewJson())!;
    groupByKey[request.clientRequestId] = g;
    groupServer[g.id] = g;
    for (final o in g.orders) {
      server[o.id] = o;
    }
    return OrderResult.ok(g);
  }

  @override
  Future<OrderResult<OrderGroupView>> fetchGroup(String groupId) async {
    fetchedGroups.add(groupId);
    if (onFetchGroup != null) return onFetchGroup!(groupId);
    final g = groupServer[groupId];
    return g == null ? const OrderResult.fail(OrderApiError(OrderErrorKind.notFound, statusCode: 404)) : OrderResult.ok(g);
  }

  @override
  Future<OrderResult<OrderQuote>> quote(QuoteRequest request) async {
    quotes.add(request);
    if (onQuote != null) return onQuote!(request);
    // Like an old server: no quote endpoint (the app then shows its local estimate).
    return const OrderResult.fail(OrderApiError(OrderErrorKind.notFound, statusCode: 404));
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
    // A combined order is paid on its primary id for the GROUP total.
    final groupTotal = groupServer.values.where((g) => g.payOrderId == orderId).map((g) => (g.total * 100).round()).firstOrNull;
    final total = groupTotal ?? server[orderId]?.totalPaise ?? 24500;
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
