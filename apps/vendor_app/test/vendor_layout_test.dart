import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/screens/kitchen_queue.dart';
import 'package:vendor_app/screens/sales_analytics.dart';
import 'package:vendor_app/screens/stock_manager.dart';
import 'package:vendor_app/widgets/add_dish_modal.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/order_card.dart';

/// The vendor app must survive the smallest phone we support (360x640) at 1.3x system
/// font scale: Flutter reports any RenderFlex overflow as a test failure, so simply
/// pumping each screen is the assertion.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        MethodChannel(ch),
        (MethodCall methodCall) async => null,
      );
    }
  });

  void smallPhone(WidgetTester tester, {double textScale = 1.3}) {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
  }

  Widget host(Widget child) => MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!),
        home: Scaffold(body: child),
      );

  OrderModel order({String? note, int items = 3, int minutesAgo = 2, int prep = 15, OrderStatus status = OrderStatus.preparing}) => OrderModel(
        id: '#ord-${1000 + items}',
        studentName: 'Rahul Sharma',
        studentLocation: 'Hostel Block A, R-304, Near the North Gate',
        items: [
          for (var i = 0; i < items; i++) OrderItem(name: 'Paneer Butter Masala Special Thali $i', quantity: i + 1, unitPrice: 180),
        ],
        totalAmount: 1260,
        prepTimeMinutes: prep,
        createdAt: DateTime.now().subtract(Duration(minutes: minutesAgo)),
        customerNote: note,
        status: status,
      );

  for (final scale in [1.0, 1.3]) {
    group('no overflow at 360x640, text x$scale', () {
      testWidgets('vendor home: Orders, Menu and Earnings tabs', (tester) async {
        smallPhone(tester, textScale: scale);
        await tester.pumpWidget(const KraveoVendorApp());
        await tester.pump(const Duration(seconds: 1));

        expect(find.text('OPEN'), findsOneWidget);
        expect(find.text('Orders'), findsOneWidget);
        await tester.tap(find.text('Menu'));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('In stock'), findsOneWidget);
        await tester.tap(find.text('Earnings'));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text("TODAY'S EARNINGS"), findsOneWidget);

        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 6));
      });

      testWidgets('incoming order takeover with a long note and many items', (tester) async {
        smallPhone(tester, textScale: scale);
        await tester.pumpWidget(host(IncomingOrderDialog(
          order: order(note: 'Please make it extra spicy, no onions and pack the curd separately', items: 6),
          onAccept: (_) {},
          onDecline: () {},
        )));
        await tester.pump(const Duration(milliseconds: 500));
        // The buttons stay reachable on-screen.
        final accept = tester.getRect(find.widgetWithText(KButton, 'Accept'));
        expect(accept.bottom, lessThanOrEqualTo(640));
        // ... and so does the confirm step.
        await tester.tap(find.widgetWithText(KButton, 'Decline'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(tester.getRect(find.widgetWithText(KButton, 'Yes, decline')).bottom, lessThanOrEqualTo(640));
      });

      testWidgets('incoming order takeover in landscape (short screen) scrolls instead of overflowing', (tester) async {
        tester.view.physicalSize = const Size(640, 360);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
          tester.platformDispatcher.clearTextScaleFactorTestValue();
        });
        await tester.pumpWidget(host(IncomingOrderDialog(order: order(note: 'No onions', items: 4), onAccept: (_) {}, onDecline: () {})));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.scrollUntilVisible(find.widgetWithText(KButton, 'Accept'), 200, scrollable: find.byType(Scrollable).first);
        expect(find.widgetWithText(KButton, 'Accept'), findsOneWidget);
      });

      testWidgets('kitchen queue cards: cooking, late, ready, history', (tester) async {
        smallPhone(tester, textScale: scale);
        final orders = [
          order(note: 'Extra spicy', items: 3),
          order(items: 2, minutesAgo: 30, prep: 10), // late
          order(items: 1, status: OrderStatus.readyForPickup),
          order(items: 4, status: OrderStatus.pickedUp),
        ];
        await tester.pumpWidget(host(KitchenQueueScreen(orders: orders, onOrderUpdate: () {})));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('LATE'), findsOneWidget);
        // Most urgent (the late one) is listed before the on-time one.
        expect(tester.widget<OrderCard>(find.byType(OrderCard).first).order.id, '#ord-1002');
        await tester.tap(find.text('History'));
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(host(KitchenQueueScreen(orders: const [], onOrderUpdate: () {})));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KEmptyState), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('stock manager list and the add-dish sheet', (tester) async {
        smallPhone(tester, textScale: scale);
        final dishes = [
          DishModel(id: 'd1', name: 'Paneer Butter Masala With Extra Long Name', category: 'Main Course', price: 180),
          DishModel(id: 'd2', name: 'Mango Lassi', category: 'Beverages', price: 60, inStock: false),
        ];
        await tester.pumpWidget(host(StockManagerScreen(dishes: dishes, onDishListChanged: () {})));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('SOLD OUT'), findsOneWidget);

        await tester.tap(find.bySemanticsLabel('Add a new dish'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(AddDishModal), findsOneWidget);
        expect(find.widgetWithText(KButton, 'Add to menu'), findsOneWidget);
      });

      testWidgets('earnings: empty state, then real numbers', (tester) async {
        smallPhone(tester, textScale: scale);
        await tester.pumpWidget(host(const SalesAnalyticsScreen(orders: [])));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KEmptyState), findsOneWidget);

        await tester.pumpWidget(host(SalesAnalyticsScreen(orders: [order(items: 2), order(items: 3), order(items: 1)])));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KStatTile), findsNWidgets(3));
        expect(find.textContaining('Most orders come'), findsOneWidget);
      });
    });
  }

  testWidgets('closing the store asks first; opening does not', (tester) async {
    smallPhone(tester, textScale: 1.0);
    await tester.pumpWidget(const KraveoVendorApp());
    await tester.pump(const Duration(seconds: 1));

    await tester.tap(find.text('OPEN'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Close the store?'), findsOneWidget);

    // "Keep open" leaves the store open
    await tester.tap(find.widgetWithText(KButton, 'Keep open'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('OPEN'), findsOneWidget);
    expect(find.text('CLOSED'), findsNothing);

    // Confirm closes it
    await tester.tap(find.text('OPEN'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.widgetWithText(KButton, 'Yes, close store'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('CLOSED'), findsOneWidget);

    // Opening again is one tap, no confirm
    await tester.tap(find.text('CLOSED'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('OPEN'), findsOneWidget);
    expect(find.text('Close the store?'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });
}
