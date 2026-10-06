import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/services/order_queue_controller.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'support/fakes.dart';

void main() {
  late FakeBackend backend;
  late FakeSocket socket;
  late FakeAlarm alarm;

  OrderQueueController make({Duration poll = const Duration(hours: 1)}) => OrderQueueController(
        backend: backend,
        vendorId: 'ven-42',
        socket: socket,
        alarm: alarm,
        pollInterval: poll,
        tokenProvider: () async => 'jwt-test',
      );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    backend = FakeBackend();
    socket = FakeSocket();
    alarm = FakeAlarm();
  });

  group('loading and the alarm', () {
    test('start loads the active queue, connects the socket with the real vendor id and the JWT', () async {
      backend.put(order(id: 'o1', status: 'PREPARING'));
      final c = make();
      expect(c.loadedOnce, isFalse);
      await c.start();
      expect(backend.calls.first, 'list:active');
      expect(c.loadedOnce, isTrue);
      expect(c.kitchen.map((o) => o.id), ['o1']);
      expect(socket.vendorId, 'ven-42');
      expect(socket.token, 'jwt-test');
      expect(alarm.ringing, isFalse);
      c.dispose();
      expect(socket.disposed, isTrue);
    });

    test('a paid PLACED order from the poll rings the alarm and waits in "incoming"', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      expect(c.incoming.single.id, 'o1');
      expect(alarm.ringing, isTrue);
      c.dispose();
      expect(alarm.ringing, isFalse); // never leave a ringing alarm behind
    });

    test('the in-app alarm stays silent while the app is in the background and rings again when it returns', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      expect(alarm.ringing, isTrue);
      c.setAppInForeground(false); // the system notification rings instead; never both
      expect(alarm.ringing, isFalse);
      socket.emit('new_order_alert', orderJson(id: 'o2'));
      await Future<void>.delayed(Duration.zero);
      expect(alarm.ringing, isFalse, reason: 'a new order while backgrounded must not start the in-app alarm');
      expect(c.incoming.map((o) => o.id), containsAll(['o1', 'o2']));
      c.setAppInForeground(true); // back on screen with orders still waiting
      expect(alarm.ringing, isTrue);
      c.dispose();
    });

    test('new_order_alert over the socket rings at once; the same order from the poll is not duplicated', () async {
      final c = make();
      await c.start();
      expect(alarm.ringing, isFalse);
      socket.emit('new_order_alert', orderJson(id: 'o9'));
      expect(c.incoming.map((o) => o.id), ['o9']);
      expect(alarm.ringing, isTrue);
      backend.put(order(id: 'o9'));
      await c.refresh();
      expect(c.incoming.length, 1);
      expect(c.allOrders.length, 1);
      c.dispose();
    });

    test('an unpaid order never reaches the kitchen (socket or poll)', () async {
      final c = make();
      await c.start();
      socket.emit('new_order_alert', orderJson(id: 'u1', paymentStatus: 'PENDING'));
      backend.onFetchOrders = (_, __) => ApiResult.success(OrdersPage(orders: [order(id: 'u2', paymentStatus: 'FAILED')]));
      await c.refresh();
      expect(c.allOrders, isEmpty);
      expect(alarm.ringing, isFalse);
      c.dispose();
    });

    test('a malformed socket event triggers a REST reload instead of a crash', () async {
      final c = make();
      await c.start();
      final before = backend.calls.where((x) => x == 'list:active').length;
      socket.emit('order_updated', {'nonsense': true});
      await Future<void>.delayed(Duration.zero);
      expect(backend.calls.where((x) => x == 'list:active').length, before + 1);
      c.dispose();
    });

    test('two waiting orders queue up; the alarm stops only when both are answered', () async {
      backend.put(order(id: 'o1', createdAt: DateTime.now().subtract(const Duration(minutes: 3))));
      backend.put(order(id: 'o2'));
      final c = make();
      await c.start();
      expect(c.incoming.map((o) => o.id), ['o1', 'o2']); // closest deadline first
      expect((await c.accept('o1')).ok, isTrue);
      expect(alarm.ringing, isTrue);
      expect((await c.reject('o2', 'Item out of stock')).ok, isTrue);
      expect(alarm.ringing, isFalse);
      c.dispose();
    });
  });

  group('accept / reject / cooking / ready', () {
    test('accept: PATCH ACCEPTED, the alarm stops, prep time is remembered', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      final out = await c.accept('o1', prepMinutes: 20);
      expect(out.ok, isTrue);
      expect(backend.calls, contains('status:o1:ACCEPTED'));
      expect(c.byId('o1')!.status, OrderStatus.accepted);
      expect(c.prepMinutesFor('o1'), 20);
      expect(alarm.ringing, isFalse);
      c.dispose();
    });

    test('while the accept call is on its way the alarm pauses and a second tap sends nothing', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      backend.gate = Completer<void>();
      final first = c.accept('o1');
      await Future<void>.delayed(Duration.zero);
      expect(c.isBusy('o1'), isTrue);
      expect(alarm.ringing, isFalse);
      expect((await c.accept('o1')).ignored, isTrue);
      backend.gate!.complete();
      expect((await first).ok, isTrue);
      expect(backend.calls.where((x) => x.startsWith('status:o1')).length, 1);
      c.dispose();
    });

    test('accept offline: nothing changes, the alarm rings again and the cook can retry', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.offline));
      final out = await c.accept('o1');
      expect(out.ok, isFalse);
      expect(out.failure, ApiFailure.offline);
      expect(c.byId('o1')!.isIncoming, isTrue);
      expect(alarm.ringing, isTrue);
      expect((await c.accept('o1')).ok, isTrue); // retry works
      c.dispose();
    });

    test('accept 409 because the customer cancelled meanwhile: re-read shows CANCELLED, alarm stops', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      backend.serverChange('o1', OrderStatus.cancelled, by: CancelledBy.customer);
      final out = await c.accept('o1');
      expect(out.ok, isFalse);
      expect(out.failure, ApiFailure.conflict);
      expect(out.current!.status, OrderStatus.cancelled);
      expect(out.current!.cancelledBy, CancelledBy.customer);
      expect(alarm.ringing, isFalse);
      expect(c.finished.single.id, 'o1');
      c.dispose();
    });

    test('accept times out but the server did accept: the re-read turns it into a success', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.timeout));
      backend.serverChange('o1', OrderStatus.accepted);
      final out = await c.accept('o1', prepMinutes: 10);
      expect(out.ok, isTrue);
      expect(c.byId('o1')!.status, OrderStatus.accepted);
      expect(c.prepMinutesFor('o1'), 10);
      c.dispose();
    });

    test('accept 403 PARTNER_NOT_APPROVED and 429 are reported, nothing changes', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.notApproved, code: 'PARTNER_NOT_APPROVED'));
      expect((await c.accept('o1')).failure, ApiFailure.notApproved);
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.rateLimited));
      expect((await c.accept('o1')).failure, ApiFailure.rateLimited);
      expect(c.byId('o1')!.isIncoming, isTrue);
      c.dispose();
    });

    test('reject sends the trimmed reason; a too-short reason is refused without a call', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      final bad = await c.reject('o1', '  x ');
      expect(bad.failure, ApiFailure.invalid);
      expect(backend.calls.where((x) => x.startsWith('reject')), isEmpty);
      final out = await c.reject('o1', '  Kitchen   is too busy  ');
      expect(out.ok, isTrue);
      expect(backend.calls, contains('reject:o1:Kitchen is too busy'));
      expect(c.byId('o1')!.status, OrderStatus.cancelled);
      expect(c.byId('o1')!.cancelledBy, CancelledBy.vendor);
      expect(alarm.ringing, isFalse);
      c.dispose();
    });

    test('start cooking shows PREPARING at once and rolls back when the server refuses', () async {
      backend.put(order(id: 'o1', status: 'ACCEPTED'));
      final c = make();
      await c.start();
      backend.gate = Completer<void>();
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.server));
      final f = c.startCooking('o1');
      await Future<void>.delayed(Duration.zero);
      expect(c.byId('o1')!.status, OrderStatus.preparing); // optimistic
      backend.gate!.complete();
      final out = await f;
      expect(out.ok, isFalse);
      expect(c.byId('o1')!.status, OrderStatus.accepted); // rolled back to the server's truth
      c.dispose();
    });

    test('cooking -> ready happy path', () async {
      backend.put(order(id: 'o1', status: 'ACCEPTED'));
      final c = make();
      await c.start();
      expect((await c.startCooking('o1')).ok, isTrue);
      expect(c.byId('o1')!.status, OrderStatus.preparing);
      expect((await c.markReady('o1')).ok, isTrue);
      expect(c.byId('o1')!.status, OrderStatus.readyForPickup);
      expect(backend.calls, containsAllInOrder(['status:o1:PREPARING', 'status:o1:READY_FOR_PICKUP']));
      c.dispose();
    });

    test('mark ready 400 (invalid transition): rollback and the server message is passed on', () async {
      backend.put(order(id: 'o1', status: 'PREPARING'));
      final c = make();
      await c.start();
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.invalid, message: 'Invalid transition'));
      final out = await c.markReady('o1');
      expect(out.failure, ApiFailure.invalid);
      expect(out.message, 'Invalid transition');
      expect(c.byId('o1')!.status, OrderStatus.preparing);
      c.dispose();
    });
  });

  group('sync and resilience', () {
    test('merge by updatedAt: an older poll copy never overwrites a newer socket copy', () async {
      final t0 = DateTime.now().toUtc().subtract(const Duration(minutes: 2));
      backend.onFetchOrders = (_, __) => ApiResult.success(OrdersPage(orders: [OrderModel.fromJson(orderJson(id: 'o1', status: 'ACCEPTED', createdAt: t0, updatedAt: t0))!]));
      final c = make();
      await c.start();
      socket.emit('order_updated', orderJson(id: 'o1', status: 'PREPARING', createdAt: t0, updatedAt: t0.add(const Duration(seconds: 40))));
      expect(c.byId('o1')!.status, OrderStatus.preparing);
      await c.refresh(); // stale list from a slow poll
      expect(c.byId('o1')!.status, OrderStatus.preparing);
      c.dispose();
    });

    test('a failed poll keeps the queue on screen and reports it; the next good poll clears it', () async {
      backend.put(order(id: 'o1', status: 'PREPARING'));
      final c = make();
      await c.start();
      backend.onFetchOrders = (_, __) => const ApiResult.failure(ApiFailure.offline);
      await c.refresh();
      expect(c.syncFailure, ApiFailure.offline);
      expect(c.kitchen.single.id, 'o1');
      backend.onFetchOrders = null;
      await c.refresh();
      expect(c.syncFailure, isNull);
      expect(c.lastSyncAt, isNotNull);
      c.dispose();
    });

    test('first load failing is not shown as "no orders": loadedOnce stays false', () async {
      backend.onFetchOrders = (_, __) => const ApiResult.failure(ApiFailure.server);
      final c = make();
      await c.start();
      expect(c.loadedOnce, isFalse);
      expect(c.syncFailure, ApiFailure.server);
      c.dispose();
    });

    test('the server auto-cancels an order nobody accepted: the alarm stops on the next poll', () async {
      backend.put(order(id: 'o1'));
      final c = make();
      await c.start();
      expect(alarm.ringing, isTrue);
      backend.serverChange('o1', OrderStatus.cancelled, by: CancelledBy.system, reason: 'Restaurant did not respond');
      await c.refresh();
      expect(alarm.ringing, isFalse);
      expect(c.byId('o1')!.cancelReason, 'Restaurant did not respond');
      c.dispose();
    });

    test('a live order missing from the list is re-read: 404 removes it, a network error keeps it', () async {
      backend.put(order(id: 'o1', status: 'PREPARING'));
      backend.put(order(id: 'o2', status: 'PREPARING'));
      final c = make();
      await c.start();
      backend.server.clear();
      backend.fetchOrderAnswers.addAll([const ApiResult.failure(ApiFailure.notFound), const ApiResult.failure(ApiFailure.offline)]);
      await c.refresh();
      expect(backend.calls.where((x) => x.startsWith('get:')).length, 2);
      expect(c.allOrders.length, 1); // one gone (server said 404), one kept (unknown)
      c.dispose();
    });

    test('a terminal order that leaves the active list stays in history', () async {
      backend.put(order(id: 'o1', status: 'DELIVERED'));
      final c = make();
      await c.start();
      backend.server.clear();
      await c.refresh();
      expect(c.finished.single.id, 'o1');
      expect(backend.calls.where((x) => x.startsWith('get:')), isEmpty);
      c.dispose();
    });

    test('restart: a new controller (app killed and reopened) reloads the queue and keeps prep times', () async {
      backend.put(order(id: 'o1'));
      backend.put(order(id: 'o2'));
      final first = make();
      await first.start();
      await first.accept('o1', prepMinutes: 30);
      await Future<void>.delayed(Duration.zero); // prefs write
      first.dispose();

      final again = make();
      await again.start();
      expect(again.byId('o1')!.status, OrderStatus.accepted);
      expect(again.prepMinutesFor('o1'), 30);
      expect(again.incoming.single.id, 'o2');
      expect(alarm.ringing, isTrue);
      again.dispose();
    });

    test('socket reconnect and app resume both reload from REST', () async {
      final c = make();
      await c.start();
      final before = backend.calls.where((x) => x == 'list:active').length;
      socket.open();
      await Future<void>.delayed(Duration.zero);
      await c.onResumed();
      expect(socket.ensureCalls, greaterThan(0));
      expect(backend.calls.where((x) => x == 'list:active').length, greaterThanOrEqualTo(before + 2));
      c.dispose();
    });

    test('the server refuses the restaurant room: live alerts shown as off, polling carries on; a later ok clears it', () async {
      final c = make();
      await c.start();
      socket.open();
      socket.answerJoin(false);
      expect(c.liveAlertsRefused, isTrue);
      backend.put(order(id: 'o1'));
      await c.refresh(); // the reload started by the reconnect
      await c.refresh(); // the next poll still brings the order
      expect(c.incoming.single.id, 'o1');
      socket.answerJoin(true);
      expect(c.liveAlertsRefused, isFalse);
      c.dispose();
    });

    test('server clock skew: countdowns follow the server Date header', () async {
      final serverNow = DateTime.now().add(const Duration(minutes: 5));
      backend.onFetchOrders = (_, __) => ApiResult.success(const OrdersPage(orders: []), serverTime: serverNow);
      final c = make();
      await c.start();
      expect(c.now().difference(serverNow).inSeconds.abs(), lessThan(3));
      c.dispose();
    });

    test('history pages load on demand and cover "today" for the earnings screen', () async {
      final now = DateTime.now();
      backend.history = [
        order(id: 'h1', status: 'DELIVERED', createdAt: now.subtract(const Duration(minutes: 1))),
        order(id: 'h2', status: 'DELIVERED', createdAt: now.subtract(const Duration(minutes: 2))),
        order(id: 'h3', status: 'CANCELLED', cancelledBy: 'CUSTOMER', createdAt: now.subtract(const Duration(days: 2))),
      ];
      final c = make();
      await c.start();
      final today = DateTime(now.year, now.month, now.day);
      expect(c.historyCovers(today), isFalse);
      await c.loadHistorySince(today);
      expect(c.historyCovers(today), isTrue);
      expect(c.finished.map((o) => o.id), containsAll(['h1', 'h2', 'h3']));
      expect(c.historyHasMore, isFalse);
      c.dispose();
    });
  });

  testWidgets('polls every 15 seconds and pokes the socket each tick; 429 pauses polling', (tester) async {
    final c = make(poll: const Duration(seconds: 15));
    c.start();
    await tester.pump();
    await tester.pump();
    int lists() => backend.calls.where((x) => x == 'list:active').length;
    final after = lists();
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    expect(lists(), after + 1);
    expect(socket.ensureCalls, 1);

    backend.onFetchOrders = (_, __) => const ApiResult.failure(ApiFailure.rateLimited, retryAfterSeconds: 60);
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    final limited = lists();
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    expect(lists(), limited); // paused
    c.dispose();
  });
}
