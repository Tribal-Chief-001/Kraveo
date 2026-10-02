import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'support/fakes.dart';
import 'support/signed_in.dart';

/// The whole restaurant app (session gate + home) against a fake Kraveo server and socket.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  late FakeBackend backend;
  late FakeAlarm alarm;
  late List<FakeSocket> sockets;

  setUp(() {
    mockSignedInPrefs();
    OrderQueueService.clearQueue();
    backend = FakeBackend();
    alarm = FakeAlarm();
    sockets = [];
  });

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> launch(WidgetTester tester) async {
    await tester.pumpWidget(KraveoVendorApp(
      auth: SignedInAuth(),
      backend: backend,
      socketFactory: () {
        final s = FakeSocket();
        sockets.add(s);
        return s;
      },
      alarm: alarm,
    ));
    await settle(tester);
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  }

  Future<void> tapButton(WidgetTester tester, String label) async {
    final f = find.widgetWithText(KButton, label);
    await tester.ensureVisible(f);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('real vendor id everywhere: queue, socket room, store status, menu', (tester) async {
    await launch(tester);
    expect(backend.calls, containsAll(['list:active', 'store:get:v1']));
    expect(sockets.single.vendorId, 'v1'); // the signed-in owner's restaurant, never a sample id
    expect(sockets.single.token, 'test-jwt');
    expect(find.text('No orders right now'), findsOneWidget);
    await unmount(tester);
    expect(sockets.single.disposed, isTrue);
  });

  testWidgets('a paid order arriving over the socket rings and opens the takeover; accept -> start cooking -> ready', (tester) async {
    await launch(tester);
    backend.put(order(id: 'ord-new'));
    sockets.single.emit('new_order_alert', orderJson(id: 'ord-new'));
    await settle(tester);
    expect(alarm.ringing, isTrue);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);

    await tapButton(tester, 'Accept');
    await settle(tester);
    expect(find.byType(IncomingOrderDialog), findsNothing);
    expect(alarm.ringing, isFalse);
    expect(backend.calls, contains('status:ord-new:ACCEPTED'));

    await tapButton(tester, 'Start cooking');
    expect(backend.calls, contains('status:ord-new:PREPARING'));
    await settle(tester);
    await tapButton(tester, 'Mark ready');
    expect(backend.calls, contains('status:ord-new:READY_FOR_PICKUP'));
    await settle(tester);
    expect(find.textContaining('Waiting for a runner'), findsOneWidget);

    // The runner claims it: the kitchen sees who is coming.
    backend.server['ord-new'] = order(id: 'ord-new', status: 'READY_FOR_PICKUP', updatedAt: DateTime.now().add(const Duration(minutes: 1)), driver: {'id': 'd1', 'name': 'Ramesh', 'phone': '+91 9876500000'});
    sockets.single.emit('order_updated', orderJson(id: 'ord-new', status: 'READY_FOR_PICKUP', updatedAt: DateTime.now().add(const Duration(minutes: 1)), driver: {'id': 'd1', 'name': 'Ramesh', 'phone': '+91 9876500000'}));
    await settle(tester);
    expect(find.text('Ramesh'), findsOneWidget);
    expect(find.text('+91 9876500000'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('mark ready fails: the card goes back to Cooking and the cook is told why', (tester) async {
    backend.put(order(id: 'ord-1', status: 'PREPARING'));
    await launch(tester);
    backend.statusAnswers.add(const ApiResult.failure(ApiFailure.offline));
    await tapButton(tester, 'Mark ready');
    await settle(tester);
    expect(find.widgetWithText(KButton, 'Mark ready'), findsOneWidget);
    expect(find.textContaining('No internet'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('app killed and reopened: the waiting order is reloaded and the takeover comes back', (tester) async {
    backend.put(order(id: 'ord-1'));
    await launch(tester);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    await unmount(tester);
    expect(alarm.ringing, isFalse); // nothing rings for a closed app's controller

    OrderQueueService.clearQueue();
    await launch(tester);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(alarm.ringing, isTrue);
    await unmount(tester);
  });

  testWidgets('resume from background reloads at once; a failed poll keeps the cards and shows a banner', (tester) async {
    backend.put(order(id: 'ord-1', status: 'PREPARING'));
    await launch(tester);
    final before = backend.calls.where((c) => c == 'list:active').length;
    for (final s in const [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
    backend.onFetchOrders = (_, __) => const ApiResult.failure(ApiFailure.offline);
    for (final s in const [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
    await settle(tester);
    expect(backend.calls.where((c) => c == 'list:active').length, greaterThan(before));
    expect(find.byKey(const ValueKey('sync-banner')), findsOneWidget);
    expect(find.widgetWithText(KButton, 'Mark ready'), findsOneWidget); // not wiped
    await unmount(tester);
  });

  testWidgets('closing the store fails on the server: the switch goes back to OPEN; live orders untouched', (tester) async {
    backend.put(order(id: 'ord-1', status: 'PREPARING'));
    await launch(tester);
    backend.storeAnswer = const ApiResult.failure(ApiFailure.offline);
    await tester.tap(find.text('OPEN'));
    await settle(tester);
    await tester.tap(find.widgetWithText(KButton, 'Yes, close store'));
    await settle(tester);
    expect(find.text('OPEN'), findsOneWidget);
    expect(find.textContaining('Could not close the store'), findsOneWidget);
    expect(find.widgetWithText(KButton, 'Mark ready'), findsOneWidget);
    expect(backend.calls.where((c) => c.startsWith('status:')), isEmpty);
    await unmount(tester);
  });

  testWidgets('an order cancelled while its takeover is open: message, then OK returns to the list', (tester) async {
    backend.put(order(id: 'ord-1'));
    await launch(tester);
    sockets.single.emit('order_updated', orderJson(id: 'ord-1', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'CUSTOMER', updatedAt: DateTime.now().add(const Duration(minutes: 1))));
    await settle(tester);
    expect(find.text('The customer cancelled this order.'), findsOneWidget);
    expect(alarm.ringing, isFalse);
    await tapButton(tester, 'OK');
    await settle(tester);
    expect(find.byType(IncomingOrderDialog), findsNothing);
    expect(find.text('No orders right now'), findsOneWidget);
    await unmount(tester);
  });
}
