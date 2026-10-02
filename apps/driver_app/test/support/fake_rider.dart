import 'dart:async';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/location_source.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';

/// Fixed "now" for tests: 2026-10-01 12:00 local time.
final testNow = DateTime(2026, 10, 1, 12);

/// A contract-shaped OrderView JSON (section 2.1). [pool] = the rider pool view (no customer
/// name/phone, no driver).
Map<String, dynamic> orderJson({
  String id = 'ord-1',
  String status = 'PREPARING',
  String paymentStatus = 'PAID',
  double fee = 25,
  double total = 245,
  bool pool = false,
  String? phone,
  String driverId = 'u-rider',
  DateTime? updatedAt,
  DateTime? deliveredAt,
  DateTime? pickedUpAt,
  String? cancelledBy,
  String? cancelReason,
  String vendorName = 'FC Night Mess',
  String drop = 'Block 2',
  String? otpCode,
}) =>
    {
      'id': id,
      'status': status,
      'paymentStatus': paymentStatus,
      'totalAmount': total,
      'deliveryFee': fee,
      'subtotal': total - fee - 15,
      'taxAndPackaging': 15.0,
      'discount': 0.0,
      'dropoffHostel': drop,
      'dropoffNotes': pool ? null : 'Near the blue gate',
      'createdAt': testNow.subtract(const Duration(minutes: 10)).toUtc().toIso8601String(),
      'updatedAt': (updatedAt ?? testNow.subtract(const Duration(minutes: 5))).toUtc().toIso8601String(),
      'paidAt': testNow.subtract(const Duration(minutes: 9)).toUtc().toIso8601String(),
      'acceptedAt': null,
      'pickedUpAt': pickedUpAt?.toUtc().toIso8601String(),
      'deliveredAt': deliveredAt?.toUtc().toIso8601String(),
      'cancelledAt': null,
      'cancelledBy': cancelledBy,
      'cancelReason': cancelReason,
      'items': [
        {'id': 'i1', 'menuItemId': 'm1', 'name': 'Veg Thali', 'quantity': 2, 'price': 90.0},
      ],
      'vendor': {'id': 'v1', 'name': vendorName, 'address': 'Entry Gate 1', 'lat': 23.07, 'lng': 76.85},
      // Real backend: the pool view has customer null; an assigned rider sees name + phone.
      'customer': pool ? null : {'id': 'c1', 'name': 'Aman Sharma', 'phone': phone, 'hostelBlock': drop},
      'driver': pool ? null : {'id': driverId, 'name': 'Test Rider', 'phone': '+91 9000000000'},
      if (otpCode != null) 'otpCode': otpCode,
    };

OrderView order({
  String id = 'ord-1',
  String status = 'PREPARING',
  String paymentStatus = 'PAID',
  double fee = 25,
  bool pool = false,
  String? phone,
  DateTime? updatedAt,
  DateTime? deliveredAt,
  DateTime? pickedUpAt,
  String? cancelledBy,
  String? cancelReason,
  String vendorName = 'FC Night Mess',
  String drop = 'Block 2',
}) =>
    OrderView.tryParse(orderJson(
      id: id,
      status: status,
      paymentStatus: paymentStatus,
      fee: fee,
      pool: pool,
      phone: phone,
      updatedAt: updatedAt,
      deliveredAt: deliveredAt,
      pickedUpAt: pickedUpAt,
      cancelledBy: cancelledBy,
      cancelReason: cancelReason,
      vendorName: vendorName,
      drop: drop,
    ))!;

OrderView offer({String id = 'pool-1', String status = 'READY_FOR_PICKUP', double fee = 30, String vendorName = 'Underdoggs Cafe', String drop = 'Block 4', String paymentStatus = 'PAID'}) =>
    order(id: id, status: status, fee: fee, pool: true, vendorName: vendorName, drop: drop, paymentStatus: paymentStatus);

const offline = ApiResult<Never>.fail(ApiFailure.offline);

/// Scriptable order API. Every call is logged in [calls].
class FakeRiderApi implements RiderOrdersApi {
  final calls = <String>[];
  final locations = <(double, double)>[];

  ApiResult<List<OrderView>> available = const ApiResult.ok([]);
  ApiResult<List<OrderView>> active = const ApiResult.ok([]);
  Map<String, ApiResult<OrderView>> orders = {};
  ApiResult<OrderPage> Function(String? cursor) onHistory = (_) => const ApiResult.ok(OrderPage([], null));
  ApiResult<OrderView?> Function(String id) onClaim = (id) => ApiResult.ok(order(id: id, status: 'READY_FOR_PICKUP'));
  ApiResult<OrderView?> Function(String id) onRelease = (_) => const ApiResult.ok(null);
  ApiResult<OrderView?> Function(String id, OrderStatus s) onStatus = (id, s) => ApiResult.ok(order(id: id, status: s.wire, updatedAt: testNow));
  ApiResult<OrderView?> Function(String id, String code) onOtp = (id, _) => ApiResult.ok(order(id: id, status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow));
  ApiResult<String?> Function(bool on) onDuty = (on) => ApiResult.ok(on ? 'ONLINE' : 'OFFLINE');
  ApiResult<void> location = const ApiResult.ok(null);

  /// When set, `fetchAvailable` waits for it (to test races with socket events).
  Completer<void>? availableGate;

  @override
  Future<ApiResult<List<OrderView>>> fetchAvailable() async {
    calls.add('available');
    if (availableGate != null) await availableGate!.future;
    return available;
  }

  @override
  Future<ApiResult<List<OrderView>>> fetchActive() async {
    calls.add('active');
    return active;
  }

  @override
  Future<ApiResult<OrderPage>> fetchHistory({String? cursor, int limit = 30}) async {
    calls.add('history:${cursor ?? '-'}');
    return onHistory(cursor);
  }

  @override
  Future<ApiResult<OrderView>> fetchOrder(String id) async {
    calls.add('order:$id');
    return orders[id] ?? const ApiResult.fail(ApiFailure.notFound, statusCode: 404);
  }

  @override
  Future<ApiResult<OrderView?>> claim(String id) async {
    calls.add('claim:$id');
    return onClaim(id);
  }

  @override
  Future<ApiResult<OrderView?>> release(String id) async {
    calls.add('release:$id');
    return onRelease(id);
  }

  @override
  Future<ApiResult<OrderView?>> updateStatus(String id, OrderStatus status) async {
    calls.add('status:$id:${status.wire}');
    return onStatus(id, status);
  }

  @override
  Future<ApiResult<OrderView?>> verifyGateOtp(String id, String code) async {
    calls.add('otp:$id:$code');
    return onOtp(id, code);
  }

  @override
  Future<ApiResult<String?>> setDuty(bool online) async {
    calls.add('duty:$online');
    return onDuty(online);
  }

  @override
  Future<ApiResult<void>> postLocation(double lat, double lng, {double heading = 0}) async {
    calls.add('location');
    locations.add((lat, lng));
    return location;
  }
}

class FakeRiderSocket implements RiderSocket {
  final _c = StreamController<RiderSocketEvent>.broadcast(sync: true);
  final watched = <String>{};
  bool connected = false;
  int connects = 0;
  bool disposed = false;

  void emit(RiderSocketEvent e) => _c.add(e);

  @override
  Stream<RiderSocketEvent> get events => _c.stream;

  @override
  bool get isConnected => connected;

  @override
  Future<void> connect() async {
    if (connected) return;
    connects++;
    connected = true;
  }

  @override
  void disconnect() => connected = false;

  @override
  void watchOrder(String id) => watched.add(id);

  @override
  void unwatchOrder(String id) => watched.remove(id);

  @override
  void dispose() {
    disposed = true;
    connected = false;
  }
}

class FakeLocation implements LocationSource {
  LocationReading reading = const LocationReading.fix(23.0775, 76.8513);
  int permissionRequests = 0;
  final opened = <LocationProblem>[];

  @override
  Future<LocationReading> read() async => reading;

  @override
  Future<void> requestPermission() async => permissionRequests++;

  @override
  Future<void> openSettingsFor(LocationProblem problem) async => opened.add(problem);
}

class FakeRider {
  FakeRider({Duration poll = const Duration(hours: 1), Duration gps = const Duration(hours: 1)}) {
    services = RiderServices(api: api, socket: socket, location: location, pollInterval: poll, locationInterval: gps, clock: () => testNow);
  }

  final api = FakeRiderApi();
  final socket = FakeRiderSocket();
  final location = FakeLocation();
  late final RiderServices services;
}
