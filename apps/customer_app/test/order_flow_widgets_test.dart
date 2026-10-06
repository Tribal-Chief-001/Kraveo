import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/checkout_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/payment_success_screen.dart';
import 'package:customer_app/screens/order_history_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';

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

Map<String, dynamic> student() => {'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 2', 'avatarId': 3, 'kraveoCoins': 120};

SessionProvider signedIn() => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())..beginForTest(student());

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

CartProvider cartWithThali() {
  final cart = CartProvider();
  cart.addItem(
    item: const MenuItemModel(id: 'm-thali', vendorId: 'ven-1', name: 'Paneer Thali', price: 120, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true),
    dhabaId: 'ven-1',
    dhabaName: 'Sharma Highway Dhaba',
  );
  return cart; // estimate: 120 + 25 + 15 = 160
}

DhabaProvider liveDhabas() => DhabaProvider()..markLiveForTest(['ven-1']);

Future<void> pumpApp(WidgetTester tester, Widget child, {required OrderProvider orders, CartProvider? cart, DhabaProvider? dhabas, SessionProvider? session}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
  await tester.pumpWidget(MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionProvider>.value(value: session ?? signedIn()),
      ChangeNotifierProvider<DhabaProvider>.value(value: dhabas ?? liveDhabas()),
      ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
      ChangeNotifierProvider<OrderProvider>.value(value: orders),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: child),
  ));
  await settle(tester);
}

/// Lets KReveal / sheets finish and async fakes complete.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Finder button(String label) => find.widgetWithText(KButton, label);

Future<void> tapButton(WidgetTester tester, String label) async {
  final f = button(label);
  await tester.ensureVisible(f.first);
  await tester.pump();
  await tester.tap(f.first);
  await settle(tester);
  // Pay on a not-yet-placed order first asks "Confirm your delivery point"; these tests are about
  // what happens after that (the sheet itself is covered in campus_drop_points_test.dart).
  final confirm = button('Confirm and pay');
  if (confirm.evaluate().isNotEmpty) {
    await tester.tap(confirm.first);
    await settle(tester);
  }
}

Future<void> scrollTo(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first);
  await tester.pump();
}

void main() {
  setUpAll(loadKraveoFonts);
  setUp(() => FakeRealtime.created.clear());

  group('Checkout', () {
    testWidgets('server total differs: shown before paying; cancelled payment offers retry on the SAME order; success opens tracking', (tester) async {
      final api = FakeOrderApi();
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final orders = fakeOrders(api, gateway: gateway);
      final cart = cartWithThali();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: orders, cart: cart);

      expect(find.textContaining('Estimate'), findsNothing, reason: 'below the fold until scrolled');
      await tapButton(tester, 'Pay ₹160');
      expect(api.creates, hasLength(1));
      expect(gateway.opened, isEmpty, reason: 'server total (₹245) differs from the estimate: show it first');
      expect(find.text('Updated total: ₹245'), findsOneWidget);
      expect(button('Pay ₹245'), findsOneWidget);
      expect(find.textContaining('Pay by'), findsOneWidget);

      await tapButton(tester, 'Pay ₹245');
      expect(gateway.opened, hasLength(1));
      expect(gateway.opened.single.amountPaise, 24500);
      expect(find.text('Payment not completed'), findsOneWidget);
      expect(button('Try payment again · ₹245'), findsOneWidget);
      expect(button('Cancel order'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Retry: same order, no second POST.
      gateway.next = const GatewayResult.success(PaymentProof(razorpayOrderId: 'r', razorpayPaymentId: 'p', razorpaySignature: 's'));
      api.onVerify = (p) async {
        final id = api.creates.length == 1 ? api.server.keys.single : '';
        api.server[id] = orderModel(id: id, paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 5)));
        return const OrderResult.ok(null);
      };
      await tapButton(tester, 'Try payment again · ₹245');
      expect(api.creates, hasLength(1));
      expect(api.paymentStarts, hasLength(2));
      expect(api.paymentStarts.toSet(), hasLength(1));
      // A short success screen comes first, then it hands over to tracking by itself.
      expect(find.byType(PaymentSuccessScreen), findsOneWidget);
      expect(find.text('Payment successful'), findsOneWidget);
      expect(find.byType(LiveTrackingScreen), findsNothing);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(PaymentSuccessScreen), findsNothing);
      expect(find.byType(LiveTrackingScreen), findsOneWidget);
      expect(find.text('Waiting for the restaurant'), findsOneWidget);
      expect(cart.items, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('same total: payment opens straight away', (tester) async {
      final api = FakeOrderApi();
      api.onCreate = (r) async {
        final o = orderModel(id: 'same', totalAmount: 160);
        api.server[o.id] = o;
        return OrderResult.ok(o);
      };
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final orders = fakeOrders(api, gateway: gateway);
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: orders, cart: cartWithThali());
      await tapButton(tester, 'Pay ₹160');
      expect(gateway.opened, hasLength(1));
      expect(button('Try payment again · ₹160'), findsOneWidget);
    });

    testWidgets('server refusals and offline show clear messages and never a stuck spinner', (tester) async {
      final api = FakeOrderApi()..onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rateLimited, statusCode: 429, message: 'You already have 3 unpaid orders.'));
      final orders = fakeOrders(api);
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: orders, cart: cartWithThali());
      await tapButton(tester, 'Pay ₹160');
      expect(find.text('You already have 3 unpaid orders.'), findsWidgets);
      expect(tester.widget<KButton>(button('Pay ₹160')).loading, isFalse);
      expect(tester.widget<KButton>(button('Pay ₹160')).onPressed, isNotNull);

      api.onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      await tapButton(tester, 'Pay ₹160');
      expect(find.textContaining('No internet connection'), findsWidgets);
      expect(find.textContaining('won\'t get a duplicate order'), findsWidgets);
      expect(api.creates[0].clientRequestId, api.creates[1].clientRequestId);
      expect(tester.takeException(), isNull);
    });

    testWidgets('payment window expired on the server: back to the cart, next tap places a new order', (tester) async {
      final api = FakeOrderApi()..onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'PAYMENT_WINDOW_EXPIRED'));
      final orders = fakeOrders(api);
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: orders, cart: cartWithThali());
      await tapButton(tester, 'Pay ₹160');
      await tapButton(tester, 'Pay ₹245');
      expect(find.textContaining('15 minutes to pay'), findsWidgets);
      expect(button('Pay ₹160'), findsOneWidget);
      api.onCreatePayment = null;
      await tapButton(tester, 'Pay ₹160');
      expect(api.creates, hasLength(2));
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a kitchen that is not in the live catalog cannot be ordered from', (tester) async {
      final api = FakeOrderApi();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: fakeOrders(api), cart: cartWithThali(), dhabas: DhabaProvider());
      await tapButton(tester, 'Pay ₹160');
      expect(api.creates, isEmpty);
      expect(find.textContaining('live menu'), findsWidgets);
    });

    testWidgets('leaving and re-opening checkout shows the same unpaid order instead of creating another', (tester) async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final cart = cartWithThali();
      await pumpApp(
        tester,
        Builder(builder: (context) => Scaffold(body: Center(child: ElevatedButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const CheckoutScreen(selectedHostel: 'Block 2'))), child: const Text('open'))))),
        orders: orders,
        cart: cart,
      );
      await tester.tap(find.text('open'));
      await settle(tester);
      await tapButton(tester, 'Pay ₹160');
      expect(find.text('Updated total: ₹245'), findsOneWidget);
      tester.state<NavigatorState>(find.byType(Navigator)).pop();
      await settle(tester);
      await tester.tap(find.text('open'));
      await settle(tester);
      expect(find.textContaining('You already placed this order'), findsOneWidget);
      expect(button('Pay ₹245'), findsOneWidget);
      expect(api.creates, hasLength(1));
    });

    testWidgets('cancelling the unpaid order at checkout returns to the editable cart', (tester) async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'Block 2'), orders: orders, cart: cartWithThali());
      await tapButton(tester, 'Pay ₹160');
      await tapButton(tester, 'Cancel order');
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Cancel order')).last);
      await settle(tester);
      expect(api.cancels, hasLength(1));
      expect(button('Pay ₹160'), findsOneWidget);
      // A new attempt gets a new idempotency key.
      await tapButton(tester, 'Pay ₹160');
      expect(api.creates, hasLength(2));
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
    });
  });

  group('Tracking states', () {
    Future<(FakeOrderApi, OrderProvider)> show(WidgetTester tester, OrderModel order) async {
      final api = FakeOrderApi()..server[order.id] = order;
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, LiveTrackingScreen(orderId: order.id), orders: orders);
      return (api, orders);
    }

    testWidgets('placed + unpaid: retry payment, deadline and cancel; cancelling shows the result', (tester) async {
      final order = orderModel(id: 'u-1', createdAt: DateTime.now().toUtc().subtract(const Duration(minutes: 3)));
      final (api, _) = await show(tester, order);
      expect(find.text('Payment not completed'), findsWidgets);
      expect(find.textContaining('Pay by ${order.paymentDeadline.toLocal().hour % 12 == 0 ? 12 : order.paymentDeadline.toLocal().hour % 12}:'), findsOneWidget);
      expect(button('Try payment again · ₹245'), findsOneWidget);
      expect(find.text('Order journey'), findsNothing, reason: 'no progress is shown for an unpaid order');

      await tapButton(tester, 'Cancel order');
      expect(find.textContaining('nothing is charged'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Cancel order')).last);
      await settle(tester);
      expect(api.cancels, ['u-1']);
      expect(find.text('This order was cancelled'), findsOneWidget);
      expect(find.text('You cancelled this order.'), findsOneWidget);
      expect(find.text('No payment was taken for this order.'), findsOneWidget);
      expect(find.textContaining('5–7 working days'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('placed + paid can be cancelled; accepted cannot', (tester) async {
      await show(tester, orderModel(id: 'p-1', paymentStatus: 'PAID'));
      expect(find.text('Waiting for the restaurant'), findsOneWidget);
      await scrollTo(tester, button('Cancel order'));
      expect(button('Cancel order'), findsOneWidget);
      expect(find.textContaining('has until'), findsOneWidget, reason: 'acceptBy from the server');

      await show(tester, orderModel(id: 'a-1', status: 'ACCEPTED', paymentStatus: 'PAID'));
      expect(find.text('Restaurant accepted'), findsOneWidget);
      expect(button('Cancel order'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('restaurant rejection with reason and refund wording only when REFUNDED', (tester) async {
      await show(tester, orderModel(id: 'r-1', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'VENDOR', cancelReason: 'Out of paneer'));
      expect(find.text('Cancelled and refunded'), findsOneWidget);
      expect(find.text('The restaurant couldn’t take your order: Out of paneer'), findsOneWidget);
      expect(find.textContaining('5–7 working days'), findsOneWidget);

      await show(tester, orderModel(id: 'r-2', status: 'CANCELLED', paymentStatus: 'PAID', cancelledBy: 'SYSTEM', cancelReason: kReasonRestaurantNoResponse));
      expect(find.textContaining('Restaurant did not respond'), findsOneWidget);
      expect(find.textContaining('refund is being processed'), findsOneWidget);
      expect(find.textContaining('5–7 working days'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a socket update moves the screen; the 15 s poll keeps asking the server', (tester) async {
      final t0 = DateTime.now().toUtc();
      final (api, _) = await show(tester, orderModel(id: 's-1', paymentStatus: 'PAID', updatedAt: t0));
      final socket = FakeRealtime.created.single..simulateConnect();
      expect(socket.joined, contains('s-1'));
      socket.emitOrder(orderJson(id: 's-1', status: 'ARRIVED_AT_GATE', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(minutes: 20)), otpCode: '5931', driver: {'id': 'd', 'name': 'Ravi', 'phone': '+91 9000000000'}));
      api.server['s-1'] = OrderModel.tryParse(orderJson(id: 's-1', status: 'ARRIVED_AT_GATE', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(minutes: 20)), otpCode: '5931', driver: {'id': 'd', 'name': 'Ravi'}))!;
      await settle(tester);
      expect(find.text('Your rider is at the gate'), findsOneWidget);
      expect(find.text('Your gate OTP'), findsOneWidget);
      for (final d in ['5', '9', '3', '1']) {
        expect(find.text(d), findsWidgets);
      }
      final before = api.fetchedIds.length;
      await tester.pump(const Duration(seconds: 15));
      await tester.pump();
      expect(api.fetchedIds.length, greaterThan(before));
      expect(tester.takeException(), isNull);
    });

    testWidgets('delivered: rating credits the server\'s coin balance and hides the button', (tester) async {
      final api = FakeOrderApi()..server['d-1'] = orderModel(id: 'd-1', status: 'DELIVERED', paymentStatus: 'PAID', driver: {'id': 'r', 'name': 'Ravi'});
      final orders = fakeOrders(api)..beginSession('u1');
      final cart = CartProvider()..setKraveoCoins(120);
      await pumpApp(tester, const LiveTrackingScreen(orderId: 'd-1'), orders: orders, cart: cart);
      await scrollTo(tester, button('Rate your meal'));
      await tapButton(tester, 'Rate your meal');
      await tapButton(tester, 'Submit rating');
      expect(api.reviews.single.orderId, 'd-1');
      expect(api.reviews.single.dishRatings.keys, containsAll(['m-thali', 'm-paratha']));
      expect(cart.userKraveoCoins, 130);
      expect(button('Rate your meal'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('Order history', () {
    testWidgets('real empty state after loading', (tester) async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, const OrderHistoryScreen(), orders: orders);
      expect(find.text('No orders yet'), findsOneWidget);
    });

    testWidgets('error with retry, then paginated list with load more', (tester) async {
      final api = FakeOrderApi();
      var fail = true;
      api.onFetchList = (scope, cursor) async {
        if (scope == 'active') return const OrderResult.ok(OrdersPage([], null));
        if (fail) return const OrderResult.fail(OrderApiError(OrderErrorKind.server, statusCode: 500));
        if (cursor == null) return OrderResult.ok(OrdersPage([orderModel(id: 'h1', status: 'DELIVERED', paymentStatus: 'PAID')], 'next'));
        return OrderResult.ok(OrdersPage([orderModel(id: 'h2', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'VENDOR')], null));
      };
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, const OrderHistoryScreen(), orders: orders);
      expect(find.text('Couldn\'t load your orders'), findsOneWidget);
      fail = false;
      await tapButton(tester, 'Try again');
      expect(find.text('Delivered'), findsOneWidget);
      await scrollTo(tester, find.text('That\'s all your orders.'));
      expect(api.fetchCursors, contains('next'));
      expect(find.text('Refunded'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('Whole app', () {
    testWidgets('app start restores the active order from the server; logout clears it', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      CustomerApiService.httpClientOverride = MockClient((req) async {
        final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
        if (path == '/auth/profile') return http.Response(jsonEncode({'success': true, 'user': student(), 'needsProfile': false}), 200);
        return http.Response('{"success":false}', 500);
      });
      addTearDown(() => CustomerApiService.httpClientOverride = null);
      final api = FakeOrderApi()
        ..onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'active' ? [orderModel(id: 'live-1')] : [], null));
      late OrderProvider orders;
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(KraveoCustomerApp(googleAuth: _NoGoogle(), createOrders: () => orders = fakeOrders(api)));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 1));
      expect(api.fetchScopes, containsAll(['active', 'history']));
      expect(find.text('Payment not completed'), findsOneWidget, reason: 'the Home bar shows the restored unpaid order');

      await tester.element(find.byType(Scaffold).first).read<SessionProvider>().logout();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(seconds: 1));
      expect(orders.activeOrders, isEmpty);
      expect(orders.orderById('live-1'), isNull);
    });
  });
}
