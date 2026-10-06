import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/services/audio_alert_service.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fakes.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/stock_card.dart';
import 'package:vendor_app/widgets/ui/ui.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('xyz.luan/audioplayers.global'),
      (MethodCall methodCall) async => null,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('xyz.luan/audioplayers'),
      (MethodCall methodCall) async => null,
    );
  });

  group('Vendor App - AudioAlertService Tests', () {
    test('startLoudAlarm and stopAlarm manage alarm flag correctly', () async {
      await AudioAlertService.startLoudAlarm();
      expect(AudioAlertService.isPlaying, isTrue);
      await AudioAlertService.stopAlarm();
      expect(AudioAlertService.isPlaying, isFalse);
    });
  });

  group('Vendor App - OrderQueueService', () {
    testWidgets('one takeover per order: duplicates are ignored, the next order opens when the first closes', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final backend = FakeBackend()
        ..put(order(id: 'ord-1'))
        ..put(order(id: 'ord-2'));
      final c = await startController(backend);
      late BuildContext ctx;
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: Builder(builder: (context) {
        ctx = context;
        return const Text('Queue Test');
      }))));
      OrderQueueService.enqueueIncomingOrder(ctx, 'ord-1', c);
      OrderQueueService.enqueueIncomingOrder(ctx, 'ord-1', c);
      OrderQueueService.enqueueIncomingOrder(ctx, 'ord-2', c);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(IncomingOrderDialog), findsOneWidget);
      expect(OrderQueueService.showingOrderId, 'ord-1');
      expect(OrderQueueService.pendingCount, equals(1)); // ord-2 waits, the duplicate was dropped

      // ord-1 is answered elsewhere: the takeover explains it; OK opens ord-2.
      backend.serverChange('ord-1', OrderStatus.cancelled, by: CancelledBy.customer);
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('The customer cancelled this order.'), findsOneWidget);
      await tester.tap(find.widgetWithText(KButton, 'OK'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(OrderQueueService.showingOrderId, 'ord-2');

      OrderQueueService.clearQueue();
      expect(OrderQueueService.pendingCount, equals(0));
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });

  Widget host(Widget child) => MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: child));

  group('Vendor App - IncomingOrderDialog Widget Test', () {
    testWidgets('Renders 64px CTAs, the answer countdown, and ACCEPT sends ACCEPTED with the chosen prep time', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final alarm = FakeAlarm();
      final backend = FakeBackend()..put(order(id: 'ord-1234', notes: 'No onions please', items: [{'id': 'i1', 'name': 'Paneer Butter Masala', 'quantity': 1, 'price': 150.0}]));
      final c = await startController(backend, alarm: alarm);
      expect(alarm.ringing, isTrue);

      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1234', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('New order'), findsOneWidget);
      expect(find.text('₹205'), findsOneWidget, reason: 'the restaurant sees what it earns, not the customer total');
      expect(find.text('₹245'), findsNothing);
      expect(find.text('No onions please'), findsOneWidget);
      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);
      expect(find.byKey(const ValueKey('accept-countdown')), findsOneWidget);
      expect(find.textContaining('to answer'), findsOneWidget);
      for (final t in ['10', '15', '20', '30']) {
        expect(find.text(t), findsOneWidget);
      }

      final acceptBtnFinder = find.widgetWithText(KButton, 'Accept');
      expect(tester.getSize(acceptBtnFinder).height, equals(64.0));
      expect(tester.getSize(find.widgetWithText(KButton, 'Decline')).height, equals(64.0));

      await tester.tap(find.text('20'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(acceptBtnFinder);
      await tester.pump(const Duration(milliseconds: 100));

      expect(backend.calls, contains('status:ord-1234:ACCEPTED'));
      expect(c.byId('ord-1234')!.status, OrderStatus.accepted);
      expect(c.prepMinutesFor('ord-1234'), equals(20));
      expect(alarm.ringing, isFalse);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('DECLINE needs a reason before it declines, and sends that reason', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final backend = FakeBackend()..put(order(id: 'ord-1'));
      final c = await startController(backend);
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));

      await tester.tap(find.widgetWithText(KButton, 'Decline'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Decline this order?'), findsOneWidget);
      expect(find.text('Why are you rejecting?'), findsOneWidget);
      // No reason picked yet: the red button does nothing.
      await tester.tap(find.widgetWithText(KButton, 'Yes, decline'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(backend.calls.where((x) => x.startsWith('reject')), isEmpty);

      // Going back returns to the normal buttons
      await tester.tap(find.widgetWithText(KButton, 'Go back'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Decline this order?'), findsNothing);

      await tester.tap(find.widgetWithText(KButton, 'Decline'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text('Item out of stock'));
      await tester.pump();
      await tester.tap(find.widgetWithText(KButton, 'Yes, decline'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(backend.calls, contains('reject:ord-1:Item out of stock'));
      expect(c.byId('ord-1')!.cancelledBy, CancelledBy.vendor);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('"Other reason" needs at least 3 letters', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final backend = FakeBackend()..put(order(id: 'ord-1'));
      final c = await startController(backend);
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.widgetWithText(KButton, 'Decline'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.ensureVisible(find.text('Other reason'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text('Other reason'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(find.byKey(const ValueKey('reject-other-field')), 'no');
      await tester.pump();
      await tester.tap(find.widgetWithText(KButton, 'Yes, decline'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(backend.calls.where((x) => x.startsWith('reject')), isEmpty);
      await tester.enterText(find.byKey(const ValueKey('reject-other-field')), 'Gas cylinder finished');
      await tester.pump();
      await tester.tap(find.widgetWithText(KButton, 'Yes, decline'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(backend.calls, contains('reject:ord-1:Gas cylinder finished'));
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a failed accept shows why, keeps the buttons, and a retry succeeds', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final alarm = FakeAlarm();
      final backend = FakeBackend()..put(order(id: 'ord-1'));
      final c = await startController(backend, alarm: alarm);
      backend.statusAnswers.add(const ApiResult.failure(ApiFailure.offline));
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.widgetWithText(KButton, 'Accept'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining('No internet'), findsOneWidget);
      expect(alarm.ringing, isTrue); // still waiting for an answer
      await tester.tap(find.widgetWithText(KButton, 'Accept'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(c.byId('ord-1')!.status, OrderStatus.accepted);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the order is cancelled while the takeover is open: clear message, alarm silent', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final alarm = FakeAlarm();
      final backend = FakeBackend()..put(order(id: 'ord-1'));
      final c = await startController(backend, alarm: alarm);
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));
      backend.serverChange('ord-1', OrderStatus.cancelled, by: CancelledBy.system, reason: 'Restaurant did not respond');
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Cancelled: not accepted within 10 minutes.'), findsOneWidget);
      expect(find.text('Accept'), findsNothing);
      expect(alarm.ringing, isFalse);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the order vanishes (server 404) while open: "no longer available"', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final backend = FakeBackend()..put(order(id: 'ord-1'));
      final c = await startController(backend);
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 100));
      backend.server.clear();
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('This order is no longer available.'), findsOneWidget);
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Vendor App - StockCard Widget Test', () {
    testWidgets('StockCard price steppers and IN STOCK toggle work correctly', (WidgetTester tester) async {
      double currentPrice = 180.0;
      bool inStock = true;

      await tester.pumpWidget(
        host(
          StatefulBuilder(
            builder: (context, setState) {
              final testDish = DishModel(
                id: 'dish-1',
                name: 'Paneer Butter Masala',
                price: currentPrice,
                category: 'North Indian',
                inStock: inStock,
              );

              return StockCard(
                dish: testDish,
                onToggleStock: () {
                  setState(() {
                    inStock = !inStock;
                  });
                },
                onUpdatePrice: (newPrice) {
                  setState(() {
                    currentPrice = newPrice;
                  });
                },
              );
            },
          ),
        ),
      );

      expect(find.text('₹180'), findsOneWidget);
      expect(find.text('IN STOCK'), findsOneWidget);
      // 64px targets for the stepper and the stock switch
      expect(tester.getSize(find.byKey(const ValueKey('price-plus'))).height, equals(64.0));
      expect(tester.getSize(find.byType(VStockSwitch)).height, equals(64.0));

      // Tap +10 price stepper
      await tester.tap(find.byKey(const ValueKey('price-plus')));
      await tester.pump();
      expect(currentPrice, equals(190.0));
      expect(find.text('₹190'), findsOneWidget);

      // Tap -10 price stepper
      await tester.tap(find.byKey(const ValueKey('price-minus')));
      await tester.pump();
      expect(currentPrice, equals(180.0));
      expect(find.text('₹180'), findsOneWidget);

      // Tap the big switch: IN STOCK -> SOLD OUT
      await tester.tap(find.byType(VStockSwitch));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(inStock, isFalse);
      expect(find.text('SOLD OUT'), findsOneWidget);
    });
  });

  group('Vendor App - OrderQueueService Unit Test', () {
    test('OrderQueueService handles clearQueue and queue count', () {
      OrderQueueService.clearQueue();
      expect(OrderQueueService.pendingCount, equals(0));
      expect(OrderQueueService.isShowingDialog, isFalse);
    });
  });
}

