import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/services/audio_alert_service.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
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

  group('Vendor App - OrderQueueService & OrderCard Tests', () {
    testWidgets('OrderQueueService handles duplicate orders and clearQueue', (WidgetTester tester) async {
      final testOrder = OrderModel(
        id: '#ORD-9999',
        studentName: 'Test Student',
        studentLocation: 'Block X',
        items: [],
        totalAmount: 100,
        createdAt: DateTime.now(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  OrderQueueService.enqueueIncomingOrder(context, testOrder, (_) {});
                  OrderQueueService.enqueueIncomingOrder(context, testOrder, (_) {});
                });
                return const Text('Queue Test');
              },
            ),
          ),
        ),
      );

      await tester.pump(const Duration(seconds: 3));
      expect(OrderQueueService.pendingCount, equals(1)); // 2nd order pending in queue
      OrderQueueService.clearQueue();
      expect(OrderQueueService.pendingCount, equals(0)); // Cleared
    });
  });

  Widget host(Widget child) => MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: child));

  OrderModel sampleOrder() => OrderModel(
        id: '#ORD-1234',
        studentName: 'Rahul Sharma',
        studentLocation: 'Block A',
        items: [OrderItem(name: 'Paneer Butter Masala', quantity: 1, unitPrice: 150)],
        totalAmount: 180,
        prepTimeMinutes: 15,
        createdAt: DateTime.now(),
        customerNote: 'No onions please',
      );

  group('Vendor App - IncomingOrderDialog Widget Test', () {
    testWidgets('Renders 64px CTAs and triggers ACCEPT callback', (WidgetTester tester) async {
      bool accepted = false;
      final testOrder = sampleOrder();

      await tester.pumpWidget(
        host(IncomingOrderDialog(
          order: testOrder,
          onAccept: (order) {
            accepted = true;
          },
          onDecline: () {},
        )),
      );

      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('New order'), findsOneWidget);
      expect(find.text('₹180'), findsOneWidget);
      expect(find.text('No onions please'), findsOneWidget);
      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);
      // Prep-time picks
      for (final t in ['10', '15', '20', '30']) {
        expect(find.text(t), findsOneWidget);
      }

      // Verify both big buttons are 64px tall
      final acceptBtnFinder = find.widgetWithText(KButton, 'Accept');
      expect(tester.getSize(acceptBtnFinder).height, equals(64.0));
      expect(tester.getSize(find.widgetWithText(KButton, 'Decline')).height, equals(64.0));

      // Pick 20 minutes, then tap ACCEPT
      await tester.tap(find.text('20'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(acceptBtnFinder);
      await tester.pump(const Duration(milliseconds: 100));

      expect(accepted, isTrue);
      expect(testOrder.prepTimeMinutes, equals(20));
      expect(testOrder.status, equals(OrderStatus.preparing));
      expect(AudioAlertService.isPlaying, isFalse);
    });

    testWidgets('DECLINE asks for confirmation before it declines', (WidgetTester tester) async {
      bool declined = false;
      await tester.pumpWidget(
        host(IncomingOrderDialog(order: sampleOrder(), onAccept: (_) {}, onDecline: () => declined = true)),
      );
      await tester.pump(const Duration(milliseconds: 100));

      await tester.tap(find.widgetWithText(KButton, 'Decline'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(declined, isFalse); // first tap only asks
      expect(find.text('Decline this order?'), findsOneWidget);

      // Going back returns to the normal buttons
      await tester.tap(find.widgetWithText(KButton, 'Go back'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Decline this order?'), findsNothing);
      expect(declined, isFalse);

      await tester.tap(find.widgetWithText(KButton, 'Decline'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.widgetWithText(KButton, 'Yes, decline'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(declined, isTrue);
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
    });
  });
}

