import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/location_source.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'support/fake_rider.dart';

/// Unit tests of the rider's order flow against a fake API, socket and GPS (no device, no network).
void main() {
  late FakeRider f;
  late RiderController c;
  var booted = false;
  late List<String> said;

  Future<void> boot({Set<String> myIds = const {'u-rider'}, bool onDutyPref = false}) async {
    SharedPreferences.setMockInitialValues({if (onDutyPref) RiderController.dutyPrefKey: true});
    c = RiderController(f.services, myIds: myIds);
    booted = true;
    said = [];
    c.messages.listen(said.add);
    await c.start();
  }

  Future<void> flush() => Future<void>.delayed(Duration.zero);

  setUp(() {
    f = FakeRider();
    booted = false;
  });
  tearDown(() {
    if (booted) c.dispose();
  });

  group('restore and duty', () {
    test('a delivery in progress is restored after the app was killed, even off duty', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      expect(c.activeChecked, isTrue);
      expect(c.active?.id, 'ord-1');
      expect(c.active?.status, OrderStatus.pickedUp);
      expect(c.onDuty, isFalse);
      expect(f.socket.connected, isTrue, reason: 'socket kept for the active order room');
      expect(f.socket.watched, {'ord-1'});
      expect(f.api.calls, isNot(contains('available')));
    });

    test('off duty: no offers are fetched, socket stays closed, no GPS', () async {
      f.api.available = ApiResult.ok([offer()]);
      await boot();
      await c.pollNow();
      expect(c.offers, isEmpty);
      expect(f.api.calls, isNot(contains('available')));
      expect(f.socket.connected, isFalse);
      expect(f.api.locations, isEmpty);
      expect(c.location, LocationState.off);
    });

    test('going on duty waits for the server, then shares GPS and loads offers', () async {
      f.api.available = ApiResult.ok([offer()]);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.onDuty, isTrue);
      expect(f.api.calls, contains('duty:true'));
      expect(f.api.locations, [(23.0775, 76.8513)]);
      expect(c.location, LocationState.ok);
      expect(c.offers.map((o) => o.id), ['pool-1']);
      expect(f.socket.connected, isTrue);
      expect((await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey), isTrue);
    });

    test('duty ON fails -> the switch stays OFF and says why; nothing is streamed', () async {
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.offline);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.onDuty, isFalse);
      expect(c.dutyBusy, isFalse);
      expect(said, contains('Could not go on duty – check internet'));
      expect(f.api.locations, isEmpty);
      expect(f.api.calls, isNot(contains('available')));
    });

    test('a saved "on duty" is re-sent on start; when it fails the rider is shown off duty', () async {
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.timeout);
      await boot(onDutyPref: true);
      expect(f.api.calls, contains('duty:true'));
      expect(c.onDuty, isFalse);
      expect((await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey), isFalse);
    });

    test('going OFF always works locally; the server is told later when it was unreachable', () async {
      await boot();
      await c.setDuty(true);
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.offline);
      await c.setDuty(false);
      expect(c.onDuty, isFalse);
      expect(c.location, LocationState.off);
      expect(c.offers, isEmpty);
      expect(said.last, contains('Kraveo will be told'));
      f.api.onDuty = (on) => ApiResult.ok(on ? 'ONLINE' : 'OFFLINE');
      f.api.calls.clear();
      await c.pollNow();
      await flush();
      expect(f.api.calls, contains('duty:false'));
    });
  });

  group('offers', () {
    setUp(() async {
      f.api.available = ApiResult.ok([offer(id: 'a'), offer(id: 'b')]);
    });

    test('socket order_available adds, order_unavailable removes at once', () async {
      await boot();
      await c.setDuty(true);
      f.socket.emit(OfferAvailable(offer(id: 'c')));
      expect(c.offers.map((o) => o.id), ['c', 'a', 'b']);
      f.socket.emit(const OfferUnavailable('a'));
      expect(c.offers.map((o) => o.id), ['c', 'b']);
    });

    test('a poll that started before order_unavailable does not bring the order back', () async {
      await boot();
      await c.setDuty(true);
      f.api.availableGate = Completer<void>();
      final poll = c.refreshOffers();
      await flush();
      f.socket.emit(const OfferUnavailable('a'));
      f.api.availableGate!.complete();
      await poll;
      expect(c.offers.map((o) => o.id), ['b']);
    });

    test('unpaid or already-claimed orders never show; socket offers are ignored off duty', () async {
      await boot();
      f.socket.emit(OfferAvailable(offer(id: 'x')));
      expect(c.offers, isEmpty);
      await c.setDuty(true);
      f.socket.emit(OfferAvailable(offer(id: 'unpaid', paymentStatus: 'PENDING')));
      f.socket.emit(OfferAvailable(order(id: 'taken', status: 'PREPARING')));
      expect(c.offers.map((o) => o.id), ['a', 'b']);
    });

    test('a failed poll keeps the offers on screen and marks them stale', () async {
      await boot();
      await c.setDuty(true);
      f.api.available = const ApiResult.fail(ApiFailure.offline);
      await c.refreshOffers();
      expect(c.offers.length, 2);
      expect(c.offersStale, isTrue);
    });

    test('pool view never carries customer name or phone', () {
      final o = offer();
      expect(o.customer, isNull);
      expect(o.driver, isNull);
    });

    test('order_available again for the same order updates it in place (add-or-update)', () async {
      await boot();
      await c.setDuty(true);
      f.socket.emit(OfferAvailable(order(id: 'a', status: 'READY_FOR_PICKUP', pool: true, updatedAt: testNow)));
      expect(c.offers.map((o) => o.id), ['a', 'b']);
      expect(c.offers.first.status, OrderStatus.readyForPickup);
    });

    test('display code is # + last 6 characters of the id, upper case', () {
      expect(order(id: 'e6349a70-2379-4197-8018-067a3905efb9').shortRef, '#05EFB9');
      expect(order(id: 'ab-1').shortRef, '#AB-1');
    });
  });

  group('claim', () {
    setUp(() => f.api.available = ApiResult.ok([offer(id: 'a'), offer(id: 'b')]));

    test('success: the server-confirmed order becomes the active delivery', () async {
      await boot();
      await c.setDuty(true);
      final ok = await c.claim(c.offers.first);
      expect(ok, isTrue);
      expect(c.active?.id, 'a');
      expect(c.offers, isEmpty);
      expect(f.socket.watched, contains('a'));
      expect(said.last, 'Order accepted. Go to FC Night Mess.');
    });

    test('409 ALREADY_TAKEN: the offer disappears with a clear message, no job shown', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'ALREADY_TAKEN');
      await boot();
      await c.setDuty(true);
      final ok = await c.claim(c.offers.first);
      expect(ok, isFalse);
      expect(c.active, isNull);
      expect(c.offers.map((o) => o.id), ['b']);
      expect(said.last, 'Another rider took this order.');
    });

    test('409 for a rider who already has a delivery re-reads the active list', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'RIDER_BUSY', message: 'You already have an active delivery.');
      await boot();
      await c.setDuty(true);
      f.api.active = ApiResult.ok([order(id: 'mine', status: 'ACCEPTED')]);
      await c.claim(c.offers.first);
      expect(said, contains('You already have an active delivery. Finish it first.'));
      expect(c.active?.id, 'mine');
    });

    test('409 ORDER_NOT_AVAILABLE (cancelled / unpaid race) removes the offer', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'ORDER_NOT_AVAILABLE');
      await boot();
      await c.setDuty(true);
      await c.claim(c.offers.first);
      expect(c.offers.map((o) => o.id), ['b']);
      expect(said.last, 'This order is no longer available.');
    });

    test('409 RIDER_OFFLINE: the app mirrors the server and goes off duty', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'RIDER_OFFLINE');
      await boot();
      await c.setDuty(true);
      expect(await c.claim(c.offers.first), isFalse);
      expect(c.onDuty, isFalse);
      expect(c.offers, isEmpty);
      expect(c.location, LocationState.off);
      expect(said.last, 'Kraveo has you off duty. Go on duty again to accept orders.');
    });

    test('an unknown 409 keeps the offer list honest by re-reading the pool', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'SOMETHING_NEW', message: 'Nope');
      await boot();
      await c.setDuty(true);
      f.api.calls.clear();
      await c.claim(c.offers.first);
      await flush();
      expect(said.last, 'Nope');
      expect(f.api.calls, contains('available'));
    });

    test('with an active delivery the app refuses locally and never calls the server', () async {
      f.api.active = ApiResult.ok([order(id: 'mine', status: 'PICKED_UP')]);
      await boot();
      await c.setDuty(true);
      final ok = await c.claim(offer(id: 'a'));
      expect(ok, isFalse);
      expect(f.api.calls.where((x) => x.startsWith('claim')), isEmpty);
    });

    test('timeout, but Kraveo did assign it: the app checks and shows the job', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.timeout);
      await boot();
      await c.setDuty(true);
      f.api.active = ApiResult.ok([order(id: 'a', status: 'PREPARING')]);
      expect(await c.claim(c.offers.first), isTrue);
      expect(c.active?.id, 'a');
    });

    test('offline and not assigned: nothing shown as accepted', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.offline);
      await boot();
      await c.setDuty(true);
      expect(await c.claim(c.offers.first), isFalse);
      expect(c.active, isNull);
      expect(said.last, 'No internet – the order was not accepted. Try again.');
    });

    test('403 PARTNER_NOT_APPROVED is explained (the session hook handles the screen)', () async {
      f.api.onClaim = (_) => const ApiResult.fail(ApiFailure.notApproved, statusCode: 403, code: 'PARTNER_NOT_APPROVED');
      await boot();
      await c.setDuty(true);
      expect(await c.claim(c.offers.first), isFalse);
      expect(said.last, 'Your account is not active right now.');
    });
  });

  group('active delivery is driven by the server status', () {
    test('Picked up is refused until READY_FOR_PICKUP; then PATCH moves it on', () async {
      f.api.active = ApiResult.ok([order(status: 'PREPARING')]);
      await boot();
      await c.advance(OrderStatus.pickedUp);
      expect(c.actionError, contains('Restaurant is still preparing'));
      expect(f.api.calls.where((x) => x.startsWith('status')), isEmpty);

      f.socket.emit(OrderUpdated(order(status: 'READY_FOR_PICKUP', updatedAt: testNow.subtract(const Duration(minutes: 1)))));
      expect(c.active!.status, OrderStatus.readyForPickup);
      await c.advance(OrderStatus.pickedUp);
      expect(f.api.calls, contains('status:ord-1:PICKED_UP'));
      expect(c.active!.status, OrderStatus.pickedUp);
      expect(c.actionError, isNull);
    });

    test('an older copy (by updatedAt) never moves the screen backwards', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP', updatedAt: testNow)]);
      await boot();
      f.socket.emit(OrderUpdated(order(status: 'READY_FOR_PICKUP', updatedAt: testNow.subtract(const Duration(minutes: 3)))));
      expect(c.active!.status, OrderStatus.pickedUp);
    });

    test('step failure offline: error shown, nothing advanced locally', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'PICKED_UP'));
      f.api.onStatus = (_, __) => const ApiResult.fail(ApiFailure.offline);
      await boot();
      await c.advance(OrderStatus.arrivedAtGate);
      expect(c.active!.status, OrderStatus.pickedUp);
      expect(c.actionError, contains('No internet'));
    });

    test('customer phone comes only from the server copy (at the gate)', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      f.api.onStatus = (id, s) => ApiResult.ok(order(id: id, status: s.wire, phone: '+91 9876500000', updatedAt: testNow));
      await boot();
      expect(c.active!.customer?.phone, isNull);
      await c.advance(OrderStatus.arrivedAtGate);
      expect(c.active!.status, OrderStatus.arrivedAtGate);
      expect(c.active!.customer?.phone, '+91 9876500000');
    });
  });

  group('gate code (OTP)', () {
    setUp(() => f.api.active = ApiResult.ok([order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]));

    test('wrong code shows the tries left; nothing is delivered', () async {
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.badRequest, statusCode: 400, code: 'OTP_INVALID', attemptsLeft: 3);
      await boot();
      final r = await c.verifyOtp('1111');
      expect(r.kind, OtpOutcomeKind.wrong);
      expect(r.attemptsLeft, 3);
      expect(c.active, isNotNull);
    });

    test('409 NOT_AT_GATE re-reads the order and explains', () async {
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'NOT_AT_GATE');
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'ARRIVED_AT_GATE'));
      await boot();
      final r = await c.verifyOtp('1111');
      expect(r.kind, OtpOutcomeKind.error);
      expect(r.message, contains('drop point'));
      expect(f.api.calls, contains('order:ord-1'));
    });

    test('OTP_INVALID with 0 tries left is treated as locked', () async {
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.badRequest, statusCode: 400, code: 'OTP_INVALID', attemptsLeft: 0);
      await boot();
      expect((await c.verifyOtp('1111')).kind, OtpOutcomeKind.locked);
      expect(c.activeLocked, isTrue);
    });

    test('423 OTP_LOCKED locks the delivery; further tries still ask Kraveo (a 423 costs no attempt)', () async {
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.locked, statusCode: 423, code: 'OTP_LOCKED');
      await boot();
      expect((await c.verifyOtp('1111')).kind, OtpOutcomeKind.locked);
      expect(c.activeLocked, isTrue);
      f.api.calls.clear();
      expect((await c.verifyOtp('2222')).kind, OtpOutcomeKind.locked);
      expect(f.api.calls, ['otp:ord-1:2222'], reason: 'DR-01: no local short-circuit, so an admin reset is never hidden by the app');
      expect(c.activeLocked, isTrue);
    });

    test('correct code: delivered notice, fee added to history', () async {
      await boot();
      final r = await c.verifyOtp('4821');
      expect(r.kind, OtpOutcomeKind.delivered);
      expect(f.api.calls, contains('otp:ord-1:4821'));
      expect(c.active, isNull);
      expect(c.notice?.kind, NoticeKind.delivered);
      expect(c.history.first.id, 'ord-1');
    });

    test('network lost during verify, but Kraveo did deliver it: reported as delivered', () async {
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.timeout);
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow));
      await boot();
      expect((await c.verifyOtp('4821')).kind, OtpOutcomeKind.delivered);
      expect(c.notice?.kind, NoticeKind.delivered);
    });

    test('network lost and not delivered: safe to retry with the same code', () async {
      var n = 0;
      f.api.onOtp = (id, _) => n++ == 0 ? const ApiResult.fail(ApiFailure.offline) : ApiResult.ok(order(id: id, status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow));
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'ARRIVED_AT_GATE'));
      await boot();
      expect((await c.verifyOtp('4821')).kind, OtpOutcomeKind.network);
      expect(c.active, isNotNull);
      expect((await c.verifyOtp('4821')).kind, OtpOutcomeKind.delivered);
    });

    test('the app never parses an OTP, even if a server sent one to a rider', () {
      final o = OrderView.tryParse(orderJson(status: 'ARRIVED_AT_GATE', otpCode: '4821'))!;
      expect(o.toString().contains('4821'), isFalse);
      expect(o.status, OrderStatus.arrivedAtGate);
    });
  });

  group('release, cancel, reassign', () {
    test('release before pickup clears the job', () async {
      f.api.active = ApiResult.ok([order(status: 'ACCEPTED')]);
      await boot();
      await c.release();
      expect(f.api.calls, contains('release:ord-1'));
      expect(c.active, isNull);
      expect(c.notice, isNull);
      expect(said.last, 'Job released. It is back with other riders.');
    });

    test('409 CANNOT_RELEASE (server already has it picked up) re-reads the order', () async {
      f.api.active = ApiResult.ok([order(status: 'READY_FOR_PICKUP')]);
      f.api.onRelease = (_) => const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'CANNOT_RELEASE');
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'PICKED_UP', updatedAt: testNow));
      await boot();
      await c.release();
      expect(c.active?.status, OrderStatus.pickedUp);
      expect(c.actionError, contains('can no longer be released'));
    });

    test('release: timeout but the server did release it -> "released", not "moved"', () async {
      f.api.active = ApiResult.ok([order(status: 'ACCEPTED')]);
      f.api.onRelease = (_) => const ApiResult.fail(ApiFailure.timeout);
      await boot();
      await c.release(); // GET /orders/:id now answers 404 for this rider (default in the fake)
      expect(c.active, isNull);
      expect(c.notice, isNull);
      expect(said.last, 'Job released. It is back with other riders.');
    });

    test('release after pickup is refused locally', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      await c.release();
      expect(f.api.calls.where((x) => x.startsWith('release')), isEmpty);
      expect(c.active, isNotNull);
      expect(c.actionError, contains('Only Kraveo support'));
    });

    test('cancelled by an admin while carrying: clear stop notice with the reason', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      f.api.active = ApiResult.ok([
        order(status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', cancelReason: 'Customer unreachable', pickedUpAt: testNow, updatedAt: testNow),
      ]);
      await c.pollNow();
      expect(c.active, isNull);
      expect(c.notice?.kind, NoticeKind.cancelled);
      expect(c.notice?.order.cancelReason, 'Customer unreachable');
    });

    test('reassigned by an admin: missing from my list and 404 on the order -> moved notice', () async {
      f.api.active = ApiResult.ok([order(status: 'PREPARING')]);
      await boot();
      f.api.active = const ApiResult.ok([]);
      f.api.orders['ord-1'] = const ApiResult.fail(ApiFailure.notFound, statusCode: 404, code: 'NOT_FOUND');
      await c.pollNow();
      expect(c.active, isNull);
      expect(c.notice?.kind, NoticeKind.reassigned);
    });

    test('a failed poll never wipes the delivery on screen', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      f.api.active = const ApiResult.fail(ApiFailure.offline);
      await c.pollNow();
      expect(c.active?.id, 'ord-1');
      expect(c.activeStale, isTrue);
    });

    test('a socket copy naming another rider is double-checked before anything is removed', () async {
      f.api.active = ApiResult.ok([order(status: 'PREPARING')]);
      f.api.orders['ord-1'] = ApiResult.ok(order(status: 'PREPARING'));
      await boot();
      f.socket.emit(OrderUpdated(OrderView.tryParse(orderJson(status: 'PREPARING', driverId: 'someone-else', updatedAt: testNow))!));
      await flush();
      expect(c.active?.id, 'ord-1', reason: 'still in my REST list');
    });
  });

  group('GPS', () {
    test('no fix -> "location unavailable", nothing posted (no made-up coordinates)', () async {
      f.location.reading = const LocationReading.problem(LocationProblem.unavailable);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.location, LocationState.unavailable);
      expect(f.api.locations, isEmpty);
    });

    test('permission denied and GPS off are named; the fix buttons ask / open settings', () async {
      f.location.reading = const LocationReading.problem(LocationProblem.permissionDenied);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.location, LocationState.permissionDenied);
      await c.fixLocation();
      expect(f.location.permissionRequests, 1);
      f.location.reading = const LocationReading.problem(LocationProblem.serviceOff);
      await c.fixLocation();
      expect(c.location, LocationState.serviceOff);
      await c.fixLocation();
      expect(f.location.opened, [LocationProblem.serviceOff]);
      expect(f.api.locations, isEmpty);
    });

    test('GPS is posted on a timer only while on duty', () async {
      f = FakeRider(gps: const Duration(milliseconds: 20));
      await boot();
      await Future<void>.delayed(const Duration(milliseconds: 70));
      expect(f.api.locations, isEmpty);
      await c.setDuty(true);
      await Future<void>.delayed(const Duration(milliseconds: 70));
      expect(f.api.locations.length, greaterThanOrEqualTo(2));
      await c.setDuty(false);
      final n = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 70));
      expect(f.api.locations.length, n);
    });
  });

  group('history and delivery fees', () {
    test('fees today / 7 days come from delivered orders only; pagination appends', () async {
      final yesterday = testNow.subtract(const Duration(days: 1));
      f.api.onHistory = (cursor) => cursor == null
          ? ApiResult.ok(OrderPage([
              order(id: 'h1', status: 'DELIVERED', fee: 25, deliveredAt: testNow.subtract(const Duration(hours: 1))),
              order(id: 'h2', status: 'DELIVERED', fee: 30, deliveredAt: yesterday),
              order(id: 'h3', status: 'CANCELLED', fee: 40),
            ], null))
          : const ApiResult.ok(OrderPage([], null));
      await boot();
      await flush();
      expect(c.historyLoaded, isTrue);
      expect(RiderController.feesOf(c.deliveredToday), 25);
      expect(c.deliveredToday.length, 1);
      expect(RiderController.feesOf(c.deliveredThisWeek), 55);
      expect(c.history.length, 3);
    });

    test('load more uses the server cursor; a failed page keeps what is shown', () async {
      f.api.onHistory = (cursor) => switch (cursor) {
            null => ApiResult.ok(OrderPage([order(id: 'h1', status: 'DELIVERED', deliveredAt: testNow.subtract(const Duration(days: 20)))], 'cur-2')),
            _ => const ApiResult.fail(ApiFailure.offline),
          };
      await boot();
      await flush();
      expect(c.historyHasMore, isTrue);
      await c.loadMoreHistory();
      expect(f.api.calls, contains('history:cur-2'));
      expect(c.history.length, 1);
      expect(c.historyError, isTrue);
    });
  });

  group('OTP lock reset by an admin (DR-01)', () {
    const locked = ApiResult<OrderView?>.fail(ApiFailure.locked, statusCode: 423, code: 'OTP_LOCKED');
    OrderView atGate(Duration ago) => order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000', updatedAt: testNow.subtract(ago));

    setUp(() => f.api.active = ApiResult.ok([atGate(const Duration(minutes: 5))]));

    test('locked -> newer copy -> unlocked', () async {
      f.api.onOtp = (_, __) => locked;
      await boot();
      expect((await c.verifyOtp('1111')).kind, OtpOutcomeKind.locked);
      expect(c.activeLocked, isTrue);

      // The 5th wrong code itself changed the order on the server (newer updatedAt): that first copy is only the
      // baseline and must NOT lift the lock.
      f.socket.emit(OrderUpdated(atGate(const Duration(minutes: 4))));
      expect(c.activeLocked, isTrue);
      f.api.active = ApiResult.ok([atGate(const Duration(minutes: 4))]);
      await c.pollNow();
      expect(c.activeLocked, isTrue, reason: 'the same copy again (poll) changes nothing');

      // The admin resets the lock: a newer copy arrives.
      f.socket.emit(OrderUpdated(atGate(const Duration(minutes: 1))));
      expect(c.activeLocked, isFalse);
      expect(said.last, contains('unlocked'));
      expect(c.active?.id, 'ord-1');
    });

    test('a newer copy that arrives by poll unlocks too, and the new code can finish the delivery', () async {
      f.api.onOtp = (_, __) => locked;
      await boot();
      await c.verifyOtp('1111');
      f.api.active = ApiResult.ok([atGate(const Duration(minutes: 4))]);
      await c.pollNow();
      expect(c.activeLocked, isTrue);
      f.api.active = ApiResult.ok([atGate(const Duration(minutes: 1))]);
      await c.pollNow();
      expect(c.activeLocked, isFalse);
      f.api.onOtp = (id, _) => ApiResult.ok(order(id: id, status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow));
      expect((await c.verifyOtp('4821')).kind, OtpOutcomeKind.delivered);
      expect(c.notice?.kind, NoticeKind.delivered);
    });

    test('an old copy never lifts the lock', () async {
      f.api.onOtp = (_, __) => locked;
      await boot();
      await c.verifyOtp('1111');
      f.socket.emit(OrderUpdated(atGate(const Duration(minutes: 4))));
      f.socket.emit(OrderUpdated(atGate(const Duration(minutes: 9))));
      expect(c.activeLocked, isTrue);
    });

    test('if Kraveo answers the retry with a normal wrong-code reply, the lock is gone locally', () async {
      f.api.onOtp = (_, __) => locked;
      await boot();
      await c.verifyOtp('1111');
      expect(c.activeLocked, isTrue);
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.badRequest, statusCode: 400, code: 'OTP_INVALID', attemptsLeft: 4);
      final r = await c.verifyOtp('0000');
      expect(r.kind, OtpOutcomeKind.wrong);
      expect(r.attemptsLeft, 4);
      expect(c.activeLocked, isFalse);
    });

    test('delivering or releasing forgets the lock of that order', () async {
      f.api.onOtp = (_, __) => locked;
      await boot();
      await c.verifyOtp('1111');
      f.api.active = ApiResult.ok([order(status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow)]);
      await c.pollNow();
      expect(c.active, isNull);
      expect(c.activeLocked, isFalse);
    });
  });

  group('location while carrying an order (DR-06)', () {
    test('going off duty with a delivery in hand keeps sharing until the job ends', () async {
      f = FakeRider(gps: const Duration(milliseconds: 20));
      f.api.active = ApiResult.ok([order(status: 'ACCEPTED')]);
      await boot();
      await c.setDuty(true);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await c.setDuty(false);
      expect(c.onDuty, isFalse);
      expect(c.sharingLocation, isTrue);
      expect(said.last, contains('still shared'));
      final n = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(f.api.locations.length, greaterThan(n), reason: 'the customer map keeps moving');
      expect(c.location, LocationState.ok);

      f.api.onRelease = (_) => const ApiResult.ok(null);
      await c.release();
      expect(c.active, isNull);
      expect(c.sharingLocation, isFalse);
      expect(c.location, LocationState.off);
      final m = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(f.api.locations.length, m, reason: 'nothing is sent once the job is released and the rider is off duty');
    });

    test('a finished delivery (off duty) stops the sharing too', () async {
      f = FakeRider(gps: const Duration(milliseconds: 20));
      f.api.active = ApiResult.ok([order(status: 'ARRIVED_AT_GATE')]);
      await boot();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(c.onDuty, isFalse);
      expect(c.location, LocationState.ok, reason: 'restored with a job: sharing resumed without a tap');
      expect(f.api.locations, isNotEmpty);
      await c.verifyOtp('4821');
      expect(c.active, isNull);
      expect(c.location, LocationState.off);
    });

    test('after a restore with an active job and duty off, sharing resumes automatically', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      await flush();
      expect(c.onDuty, isFalse);
      expect(c.sharingLocation, isTrue);
      expect(f.api.locations, [(23.0775, 76.8513)]);
    });

    test('logging out stops everything', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      await flush();
      await c.stopForLogout();
      expect(c.location, LocationState.off);
    });

    test('with no job, going off duty stops sharing at once', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      await c.setDuty(false);
      expect(c.sharingLocation, isFalse);
      expect(c.location, LocationState.off);
    });
  });

  group('duty mirrors what Kraveo holds (DR-07)', () {
    test('Kraveo says OFFLINE while the phone shows ON: the phone goes off, without another server call', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      f.api.calls.clear();
      await c.reconcileDuty('OFFLINE');
      expect(c.onDuty, isFalse);
      expect(c.location, LocationState.off);
      expect(said.last, contains('Kraveo has you off duty'));
      expect((await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey), isFalse);
      expect(f.api.calls, isNot(contains('duty:false')));
    });

    test('Kraveo says ONLINE while a failed restore left the phone off: the phone goes on', () async {
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.timeout);
      f.api.available = ApiResult.ok([offer()]);
      await boot(onDutyPref: true);
      expect(c.onDuty, isFalse);
      f.api.onDuty = (on) => ApiResult.ok(on ? 'ONLINE' : 'OFFLINE');
      f.api.calls.clear();
      await c.reconcileDuty('ONLINE');
      await flush();
      expect(c.onDuty, isTrue);
      expect(f.api.calls, isNot(contains('duty:true')), reason: 'mirroring needs no second call');
      expect(c.offers.map((o) => o.id), ['pool-1']);
      expect(f.api.locations, isNotEmpty);
      expect((await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey), isTrue);
    });

    test('IN_TRANSIT counts as on duty', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      await c.reconcileDuty('IN_TRANSIT');
      expect(c.onDuty, isTrue);
    });

    test('a pending "I went off duty" is not fought', () async {
      await boot();
      await c.setDuty(true);
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.offline);
      await c.setDuty(false);
      expect(c.onDuty, isFalse);
      await c.reconcileDuty('ONLINE');
      expect(c.onDuty, isFalse, reason: 'Kraveo has not heard the OFF yet; the poll will send it');
    });

    test('a missing or unknown value changes nothing (older server)', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      await c.reconcileDuty(null);
      await c.reconcileDuty('');
      await c.reconcileDuty('SOMETHING_NEW');
      expect(c.onDuty, isTrue);
    });

    test('an answer that was asked before the rider switched is ignored', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      await c.reconcileDuty('OFFLINE', asOf: testNow.subtract(const Duration(minutes: 1)));
      expect(c.onDuty, isTrue);
      await c.reconcileDuty('OFFLINE', asOf: testNow.add(const Duration(minutes: 1)));
      expect(c.onDuty, isFalse);
    });
  });

  group('a finished delivery does not hide the next job (DR-17)', () {
    test('the "delivered" notice is dropped when the next job arrives', () async {
      f.api.active = ApiResult.ok([order(status: 'ARRIVED_AT_GATE')]);
      f.api.available = ApiResult.ok([offer()]);
      await boot();
      await c.verifyOtp('4821');
      expect(c.notice?.kind, NoticeKind.delivered);
      await c.setDuty(true);
      await flush();
      expect(c.offers, isNotEmpty);
      expect(await c.claim(c.offers.first), isTrue);
      expect(c.active?.id, 'pool-1');
      expect(c.notice, isNull);
    });

    test('a cancelled order with the food in hand stays until the rider reads it', () async {
      f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]);
      await boot();
      f.api.active = ApiResult.ok([
        order(status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', pickedUpAt: testNow, updatedAt: testNow),
      ]);
      await c.pollNow();
      expect(c.notice?.kind, NoticeKind.cancelled);
      f.api.available = ApiResult.ok([offer()]);
      await c.setDuty(true);
      await flush();
      await c.claim(c.offers.first);
      expect(c.active?.id, 'pool-1');
      expect(c.notice?.kind, NoticeKind.cancelled);
    });
  });
}
