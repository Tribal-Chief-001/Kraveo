import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'fake_rider.dart';

/// Combined (multi-restaurant) order fixtures in the exact shape of the real backend (Docs/22 section 10.4, copied from
/// `backend/test/e2e/order_groups_lifecycle.test.ts`): every child is a full OrderView and carries
/// `group: { id, index, size, primary, stops: [{ orderId, index, status, vendor:{name,address,lat,lng}, itemCount }] }`.
/// The `stops` entries never carry `hasLocation`; only the child's own `vendor` does.

/// The placeholder pin every real stop entry carries in the backend test (`23.0768, 76.8524`).
const stopPin = {'lat': 23.0768, 'lng': 76.8524};

Map<String, dynamic> groupJson({
  String gid = 'grp-1',
  required int index,
  List<String> ids = const ['gA', 'gB'],
  List<String>? statuses,
  bool pool = false,
  bool? ownPinKnown,
  int? size,
}) {
  final st = statuses ?? [for (final _ in ids) 'READY_FOR_PICKUP'];
  final json = orderJson(
    id: ids[index],
    status: st[index],
    fee: index == 0 ? 25 : 15,
    total: index == 0 ? 245 : 120,
    pool: pool,
    phone: '+91 9811111111',
    vendorName: 'Kitchen ${index + 1}',
    drop: 'BH2',
    updatedAt: testNow.subtract(const Duration(minutes: 5)),
    vendorExtra: {'address': 'Gate ${index + 1}', if (ownPinKnown ?? true) ...{'hasLocation': true, 'lat': const [23.0745, 23.0755, 23.0765, 23.0775, 23.0785][index], 'lng': 76.859}},
  );
  json['group'] = {
    'id': gid,
    'index': index,
    'size': size ?? ids.length,
    'primary': index == 0,
    'stops': [
      for (var i = 0; i < ids.length; i++)
        {
          'orderId': ids[i],
          'index': i,
          'status': st[i],
          'vendor': {'name': 'Kitchen ${i + 1}', 'address': 'Gate ${i + 1}', ...stopPin},
          'itemCount': 2,
        },
    ],
  };
  return json;
}

OrderView groupChild({String gid = 'grp-1', required int index, List<String> ids = const ['gA', 'gB'], List<String>? statuses, bool pool = false, bool? ownPinKnown}) =>
    OrderView.tryParse(groupJson(gid: gid, index: index, ids: ids, statuses: statuses, pool: pool, ownPinKnown: ownPinKnown))!;

/// The pool entry of a combined order: the primary child's pool view (customer null, notes hidden) with its group.
OrderView groupOffer({String gid = 'grp-1', List<String> ids = const ['gA', 'gB'], List<String>? statuses}) {
  final j = groupJson(gid: gid, index: 0, ids: ids, statuses: statuses ?? [for (final _ in ids) 'ACCEPTED'], pool: true, ownPinKnown: false);
  return OrderView.tryParse(j)!;
}

/// A tiny server for ONE combined order, behind [FakeRiderApi]: the same rules as the real backend (per-child pickup
/// only when that child is READY, arrival only after every child is picked up and then for all of them, one code that
/// delivers everything, release only before the first pickup). Every change bumps `updatedAt`.
class GroupWorld {
  GroupWorld(this.f, {this.ids = const ['gA', 'gB'], this.gid = 'grp-1', List<String>? start, this.code = '4821'})
      : status = {for (var i = 0; i < ids.length; i++) ids[i]: (start != null && i < start.length) ? start[i] : 'READY_FOR_PICKUP'} {
    install();
  }

  final FakeRider f;
  final List<String> ids;
  final String gid;
  final String code;
  final Map<String, String> status;
  final Map<String, int> touched = {};
  int _clock = 0;
  bool released = false;
  int wrongCodes = 0;

  String id(int i) => ids[i];

  void bump(String id) => touched[id] = ++_clock;

  List<String> get statuses => [for (final i in ids) status[i]!];

  OrderView child(int i, {bool pool = false}) {
    final j = groupJson(gid: gid, index: i, ids: ids, statuses: statuses, pool: pool);
    final at = touched[ids[i]];
    if (at != null) j['updatedAt'] = testNow.add(Duration(seconds: at)).toUtc().toIso8601String();
    if (status[ids[i]] == 'DELIVERED') j['deliveredAt'] = testNow.add(Duration(seconds: at ?? 1)).toUtc().toIso8601String();
    return OrderView.tryParse(j)!;
  }

  List<OrderView> get children => [for (var i = 0; i < ids.length; i++) child(i)];

  void sync() => f.api.active = released ? const ApiResult.ok([]) : ApiResult.ok(children);

  void install() {
    f.api.onClaim = (id) {
      sync();
      return ApiResult.ok(child(ids.indexOf(id)));
    };
    f.api.onStatus = (id, s) {
      final i = ids.indexOf(id);
      if (s == OrderStatus.pickedUp) {
        if (status[id] != 'READY_FOR_PICKUP') return const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'INVALID_TRANSITION');
        status[id] = 'PICKED_UP';
        bump(id);
      } else if (s == OrderStatus.arrivedAtGate) {
        if (status.values.any((v) => v != 'PICKED_UP' && v != 'ARRIVED_AT_GATE')) {
          return const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'GROUP_NOT_PICKED_UP', message: 'Not every restaurant is picked up.');
        }
        for (final k in ids) {
          status[k] = 'ARRIVED_AT_GATE';
          bump(k);
        }
      }
      sync();
      return ApiResult.ok(child(i));
    };
    f.api.onOtp = (id, c) {
      if (c != code) {
        wrongCodes++;
        return ApiResult.fail(ApiFailure.badRequest, statusCode: 400, code: 'OTP_INVALID', attemptsLeft: 5 - wrongCodes);
      }
      for (final k in ids) {
        status[k] = 'DELIVERED';
        bump(k);
      }
      sync();
      return ApiResult.ok(child(ids.indexOf(id)));
    };
    f.api.onRelease = (id) {
      if (status.values.any((v) => v == 'PICKED_UP' || v == 'ARRIVED_AT_GATE')) {
        return const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'CANNOT_RELEASE');
      }
      released = true;
      sync();
      return const ApiResult.ok(null);
    };
    f.api.orders = {};
    sync();
  }

  /// The kitchen of child [i] changes status (what the restaurant app does).
  void kitchen(int i, String s) {
    status[ids[i]] = s;
    bump(ids[i]);
    sync();
  }

  int count(String call) => f.api.calls.where((c) => c == call).length;
  int countStarting(String prefix) => f.api.calls.where((c) => c.startsWith(prefix)).length;
}
