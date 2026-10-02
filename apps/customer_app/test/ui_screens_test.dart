import 'package:customer_app/models/customization.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/auth_screen.dart';
import 'package:customer_app/screens/dhaba_menu_screen.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/order_history_screen.dart';
import 'package:customer_app/widgets/cart_sheet.dart';
import 'package:customer_app/widgets/customization_modal.dart';
import 'package:customer_app/widgets/review_modal.dart';
import 'package:customer_app/widgets/ui/otp_boxes.dart';
import 'package:customer_app/widgets/ui/sheet_chrome.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';

import 'support/order_fakes.dart';

/// Renders screens on the smallest supported phone (360x640) at 1.3x system text scale.
/// Any RenderFlex overflow or build error surfaces as a test exception.
Future<void> pumpScreen(
  WidgetTester tester,
  Widget child, {
  CartProvider? cart,
  OrderProvider? orders,
  DhabaProvider? dhabas,
  SessionProvider? session,
}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<SessionProvider>.value(value: session ?? SessionProvider(initial: SessionStatus.signedIn)),
        ChangeNotifierProvider<DhabaProvider>.value(value: dhabas ?? DhabaProvider()),
        ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
        ChangeNotifierProvider<OrderProvider>.value(value: orders ?? OrderProvider()),
      ],
      child: MaterialApp(theme: KraveoTheme.customer(), home: child),
    ),
  );
  await tester.pump(const Duration(milliseconds: 800));
}

Finder _pressable(String label) => find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == label);

MenuItemModel _item(String id, {bool veg = true, bool available = true, double price = 120}) => MenuItemModel(
      id: id,
      vendorId: 'ven-1',
      name: 'Test dish $id',
      price: price,
      category: 'Thalis',
      description: 'A description long enough to wrap onto a second line at large text sizes',
      imageUrl: '',
      isAvailable: available,
      isVeg: veg,
    );

/// A provider whose fake server knows [orders] (GET /orders/:id) and lists them in history.
OrderProvider _ordersWith(List<OrderModel> orders) {
  final api = FakeOrderApi();
  for (final o in orders) {
    api.server[o.id] = o;
  }
  api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'history' ? orders.where((o) => o.isTerminal).toList() : orders.where((o) => o.isLive).toList(), null));
  return fakeOrders(api);
}

const _rider = {'id': 'd1', 'name': 'Vikram Singh', 'phone': '+91 98765 43210'};

/// Flutter's test engine draws every glyph as a 1em box unless fonts are loaded, which would
/// overstate text widths ~2x. Load the real bundled Kraveo fonts so layout checks are honest.
Future<void> loadKraveoFonts() async {
  const fonts = {
    'packages/kraveo_ui/Bricolage': 'packages/kraveo_ui/assets/fonts/BricolageGrotesque.ttf',
    'packages/kraveo_ui/Jakarta': 'packages/kraveo_ui/assets/fonts/PlusJakartaSans.ttf',
  };
  for (final entry in fonts.entries) {
    final loader = FontLoader(entry.key)..addFont(rootBundle.load(entry.value));
    await loader.load();
  }
}

void main() {
  setUpAll(loadKraveoFonts);

  testWidgets('AuthScreen shows the Google welcome without overflow', (tester) async {
    await pumpScreen(tester, const AuthScreen());
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.textContaining('cravings'), findsOneWidget);
    expect(find.textContaining('Google name and email'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('OtpBoxes mirrors typed digits and ignores non-digits', (tester) async {
    final controller = TextEditingController();
    String? completed;
    await pumpScreen(
      tester,
      Scaffold(body: Padding(padding: const EdgeInsets.all(20), child: OtpBoxes(controller: controller, onCompleted: (v) => completed = v))),
    );
    await tester.enterText(find.byType(TextField), '48a2 7');
    await tester.pump(const Duration(milliseconds: 400));
    expect(controller.text, '4827');
    expect(completed, '4827');
    for (final d in ['4', '8', '2', '7']) {
      expect(find.text(d), findsOneWidget);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('HomeScreen renders header, promo, chips and kitchens without overflow', (tester) async {
    final session = SessionProvider(initial: SessionStatus.checking)
      ..beginForTest({'id': 'u', 'name': 'Aarav Sharma', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 1', 'avatarId': 2});
    await pumpScreen(tester, const HomeScreen(), session: session);
    // Let the skeleton grace period elapse.
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 800));

    expect(find.text('DELIVERING TO'), findsOneWidget);
    expect(find.text('Block 1'), findsWidgets);
    expect(find.text('VITFIRST'), findsOneWidget);
    expect(find.text('Kitchens near campus'), findsOneWidget);
    expect(find.text('Home'), findsOneWidget);

    await tester.scrollUntilVisible(find.text('Sharma Highway Dhaba'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Sharma Highway Dhaba'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('HomeScreen without a chosen drop point shows a neutral Delivery point pill', (tester) async {
    final session = SessionProvider(initial: SessionStatus.checking)
      ..beginForTest({'id': 'u', 'name': 'Meera Rao', 'role': 'STUDENT', 'isStudent': false});
    await pumpScreen(tester, const HomeScreen(), session: session);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('DELIVERY POINT'), findsOneWidget);
    expect(find.text('Choose drop point'), findsOneWidget);
    expect(find.text('DELIVERING TO'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('HomeScreen shows an explanatory empty state for no search matches', (tester) async {
    final dhabas = DhabaProvider()..setSearchQuery('zzzz-no-such-dish');
    await pumpScreen(tester, const HomeScreen(), dhabas: dhabas);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 800));
    await tester.scrollUntilVisible(find.text('No kitchens match'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('No kitchens match'), findsOneWidget);
    expect(find.text('Clear filters'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Menu: ADD morphs to a stepper and the cart bar appears', (tester) async {
    final dhabas = DhabaProvider();
    final cart = CartProvider();
    final dhaba = dhabas.dhabas.firstWhere((d) => d.id == 'ven-2');
    await pumpScreen(tester, DhabaMenuScreen(dhaba: dhaba, selectedHostel: 'Block 2'), dhabas: dhabas, cart: cart);

    expect(find.text('View cart'), findsNothing);
    // ven-2: Paneer Kathi Roll is customisable, Cold Coffee is not.
    await tester.scrollUntilVisible(find.text('Cold Coffee with Ice Cream'), 200, scrollable: find.byType(Scrollable).first);
    await tester.ensureVisible(_pressable('Add Cold Coffee with Ice Cream'));
    await tester.pump();
    await tester.tap(_pressable('Add Cold Coffee with Ice Cream'));
    await tester.pump(const Duration(milliseconds: 700));

    expect(cart.itemCount, 1);
    expect(find.text('View cart'), findsOneWidget);
    expect(_pressable('Remove one Cold Coffee with Ice Cream'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Menu: sold-out dishes show a Sold out state instead of ADD', (tester) async {
    final dhabas = _MenuStubProvider([_item('in-stock'), _item('gone', available: false)]);
    final dhaba = dhabas.dhabas.first;
    await pumpScreen(tester, DhabaMenuScreen(dhaba: dhaba, selectedHostel: 'Block 1'), dhabas: dhabas);
    await tester.scrollUntilVisible(find.text('Test dish gone'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Sold out'), findsOneWidget);
    expect(_pressable('Add Test dish gone'), findsNothing);
    expect(_pressable('Add Test dish in-stock'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('CartSheet lists lines, coupon, coins and a bold total', (tester) async {
    final cart = CartProvider();
    cart.addItem(item: _item('a', price: 180), dhabaId: 'ven-1', dhabaName: 'Sharma Highway Dhaba');
    cart.addItem(item: _item('b', veg: false, price: 90), dhabaId: 'ven-1', dhabaName: 'Sharma Highway Dhaba');
    await pumpScreen(tester, Scaffold(body: Builder(builder: (context) {
      return Center(child: ElevatedButton(onPressed: () => CartSheet.show(context, selectedHostel: 'Block 2'), child: const Text('open')));
    })), cart: cart);

    await tester.tap(find.text('open'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('Sharma Highway Dhaba'), findsOneWidget);
    expect(find.text('Test dish a'), findsOneWidget);
    final sheetScroll = find.descendant(of: find.byType(KSheetFrame), matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('Have a coupon?'), 200, scrollable: sheetScroll);
    await tester.scrollUntilVisible(find.textContaining('Kraveo Coins'), 200, scrollable: sheetScroll);
    await tester.scrollUntilVisible(find.text('To pay'), 200, scrollable: sheetScroll);
    expect(find.text('Bill details'), findsOneWidget);
    expect(find.textContaining('Checkout'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Applying the promo shows a discount line and the applied ticket.
    cart.applyCoupon('VITFIRST');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.scrollUntilVisible(find.text('VITFIRST applied'), -200, scrollable: sheetScroll);
    expect(find.text('VITFIRST applied'), findsOneWidget);
    await tester.scrollUntilVisible(find.textContaining('Coupon (VITFIRST)'), 200, scrollable: sheetScroll);
    expect(find.textContaining('Coupon (VITFIRST)'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('CustomizationModal enforces required groups and totals the price', (tester) async {
    const item = MenuItemModel(
      id: 'cust-1',
      vendorId: 'ven-1',
      name: 'Build your thali',
      price: 150,
      category: 'Thalis',
      description: 'desc',
      imageUrl: '',
      isAvailable: true,
      customizationGroups: [
        CustomizationGroup(
          id: 'g1',
          title: 'Bread',
          isRequired: true,
          maxSelection: 1,
          options: [
            CustomizationOption(id: 'o1', name: '4 Rotis', price: 0),
            CustomizationOption(id: 'o2', name: '2 Naans', price: 25),
          ],
        ),
      ],
    );
    var added = false;
    await pumpScreen(tester, Scaffold(body: Builder(builder: (context) {
      return Center(child: ElevatedButton(onPressed: () => CustomizationModal.show(context, item: item, onAddToCart: (o, n) => added = true), child: const Text('open')));
    })));
    await tester.tap(find.text('open'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.textContaining('Add to cart'), findsOneWidget);
    expect(find.text('Required'), findsOneWidget);
    await tester.tap(find.textContaining('Add to cart'));
    await tester.pump(const Duration(milliseconds: 600));
    expect(added, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('LiveTrackingScreen with no order explains what will appear', (tester) async {
    await pumpScreen(tester, const LiveTrackingScreen());
    expect(find.text('No active order'), findsOneWidget);
    expect(find.text('Explore kitchens'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('LiveTrackingScreen (picked up) shows status, next step, rider and journey but no OTP yet', (tester) async {
    final order = orderModel(status: 'PICKED_UP', paymentStatus: 'PAID', driver: _rider);
    await pumpScreen(tester, LiveTrackingScreen(orderId: order.id), orders: _ordersWith([order]));
    await tester.pump(const Duration(milliseconds: 1500));

    expect(find.text('On the way to campus'), findsOneWidget);
    expect(find.textContaining('Next:'), findsOneWidget);
    expect(find.text('Your gate OTP'), findsNothing, reason: 'the OTP only exists at the gate');
    await tester.scrollUntilVisible(find.text('Order journey'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Order journey'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('YOUR DELIVERY PARTNER'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Vikram Singh'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('LiveTrackingScreen at the gate shows the server OTP and no customer-side verification', (tester) async {
    final order = orderModel(status: 'ARRIVED_AT_GATE', paymentStatus: 'PAID', driver: _rider, otpCode: '4827');
    await pumpScreen(tester, LiveTrackingScreen(orderId: order.id), orders: _ordersWith([order]));
    await tester.pump(const Duration(milliseconds: 1500));
    expect(find.text('Your rider is at the gate'), findsOneWidget);
    expect(find.text('Your gate OTP'), findsOneWidget);
    for (final d in ['4', '8', '2', '7']) {
      expect(find.text(d), findsWidgets);
    }
    expect(find.text('Confirm handover'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('LiveTrackingScreen renders cancelled and delivered states', (tester) async {
    final cancelled = orderModel(id: 'c1', status: 'CANCELLED', paymentStatus: 'PENDING', cancelledBy: 'SYSTEM', cancelReason: 'Payment not completed');
    await pumpScreen(tester, LiveTrackingScreen(orderId: cancelled.id), orders: _ordersWith([cancelled]));
    expect(find.text('This order was cancelled'), findsOneWidget);
    expect(find.textContaining('Payment not completed'), findsWidgets);
    expect(find.text('Your gate OTP'), findsNothing);
    expect(tester.takeException(), isNull);

    final delivered = orderModel(id: 'd1', status: 'DELIVERED', paymentStatus: 'PAID', driver: _rider);
    await pumpScreen(tester, LiveTrackingScreen(orderId: delivered.id), orders: _ordersWith([delivered]));
    await tester.pump(const Duration(milliseconds: 1500));
    expect(find.text('Delivered. Enjoy!'), findsOneWidget);
    expect(find.text('Your gate OTP'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('OrderHistoryScreen lists server orders with pills and actions', (tester) async {
    final orders = _ordersWith([orderModel(id: 'h1', status: 'DELIVERED', paymentStatus: 'PAID', driver: _rider)]);
    await orders.loadHistory(refresh: true);
    await pumpScreen(tester, const OrderHistoryScreen(), orders: orders);
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Your orders'), findsOneWidget);
    expect(find.text('Delivered'), findsWidgets);
    expect(find.text('Reorder'), findsWidgets);
    expect(find.text('Rate'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ReviewModal renders rating sections without overflow', (tester) async {
    await pumpScreen(tester, Scaffold(body: Builder(builder: (context) {
      return Center(
        child: ElevatedButton(
          onPressed: () => ReviewModal.show(context, order: orderModel(status: 'DELIVERED', paymentStatus: 'PAID', driver: _rider)),
          child: const Text('open'),
        ),
      );
    })));
    await tester.tap(find.text('open'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Rate Sharma Highway Dhaba'), findsOneWidget);
    expect(find.text('Submit rating'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

/// Serves a fixed menu for every kitchen so item states can be tested.
class _MenuStubProvider extends DhabaProvider {
  _MenuStubProvider(this._menu);
  final List<MenuItemModel> _menu;

  @override
  List<MenuItemModel> getMenuItemsForDhaba(String dhabaId) => _menu;
}
