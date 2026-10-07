import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'support/fake_group.dart';
import 'support/fake_rider.dart';

/// Combined (multi-restaurant) orders for the rider (Docs/22 sections 4.6, 6, 10): the model from the real response shape,
/// and the controller against a fake server that follows the real backend rules.
void main() {
  group('model: OrderView.group and the merged delivery', () {
    test('a child of a combined order parses the real group shape; a single order has no group', () {
      final o = groupChild(index: 1, statuses: ['PICKED_UP', 'READY_FOR_PICKUP']);
      expect(o.isGroup, isTrue);
      expect(o.group!.id, 'grp-1');
      expect(o.group!.index, 1);
      expect(o.group!.size, 2);
      expect(o.group!.primary, isFalse);
      expect(o.group!.stops.map((s) => (s.orderId, s.index, s.name, s.address, s.itemCount, s.status)), [
        ('gA', 0, 'Kitchen 1', 'Gate 1', 2, OrderStatus.pickedUp),
        ('gB', 1, 'Kitchen 2', 'Gate 2', 2, OrderStatus.readyForPickup),
      ]);
      expect(order().group, isNull);
      expect(order().isGroup, isFalse);
      expect(order().stops, isEmpty);
    });

    test('a malformed group never breaks the order: it is read as a single order or with fewer stops', () {
      for (final bad in <Object?>['x', 5, [], {}, {'id': ''}, {'size': 2}]) {
        final j = orderJson()..['group'] = bad;
        final o = OrderView.tryParse(j);
        expect(o, isNotNull);
        expect(o!.group, isNull, reason: '$bad');
      }
      final j = orderJson()
        ..['group'] = {
          'id': 'g1',
          'stops': ['junk', null, {'index': 0}, {'orderId': 'a', 'index': 'zero', 'status': 'WHAT', 'vendor': 'nope', 'itemCount': 'many'}],
        };
      final o = OrderView.tryParse(j)!;
      expect(o.group!.size, 1);
      expect(o.group!.primary, isTrue);
      expect(o.group!.stops.single.orderId, 'a');
      expect(o.group!.stops.single.status, OrderStatus.unknown);
      expect(o.group!.stops.single.name, 'Restaurant');
    });

    test('the pool entry hides the customer; its stops carry no verified pin (the stops entry has no hasLocation)', () {
      final o = groupOffer();
      expect(o.customer, isNull);
      expect(o.dropoffNotes, isNull);
      expect(o.group!.stops, hasLength(2));
      expect(o.group!.stops.every((s) => s.point == null), isTrue);
      expect(o.headlineName, 'Combined order - 2 restaurants');
      expect(o.pickupLabel, 'Kitchen 1 + Kitchen 2');
    });

    test('two children fold into ONE delivery: primary id, least advanced status, all items, summed fee', () {
      final a = groupChild(index: 0, statuses: ['PICKED_UP', 'READY_FOR_PICKUP']);
      final b = groupChild(index: 1, statuses: ['PICKED_UP', 'READY_FOR_PICKUP']);
      final m = OrderView.mergeGroup([b, a])!;
      expect(m.id, 'gA');
      expect(m.status, OrderStatus.readyForPickup, reason: 'the least advanced stop');
      expect(m.items.length, 2);
      expect(m.itemCount, 4);
      expect(m.deliveryFee, 40);
      expect(m.groupParts.map((p) => p.id), ['gA', 'gB']);
      expect(m.stops.map((s) => s.status), [OrderStatus.pickedUp, OrderStatus.readyForPickup]);
      expect(m.customer?.phone, '+91 9811111111');
      expect(m.allStopsPickedUp, isFalse);
      expect(m.canRelease, isFalse, reason: 'one stop is already picked up');
      expect(m.stops.map((s) => s.point != null), [true, true], reason: 'own copies vouch for their pins');
    });

    test('only one copy known: the other stop still shows from the stops list, without a verified pin, and the fee is unknown', () {
      final m = OrderView.mergeGroup([groupChild(index: 0)])!;
      expect(m.stops, hasLength(2));
      expect(m.stops[1].orderId, 'gB');
      expect(m.stops[1].point, isNull);
      expect(m.stops[0].point, isNotNull);
      expect(m.deliveryFee, isNull, reason: 'not every child is known yet: never a made-up partial sum');
    });

    test('a stale copy can never move a stop backwards; the stops list of a newer copy wins over an older own copy', () {
      final old = groupChild(index: 1, statuses: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      final newer = groupChild(index: 0, statuses: ['READY_FOR_PICKUP', 'PICKED_UP']);
      final m = OrderView.mergeGroup([old, newer])!;
      expect(m.stops[1].status, OrderStatus.pickedUp);
      final back = m.mergedWith([old])!;
      expect(back.stops[1].status, OrderStatus.pickedUp);
    });

    test('status rules: any cancelled stop cancels, any delivered stop delivers, all at the gate is at the gate', () {
      OrderView mk(List<String> st) => OrderView.mergeGroup([groupChild(index: 0, statuses: st), groupChild(index: 1, statuses: st)])!;
      expect(mk(['PICKED_UP', 'PICKED_UP']).status, OrderStatus.pickedUp);
      expect(mk(['PICKED_UP', 'PICKED_UP']).allStopsPickedUp, isTrue);
      expect(mk(['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE']).status, OrderStatus.arrivedAtGate);
      expect(mk(['DELIVERED', 'DELIVERED']).status, OrderStatus.delivered);
      expect(mk(['CANCELLED', 'READY_FOR_PICKUP']).status, OrderStatus.cancelled);
      expect(mk(['ACCEPTED', 'PREPARING']).status, OrderStatus.accepted);
      expect(mk(['READY_FOR_PICKUP', 'READY_FOR_PICKUP']).canRelease, isTrue);
    });

    test('the cancelling child keeps its real reason, a cascaded sibling its generic one', () {
      final a = OrderView.tryParse(groupJson(index: 0, statuses: ['CANCELLED', 'CANCELLED'])
        ..['cancelledBy'] = 'SYSTEM'
        ..['cancelReason'] = 'Another restaurant in your order could not take it')!;
      final b = OrderView.tryParse(groupJson(index: 1, statuses: ['CANCELLED', 'CANCELLED'])
        ..['cancelledBy'] = 'VENDOR'
        ..['cancelReason'] = 'Out of stock')!;
      final m = OrderView.mergeGroup([a, b])!;
      expect(m.cancelledBy, 'VENDOR');
      expect(m.cancelReason, 'Out of stock');
    });
  });

  group('controller: combined order, end to end', () {
    late FakeRider f;
    late RiderController c;
    late GroupWorld w;
    late List<String> said;

    Future<void> boot({bool onDuty = true}) async {
      SharedPreferences.setMockInitialValues({if (onDuty) RiderController.dutyPrefKey: true});
      c = RiderController(f.services, myIds: const {'u-rider'});
      said = [];
      c.messages.listen(said.add);
      await c.start();
      await Future<void>.delayed(Duration.zero);
    }

    setUp(() => f = FakeRider());
    tearDown(() => c.dispose());

    test('the pool shows ONE card for the group; accept claims through the primary id and opens ONE delivery', () async {
      w = GroupWorld(f, start: ['ACCEPTED', 'PREPARING']);
      w.released = true; // nothing assigned yet
      w.sync();
      f.api.available = ApiResult.ok([groupOffer()]);
      await boot();
      expect(c.offers.map((o) => o.id), ['gA']);
      expect(c.offers.single.group!.size, 2);
      w.released = false;
      w.sync();
      final ok = await c.claim(c.offers.single);
      expect(ok, isTrue);
      expect(f.api.calls.where((x) => x.startsWith('claim:')), ['claim:gA']);
      expect(c.active!.isGroup, isTrue);
      expect(c.active!.id, 'gA');
      expect(c.active!.stops.map((s) => s.orderId), ['gA', 'gB']);
      expect(c.otherActiveCount, 0, reason: 'the two children are ONE delivery');
      expect(f.socket.watched, {'gA', 'gB'}, reason: 'every restaurant order room is joined');
      expect(c.offers, isEmpty);
      expect(said.last, 'Order accepted. Collect it from 2 restaurants.');
      expect(f.api.calls, contains('active'), reason: 'the other children come from the rider\'s own list right after the claim');
    });

    test('claim errors for a group read like single orders: ALREADY_TAKEN, RIDER_BUSY, ORDER_NOT_AVAILABLE', () async {
      f.api.available = ApiResult.ok([groupOffer()]);
      await boot();
      for (final (code, text) in [
        ('ALREADY_TAKEN', 'Another rider took this order.'),
        ('RIDER_BUSY', 'You already have an active delivery. Finish it first.'),
        ('ORDER_NOT_AVAILABLE', 'This order is no longer available.'),
      ]) {
        f.socket.emit(OfferAvailable(groupOffer()));
        f.api.onClaim = (_) => ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: code);
        expect(await c.claim(c.offers.firstWhere((o) => o.id == 'gA')), isFalse, reason: code);
        expect(said.last, text, reason: code);
      }
    });

    test('socket: order_available for a group adds one card, order_unavailable for the primary removes it', () async {
      await boot();
      final offer = groupOffer();
      f.socket.emit(OfferAvailable(offer));
      expect(c.offers.map((o) => o.id), ['gA']);
      f.socket.emit(OfferAvailable(offer));
      expect(c.offers, hasLength(1));
      f.socket.emit(const OfferUnavailable('gA'));
      expect(c.offers, isEmpty);
      final e = parseRiderSocketEvent('order_available', groupJson(index: 0, pool: true, statuses: ['ACCEPTED', 'ACCEPTED']));
      expect((e as OfferAvailable).order.group!.stops, hasLength(2));
    });

    test('the delivery is restored after a restart as ONE active delivery with every stop', () async {
      w = GroupWorld(f, start: ['PICKED_UP', 'READY_FOR_PICKUP']);
      await boot(onDuty: false);
      expect(c.active!.isGroup, isTrue);
      expect(c.active!.stops.map((s) => s.status), [OrderStatus.pickedUp, OrderStatus.readyForPickup]);
      expect(c.otherActiveCount, 0);
      expect(c.sharingLocation, isTrue);
      expect(f.socket.watched, {'gA', 'gB'});
    });

    test('per-stop pickup, arrival only after ALL stops, ONE arrival call, ONE code, delivery closes the whole order', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'PREPARING']);
      await boot();
      expect(c.active!.status, OrderStatus.preparing);

      // the second kitchen is not ready: nothing is sent
      await c.pickUpStop('gB');
      expect(w.countStarting('status:'), 0);
      expect(c.actionError, 'Kitchen 2 is still preparing. Wait until it is marked ready.');

      await c.pickUpStop('gA');
      expect(f.api.calls.where((x) => x.startsWith('status:')), ['status:gA:PICKED_UP']);
      expect(c.active!.stops.map((s) => s.status), [OrderStatus.pickedUp, OrderStatus.preparing]);

      // "Arrived" before every stop is picked up: refused on the phone, no request
      await c.advance(OrderStatus.arrivedAtGate);
      expect(c.actionError, 'Pick up the food from every restaurant first.');
      expect(w.countStarting('status:'), 1);
      // "picked up" through the order-level button is never sent for a combined order
      await c.advance(OrderStatus.pickedUp);
      expect(w.countStarting('status:'), 1);

      // the kitchen finishes (socket update of the second order), then it is picked up
      w.kitchen(1, 'READY_FOR_PICKUP');
      f.socket.emit(OrderUpdated(w.child(1)));
      expect(c.active!.stops[1].status, OrderStatus.readyForPickup);
      await c.pickUpStop('gB');
      expect(c.active!.status, OrderStatus.pickedUp);
      expect(c.active!.allStopsPickedUp, isTrue);
      expect(c.actionError, isNull);

      await c.advance(OrderStatus.arrivedAtGate);
      expect(f.api.calls.where((x) => x.contains('ARRIVED_AT_GATE')), ['status:gA:ARRIVED_AT_GATE'], reason: 'ONE arrival request for the whole order');
      expect(c.active!.status, OrderStatus.arrivedAtGate);
      // a second tap is not possible any more
      await c.advance(OrderStatus.arrivedAtGate);
      expect(f.api.calls.where((x) => x.contains('ARRIVED_AT_GATE')), hasLength(1));

      final wrong = await c.verifyOtp('0000');
      expect(wrong.kind, OtpOutcomeKind.wrong);
      expect(wrong.attemptsLeft, 4);
      final done = await c.verifyOtp('4821');
      expect(done.kind, OtpOutcomeKind.delivered);
      expect(f.api.calls.where((x) => x.startsWith('otp:') && x.endsWith('4821')), ['otp:gA:4821'], reason: 'the code is entered ONCE');
      expect(c.active, isNull);
      expect(c.notice!.kind, NoticeKind.delivered);
      expect(c.notice!.order.isGroup, isTrue);
      expect(f.socket.watched, isEmpty);
      expect(c.sharingLocation, isTrue, reason: 'on duty');
    });

    test('a double tap on "Picked up" sends ONE request', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      final first = c.pickUpStop('gA');
      final second = c.pickUpStop('gA');
      final third = c.pickUpStop('gB'); // another stop while one is being saved: also ignored
      await Future.wait([first, second, third]);
      expect(f.api.calls.where((x) => x.startsWith('status:')), ['status:gA:PICKED_UP']);
      await c.pickUpStop('gA'); // already picked up: nothing to send
      expect(f.api.calls.where((x) => x.startsWith('status:')), hasLength(1));
    });

    test('the server refuses the arrival (GROUP_NOT_PICKED_UP): plain text, state re-read', () async {
      w = GroupWorld(f, start: ['PICKED_UP', 'PICKED_UP']);
      await boot();
      w.status['gB'] = 'READY_FOR_PICKUP'; // the server disagrees with the phone
      w.sync();
      f.api.fetchOrderStub(w);
      await c.advance(OrderStatus.arrivedAtGate);
      expect(c.actionError, 'Pick up the food from every restaurant first.');
    });

    test('network trouble on a pickup: not saved, then the re-read finds it was saved after all', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      f.api.onStatus = (id, s) {
        w.status[id] = 'PICKED_UP';
        w.bump(id);
        w.sync();
        f.api.orders = {'gA': ApiResult.ok(w.child(0))}; // what the re-read will find
        return offline;
      };
      await c.pickUpStop('gA');
      expect(c.active!.stops[0].status, OrderStatus.pickedUp);
      expect(c.actionError, isNull);
      expect(f.api.calls, contains('order:gA'));
    });

    test('release: allowed before the first pickup (one request, whole group), refused on the phone after any pickup', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      expect(c.active!.canRelease, isTrue);
      await c.pickUpStop('gB');
      expect(c.active!.canRelease, isFalse);
      await c.release();
      expect(f.api.calls.where((x) => x.startsWith('release:')), isEmpty);
      expect(c.actionError, 'You already have food from one of the restaurants. Only Kraveo support can move this delivery now.');
      expect(c.active, isNotNull);
    });

    test('release before any pickup frees the rider and leaves the room of every stop', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'PREPARING']);
      await boot();
      await c.release();
      expect(f.api.calls.where((x) => x.startsWith('release:')), ['release:gA']);
      expect(c.active, isNull);
      expect(f.socket.watched, isEmpty);
      expect(said.last, 'Job released. It is back with other riders.');
      expect(c.notice, isNull);
    });

    test('CANNOT_RELEASE from the server (the phone did not know about a pickup) says so for the combined order', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      f.api.onRelease = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'CANNOT_RELEASE');
      f.api.fetchOrderStub(w);
      await c.release();
      expect(c.actionError, 'This combined order can no longer be released (food from one restaurant was already picked up). Contact Kraveo support.');
    });

    test('cancelled: ONE notice for the whole order with the real reason, rooms left, nothing delivered', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      final a = OrderView.tryParse(groupJson(index: 0, statuses: ['CANCELLED', 'CANCELLED'])
        ..['cancelledBy'] = 'SYSTEM'
        ..['cancelReason'] = 'Another restaurant in your order could not take it'
        ..['updatedAt'] = testNow.add(const Duration(seconds: 30)).toUtc().toIso8601String())!;
      final b = OrderView.tryParse(groupJson(index: 1, statuses: ['CANCELLED', 'CANCELLED'])
        ..['cancelledBy'] = 'VENDOR'
        ..['cancelReason'] = 'Out of stock'
        ..['updatedAt'] = testNow.add(const Duration(seconds: 30)).toUtc().toIso8601String())!;
      f.api.active = ApiResult.ok([a, b]);
      await c.pollNow();
      expect(c.active, isNull);
      expect(c.notice!.kind, NoticeKind.cancelled);
      expect(c.notice!.order.cancelReason, 'Out of stock');
      expect(f.socket.watched, isEmpty);
    });

    test('a socket update of ONE child that is cancelled closes the whole order', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      final b = OrderView.tryParse(groupJson(index: 1, statuses: ['READY_FOR_PICKUP', 'CANCELLED'])
        ..['cancelledBy'] = 'VENDOR'
        ..['cancelReason'] = 'Closed'
        ..['updatedAt'] = testNow.add(const Duration(seconds: 30)).toUtc().toIso8601String())!;
      f.socket.emit(OrderUpdated(b));
      expect(c.notice!.kind, NoticeKind.cancelled);
      expect(c.active, isNull);
    });

    test('moved away by Kraveo (the children vanish from the list and the order is not ours): reassigned notice once', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      f.api.active = const ApiResult.ok([]);
      f.api.orders = {'gA': const ApiResult.fail(ApiFailure.notFound, statusCode: 404)};
      await c.pollNow();
      expect(c.active, isNull);
      expect(c.notice!.kind, NoticeKind.reassigned);
      expect(f.socket.watched, isEmpty);
    });

    test('a failed poll keeps the combined delivery on screen and marks it stale', () async {
      w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
      await boot();
      f.api.active = offline;
      await c.pollNow();
      expect(c.active!.isGroup, isTrue);
      expect(c.activeStale, isTrue);
    });

    test('history: a delivered combined order is ONE trip with the sum of its fees; single orders are unchanged', () async {
      w = GroupWorld(f, start: ['DELIVERED', 'DELIVERED']);
      w.released = true;
      w.sync();
      final single = order(id: 'solo', status: 'DELIVERED', fee: 30, deliveredAt: testNow, updatedAt: testNow);
      f.api.onHistory = (_) => ApiResult.ok(OrderPage([...w.children, single], null));
      await boot();
      expect(c.history.length, 2);
      expect(c.delivered.length, 2);
      expect(c.deliveredToday.length, 2, reason: 'one combined order + one single order = 2 deliveries');
      expect(RiderController.feesOf(c.deliveredToday), 70);
      expect(c.history.first.isGroup, isTrue);
      expect(c.history.first.pickupLabel, 'Kitchen 1 + Kitchen 2');
    });

    test('history pages: the two children of one order on different pages still make one trip', () async {
      w = GroupWorld(f, start: ['DELIVERED', 'DELIVERED']);
      w.released = true;
      w.sync();
      final old = testNow.subtract(const Duration(days: 9)).toUtc().toIso8601String();
      final first = OrderView.tryParse(groupJson(index: 0, statuses: ['DELIVERED', 'DELIVERED'])..['deliveredAt'] = old)!;
      f.api.onHistory = (cursor) => cursor == null ? ApiResult.ok(OrderPage([first], 'p2')) : ApiResult.ok(OrderPage([w.child(1)], null));
      await boot();
      expect(c.history.length, 1);
      expect(c.historyHasMore, isTrue);
      await c.loadMoreHistory();
      expect(c.history.length, 1);
      expect(c.history.single.group!.stops, hasLength(2));
      expect(RiderController.feesOf(c.delivered), 40);
    });

    test('finishing a combined order puts ONE trip into history, even when the list already holds one of its children', () async {
      w = GroupWorld(f, start: ['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE']);
      await boot();
      f.api.onHistory = (_) => ApiResult.ok(OrderPage([w.child(0), w.child(1)], null));
      final r = await c.verifyOtp('4821');
      expect(r.kind, OtpOutcomeKind.delivered);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(c.history.length, 1);
      expect(c.delivered.length, 1);
    });

    test('single orders next to a combined one keep working: a single active order is not touched by the group code', () async {
      f.api.active = ApiResult.ok([order(status: 'READY_FOR_PICKUP')]);
      await boot();
      expect(c.active!.isGroup, isFalse);
      await c.advance(OrderStatus.pickedUp);
      expect(f.api.calls, contains('status:ord-1:PICKED_UP'));
      expect(c.active!.status, OrderStatus.pickedUp);
    });
  });
}

extension on FakeRiderApi {
  /// The server's answer to "show me this order" for the re-read after a refused action.
  void fetchOrderStub(GroupWorld w) {
    orders = {for (var i = 0; i < w.ids.length; i++) w.ids[i]: ApiResult.ok(w.child(i))};
  }
}
