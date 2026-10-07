import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/screens/kitchen_queue.dart';
import 'package:vendor_app/services/failure_messages.dart';
import 'package:vendor_app/services/order_queue_controller.dart';
import 'package:vendor_app/services/push/push_background.dart';
import 'package:vendor_app/services/push/push_controller.dart';
import 'package:vendor_app/services/push/push_message.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/widgets/group_note.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'support/fakes.dart';
import 'support/group_fakes.dart';
import 'support/push_fakes.dart';

/// Combined (multi-restaurant) orders on the restaurant side (Docs/22 sections 4.5, 7, 10): the part's `group`
/// `{ size, allAccepted }`, the note, "Start cooking" off until every restaurant accepted, GROUP_WAITING, the
/// GROUP_READY_TO_COOK push. A restaurant never learns another restaurant's name, totals or customer prices.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  void phone(WidgetTester tester, {double textScale = 1.3}) {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
  }

  // Like the real app (main.dart): whatever the phone's font setting, the app draws text at most 1.3x. At a system setting
  // of 2x the screens therefore look like 1.3x; the new note is also checked at a REAL 2x on its own (see "GroupNote").
  Widget host(Widget child) => MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!),
        home: Scaffold(body: child),
      );

  group('model: OrderView.group for a restaurant', () {
    test('the real shape { size, allAccepted } is read; a single order has no group', () {
      final waiting = OrderModel.fromJson(groupedOrderJson(size: 3))!;
      expect(waiting.group!.size, 3);
      expect(waiting.group!.allAccepted, isFalse);
      expect(waiting.isGrouped, isTrue);
      expect(waiting.waitingForGroup, isTrue);
      final ready = OrderModel.fromJson(groupedOrderJson(allAccepted: true))!;
      expect(ready.group!.allAccepted, isTrue);
      expect(ready.waitingForGroup, isFalse);
      final single = order(id: 'solo', status: 'ACCEPTED');
      expect(single.group, isNull);
      expect(single.isGrouped, isFalse);
      expect(single.waitingForGroup, isFalse);
    });

    test('anything that is not a map with a real boolean allAccepted is read as "no group": a normal order is never blocked', () {
      for (final bad in <Object?>['x', 7, [], {}, {'size': 2}, {'size': 2, 'allAccepted': 'yes'}, {'size': 2, 'allAccepted': 1}, {'size': 2, 'allAccepted': null}]) {
        final j = orderJson(status: 'ACCEPTED')..['group'] = bad;
        final o = OrderModel.fromJson(j);
        expect(o, isNotNull, reason: '$bad');
        expect(o!.group, isNull, reason: '$bad');
        expect(o.waitingForGroup, isFalse, reason: '$bad');
      }
      final odd = OrderModel.fromJson(orderJson(status: 'ACCEPTED')..['group'] = {'size': 'many', 'allAccepted': true})!;
      expect(odd.group!.size, 2);
    });

    test('a finished or cancelled part does not wait for anybody', () {
      expect(groupedOrder(status: 'CANCELLED', paymentStatus: 'REFUNDED').waitingForGroup, isFalse);
      expect(groupedOrder(status: 'DELIVERED').waitingForGroup, isFalse);
    });

    test('an old copy that says "not all accepted" never undoes the news "all accepted" (same moment, same step)', () {
      final t = DateTime.now().toUtc();
      final accepted = groupedOrder(allAccepted: true, updatedAt: t);
      final stalePoll = groupedOrder(allAccepted: false, updatedAt: t);
      expect(accepted.isSupersededBy(stalePoll), isFalse);
      expect(groupedOrder(allAccepted: false, updatedAt: t).isSupersededBy(accepted), isTrue);
      // a really newer copy decides (e.g. the order moved on)
      expect(accepted.isSupersededBy(groupedOrder(status: 'PREPARING', allAccepted: false, updatedAt: t.add(const Duration(seconds: 5)))), isTrue);
    });

    test('nothing about another restaurant is kept, even if a server ever sent it', () {
      final j = groupedOrderJson();
      (j['group'] as Map)
        ..['id'] = 'grp-1'
        ..['stops'] = [
          {'orderId': 'x', 'vendor': {'name': 'Other Kitchen'}}
        ];
      j['groupId'] = 'grp-1';
      final o = OrderModel.fromJson(j)!;
      expect(o.group!.size, 2);
      expect(o.toString(), isNot(contains('Other Kitchen')));
    });
  });

  group('controller', () {
    late FakeBackend backend;
    late FakeSocket socket;

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      backend = FakeBackend();
      socket = FakeSocket();
    });

    test('the live update "all restaurants accepted" reaches the order; an older poll cannot undo it', () async {
      final t = DateTime.now().toUtc().subtract(const Duration(minutes: 2));
      backend.put(groupedOrder(updatedAt: t));
      final c = await startController(backend, socket: socket);
      expect(c.byId('ord-g1')!.group!.allAccepted, isFalse);
      socket.emit('order_updated', groupedOrderJson(allAccepted: true, updatedAt: t));
      expect(c.byId('ord-g1')!.group!.allAccepted, isTrue);
      await c.refresh(); // the server copy still says false for the same moment (a poll that started earlier)
      expect(c.byId('ord-g1')!.group!.allAccepted, isTrue);
      c.dispose();
    });

    test('GROUP_WAITING from the server: nothing starts, the answer carries the server text and code, the order is re-read', () async {
      backend.put(groupedOrder(allAccepted: true)); // this phone believes all accepted; the server says otherwise
      final c = await startController(backend, socket: socket);
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.conflict,
          statusCode: 409, code: 'GROUP_WAITING', message: 'Waiting for the other restaurant(s) in this combined order to accept.'));
      final out = await c.startCooking('ord-g1');
      expect(out.ok, isFalse);
      expect(out.code, 'GROUP_WAITING');
      expect(out.message, 'Waiting for the other restaurant(s) in this combined order to accept.');
      expect(c.byId('ord-g1')!.status, OrderStatus.accepted, reason: 'the optimistic "preparing" is rolled back');
      expect(backend.calls, contains('get:ord-g1'));
      c.dispose();
    });

    test('the controller does not decide "waiting" itself: the server is the authority (the button is what is disabled)', () async {
      backend.put(groupedOrder());
      final c = await startController(backend, socket: socket);
      final out = await c.startCooking('ord-g1');
      expect(backend.calls.where((x) => x.startsWith('status:')), ['status:ord-g1:PREPARING']);
      expect(out.ok, isTrue);
      c.dispose();
    });

    test('GROUP_WAITING is worded plainly, in the server\'s own sentence; without one the same sentence', () {
      const sentence = 'Waiting for the other restaurant(s) in this combined order to accept.';
      expect(failureText(ApiFailure.conflict, serverMessage: sentence, code: 'GROUP_WAITING').english, sentence);
      expect(failureText(ApiFailure.conflict, code: 'GROUP_WAITING').english, sentence);
      expect(failureText(ApiFailure.conflict, serverMessage: '   ', code: 'GROUP_WAITING').english, sentence);
      expect(failureText(ApiFailure.conflict, code: 'GROUP_WAITING').hindi, isNotEmpty);
    });
  });

  for (final scale in [1.3, 2.0]) {
    group('kitchen cards of a combined order at 360x640, text x$scale', () {
      late FakeBackend backend;
      late FakeSocket socket;

      setUp(() {
        SharedPreferences.setMockInitialValues({});
        backend = FakeBackend();
        socket = FakeSocket();
      });

      late OrderQueueController ctl;

      Future<void> pump(WidgetTester tester, FakeBackend b) async {
        phone(tester, textScale: scale);
        ctl = await startController(b, socket: socket);
        await tester.pumpWidget(host(KitchenQueueScreen(controller: ctl, onOpenIncoming: (_) {})));
        await tester.pump(const Duration(seconds: 1));
      }

      Future<void> done(WidgetTester tester) async {
        ctl.dispose();
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 1));
      }

      Future<void> show(WidgetTester tester, Finder f) async {
        await tester.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).last);
        await tester.pump(const Duration(milliseconds: 300));
      }

      testWidgets('waiting: the note is shown and "Start cooking" is off; tapping it sends nothing', (tester) async {
        backend.put(groupedOrder());
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('start-ord-g1')));
        expect(find.byKey(const ValueKey('group-note-ord-g1')), findsOneWidget);
        expect(find.text(GroupNote.waitingEnglish), findsOneWidget);
        expect(find.text(GroupNote.acceptedEnglish), findsNothing);
        expect(tester.widget<KButton>(find.byKey(const ValueKey('start-ord-g1'))).onPressed, isNull);
        await tester.tap(find.byKey(const ValueKey('start-ord-g1')), warnIfMissed: false);
        await tester.pump();
        expect(backend.calls.where((x) => x.startsWith('status:')), isEmpty);
        expect(tester.takeException(), isNull);
        await done(tester);
      });

      testWidgets('all accepted: "All restaurants accepted" and "Start cooking" works; a double tap sends ONE request', (tester) async {
        backend.put(groupedOrder(allAccepted: true));
        backend.gate = Completer<void>(); // the request is "on its way" while the second tap lands
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('start-ord-g1')));
        expect(find.text(GroupNote.acceptedEnglish), findsOneWidget);
        expect(find.text(GroupNote.waitingEnglish), findsNothing);
        final button = find.byKey(const ValueKey('start-ord-g1'));
        expect(tester.widget<KButton>(button).onPressed, isNotNull);
        await tester.tap(button);
        await tester.tap(button, warnIfMissed: false);
        await tester.pump(const Duration(milliseconds: 300));
        expect(backend.calls.where((x) => x.startsWith('status:')), ['status:ord-g1:PREPARING']);
        backend.gate!.complete();
        await tester.pump(const Duration(milliseconds: 600));
        expect(backend.calls.where((x) => x.startsWith('status:')), ['status:ord-g1:PREPARING']);
        expect(tester.takeException(), isNull);
        await done(tester);
      });

      testWidgets('the live update switches the note and the button on without a reload', (tester) async {
        final t = DateTime.now().toUtc().subtract(const Duration(minutes: 1));
        backend.put(groupedOrder(updatedAt: t));
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('start-ord-g1')));
        expect(tester.widget<KButton>(find.byKey(const ValueKey('start-ord-g1'))).onPressed, isNull);
        socket.emit('order_updated', groupedOrderJson(allAccepted: true, updatedAt: t));
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text(GroupNote.acceptedEnglish), findsOneWidget);
        expect(tester.widget<KButton>(find.byKey(const ValueKey('start-ord-g1'))).onPressed, isNotNull);
        expect(tester.takeException(), isNull);
        await done(tester);
      });

      testWidgets('the server still answers 409 GROUP_WAITING: its sentence is shown plainly', (tester) async {
        backend.put(groupedOrder(allAccepted: true));
        backend.statusAnswers.add(const ApiResult.failure(ApiFailure.conflict,
            statusCode: 409, code: 'GROUP_WAITING', message: 'Waiting for the other restaurant(s) in this combined order to accept.'));
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('start-ord-g1')));
        await tester.tap(find.byKey(const ValueKey('start-ord-g1')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.textContaining('Waiting for the other restaurant(s) in this combined order to accept.'), findsWidgets);
        expect(find.textContaining('order changed meanwhile'), findsNothing);
        expect(tester.takeException(), isNull);
        await done(tester);
      });

      testWidgets('a single-restaurant order has no note and a working "Start cooking" (unchanged)', (tester) async {
        backend.put(order(id: 'solo-1', status: 'ACCEPTED'));
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('start-solo-1')));
        expect(find.byType(GroupNote), findsNothing);
        expect(find.byKey(const ValueKey('group-note-solo-1')), findsNothing);
        expect(find.textContaining('Combined order'), findsNothing);
        expect(tester.widget<KButton>(find.byKey(const ValueKey('start-solo-1'))).onPressed, isNotNull);
        await done(tester);
      });

      testWidgets('cooking and ready parts show the note too; no other restaurant is ever named', (tester) async {
        backend
          ..put(groupedOrder(id: 'ord-g2', status: 'PREPARING', allAccepted: true))
          ..put(groupedOrder(id: 'ord-g3', status: 'READY_FOR_PICKUP', allAccepted: true));
        await pump(tester, backend);
        await show(tester, find.byKey(const ValueKey('group-note-ord-g2')));
        expect(find.byKey(const ValueKey('group-note-ord-g2')), findsOneWidget);
        await show(tester, find.byKey(const ValueKey('group-note-ord-g3')));
        expect(find.byKey(const ValueKey('group-note-ord-g3')), findsOneWidget);
        expect(find.text(GroupNote.acceptedEnglish), findsAtLeastNWidgets(1));
        expect(find.textContaining('Kitchen'), findsNothing);
        expect(tester.takeException(), isNull);
        await done(tester);
      });

      testWidgets('a part cancelled because another restaurant could not take it shows the server\'s reason, and no waiting note', (tester) async {
        backend.put(groupedOrder(id: 'ord-g9', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'SYSTEM', cancelReason: 'Another restaurant in your order could not take it'));
        phone(tester, textScale: scale);
        final c = await startController(backend, socket: socket);
        ctl = c;
        await tester.pumpWidget(host(KitchenQueueScreen(controller: c)));
        await tester.pump(const Duration(seconds: 1));
        await tester.tap(find.text('History'));
        await tester.pump(const Duration(seconds: 1));
        await show(tester, find.textContaining('Another restaurant in your order could not take it'));
        expect(find.textContaining('Reason: Another restaurant in your order could not take it'), findsOneWidget);
        expect(find.byKey(const ValueKey('group-note-ord-g9')), findsNothing);
        expect(tester.takeException(), isNull);
        await done(tester);
      });
    });
  }

  for (final scale in [1.3, 2.0]) {
    testWidgets('GroupNote alone at 360 px wide and a real ${scale}x text (no clamp): both states fit', (tester) async {
      phone(tester, textScale: scale);
      for (final all in [false, true]) {
        await tester.pumpWidget(MaterialApp(
          theme: KraveoTheme.vendor(),
          home: Scaffold(body: Padding(padding: const EdgeInsets.all(16), child: GroupNote(order: groupedOrder(allAccepted: all)))),
        ));
        await tester.pump();
        expect(find.text(all ? GroupNote.acceptedEnglish : GroupNote.waitingEnglish), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: GroupNote(order: order(id: 'solo')))));
      expect(find.byType(Container), findsNothing);
    });

    testWidgets('incoming order takeover of a combined order at 360x640, text x$scale: the note is there, the buttons stay reachable', (tester) async {
      phone(tester, textScale: scale);
      SharedPreferences.setMockInitialValues({});
      final c = await startController(FakeBackend()..put(groupedOrder(id: 'ord-in', status: 'PLACED')));
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-in', controller: c)));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byKey(const ValueKey('group-note-ord-in')), findsOneWidget);
      expect(find.text(GroupNote.waitingEnglish), findsOneWidget);
      final accept = tester.getRect(find.widgetWithText(KButton, 'Accept'));
      expect(accept.bottom, lessThanOrEqualTo(640));
      expect(tester.takeException(), isNull);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  }

  group('push GROUP_READY_TO_COOK', () {
    test('is a known, actionable event with the order id', () {
      final m = PushMessage.fromData({'event': 'GROUP_READY_TO_COOK', 'orderId': 'ord-9', 'v': '1'});
      expect(m.event, PushEvent.groupReadyToCook);
      expect(m.isActionable, isTrue);
      expect(PushMessage.fromData({'event': 'GROUP_READY_TO_COOK'}).isActionable, isFalse);
    });

    test('data-only in the background: a quiet update with the push text (or the contract text), never the loud alarm', () async {
      final n = FakeNotifications();
      await showBackgroundPush(
          PushMessage.fromData({'event': 'GROUP_READY_TO_COOK', 'orderId': 'ord-9'}, title: 'Start cooking', body: 'All restaurants accepted - you can start cooking.'), n);
      expect(n.shown, ['update:ord-9']);
      final n2 = FakeNotifications();
      await showBackgroundPush(PushMessage.fromData({'event': 'GROUP_READY_TO_COOK', 'orderId': 'ord-9'}, hasNotificationBlock: true), n2);
      expect(n2.shown, isEmpty, reason: 'Android shows a push that carries a notification block');
    });

    group('routing', () {
      late FakePushMessaging messaging;
      late PushController push;
      late List<PushAction> seen;

      setUp(() async {
        SharedPreferences.setMockInitialValues({});
        messaging = FakePushMessaging();
        push = PushController(
          messaging: messaging,
          notifications: FakeNotifications(),
          permissions: FakePermissions(),
          registry: FakeRegistry(),
          appVersion: () async => '1.5.0+9',
          retryDelays: const [],
        );
        seen = [];
        await push.onSignedIn('u1');
        push.attachHome(seen.add);
      });

      tearDown(() => push.dispose());

      PushMessage msg() => PushMessage.fromData({'event': 'GROUP_READY_TO_COOK', 'orderId': 'ord-9', 'v': '1'});

      test('in the foreground it reloads the order list (a refresh), no second sound', () async {
        messaging.foreground.add(msg());
        await Future<void>.delayed(Duration.zero);
        expect(seen.map((a) => a.kind), [PushActionKind.refreshOrders]);
      });

      test('a tap opens the kitchen queue (where the order\'s "Start cooking" is now on)', () async {
        messaging.opened.add(msg());
        await Future<void>.delayed(Duration.zero);
        expect(seen.single.kind, PushActionKind.showQueue);
      });
    });
  });
}
