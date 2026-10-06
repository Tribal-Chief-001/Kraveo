// Regression tests for the 6 Oct 2026 pre-demo bug hunt (Docs/bughunt CU1 / CU2): screens.
// Everything runs at 360x640 (the smallest supported phone) with large text where it matters.
import 'dart:async';
import 'dart:convert';

import 'package:customer_app/models/dhaba.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/checkout_screen.dart';
import 'package:customer_app/screens/dhaba_menu_screen.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/order_history_screen.dart';
import 'package:customer_app/screens/payment_success_screen.dart';
import 'package:customer_app/screens/profile_screen.dart';
import 'package:customer_app/screens/profile_setup_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/external_links.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:customer_app/widgets/animated_rider_map.dart';
import 'package:customer_app/widgets/map/map_view.dart';
import 'package:customer_app/widgets/map/tracking_map.dart';
import 'package:customer_app/widgets/review_modal.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';
import 'support/sample_catalog.dart';

// ---- helpers ---------------------------------------------------------------------------------

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

Future<void> _loadKraveoFonts() async {
  const fonts = {
    'packages/kraveo_ui/Bricolage': 'packages/kraveo_ui/assets/fonts/BricolageGrotesque.ttf',
    'packages/kraveo_ui/Jakarta': 'packages/kraveo_ui/assets/fonts/PlusJakartaSans.ttf',
  };
  for (final entry in fonts.entries) {
    final loader = FontLoader(entry.key)..addFont(rootBundle.load(entry.value));
    await loader.load();
  }
}

SessionProvider _student({String hostel = 'BH2'}) => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())
  ..beginForTest({'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': hostel, 'avatarId': 3, 'kraveoCoins': 120});

/// Fake `/api/vendors`; every other path answers 404. Counts the catalog requests.
class _Server {
  _Server({this.vendors = const [], this.fail = false});
  List<Map<String, dynamic>> vendors;
  bool fail;
  int vendorRequests = 0;

  _Server install() {
    CustomerApiService.httpClientOverride = MockClient((req) async {
      final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
      if (path == '/vendors') {
        vendorRequests++;
        if (fail) return http.Response('<html>502 Bad Gateway</html>', 502);
        return http.Response(jsonEncode({'success': true, 'data': vendors}), 200, headers: {'content-type': 'application/json'});
      }
      return http.Response('{"success":false}', 404);
    });
    return this;
  }
}

Map<String, dynamic> _vendor(String id, String name, {bool open = true, List<Map<String, dynamic>> menu = const []}) => {
      'id': id,
      'name': name,
      'category': 'North Indian • Campus Dhaba',
      'rating': 4.5,
      'eta': '20-25 min',
      'bannerImage': '',
      'isAcceptingOrders': open,
      'address': 'Kothri',
      'menuItems': menu,
    };

Map<String, dynamic> _dish(String id, String vendorId, String name, String category, {double price = 120}) =>
    {'id': id, 'vendorId': vendorId, 'name': name, 'price': price, 'category': category, 'description': 'd', 'imageUrl': '', 'isAvailable': true, 'isVeg': true};

/// The kitchen that matches `orderJson`'s default vendor (`v-real-1`) with the two dishes it sells.
DhabaProvider _catalogForOrders() => DhabaProvider(
      dhabas: [Dhaba(id: 'v-real-1', name: 'Sharma Highway Dhaba', category: 'North Indian', rating: 4.5, eta: '20-25 min', bannerUrl: '', isAcceptingOrders: true, address: 'Kothri')],
      menus: {
        'v-real-1': [
          const MenuItemModel(id: 'm-thali', vendorId: 'v-real-1', name: 'Paneer Thali', price: 115, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true),
          const MenuItemModel(id: 'm-paratha', vendorId: 'v-real-1', name: 'Aloo Paratha', price: 90, category: 'Parathas', description: 'd', imageUrl: '', isAvailable: true),
        ],
      },
    );

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  OrderProvider? orders,
  CartProvider? cart,
  DhabaProvider? dhabas,
  SessionProvider? session,
  double textScale = 1.3,
  Size size = const Size(360, 640),
  double keyboard = 0,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  if (keyboard > 0) tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.view.resetViewInsets();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
  await tester.pumpWidget(MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionProvider>.value(value: session ?? _student()),
      ChangeNotifierProvider<DhabaProvider>.value(value: dhabas ?? (DhabaProvider()..markLiveForTest(['ven-1']))),
      ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
      ChangeNotifierProvider<OrderProvider>.value(value: orders ?? OrderProvider()),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: child),
  ));
  await _settle(tester);
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Finder _button(String label) => find.widgetWithText(KButton, label);

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f.first);
  await tester.pump();
  await tester.tap(f.first);
  await _settle(tester);
}

CartProvider _cartWith({double price = 120, int quantity = 1}) {
  final cart = CartProvider();
  for (var i = 0; i < quantity; i++) {
    cart.addItem(
      item: MenuItemModel(id: 'm-thali', vendorId: 'ven-1', name: 'Paneer Thali', price: price, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true),
      dhabaId: 'ven-1',
      dhabaName: 'Sharma Highway Dhaba',
    );
  }
  return cart;
}

/// A stand-in for the Google map.
class _FakeMaps extends MapViewFactory {
  _FakeMaps({this.available = true});
  final bool available;
  final List<MapViewSpec> specs = [];

  @override
  Future<bool> isAvailable() async => available;

  @override
  Widget build(BuildContext context, MapViewSpec spec) {
    specs.add(spec);
    scheduleMicrotask(spec.onReady);
    return const SizedBox.expand(key: ValueKey('fake-map'));
  }
}

OrderModel _live({String id = 't-1', String status = 'PICKED_UP', Map<String, dynamic>? driver, String? otp}) => OrderModel.tryParse(orderJson(
      id: id,
      status: status,
      paymentStatus: 'PAID',
      dropoffHostel: 'BH2',
      driver: driver ?? {'id': 'd', 'name': 'Ravi', 'phone': '+91 98765 43210'},
      otpCode: otp,
    ))!;

/// Scrolls [f] to the middle of the screen (so a floating bar at the bottom cannot cover it).
Future<void> _center(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 100, scrollable: find.byType(Scrollable).first);
  Scrollable.ensureVisible(tester.element(f), alignment: 0.4);
  await tester.pump(const Duration(milliseconds: 400));
}

const String _sheetTitle = 'Confirm your delivery point';

void main() {
  setUpAll(_loadKraveoFonts);
  setUp(() {
    FakeRealtime.created.clear();
    SharedPreferences.setMockInitialValues({});
    ExternalLinks.launcher = (uri) async => false;
  });
  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    ExternalLinks.launcher = (uri) async => false;
  });

  // ================================================================================== Home ====
  group('Home (CU1-01 / 02 / 03 / 09 / 23)', () {
    Future<OrderProvider> ordersLoaded({List<OrderModel> history = const []}) async {
      final api = FakeOrderApi()..onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'history' ? history : [], null));
      final o = fakeOrders(api)..beginSession('u1');
      await o.refreshActive(); // (pumpEventQueue would spin forever under the test's fake clock)
      await o.loadHistory(refresh: true);
      return o;
    }

    testWidgets('a failed catalog shows "Can\'t load kitchens" with Try again (and never invented kitchens); Try again loads them', (tester) async {
      final server = _Server(fail: true).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      expect(find.text('Can\'t load kitchens'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.text('Sharma Highway Dhaba'), findsNothing);
      expect(find.text('FC Night Mess'), findsNothing);
      expect(find.textContaining('places'), findsNothing);
      expect(server.vendorRequests, 1);

      server
        ..fail = false
        ..vendors = [_vendor('v1', 'Real Dhaba')];
      await _tap(tester, find.text('Try again'));
      expect(server.vendorRequests, 2);
      expect(find.text('Can\'t load kitchens'), findsNothing);
      await tester.scrollUntilVisible(find.text('Real Dhaba'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Real Dhaba'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('no approved kitchens: "No kitchens are open right now" (not an error)', (tester) async {
      _Server(vendors: []).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      expect(find.text('No kitchens are open right now'), findsOneWidget);
      expect(find.text('Can\'t load kitchens'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pull-to-refresh and returning to the app both reload the catalog', (tester) async {
      final server = _Server(vendors: [_vendor('v1', 'Real Dhaba')]).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      expect(server.vendorRequests, 1);

      await tester.fling(find.byType(CustomScrollView).first, const Offset(0, 400), 1000);
      await _settle(tester);
      expect(server.vendorRequests, 2, reason: 'pull to refresh');

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _settle(tester);
      expect(server.vendorRequests, 3, reason: 'app resume');
    });

    testWidgets('a failed pull-to-refresh keeps the kitchens on screen and says so', (tester) async {
      final server = _Server(vendors: [_vendor('v1', 'Real Dhaba')]).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      server.fail = true;
      await tester.fling(find.byType(CustomScrollView).first, const Offset(0, 400), 1000);
      await _settle(tester);
      expect(find.textContaining('Couldn\'t refresh the kitchens'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Real Dhaba'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Real Dhaba'), findsOneWidget);
      expect(find.text('Can\'t load kitchens'), findsNothing);
    });

    testWidgets('the first-order promo is shown only to a student with no orders; unknown history hides it', (tester) async {
      _Server(vendors: [_vendor('v1', 'Real Dhaba')]).install();
      await _pump(tester, const HomeScreen(), dhabas: sampleCatalogProvider(), orders: OrderProvider());
      expect(find.text('VITFIRST'), findsNothing, reason: 'orders not loaded yet: hidden');

      await _pump(tester, const HomeScreen(), dhabas: sampleCatalogProvider(), orders: await ordersLoaded());
      expect(find.text('VITFIRST'), findsOneWidget);

      await _pump(tester, const HomeScreen(), dhabas: sampleCatalogProvider(), orders: await ordersLoaded(history: [orderModel(id: 'h1', status: 'DELIVERED', paymentStatus: 'PAID')]));
      expect(find.text('VITFIRST'), findsNothing, reason: 'a student who already ordered is refused VITFIRST by the server');
      expect(find.text('FIRST ORDER'), findsNothing);
    });

    testWidgets('category chips come from the live menus: no "Night Mess", and every chip lists kitchens', (tester) async {
      _Server(vendors: [
        _vendor('v1', 'Alpha Dhaba', menu: [_dish('a1', 'v1', 'Thali', 'Thalis'), _dish('a2', 'v1', 'Lassi', 'Beverages')]),
        _vendor('v2', 'Beta Kitchen', menu: [_dish('b1', 'v2', 'Roll', 'Rolls')]),
      ]).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      expect(find.text('Night Mess'), findsNothing);
      expect(find.text('Parathas'), findsNothing);
      final chipRow = find.byWidgetPredicate((w) => w is Scrollable && w.axisDirection == AxisDirection.right);
      for (final chip in ['All', 'Thalis', 'Beverages', 'Rolls']) {
        await tester.scrollUntilVisible(find.widgetWithText(KChoiceChip, chip), 60, scrollable: chipRow.first);
        expect(find.widgetWithText(KChoiceChip, chip), findsOneWidget, reason: chip);
      }
      await tester.tap(find.widgetWithText(KChoiceChip, 'Rolls'));
      await _settle(tester);
      expect(find.text('No kitchens match'), findsNothing);
      await tester.scrollUntilVisible(find.text('Beta Kitchen'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Beta Kitchen'), findsOneWidget);
      expect(find.text('Alpha Dhaba'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('back from Orders / Me / Track returns to the Home tab first', (tester) async {
      _Server(vendors: [_vendor('v1', 'Real Dhaba')]).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      int tab() => tester.widget<IndexedStack>(find.byType(IndexedStack).first).index ?? 0;
      expect(tab(), 0);
      for (final (label, icon) in [('Orders', LucideIcons.receiptText), ('Me', LucideIcons.user), ('Track', LucideIcons.bike)]) {
        await tester.tap(find.byIcon(icon));
        await _settle(tester);
        expect(tab(), isNot(0), reason: label);
        await tester.binding.handlePopRoute();
        await _settle(tester);
        expect(tab(), 0, reason: 'system back from $label goes to Home');
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('no invented "Min ₹99" on kitchen cards', (tester) async {
      _Server(vendors: [_vendor('v1', 'Real Dhaba')]).install();
      await _pump(tester, const HomeScreen(), dhabas: DhabaProvider());
      await tester.scrollUntilVisible(find.text('Real Dhaba'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.textContaining('Min'), findsNothing);
      expect(find.textContaining('Delivery'), findsWidgets);
    });
  });

  // ============================================================================== Menu / cart ====
  group('Menu (CU1-03 / 11 / 16)', () {
    testWidgets('opening a menu reloads the catalog: a kitchen that closed meanwhile shows the banner', (tester) async {
      final server = _Server(vendors: [_vendor('v1', 'Real Dhaba', open: false, menu: [_dish('a1', 'v1', 'Thali', 'Thalis')])]).install();
      final dhabas = DhabaProvider(
        dhabas: [Dhaba(id: 'v1', name: 'Real Dhaba', category: 'x', rating: 4.5, eta: '20 min', bannerUrl: '', isAcceptingOrders: true, address: 'Kothri')],
        menus: {'v1': [const MenuItemModel(id: 'a1', vendorId: 'v1', name: 'Thali', price: 120, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true)]},
      );
      await _pump(tester, DhabaMenuScreen(dhaba: dhabas.byId('v1')!, selectedHostel: 'BH2'), dhabas: dhabas);
      expect(server.vendorRequests, 1);
      expect(find.textContaining('not taking orders right now'), findsOneWidget, reason: 'the banner follows the refreshed catalog');
    });

    /// A provider that loaded one kitchen through the (fake) server, so the menu's own reload keeps it.
    Future<DhabaProvider> loaded(_Server server) async {
      server.install();
      final p = DhabaProvider();
      await p.loadCatalog();
      return p;
    }

    testWidgets('a closed kitchen\'s ADD button answers with a message instead of doing nothing', (tester) async {
      final server = _Server(vendors: [
        _vendor('v1', 'Real Dhaba', open: false, menu: [_dish('a1', 'v1', 'Thali', 'Thalis')])
      ]);
      final dhabas = await loaded(server);
      final cart = CartProvider();
      await _pump(tester, DhabaMenuScreen(dhaba: dhabas.byId('v1')!, selectedHostel: 'BH2'), dhabas: dhabas, cart: cart);
      await tester.scrollUntilVisible(find.text('Thali'), 200, scrollable: find.byType(Scrollable).first);
      final add = find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Add Thali');
      await tester.ensureVisible(add);
      await tester.pump();
      await tester.tap(add);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Real Dhaba is not taking orders right now.'), findsOneWidget);
      expect(cart.itemCount, 0);
    });

    testWidgets('no invented "Min ₹…" chip on the menu', (tester) async {
      final server = _Server(vendors: [
        _vendor('v1', 'Real Dhaba', menu: [_dish('a1', 'v1', 'Thali', 'Thalis')])
      ]);
      final dhabas = await loaded(server);
      await _pump(tester, DhabaMenuScreen(dhaba: dhabas.byId('v1')!, selectedHostel: 'BH2'), dhabas: dhabas);
      expect(find.textContaining('Min ₹'), findsNothing);
      expect(find.text('Thali'), findsWidgets);
    });

    testWidgets('the 21st portion of a dish is refused with a friendly snackbar (menu "+")', (tester) async {
      final server = _Server(vendors: [
        _vendor('v1', 'Real Dhaba', menu: [_dish('a1', 'v1', 'Thali', 'Thalis')])
      ]);
      final dhabas = await loaded(server);
      final dhaba = dhabas.byId('v1')!;
      final dish = dhabas.getMenuItemsForDhaba('v1').single;
      final cart = CartProvider();
      for (var i = 0; i < CartProvider.maxQuantityPerDish; i++) {
        cart.addItem(item: dish, dhabaId: dhaba.id, dhabaName: dhaba.name);
      }
      await _pump(tester, DhabaMenuScreen(dhaba: dhaba, selectedHostel: 'BH2'), dhabas: dhabas, cart: cart);
      final more = find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Add one more ${dish.name}');
      await _center(tester, more);
      await tester.tap(more);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text(CartProvider.maxQuantityMessage), findsOneWidget);
      expect(cart.getItemQuantityInCart(dish.id), 20);
    });
  });

  // ================================================================================ Checkout ====
  group('Checkout (CU1-01 / 03 / 07 / 10 / 11 / 15 / 26)', () {
    Future<(FakeOrderApi, OrderProvider)> open(WidgetTester tester, {CartProvider? cart, double textScale = 1.3, double keyboard = 0, DhabaProvider? dhabas}) async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      await _pump(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: orders, cart: cart ?? _cartWith(), dhabas: dhabas, textScale: textScale, keyboard: keyboard);
      return (api, orders);
    }

    /// Pay -> (sheet) -> Confirm and pay.
    Future<void> pay(WidgetTester tester, String label) async {
      await _tap(tester, _button(label));
      final confirm = _button('Confirm and pay');
      if (confirm.evaluate().isNotEmpty) await _tap(tester, confirm);
    }

    testWidgets('the server refuses the coupon: it is removed, checkout stays open, one line gives the reason and the new total', (tester) async {
      final cart = _cartWith(price: 120)..applyCoupon('VITFIRST'); // 120 + 25 - 24 = 121
      final (api, _) = await open(tester, cart: cart);
      api.onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'COUPON_NOT_APPLICABLE', message: 'VITFIRST is only for your first order.'));
      expect(_button('Pay ₹121'), findsOneWidget);

      await pay(tester, 'Pay ₹121');
      expect(cart.appliedCouponCode, isNull, reason: 'the refused coupon is dropped by itself');
      expect(find.text('Checkout'), findsOneWidget, reason: 'still on the checkout screen');
      expect(_button('Pay ₹145'), findsOneWidget, reason: 'the button shows the new total');
      expect(find.textContaining('Coupon removed. VITFIRST is only for your first order. Your total is now ₹145.'), findsWidgets);
      expect(tester.takeException(), isNull);

      // The next tap places the order without the coupon (new idempotency key).
      api.onCreate = null;
      await pay(tester, 'Pay ₹145');
      expect(api.creates, hasLength(2));
      expect(api.creates.last.couponCode, isNull);
      expect(api.creates.last.clientRequestId, isNot(api.creates.first.clientRequestId));
    });

    testWidgets('INVALID_ITEMS / VENDOR_CLOSED: friendly wording (no ids) and the catalog is reloaded', (tester) async {
      // The kitchen is still listed after the reload (only its menu changed).
      final server = _Server(vendors: [_vendor('ven-1', 'Sharma Highway Dhaba')]).install();
      final (api, _) = await open(tester, dhabas: sampleCatalogProvider());
      const uuid = '9f3c2d1e-0000-4000-8000-000000000001';
      api.onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'INVALID_ITEMS', message: "Item '9f3c2d1e-0000-4000-8000-000000000001' is not available at this dhaba."));
      final before = server.vendorRequests;
      await pay(tester, 'Pay ₹145');
      expect(find.textContaining(uuid), findsNothing);
      expect(find.textContaining('no longer available'), findsWidgets);
      expect(server.vendorRequests, greaterThan(before), reason: 'the menu is refreshed after INVALID_ITEMS');

      final afterFirst = server.vendorRequests;
      api.onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'VENDOR_CLOSED', message: 'This Dhaba is currently CLOSED for new orders.'));
      await pay(tester, 'Pay ₹145');
      expect(find.textContaining('closed for new orders'), findsWidgets);
      expect(find.textContaining('Dhaba is currently CLOSED'), findsNothing, reason: 'customer wording, not the raw server text');
      expect(server.vendorRequests, greaterThan(afterFirst), reason: 'and after VENDOR_CLOSED');
    });

    testWidgets('paise are shown everywhere: Pay button, bill rows and total (₹175.40)', (tester) async {
      final cart = _cartWith(price: 188)..applyCoupon('VITFIRST'); // 37.6 off -> 175.40
      await open(tester, cart: cart);
      expect(_button('Pay ₹175.40'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('To pay'), 200, scrollable: find.byType(Scrollable).first);
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('-₹37.60'), findsOneWidget);
      expect(find.text('₹175.40'), findsOneWidget);
      expect(find.text('₹190'), findsNothing);
    });

    testWidgets('a double tap on Pay opens ONE delivery-point sheet; its button is disabled for the first moments', (tester) async {
      final (api, _) = await open(tester);
      final payButton = _button('Pay ₹145');
      await tester.tap(payButton);
      await tester.tap(payButton); // the second tap of the double tap
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text(_sheetTitle), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text(_sheetTitle), findsOneWidget, reason: 'never a second sheet');

      final confirm = _button('Confirm and pay');
      expect(tester.widget<KButton>(confirm).onPressed, isNull, reason: 'a stray tap cannot confirm a point nobody read');
      await tester.tap(confirm, warnIfMissed: false);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text(_sheetTitle), findsOneWidget);
      expect(api.creates, isEmpty);

      await tester.pump(const Duration(milliseconds: 500));
      expect(tester.widget<KButton>(confirm).onPressed, isNotNull);
      await _tap(tester, confirm);
      expect(find.text(_sheetTitle), findsNothing);
      expect(api.creates, hasLength(1));
    });

    testWidgets('cancel wording: no "Nothing has been paid" promise; after a failed payment it says the bank refunds automatically', (tester) async {
      final api = FakeOrderApi();
      final gateway = FakeGateway()..next = const GatewayResult.failed();
      final orders = fakeOrders(api, gateway: gateway);
      await _pump(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: orders, cart: _cartWith(price: 220));
      await pay(tester, 'Pay ₹245'); // a 245 server total equals the 220+25 estimate: the sheet opens and fails
      expect(find.text('Payment not completed'), findsWidgets);

      await _tap(tester, _button('Cancel order'));
      expect(find.textContaining('Nothing has been paid'), findsNothing);
      expect(find.textContaining('bank already took money'), findsOneWidget);
      expect(find.textContaining('refunds it automatically'), findsOneWidget);
    });

    testWidgets('the footer says "pay online" (cards work too), not "pay by UPI"', (tester) async {
      await open(tester);
      expect(find.textContaining('pay online'), findsOneWidget);
      expect(find.textContaining('pay by UPI'), findsNothing);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('keyboard open on 360x640 at ${scale}x text: no overflow, the Pay button stays above the keyboard and the notice moves into the list', (tester) async {
        final (api, _) = await open(tester, textScale: scale);
        api.onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'VENDOR_CLOSED', message: 'closed'));
        await pay(tester, 'Pay ₹145');
        expect(find.textContaining('closed for new orders'), findsWidgets, reason: 'the notice (and the snackbar) show the error');
        await tester.pump(const Duration(seconds: 4)); // the snackbar has gone

        // The keyboard comes up (the delivery note is being typed).
        tester.view.viewInsets = const FakeViewPadding(bottom: 280);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');

        final payRect = tester.getRect(_button('Pay ₹145'));
        expect(payRect.bottom, lessThanOrEqualTo(640 - 280 + 0.5), reason: 'the button is not hidden under the keyboard');
        expect(find.textContaining('Placing your order'), findsNothing, reason: 'the caption is dropped while typing');
        expect(find.textContaining('Next: Kraveo confirms'), findsNothing);
        // The error moved from the footer into the list: still readable, and only once.
        expect(find.textContaining('closed for new orders'), findsOneWidget);
        expect(tester.getRect(find.textContaining('closed for new orders')).bottom, lessThanOrEqualTo(payRect.top));

        // The form keeps real room: the note field can be scrolled fully above the Pay button.
        final note = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('Note for your runner'));
        await tester.scrollUntilVisible(note, 50, scrollable: find.byType(Scrollable).first);
        await tester.pump(const Duration(milliseconds: 300));
        final noteRect = tester.getRect(note);
        expect(noteRect.top, greaterThanOrEqualTo(60));
        expect(noteRect.bottom, lessThanOrEqualTo(payRect.top + 1));
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('Payment success screen (CU1-15)', () {
    for (final (name, size, scale) in [('360x640 at 2x', const Size(360, 640), 2.0), ('landscape 640x360', const Size(640, 360), 1.3)]) {
      testWidgets('scrolls instead of overflowing on $name', (tester) async {
        var continued = 0;
        await _pump(
          tester,
          PaymentSuccessScreen(orderId: 'abc-123456', amountLabel: '₹190.40', vendorName: 'Sharma Highway Dhaba', autoContinue: const Duration(hours: 1), onContinue: () => continued++),
          size: size,
          textScale: scale,
        );
        expect(find.byType(SingleChildScrollView), findsOneWidget);
        expect(find.text('₹190.40'), findsOneWidget, reason: 'the amount shows paise');
        expect(tester.takeException(), isNull);
        await tester.scrollUntilVisible(_button('Track my order'), 100, scrollable: find.byType(Scrollable).first);
        expect(_button('Track my order'), findsOneWidget);
        await tester.tap(_button('Track my order'));
        expect(continued, 1);
      });
    }
  });

  // ===================================================================================== Orders ====
  group('Order history (CU1-06 / 13 / 27, CU2-10)', () {
    OrderModel delivered({String id = 'h1', String dropoff = 'Block 3', double? total}) => OrderModel.tryParse(orderJson(id: id, status: 'DELIVERED', paymentStatus: 'PAID', dropoffHostel: dropoff, totalAmount: total, driver: {'id': 'd', 'name': 'Ravi'}))!;

    Future<(OrderProvider, CartProvider, DhabaProvider)> show(WidgetTester tester, {CartProvider? cart, List<OrderModel>? history}) async {
      final api = FakeOrderApi();
      final list = history ?? [delivered()];
      api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'history' ? list : [], null));
      final orders = fakeOrders(api)..beginSession('u1');
      await orders.loadHistory(refresh: true);
      final c = cart ?? CartProvider();
      final dhabas = _catalogForOrders();
      await _pump(tester, const OrderHistoryScreen(selectedHostel: 'BH2'), orders: orders, cart: c, dhabas: dhabas);
      return (orders, c, dhabas);
    }

    testWidgets('legacy drop points are shown with the new names; big totals get a thousands separator; no coin promise', (tester) async {
      await show(tester, history: [delivered(total: 1234.5)]);
      expect(find.textContaining('· BH3'), findsOneWidget, reason: '"Block 3" is shown as BH3');
      expect(find.textContaining('Block 3'), findsNothing);
      expect(find.text('₹1,234.50'), findsOneWidget);
      expect(find.textContaining('earn Kraveo Coins'), findsNothing);
    });

    testWidgets('Reorder finds the kitchen even when Home has a search / filter active, and opens the cart', (tester) async {
      final api = FakeOrderApi();
      api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'history' ? [delivered()] : [], null));
      final orders = fakeOrders(api)..beginSession('u1');
      await orders.loadHistory(refresh: true);
      final dhabas = _catalogForOrders()..setSearchQuery('zzzz-nothing-matches');
      expect(dhabas.dhabas, isEmpty, reason: 'the Home list is filtered down to nothing');
      final cart = CartProvider();
      await _pump(tester, const OrderHistoryScreen(selectedHostel: 'BH2'), orders: orders, cart: cart, dhabas: dhabas);

      await _tap(tester, _button('Reorder'));
      expect(find.textContaining('isn\'t taking orders in the app'), findsNothing);
      expect(cart.itemCount, 2);
      expect(cart.dhabaName, 'Sharma Highway Dhaba');
      expect(find.textContaining('Checkout'), findsWidgets, reason: 'the cart sheet is open');
    });

    testWidgets('a non-empty cart is only replaced after the student confirms', (tester) async {
      final cart = CartProvider()
        ..addItem(
          item: const MenuItemModel(id: 'other', vendorId: 'v-other', name: 'Other dish', price: 50, category: 'x', description: 'd', imageUrl: '', isAvailable: true),
          dhabaId: 'v-other',
          dhabaName: 'Other Kitchen',
        );
      await show(tester, cart: cart);

      await _tap(tester, _button('Reorder'));
      expect(find.text('Replace your cart?'), findsOneWidget);
      expect(find.textContaining('Other Kitchen'), findsOneWidget);
      await _tap(tester, _button('Keep my cart'));
      expect(cart.dhabaName, 'Other Kitchen', reason: 'declined: nothing changed');
      expect(cart.itemCount, 1);

      await _tap(tester, _button('Reorder'));
      await _tap(tester, _button('Replace cart'));
      expect(cart.dhabaName, 'Sharma Highway Dhaba');
      expect(cart.itemCount, 2);
    });
  });

  // =================================================================================== Tracking ====
  group('Tracking (CU2-01 / 03 / 04 / 05 / 06 / 07 / 08 / 10 / 17)', () {
    Future<(FakeOrderApi, OrderProvider)> show(WidgetTester tester, OrderModel order, {MapViewFactory? maps, CartProvider? cart, DhabaProvider? dhabas, SessionProvider? session, Size size = const Size(360, 640)}) async {
      final api = FakeOrderApi()..server[order.id] = order;
      final orders = fakeOrders(api)..beginSession('u1');
      await _pump(tester, LiveTrackingScreen(orderId: order.id, mapFactory: maps), orders: orders, cart: cart, dhabas: dhabas, session: session, size: size);
      return (api, orders);
    }

    testWidgets('an order that cannot be found shows an explanation instead of an endless spinner', (tester) async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api)..beginSession('u1');
      await _pump(tester, const LiveTrackingScreen(orderId: 'ghost'), orders: orders);
      expect(find.text('We couldn\'t find this order'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(orders.isPolling, isFalse, reason: 'no polling forever for an order that is not ours');

      api.server['ghost'] = _live(id: 'ghost');
      await _tap(tester, _button('Check again'));
      expect(find.text('Live tracking'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('offline first load: "Couldn\'t load this order" with Try again; Try again recovers', (tester) async {
      final api = FakeOrderApi();
      var offline = true;
      api.onFetch = (id) async => offline ? const OrderResult.fail(OrderApiError(OrderErrorKind.offline)) : OrderResult.ok(_live(id: id));
      final orders = fakeOrders(api)..beginSession('u1');
      await _pump(tester, const LiveTrackingScreen(orderId: 'x1'), orders: orders);
      expect(find.text('Couldn\'t load this order'), findsOneWidget);
      expect(find.textContaining('No internet connection'), findsOneWidget);
      offline = false;
      await _tap(tester, _button('Try again'));
      expect(find.text('Live tracking'), findsOneWidget);
      expect(find.text('Couldn\'t load this order'), findsNothing);
    });

    testWidgets('restaurant rejects a paid order: "being processed" turns into "Cancelled and refunded" when the second event arrives', (tester) async {
      final placed = OrderModel.tryParse(orderJson(id: 'r1', status: 'PLACED', paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().subtract(const Duration(seconds: 30))))!;
      final (_, orders) = await show(tester, placed);
      final socket = FakeRealtime.created.single..simulateConnect();

      socket.emitOrder(orderJson(id: 'r1', status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'PENDING', cancelledBy: 'VENDOR', updatedAt: DateTime.now().toUtc().subtract(const Duration(seconds: 5))));
      await _settle(tester);
      expect(find.text('This order was cancelled'), findsOneWidget);
      expect(find.textContaining('Your refund is being processed'), findsOneWidget);
      expect(find.text(kSupportEmail), findsNothing, reason: 'just the plain text, tappable below');
      expect(find.textContaining(kSupportEmail), findsOneWidget, reason: 'support is one tap away while the refund is pending');
      expect(orders.isSocketOpen, isTrue, reason: 'the socket stays open for the refund result');

      socket.emitOrder(orderJson(id: 'r1', status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', cancelledBy: 'VENDOR', updatedAt: DateTime.now().toUtc()));
      await _settle(tester);
      expect(find.text('Cancelled and refunded'), findsOneWidget);
      expect(find.textContaining('has been issued'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('"Order again" on a cancelled order reorders (same helper as Orders): cart filled and opened', (tester) async {
      final cancelled = OrderModel.tryParse(orderJson(id: 'c1', status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', cancelledBy: 'VENDOR'))!;
      final cart = CartProvider();
      await show(tester, cancelled, cart: cart, dhabas: _catalogForOrders());
      await _tap(tester, _button('Order again'));
      expect(cart.itemCount, 2);
      expect(cart.dhabaId, 'v-real-1');
      expect(find.textContaining('Checkout'), findsWidgets);
    });

    testWidgets('no invented "Kitchen usually delivers in …" chip', (tester) async {
      await show(tester, _live(status: 'PREPARING'), dhabas: _catalogForOrders());
      expect(find.textContaining('usually delivers'), findsNothing);
    });

    testWidgets('the call button dials the rider; when no dialer exists the number is copied and the student is told', (tester) async {
      final opened = <Uri>[];
      ExternalLinks.launcher = (uri) async {
        opened.add(uri);
        return true;
      };
      await show(tester, _live(status: 'ACCEPTED'));
      final call = find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Call Ravi');
      await _center(tester, call);
      await tester.tap(call);
      await tester.pump();
      expect(opened.single.toString(), 'tel:+919876543210');

      final clip = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') clip.add((call.arguments as Map)['text'] as String);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      ExternalLinks.launcher = (uri) async => false;
      await tester.tap(call);
      await tester.pump(const Duration(milliseconds: 300));
      expect(clip, ['+91 98765 43210']);
      expect(find.textContaining('Couldn’t open the dialer'), findsOneWidget);
    });

    testWidgets('the map is NOT rebuilt when the OTP card appears above it', (tester) async {
      final maps = _FakeMaps();
      // A tall screen keeps every card built (the list builds lazily; a card scrolled far off-screen is dropped, with or without keys).
      await show(tester, _live(), maps: maps, size: const Size(360, 1600));
      final socket = FakeRealtime.created.single..simulateConnect();
      final before = tester.state(find.byType(TrackingMap));
      expect(find.text('Your gate OTP'), findsNothing);

      socket.emitOrder(orderJson(id: 't-1', status: 'ARRIVED_AT_GATE', paymentStatus: 'PAID', otpCode: '4827', driver: {'id': 'd', 'name': 'Ravi'}, updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 5))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Your gate OTP'), findsOneWidget);
      expect(_button('Copy code'), findsOneWidget, reason: 'the code itself is drawn as separate digit boxes');
      expect(identical(tester.state(find.byType(TrackingMap)), before), isTrue, reason: 'the same map state survived: no flash back to the strip');
      expect(tester.takeException(), isNull);
    });

    group('rider position staleness (CU2-04) and GPS chip (CU2-17)', () {
      Future<(ValueNotifier<RiderLocation?>, ValueNotifier<DateTime>)> pumpMap(WidgetTester tester, OrderModel order, {MapViewFactory? factory, DateTime? fixAt}) async {
        final clock = ValueNotifier<DateTime>(DateTime(2026, 10, 6, 12, 0));
        final rider = ValueNotifier<RiderLocation?>(RiderLocation(orderId: order.id, lat: 23.0636, lng: 76.8598, receivedAt: fixAt ?? clock.value));
        await tester.pumpWidget(MaterialApp(
          theme: KraveoTheme.customer(),
          home: Scaffold(
            body: SingleChildScrollView(
              child: TrackingMap(order: order, rider: rider, factory: factory ?? _FakeMaps(available: false), clock: () => clock.value),
            ),
          ),
        ));
        await tester.pump();
        return (rider, clock);
      }

      testWidgets('"about N min" disappears by itself when the rider stops reporting, and comes back with a new fix', (tester) async {
        final (rider, clock) = await pumpMap(tester, _live());
        expect(find.textContaining('Rider is about'), findsOneWidget);
        expect(find.byType(StaleRiderLine), findsNothing);

        // Nothing else happens: no new fix, no rebuild of the screen - only time passes.
        clock.value = clock.value.add(const Duration(minutes: 3));
        await tester.pump(kStaleCheckInterval + const Duration(seconds: 1));
        expect(find.textContaining('Rider is about'), findsNothing, reason: 'a 3-minute-old fix is no longer an ETA');
        expect(find.byType(StaleRiderLine), findsOneWidget);
        expect(find.textContaining('isn\'t updating'), findsOneWidget);

        rider.value = RiderLocation(orderId: 't-1', lat: 23.0636, lng: 76.8598, receivedAt: clock.value);
        await tester.pump();
        expect(find.textContaining('Rider is about'), findsOneWidget);
        expect(find.byType(StaleRiderLine), findsNothing);
      });

      testWidgets('the real map is told to mark the marker stale (and fresh again)', (tester) async {
        final maps = _FakeMaps();
        final (rider, clock) = await pumpMap(tester, _live(), factory: maps);
        await tester.pump(const Duration(milliseconds: 100));
        final spec = maps.specs.last;
        expect(spec.riderStale!.value, isFalse);
        clock.value = clock.value.add(const Duration(minutes: 5));
        await tester.pump(kStaleCheckInterval + const Duration(seconds: 1));
        expect(spec.riderStale!.value, isTrue);
        rider.value = RiderLocation(orderId: 't-1', lat: 23.0637, lng: 76.8598, receivedAt: clock.value);
        await tester.pump();
        expect(spec.riderStale!.value, isFalse);
      });

      testWidgets('the age timer is cancelled with the widget (no pending timer after dispose)', (tester) async {
        await pumpMap(tester, _live());
        await tester.pumpWidget(const SizedBox());
        // flutter_test fails the test here if a periodic timer was left behind.
      });

      testWidgets('the strip says "GPS live" only while the rider carries the food, not on the way to the restaurant', (tester) async {
        await pumpMap(tester, _live(status: 'ACCEPTED'));
        expect(find.byType(AnimatedRiderMap), findsOneWidget);
        expect(find.textContaining('GPS'), findsNothing);

        await pumpMap(tester, _live(status: 'PICKED_UP'));
        expect(find.text('GPS live'), findsOneWidget);
      });

      testWidgets('the strip\'s GPS age keeps counting without new fixes', (tester) async {
        final (_, clock) = await pumpMap(tester, _live());
        expect(find.text('GPS live'), findsOneWidget);
        clock.value = clock.value.add(const Duration(minutes: 4));
        await tester.pump(kStaleCheckInterval + const Duration(seconds: 1));
        expect(find.text('GPS 4 min ago'), findsOneWidget);
      });
    });
  });

  // ================================================================================ Me / sign-up ====
  group('Me tab, sign-up and reviews (CU2-06, CU1-13 / 17 / 19)', () {
    testWidgets('the Me tab shows the support e-mail; tapping opens the mail app, or copies the address when there is none', (tester) async {
      final opened = <Uri>[];
      ExternalLinks.launcher = (uri) async {
        opened.add(uri);
        return true;
      };
      await _pump(tester, const ProfileScreen());
      final row = find.byWidgetPredicate((w) => w is KPressable && (w.semanticLabel ?? '').startsWith('Contact Kraveo support'));
      await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
      expect(find.text(kSupportEmail), findsOneWidget);
      await tester.tap(row);
      await tester.pump();
      expect(opened.single.scheme, 'mailto');
      expect(opened.single.path, 'kraveo.contact@gmail.com');

      final clip = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') clip.add((call.arguments as Map)['text'] as String);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      ExternalLinks.launcher = (uri) async => false;
      await tester.tap(row);
      await tester.pump(const Duration(milliseconds: 300));
      expect(clip, [kSupportEmail]);
      expect(find.textContaining('No email app found'), findsOneWidget);
    });

    testWidgets('the coins card no longer promises "50 coins = ₹20 off"', (tester) async {
      await _pump(tester, const ProfileScreen());
      expect(find.textContaining('50 coins'), findsNothing);
      expect(find.textContaining('off'), findsNothing);
      expect(find.text('Redeeming soon'), findsOneWidget);
    });

    testWidgets('sign-up step 1: hardware back leaves the app; later steps go back one step (never while saving)', (tester) async {
      final session = SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())
        ..beginForTest({'id': 'u1', 'name': null, 'email': 'a@x.com', 'role': 'STUDENT'}, needsProfile: true, googleName: 'Aarav Sharma');
      await _pump(tester, const ProfileSetupScreen(), session: session);
      bool canPop() => tester.widgetList(find.descendant(of: find.byType(ProfileSetupScreen), matching: find.byWidgetPredicate((w) => w is PopScope))).cast<PopScope>().first.canPop;
      expect(canPop(), isTrue, reason: 'step 1: back is allowed to leave');

      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9876543210');
      await tester.tap(find.text('Continue'));
      await _settle(tester);
      expect(canPop(), isFalse, reason: 'step 2: back goes to step 1 instead');
      await tester.binding.handlePopRoute();
      await _settle(tester);
      expect(canPop(), isTrue);
      expect(find.byKey(const ValueKey('name-field')), findsOneWidget);
    });

    testWidgets('the review notes are capped at the server\'s 300 characters (the kitchen note leaves room for the tags)', (tester) async {
      final order = OrderModel.tryParse(orderJson(status: 'DELIVERED', paymentStatus: 'PAID', driver: {'id': 'd', 'name': 'Ravi'}))!;
      await _pump(tester, Scaffold(body: Builder(builder: (context) => Center(child: ElevatedButton(onPressed: () => ReviewModal.show(context, order: order), child: const Text('open'))))));
      await tester.tap(find.text('open'));
      await _settle(tester);
      expect(find.textContaining('Earn Kraveo Coins'), findsNothing);
      TextField field(String hintStart) => tester.widgetList<TextField>(find.byType(TextField)).firstWhere((w) => (w.decoration?.hintText ?? '').startsWith(hintStart));
      expect(field('Private note').maxLength, kReviewNoteMaxLength);
      await tester.drag(find.byType(ListView).last, const Offset(0, -900));
      await tester.pump(const Duration(milliseconds: 400));
      expect(field('A note for the kitchen').maxLength, lessThanOrEqualTo(kReviewNoteMaxLength - 62), reason: 'tags + note must fit in 300 characters');
      expect(kReviewNoteMaxLength, 300);
    });
  });
}
