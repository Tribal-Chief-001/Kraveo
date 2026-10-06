import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/services/menu_stock_controller.dart';
import 'support/fakes.dart';
import 'package:vendor_app/screens/kitchen_queue.dart';
import 'package:vendor_app/screens/sales_analytics.dart';
import 'package:vendor_app/screens/stock_manager.dart';
import 'package:vendor_app/widgets/add_dish_modal.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'support/signed_in.dart';

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

  List<Map<String, dynamic>> longItems(int n) => [
        for (var i = 0; i < n; i++) {'id': 'i$i', 'name': 'Paneer Butter Masala Special Thali $i', 'quantity': i + 1, 'price': 180.0},
      ];

  /// A fake Kraveo with one order in every state the kitchen sees, plus today's finished ones.
  FakeBackend busyKitchen() {
    final now = DateTime.now();
    return FakeBackend()
      ..put(order(id: 'ord-0001', status: 'ACCEPTED', items: longItems(2), notes: 'Extra spicy'))
      ..put(order(id: 'ord-1002', status: 'PREPARING', items: longItems(2), createdAt: now.subtract(const Duration(minutes: 40))))
      ..put(order(id: 'ord-1003', status: 'PREPARING', items: longItems(3)))
      ..put(order(id: 'ord-1004', status: 'READY_FOR_PICKUP', items: longItems(1), driver: {'id': 'd1', 'name': 'Ramesh Kumar Yadav', 'phone': '+91 9876500000'}))
      ..put(order(id: 'ord-1005', status: 'READY_FOR_PICKUP', items: longItems(1)))
      ..put(order(id: 'ord-1006', status: 'PICKED_UP', items: longItems(4)))
      ..put(order(id: 'ord-1007', status: 'DELIVERED', items: longItems(2)))
      ..put(order(id: 'ord-1008', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'SYSTEM', cancelReason: 'Restaurant did not respond'));
  }

  for (final scale in [1.0, 1.3]) {
    group('no overflow at 360x640, text x$scale', () {
      testWidgets('vendor home: Orders, Menu and Earnings tabs', (tester) async {
        smallPhone(tester, textScale: scale);
        mockSignedInPrefs();
        await tester.pumpWidget(KraveoVendorApp(auth: SignedInAuth(), backend: busyKitchen(), socketFactory: FakeSocket.new, alarm: FakeAlarm()));
        await tester.pump();
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
        SharedPreferences.setMockInitialValues({});
        final c = await startController(FakeBackend()..put(order(id: 'ord-1', notes: 'Please make it extra spicy, no onions and pack the curd separately', items: longItems(6))));
        await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
        await tester.pump(const Duration(milliseconds: 500));
        // The buttons stay reachable on-screen.
        final accept = tester.getRect(find.widgetWithText(KButton, 'Accept'));
        expect(accept.bottom, lessThanOrEqualTo(640));
        // ... and so does the confirm step.
        await tester.tap(find.widgetWithText(KButton, 'Decline'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(tester.getRect(find.widgetWithText(KButton, 'Yes, decline')).bottom, lessThanOrEqualTo(640));
        // The reason list scrolls above the pinned buttons; picking "Other" shows the text box.
        await tester.ensureVisible(find.text('Other reason'));
        await tester.pump(const Duration(milliseconds: 400));
        await tester.tap(find.text('Other reason'));
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byKey(const ValueKey('reject-other-field')), findsOneWidget);
        c.dispose();
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('takeover "gone" screen after the order was cancelled', (tester) async {
        smallPhone(tester, textScale: scale);
        SharedPreferences.setMockInitialValues({});
        final backend = FakeBackend()..put(order(id: 'ord-1'));
        final c = await startController(backend);
        await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
        backend.serverChange('ord-1', OrderStatus.cancelled, by: CancelledBy.admin, reason: 'Customer called support to cancel this order because of a mistake');
        await c.refresh();
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.text('Kraveo cancelled this order.'), findsOneWidget);
        c.dispose();
        await tester.pumpWidget(const SizedBox());
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
        SharedPreferences.setMockInitialValues({});
        final c = await startController(FakeBackend()..put(order(id: 'ord-1', notes: 'No onions', items: longItems(4))));
        await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.scrollUntilVisible(find.widgetWithText(KButton, 'Accept'), 200, scrollable: find.byType(Scrollable).first);
        expect(find.widgetWithText(KButton, 'Accept'), findsOneWidget);
        c.dispose();
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('kitchen queue cards: new, accepted, cooking, late, ready (with and without runner), history', (tester) async {
        smallPhone(tester, textScale: scale);
        SharedPreferences.setMockInitialValues({});
        final c = await startController(busyKitchen()..put(order(id: 'ord-0009')));
        await tester.pumpWidget(host(KitchenQueueScreen(controller: c, onOpenIncoming: (_) {})));
        await tester.pump(const Duration(seconds: 1));
        expect(find.textContaining('New orders', findRichText: true), findsOneWidget);
        // Most urgent cooking order (the late one) is listed before the on-time one.
        final lateCard = find.byKey(const ValueKey('ord-1002'));
        await tester.scrollUntilVisible(lateCard, 300, scrollable: find.byType(Scrollable).last);
        final onTime = find.byKey(const ValueKey('ord-1003'));
        if (onTime.evaluate().isNotEmpty) expect(tester.getTopLeft(lateCard).dy, lessThan(tester.getTopLeft(onTime).dy));
        expect(find.text('LATE'), findsOneWidget);
        await tester.scrollUntilVisible(find.byKey(const ValueKey('rider-ord-1004')), 300, scrollable: find.byType(Scrollable).last);
        expect(find.text('Ramesh Kumar Yadav'), findsOneWidget);
        await tester.tap(find.text('History'));
        await tester.pump(const Duration(seconds: 1));
        await tester.scrollUntilVisible(find.textContaining('Not accepted in 10 minutes'), 300, scrollable: find.byType(Scrollable).last);
        expect(find.textContaining('Restaurant did not respond'), findsOneWidget);
        final empty = await startController(FakeBackend());
        await tester.pumpWidget(host(KitchenQueueScreen(controller: empty)));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KEmptyState), findsOneWidget);
        c.dispose();
        empty.dispose();
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('stock manager list and the add-dish sheet', (tester) async {
        smallPhone(tester, textScale: scale);
        final backend = FakeBackend()
          ..menu = [
            DishModel(id: 'd1', name: 'Paneer Butter Masala With Extra Long Name', category: 'Main Course', price: 180),
            DishModel(id: 'd2', name: 'Mango Lassi', category: 'Beverages', price: 60, inStock: false),
          ];
        final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
        await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('SOLD OUT'), findsOneWidget);

        await tester.tap(find.bySemanticsLabel('Add a new dish'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(AddDishModal), findsOneWidget);
        expect(find.widgetWithText(KButton, 'Add to menu'), findsOneWidget);
        menu.dispose();
      });

      testWidgets('earnings: empty state, then real numbers', (tester) async {
        smallPhone(tester, textScale: scale);
        await tester.pumpWidget(host(const SalesAnalyticsScreen(orders: [])));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KEmptyState), findsOneWidget);

        final done = [
          order(id: 'a1', status: 'DELIVERED', items: longItems(2)),
          order(id: 'a2', status: 'PICKED_UP', items: longItems(3)),
          order(id: 'a3', status: 'PREPARING', items: longItems(1)),
          order(id: 'a4', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'CUSTOMER'),
        ];
        await tester.pumpWidget(host(SalesAnalyticsScreen(orders: done)));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(KStatTile), findsNWidgets(3));
        await tester.scrollUntilVisible(find.textContaining('Most orders come'), 200, scrollable: find.byType(Scrollable).last);
        expect(find.textContaining('Most orders come'), findsOneWidget);
        await tester.pumpWidget(host(SalesAnalyticsScreen(key: const ValueKey('incomplete'), orders: done, complete: false, onRetry: () {})));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byKey(const ValueKey('earnings-incomplete')), findsOneWidget);
      });
    });
  }

  testWidgets('closing the store asks first; opening does not', (tester) async {
    smallPhone(tester, textScale: 1.0);
    mockSignedInPrefs();
    // A restaurant with a dish: opening it needs no "no dishes yet" question (that case has its own test in bugfix_ve_test).
    final backend = FakeBackend()..menu = [DishModel(id: 'm1', name: 'Dal', category: 'Main Course', price: 90)];
    await tester.pumpWidget(KraveoVendorApp(auth: SignedInAuth(), backend: backend, socketFactory: FakeSocket.new, alarm: FakeAlarm()));
    await tester.pump();
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
    // Sent for the REAL restaurant of the signed-in owner.
    expect(backend.calls, containsAllInOrder(['store:set:v1:false', 'store:set:v1:true']));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });
}
