import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/services/audio_alert_service.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/stock_card.dart';

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

  group('Vendor App - IncomingOrderDialog Widget Test', () {
    testWidgets('Renders 64px CTAs and triggers ACCEPT callback', (WidgetTester tester) async {
      bool accepted = false;
      final testOrder = OrderModel(
        id: '#ORD-1234',
        studentName: 'Rahul Sharma',
        studentLocation: 'Block A',
        items: [OrderItem(name: 'Paneer Butter Masala', quantity: 1, unitPrice: 180)],
        totalAmount: 180,
        prepTimeMinutes: 15,
        createdAt: DateTime.now(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: IncomingOrderDialog(
              orderPayload: testOrder,
              onAccept: (order) {
                accepted = true;
              },
            ),
          ),
        ),
      );

      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('NEW ORDER ARRIVED!'), findsOneWidget);
      expect(find.text('DECLINE'), findsOneWidget);
      expect(find.textContaining('ACCEPT'), findsOneWidget);

      // Verify button height is 64px
      final acceptBtnFinder = find.widgetWithText(ElevatedButton, 'ACCEPT (15M)');
      final Size btnSize = tester.getSize(acceptBtnFinder);
      expect(btnSize.height, equals(64.0));

      // Tap ACCEPT
      await tester.tap(acceptBtnFinder);
      await tester.pump(const Duration(milliseconds: 100));

      expect(accepted, isTrue);
      expect(AudioAlertService.isPlaying, isFalse);
    });
  });

  group('Vendor App - StockCard Widget Test', () {
    testWidgets('StockCard price steppers and IN STOCK toggle work correctly', (WidgetTester tester) async {
      double currentPrice = 180.0;
      bool inStock = true;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
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
        ),
      );

      expect(find.text('₹180'), findsOneWidget);
      expect(find.text('IN STOCK'), findsOneWidget);

      // Tap +10 price stepper icon
      await tester.tap(find.byTooltip('+10 Price'));
      await tester.pump();
      expect(currentPrice, equals(190.0));
      expect(find.text('₹190'), findsOneWidget);

      // Tap -10 price stepper icon
      await tester.tap(find.byTooltip('-10 Price'));
      await tester.pump();
      expect(currentPrice, equals(180.0));
      expect(find.text('₹180'), findsOneWidget);

      // Tap IN STOCK toggle
      await tester.tap(find.text('IN STOCK'));
      await tester.pump();
      expect(inStock, isFalse);
      expect(find.text('SOLD OUT'), findsOneWidget);
    });
  });
}
