import 'dart:async';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/services/order_queue_controller.dart';
import 'package:vendor_app/services/order_socket.dart';
import 'package:vendor_app/services/vendor_backend.dart';

/// Builds an `OrderView` exactly as contract section 2.1 describes it (vendor view).
Map<String, dynamic> orderJson({
  String id = '3f2a9c1e-0000-4000-8000-00000000a1b2',
  String status = 'PLACED',
  String paymentStatus = 'PAID',
  DateTime? createdAt,
  DateTime? updatedAt,
  DateTime? paidAt,
  DateTime? acceptedAt,
  String customerName = 'Rahul',
  String? dropoffNotes = 'No onions please',
  Map<String, dynamic>? driver,
  String? cancelledBy,
  String? cancelReason,
  List<Map<String, dynamic>>? items,
  double total = 245,
}) {
  final created = createdAt ?? DateTime.now().toUtc().subtract(const Duration(minutes: 1));
  return {
    'id': id,
    'status': status,
    'paymentStatus': paymentStatus,
    'totalAmount': total,
    'deliveryFee': 25.0,
    'subtotal': 205.0,
    'taxAndPackaging': 15.0,
    'discount': 0.0,
    'dropoffHostel': 'BH1',
    'dropoffNotes': dropoffNotes,
    'createdAt': created.toUtc().toIso8601String(),
    'updatedAt': (updatedAt ?? created).toUtc().toIso8601String(),
    'paidAt': (paidAt ?? (paymentStatus == 'PENDING' ? null : created))?.toUtc().toIso8601String(),
    'acceptedAt': acceptedAt?.toUtc().toIso8601String(),
    'pickedUpAt': null,
    'deliveredAt': null,
    'cancelledAt': status == 'CANCELLED' ? (updatedAt ?? created).toUtc().toIso8601String() : null,
    'cancelledBy': cancelledBy,
    'cancelReason': cancelReason,
    'items': items ??
        [
          {'id': 'oi-1', 'menuItemId': 'm-1', 'name': 'Paneer Butter Masala', 'quantity': 1, 'price': 180.0},
          {'id': 'oi-2', 'menuItemId': 'm-2', 'name': 'Tandoori Roti', 'quantity': 2, 'price': 12.5},
        ],
    'vendor': {'id': 'ven-42', 'name': 'Sharma Dhaba', 'address': 'Ashta Road', 'lat': 23.07, 'lng': 76.85},
    'customer': {'id': 'cust-1', 'name': customerName, 'phone': null, 'hostelBlock': 'BH1'},
    'driver': driver,
    'vendorId': 'ven-42',
    // Like the server: the accept deadline is only sent while PLACED + PAID.
    'acceptBy': status == 'PLACED' && paymentStatus == 'PAID' ? (paidAt ?? created).add(const Duration(minutes: 10)).toUtc().toIso8601String() : null,
  };
}

OrderModel order({String id = 'ord-a1b2c3', String status = 'PLACED', String paymentStatus = 'PAID', DateTime? updatedAt, DateTime? createdAt, Map<String, dynamic>? driver, String? cancelledBy, String? cancelReason, String? notes, List<Map<String, dynamic>>? items}) =>
    OrderModel.fromJson(orderJson(
      id: id,
      status: status,
      paymentStatus: paymentStatus,
      updatedAt: updatedAt,
      createdAt: createdAt,
      driver: driver,
      cancelledBy: cancelledBy,
      cancelReason: cancelReason,
      dropoffNotes: notes,
      items: items,
    ))!;

/// A scriptable Kraveo server. Holds a set of orders; actions change them like the real server would,
/// unless a test overrides a response.
class FakeBackend implements VendorBackend {
  final Map<String, OrderModel> server = {};
  final List<String> calls = [];

  /// Override the next answers (consumed first-in first-out) for a call kind.
  ApiResult<OrdersPage>? Function(OrderScope scope, String? cursor)? onFetchOrders;
  final List<ApiResult<OrderModel>> statusAnswers = [];
  final List<ApiResult<OrderModel>> rejectAnswers = [];
  final List<ApiResult<OrderModel>> fetchOrderAnswers = [];
  List<OrderModel> history = [];
  int historyPageSize = 2;

  /// Holds a call open until completed (to test in-flight states).
  Completer<void>? gate;

  bool storeOpen = true;
  ApiResult<bool>? storeAnswer;
  List<DishModel> menu = [];
  ApiResult<DishModel>? dishAnswer;
  bool? lastIsVeg;
  ApiFailure? menuFailure;

  int _version = 0;

  void put(OrderModel o) => server[o.id] = o;

  OrderModel _advance(OrderModel o, OrderStatus to, {CancelledBy? by, String? reason}) {
    final j = orderJson(
      id: o.id,
      status: to.wire,
      paymentStatus: to == OrderStatus.cancelled ? 'REFUNDED' : 'PAID',
      createdAt: o.createdAt,
      updatedAt: o.createdAt.add(Duration(seconds: 30 + (++_version))),
      acceptedAt: to.rank >= 1 && to != OrderStatus.cancelled ? DateTime.now() : null,
      cancelledBy: by?.name.toUpperCase(),
      cancelReason: reason,
    );
    return OrderModel.fromJson(j)!;
  }

  /// What the real server does on its own (expiry job, customer cancel ...).
  void serverChange(String id, OrderStatus to, {CancelledBy? by, String? reason}) => server[id] = _advance(server[id]!, to, by: by, reason: reason);

  @override
  Future<ApiResult<OrdersPage>> fetchOrders(OrderScope scope, {String? cursor, int limit = 50}) async {
    calls.add('list:${scope.name}${cursor == null ? '' : ':$cursor'}');
    final override = onFetchOrders?.call(scope, cursor);
    if (override != null) return override;
    if (scope == OrderScope.active) {
      return ApiResult.success(OrdersPage(orders: server.values.where((o) => o.isPaid || o.status.isTerminal).toList()));
    }
    final start = cursor == null ? 0 : int.parse(cursor);
    final page = history.skip(start).take(historyPageSize).toList();
    final next = start + historyPageSize < history.length ? '${start + historyPageSize}' : null;
    return ApiResult.success(OrdersPage(orders: page, nextCursor: next));
  }

  @override
  Future<ApiResult<OrderModel>> fetchOrder(String id) async {
    calls.add('get:$id');
    if (fetchOrderAnswers.isNotEmpty) return fetchOrderAnswers.removeAt(0);
    final o = server[id];
    return o == null ? const ApiResult.failure(ApiFailure.notFound) : ApiResult.success(o);
  }

  @override
  Future<ApiResult<OrderModel>> updateStatus(String id, OrderStatus status) async {
    calls.add('status:$id:${status.wire}');
    if (gate != null) await gate!.future;
    if (statusAnswers.isNotEmpty) return statusAnswers.removeAt(0);
    final o = server[id];
    if (o == null) return const ApiResult.failure(ApiFailure.notFound);
    if (o.status == OrderStatus.cancelled) return const ApiResult.failure(ApiFailure.conflict, message: 'Order was cancelled');
    server[id] = _advance(o, status);
    return ApiResult.success(server[id]);
  }

  @override
  Future<ApiResult<OrderModel>> reject(String id, String reason) async {
    calls.add('reject:$id:$reason');
    if (gate != null) await gate!.future;
    if (rejectAnswers.isNotEmpty) return rejectAnswers.removeAt(0);
    final o = server[id];
    if (o == null) return const ApiResult.failure(ApiFailure.notFound);
    server[id] = _advance(o, OrderStatus.cancelled, by: CancelledBy.vendor, reason: reason);
    return ApiResult.success(server[id]);
  }

  @override
  Future<ApiResult<bool>> fetchStoreOpen(String vendorId) async {
    calls.add('store:get:$vendorId');
    return ApiResult.success(storeOpen);
  }

  @override
  Future<ApiResult<bool>> setStoreOpen(String vendorId, bool open) async {
    calls.add('store:set:$vendorId:$open');
    if (storeAnswer != null) return storeAnswer!;
    storeOpen = open;
    return ApiResult.success(open);
  }

  @override
  Future<ApiResult<List<DishModel>>> fetchMenu(String vendorId) async {
    calls.add('menu:$vendorId');
    if (menuFailure != null) return ApiResult.failure(menuFailure!);
    return ApiResult.success(menu);
  }

  @override
  Future<ApiResult<DishModel>> addDish(String vendorId, {required String name, required String category, required double price, bool isVeg = true}) async {
    calls.add('dish:add:$vendorId:$name');
    lastIsVeg = isVeg;
    if (dishAnswer != null) return dishAnswer!;
    final d = DishModel(id: 'new-${menu.length}', name: name, category: category, price: price);
    return ApiResult.success(d);
  }

  @override
  Future<ApiResult<DishModel>> updateDish(String itemId, {bool? isAvailable, double? price}) async {
    calls.add('dish:update:$itemId:${isAvailable ?? ''}:${price ?? ''}');
    if (dishAnswer != null) return dishAnswer!;
    return const ApiResult.success(null);
  }
}

class FakeSocket extends OrderSocket {
  String? token;
  String? vendorId;
  int ensureCalls = 0;
  bool disposed = false;
  bool connected = false;

  @override
  bool get isConnected => connected;

  @override
  void connect({required String token, required String vendorId}) {
    this.token = token;
    this.vendorId = vendorId;
  }

  /// Simulates the server accepting the handshake.
  void open() {
    connected = true;
    onConnected?.call();
  }

  void emit(String event, Object? payload) => onOrderEvent?.call(event, payload);

  /// Simulates the server's `join_room` ack.
  void answerJoin(bool ok) => onRoomJoined?.call(ok);

  @override
  void ensureConnected() => ensureCalls++;

  @override
  void dispose() => disposed = true;
}

class FakeAlarm implements AlarmSink {
  bool ringing = false;
  int starts = 0;

  @override
  bool get isRinging => ringing;

  @override
  Future<void> start() async {
    ringing = true;
    starts++;
  }

  @override
  Future<void> stop() async => ringing = false;
}

/// A started controller over [backend] for widget tests. Dispose it at the end of the test
/// (its poll timer would otherwise outlive the test).
Future<OrderQueueController> startController(FakeBackend backend, {FakeAlarm? alarm, FakeSocket? socket}) async {
  final c = OrderQueueController(
    backend: backend,
    vendorId: 'ven-42',
    socket: socket ?? FakeSocket(),
    alarm: alarm ?? FakeAlarm(),
    pollInterval: const Duration(hours: 1),
    tokenProvider: () async => 'jwt-test',
  );
  await c.start();
  return c;
}
