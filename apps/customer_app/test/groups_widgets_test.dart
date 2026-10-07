import 'dart:async';

import 'package:customer_app/models/dhaba.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/models/order_group.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/checkout_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/order_history_screen.dart';
import 'package:customer_app/screens/payment_success_screen.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:customer_app/widgets/cart_sheet.dart';
import 'package:customer_app/widgets/ui/sheet_chrome.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';

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

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

SessionProvider signedIn() => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())
  ..beginForTest({'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 2', 'avatarId': 3, 'kraveoCoins': 120});

MenuItemModel dish(String id, String vendor, double price, {String? name}) =>
    MenuItemModel(id: id, vendorId: vendor, name: name ?? 'Dish $id', price: price, category: 'x', description: 'd', imageUrl: '', isAvailable: true);

/// Kitchen 1 (thali 100) + Kitchen 2 (roll 90): estimate = 190 + 25 + 15 = 230, the server's quote says 260.
CartProvider groupCart() {
  final cart = CartProvider();
  cart.addItem(item: dish('m-thali', 'gx-ven-1', 100, name: 'Paneer Thali'), dhabaId: 'gx-ven-1', dhabaName: 'Kitchen 1');
  cart.addItem(item: dish('m-roll', 'gx-ven-2', 90, name: 'Paneer Roll'), dhabaId: 'gx-ven-2', dhabaName: 'Kitchen 2');
  return cart;
}

CartProvider singleCart() {
  final cart = CartProvider();
  cart.addItem(item: dish('m-thali', 'gx-ven-1', 120, name: 'Paneer Thali'), dhabaId: 'gx-ven-1', dhabaName: 'Kitchen 1');
  return cart;
}

DhabaProvider liveDhabas() => DhabaProvider()..markLiveForTest(['gx-ven-1', 'gx-ven-2']);

Dhaba kitchen(String id, String name) => Dhaba(id: id, name: name, category: 'North Indian', rating: 4.5, eta: '20-25 min', bannerUrl: '', isAcceptingOrders: true, address: 'Kothri');

DhabaProvider catalog({bool second = true}) => DhabaProvider(
      dhabas: [kitchen('gx-ven-1', 'Kitchen 1'), if (second) kitchen('gx-ven-2', 'Kitchen 2')],
      menus: {
        'gx-ven-1': [dish('m-thali', 'gx-ven-1', 90, name: 'Paneer Thali'), dish('m-paratha', 'gx-ven-1', 90, name: 'Aloo Paratha')],
        if (second) 'gx-ven-2': [dish('m-roll', 'gx-ven-2', 90, name: 'Paneer Roll')],
      },
    );

Future<void> pumpApp(
  WidgetTester tester,
  Widget child, {
  required OrderProvider orders,
  CartProvider? cart,
  DhabaProvider? dhabas,
  double textScale = 1.3,
  Size size = const Size(360, 640),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
  await tester.pumpWidget(MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionProvider>.value(value: signedIn()),
      ChangeNotifierProvider<DhabaProvider>.value(value: dhabas ?? liveDhabas()),
      ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
      ChangeNotifierProvider<OrderProvider>.value(value: orders),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: child),
  ));
  await settle(tester);
}

Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Finder button(String label) => find.widgetWithText(KButton, label);

Future<void> tapButton(WidgetTester tester, String label) async {
  final f = button(label);
  if (f.evaluate().isEmpty) await scrollTo(tester, f);
  await tester.ensureVisible(f.first);
  await tester.pump();
  await tester.tap(f.first);
  await settle(tester);
  final confirm = button('Confirm and pay');
  if (confirm.evaluate().isNotEmpty) {
    await tester.tap(confirm.first);
    await settle(tester);
  }
}

Future<void> scrollTo(WidgetTester tester, Finder f) async {
  await tester.scrollUntilVisible(f, 200, scrollable: find.byType(Scrollable).first, maxScrolls: 80);
  await tester.pump();
}

OrderQuote quote({double total = 260, int count = 2, int max = 3}) => OrderQuote.tryParse(quoteJson(count: count, total: total, max: max))!;

OrderGroupView groupView({List<String> statuses = const ['PLACED', 'PLACED'], String payment = 'PENDING', String refund = 'NONE', List<String?> by = const [null, null], List<String?> reasons = const [null, null], String? otp, Map<String, dynamic>? driver}) =>
    OrderGroupView.tryParse(groupViewJson(paymentStatus: payment, orders: groupChildrenJson(statuses: statuses, paymentStatus: payment, refundStatus: refund, cancelledBy: by, cancelReasons: reasons, otpCode: otp, driver: driver)))!;

void putGroup(FakeOrderApi api, OrderGroupView g) {
  api.groupServer[g.id] = g;
  for (final o in g.orders) {
    api.server[o.id] = o;
  }
}

const _rider = {'id': 'd1', 'name': 'Vikram', 'phone': '+91 98765 43210'};

void main() {
  setUpAll(loadKraveoFonts);
  setUp(() => FakeRealtime.created.clear());

  group('Checkout: the bill comes from the server quote', () {
    testWidgets('ONE restaurant: bill and Pay button show the quote; the order still goes through POST /orders', (tester) async {
      final api = FakeOrderApi();
      api.onQuote = (r) async => OrderResult.ok(OrderQuote.tryParse({
            'restaurantCount': 1,
            'subtotal': 120,
            'fees': {'total': 20, 'base': 20, 'baseWaived': false, 'extraRestaurants': 0, 'extraRestaurantFee': 15, 'extraTotal': 0},
            'discount': 0,
            'couponCode': null,
            'total': 140,
            'perRestaurant': [{'vendorId': 'gx-ven-1', 'vendorName': 'Kitchen 1', 'subtotal': 120, 'fee': 20}],
            'maxRestaurants': 3,
          })!);
      final orders = fakeOrders(api);
      final cart = singleCart();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: orders, cart: cart);
      expect(api.quotes, hasLength(1));
      expect(api.quotes.single.restaurants.single.vendorId, 'gx-ven-1');
      expect(button('Pay ₹140'), findsOneWidget, reason: 'the quote total, not the Rs 25 estimate (145)');
      await scrollTo(tester, find.text('Bill details'));
      expect(find.textContaining('Estimate'), findsNothing);
      expect(find.textContaining('Extra restaurant fee'), findsNothing);
      expect(find.text('Delivery & service fee'), findsOneWidget);
      expect(find.text('₹20'), findsWidgets);

      await tapButton(tester, 'Pay ₹140');
      expect(api.creates, hasLength(1));
      expect(api.groupCreates, isEmpty);
      expect(find.text('Updated total: ₹245'), findsOneWidget, reason: 'the safety net when the server total differs from what was shown');
      expect(tester.takeException(), isNull);
    });

    testWidgets('two restaurants: estimate while loading (marked), then the quote with the extra-restaurant row', (tester) async {
      final gate = Completer<OrderResult<OrderQuote>>();
      final api = FakeOrderApi()..onQuote = (r) => gate.future;
      final orders = fakeOrders(api);
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: orders, cart: groupCart());
      expect(api.quotes, hasLength(1));
      expect(api.quotes.single.restaurants.map((r) => r.vendorId), ['gx-ven-1', 'gx-ven-2']);
      expect(button('Pay ₹230'), findsOneWidget, reason: 'local estimate 190 + 25 + 15 while the quote loads');
      await scrollTo(tester, find.text('Bill details'));
      expect(find.textContaining('Estimate'), findsOneWidget);
      expect(find.text('Extra restaurant fee (x 1)'), findsOneWidget);

      gate.complete(OrderResult.ok(quote()));
      await settle(tester);
      expect(button('Pay ₹260'), findsOneWidget);
      await scrollTo(tester, find.text('Bill details'));
      expect(find.textContaining('Estimate'), findsNothing);
      expect(find.text('Items subtotal'), findsOneWidget);
      expect(find.text('₹270'), findsOneWidget);
      expect(find.text('Extra restaurant fee (x 1)'), findsOneWidget);
      expect(find.text('Coupon (KRAVEO50)'), findsOneWidget);
      expect(find.text('-₹50'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a quote that failed offline keeps the marked estimate, no scary text, and can be retried', (tester) async {
      final api = FakeOrderApi();
      var offline = true;
      api.onQuote = (r) async => offline ? const OrderResult.fail(OrderApiError(OrderErrorKind.offline)) : OrderResult.ok(quote());
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: fakeOrders(api), cart: groupCart());
      expect(button('Pay ₹230'), findsOneWidget);
      await scrollTo(tester, find.text('Bill details'));
      expect(find.textContaining('Estimate'), findsOneWidget);
      expect(find.text('Get the exact price'), findsOneWidget);
      offline = false;
      await tester.tap(find.text('Get the exact price'));
      await settle(tester);
      expect(button('Pay ₹260'), findsOneWidget);
    });

    testWidgets('quote refusals are shown plainly: too many restaurants blocks Pay and teaches the cart its limit', (tester) async {
      final api = FakeOrderApi();
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'TOO_MANY_RESTAURANTS', message: 'You can order from at most 1 restaurants at once.', maxRestaurants: 1));
      final cart = groupCart();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: fakeOrders(api), cart: cart);
      expect(cart.maxRestaurants, 1);
      expect(find.textContaining('Ordering from several restaurants at once is not available right now'), findsWidgets);
      expect(tester.widget<KButton>(button('Pay ₹230')).onPressed, isNull, reason: 'cannot succeed: no point sending it');
      expect(api.groupCreates, isEmpty);
    });

    testWidgets('a coupon the server refuses is explained in the bill; Pay still works (the coupon is dropped when placing)', (tester) async {
      final api = FakeOrderApi();
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'COUPON_NOT_APPLICABLE', message: 'VITFIRST is only for your first order.'));
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: fakeOrders(api), cart: groupCart());
      await scrollTo(tester, find.text('Bill details'));
      expect(find.text('VITFIRST is only for your first order.'), findsOneWidget);
      expect(tester.widget<KButton>(button('Pay ₹230')).onPressed, isNotNull);
    });

    testWidgets('an old server without /orders/quote: single behaviour, plain estimate, cart limit 1', (tester) async {
      final api = FakeOrderApi(); // quote answers 404 by default
      final cart = singleCart();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: fakeOrders(api), cart: cart);
      expect(button('Pay ₹145'), findsOneWidget);
      expect(cart.maxRestaurants, 1);
      expect(find.textContaining('not available'), findsNothing);
    });
  });

  group('Checkout: combined order', () {
    Future<(FakeOrderApi, OrderProvider, CartProvider, FakeGateway)> open(WidgetTester tester, {double textScale = 1.3, Size size = const Size(360, 640), FakeGateway? gateway}) async {
      final api = FakeOrderApi()..onQuote = (r) async => OrderResult.ok(quote());
      final gw = gateway ?? FakeGateway();
      final orders = fakeOrders(api, gateway: gw);
      final cart = groupCart();
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: orders, cart: cart, textScale: textScale, size: size);
      return (api, orders, cart, gw);
    }

    testWidgets('shows each restaurant with its subtotal; one POST /order-groups; payment on the PRIMARY id for the group total; retry, cancel copy, success and tracking', (tester) async {
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final (api, orders, cart, _) = await open(tester, gateway: gateway);
      expect(find.text('Your order · 2 restaurants'), findsOneWidget);
      expect(find.text('Kitchen 1'), findsWidgets);
      expect(find.text('Kitchen 2'), findsWidgets);
      expect(find.text('₹100'), findsWidgets);

      await tapButton(tester, 'Pay ₹260');
      expect(api.creates, isEmpty);
      expect(api.groupCreates, hasLength(1));
      expect(api.groupCreates.single.restaurants.map((r) => r.vendorId), ['gx-ven-1', 'gx-ven-2']);
      expect(api.groupCreates.single.dropoffHostel, 'BH2');
      expect(gateway.opened.single.orderId, 'gx-order-1');
      expect(gateway.opened.single.amountPaise, 26000);
      expect(find.text('Payment not completed'), findsOneWidget);
      expect(button('Try payment again · ₹260'), findsOneWidget);
      expect(find.text('Updated total: ₹260'), findsNothing, reason: 'the quote was right');

      // Cancelling cancels the whole combined order and says so.
      await tapButton(tester, 'Cancel order');
      expect(find.textContaining('This cancels your whole order'), findsWidgets);
      await tester.tap(find.text('Keep it'));
      await settle(tester);
      expect(api.cancels, isEmpty);

      // Retry on the SAME order; success.
      gateway.next = const GatewayResult.success(PaymentProof(razorpayOrderId: 'r', razorpayPaymentId: 'p', razorpaySignature: 's'));
      api.onVerify = (p) async {
        putGroup(api, groupView(payment: 'PAID'));
        return const OrderResult.ok(null);
      };
      await tapButton(tester, 'Try payment again · ₹260');
      expect(api.groupCreates, hasLength(1));
      expect(api.paymentStarts, ['gx-order-1', 'gx-order-1']);
      expect(find.byType(PaymentSuccessScreen), findsOneWidget);
      expect(find.text('Waiting for your 2 restaurants to accept your order.'), findsOneWidget);
      expect(find.text('₹260'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(LiveTrackingScreen), findsOneWidget);
      expect(find.text('Your 2 restaurants'), findsOneWidget);
      expect(find.text('Waiting for the restaurants'), findsOneWidget);
      expect(cart.items, isEmpty);
      expect(orders.activeOrders, hasLength(1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('cancelling the unpaid combined order cancels every restaurant (one request) and returns to the cart', (tester) async {
      final (api, orders, cart, _) = await open(tester, gateway: FakeGateway()..next = const GatewayResult.cancelled());
      api.onCancel = (id) async {
        final g = groupView(statuses: const ['CANCELLED', 'CANCELLED'], by: const ['CUSTOMER', 'SYSTEM'], reasons: const ['Cancelled at checkout', 'Another restaurant in your order could not take it']);
        putGroup(api, g);
        return OrderResult.ok(g.orders.first);
      };
      await tapButton(tester, 'Pay ₹260');
      expect(button('Try payment again · ₹260'), findsOneWidget);
      await tapButton(tester, 'Cancel order');
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Cancel order')).last);
      await settle(tester);
      expect(api.cancels, ['gx-order-1']);
      expect(orders.activeOrders.single.status, OrderProgressStatus.cancelled);
      expect(cart.restaurantCount, 2, reason: 'the cart stays so the student can change it and order again');
      // A new attempt gets a new idempotency key.
      await tapButton(tester, 'Pay ₹260');
      expect(api.groupCreates, hasLength(2));
      expect(api.groupCreates[1].clientRequestId, isNot(api.groupCreates[0].clientRequestId));
    });

    testWidgets('same cart, network failure twice: same idempotency key both times', (tester) async {
      final (api, _, _, _) = await open(tester);
      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      await tapButton(tester, 'Pay ₹260');
      await tapButton(tester, 'Pay ₹260');
      expect(api.groupCreates, hasLength(2));
      expect(api.groupCreates[0].clientRequestId, api.groupCreates[1].clientRequestId);
      expect(find.textContaining('No internet connection'), findsWidgets);
      expect(find.textContaining('won\'t get a duplicate order'), findsWidgets);
    });

    testWidgets('a server total that differs from the quote is shown as "Updated total" before any money is taken', (tester) async {
      final (api, _, _, gateway) = await open(tester);
      api.onCreateGroup = (r) async {
        final kids = groupChildrenJson();
        kids.first['totalAmount'] = 175; // 175 + 95 = 270
        final g = OrderGroupView.tryParse(groupViewJson(orders: kids, total: 270))!;
        putGroup(api, g);
        return OrderResult.ok(g);
      };
      await tapButton(tester, 'Pay ₹260');
      expect(gateway.opened, isEmpty);
      expect(find.text('Updated total: ₹270'), findsOneWidget);
      expect(button('Pay ₹270'), findsOneWidget);
      await scrollTo(tester, find.text('Extra restaurant fee (x 1)'));
      expect(find.text('Extra restaurant fee (x 1)'), findsOneWidget, reason: 'the placed bill splits the base fee from the extra restaurant fee');
    });

    testWidgets('a closed restaurant is named; an old server (404) switches the cart back to one restaurant', (tester) async {
      final (api, _, cart, _) = await open(tester);
      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'VENDOR_CLOSED', message: 'This Dhaba is currently CLOSED for new orders.', vendorId: 'gx-ven-2'));
      await tapButton(tester, 'Pay ₹260');
      expect(find.textContaining('Kitchen 2 is closed for new orders right now'), findsWidgets);

      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.notFound, statusCode: 404));
      await tapButton(tester, 'Pay ₹260');
      expect(find.textContaining('not available yet'), findsWidgets);
      expect(cart.maxRestaurants, 1);
      await settle(tester);
      expect(find.textContaining('Go back and keep one restaurant'), findsWidgets);
      expect(tester.widget<KButton>(button('Pay ₹260')).onPressed, isNull);
    });

    testWidgets('a restaurant whose live menu has not loaded blocks the order by name', (tester) async {
      final api = FakeOrderApi()..onQuote = (r) async => OrderResult.ok(quote());
      await pumpApp(tester, const CheckoutScreen(selectedHostel: 'BH2'), orders: fakeOrders(api), cart: groupCart(), dhabas: DhabaProvider()..markLiveForTest(['gx-ven-1']));
      await tapButton(tester, 'Pay ₹260');
      expect(api.groupCreates, isEmpty);
      expect(find.textContaining('Kitchen 2\'s live menu'), findsWidgets);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('360x640 at ${scale}x text: no overflow before and after placing', (tester) async {
        final (api, _, _, _) = await open(tester, textScale: scale, gateway: FakeGateway()..next = const GatewayResult.cancelled());
        expect(tester.takeException(), isNull);
        await scrollTo(tester, find.text('Bill details'));
        expect(tester.takeException(), isNull);
        final g = groupView();
        putGroup(api, g);
        await tapButton(tester, 'Pay ₹260');
        await scrollTo(tester, find.text('Bill details'));
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('Cart sheet: several restaurants', () {
    Future<CartProvider> show(WidgetTester tester, {double textScale = 1.3}) async {
      final cart = groupCart();
      await pumpApp(
        tester,
        Builder(builder: (context) => Scaffold(body: Center(child: ElevatedButton(onPressed: () => CartSheet.show(context, selectedHostel: 'BH2'), child: const Text('open'))))),
        orders: fakeOrders(FakeOrderApi()),
        cart: cart,
        textScale: textScale,
      );
      await tester.tap(find.text('open'));
      await settle(tester);
      return cart;
    }

    testWidgets('grouped by restaurant with subtotals; remove one restaurant; clear all', (tester) async {
      final cart = await show(tester);
      expect(find.text('Your cart'), findsOneWidget);
      expect(find.textContaining('2 restaurants'), findsWidgets);
      expect(find.text('Kitchen 1'), findsOneWidget);
      expect(find.text('Kitchen 2'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Extra restaurant fee (x 1)'), 200, scrollable: find.descendant(of: find.byType(KSheetFrame), matching: find.byType(Scrollable)).first);
      expect(find.text('Extra restaurant fee (x 1)'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.drag(find.descendant(of: find.byType(KSheetFrame), matching: find.byType(Scrollable)).first, const Offset(0, 3000));
      await tester.pump();
      await tester.tap(find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Remove Kitchen 2 from your cart'));
      await settle(tester);
      expect(find.text('Remove Kitchen 2?'), findsOneWidget);
      await tester.tap(button('Remove'));
      await settle(tester);
      expect(cart.restaurants.map((r) => r.id), ['gx-ven-1']);
      expect(find.text('Kitchen 1'), findsWidgets);
    });

    testWidgets('Clear cart asks first and then empties it', (tester) async {
      final cart = await show(tester);
      await tester.scrollUntilVisible(button('Clear cart'), 200, scrollable: find.descendant(of: find.byType(KSheetFrame), matching: find.byType(Scrollable)).first);
      await tester.tap(button('Clear cart'));
      await settle(tester);
      expect(find.text('Clear your cart?'), findsOneWidget);
      await tester.tap(button('Keep it'));
      await settle(tester);
      expect(cart.restaurantCount, 2);
      await tester.tap(button('Clear cart'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Clear cart')).last);
      await settle(tester);
      expect(cart.items, isEmpty);
      expect(find.text('Your cart is empty'), findsOneWidget);
    });

    testWidgets('2x text on a small phone: no overflow', (tester) async {
      await show(tester, textScale: 2.0);
      expect(tester.takeException(), isNull);
    });
  });

  group('Tracking a combined order', () {
    Future<(FakeOrderApi, OrderProvider)> show(WidgetTester tester, OrderGroupView g, {String id = 'gx-order-1', double textScale = 1.3, DhabaProvider? dhabas}) async {
      final api = FakeOrderApi();
      putGroup(api, g);
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, LiveTrackingScreen(orderId: id), orders: orders, textScale: textScale, dhabas: dhabas);
      return (api, orders);
    }

    testWidgets('a row per restaurant, one total, opens from any restaurant\'s id; cancel is offered while every restaurant is placed', (tester) async {
      final (api, _) = await show(tester, groupView(payment: 'PAID'), id: 'gx-order-2');
      expect(find.text('Live tracking'), findsOneWidget);
      expect(find.textContaining('2 restaurants'), findsWidgets);
      expect(find.text('Your 2 restaurants'), findsOneWidget);
      expect(find.text('Kitchen 1'), findsWidgets);
      expect(find.text('Kitchen 2'), findsWidgets);
      expect(find.text('1 × Paneer Roll'), findsOneWidget);
      expect(find.text('Waiting for the restaurants'), findsOneWidget);
      expect(find.textContaining('₹260'), findsWidgets);
      expect(find.text('Placed'), findsWidgets);
      await scrollTo(tester, button('Cancel order'));
      expect(button('Cancel order'), findsOneWidget);
      expect(find.textContaining('have until'), findsOneWidget);
      expect(api.fetchedGroups, isNotEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('each restaurant has its own status chip; no cancel once one restaurant accepted', (tester) async {
      await show(tester, groupView(payment: 'PAID', statuses: const ['ACCEPTED', 'PLACED']));
      expect(find.text('Accepted'), findsWidgets);
      expect(find.text('Placed'), findsWidgets);
      expect(button('Cancel order'), findsNothing);
      await show(tester, groupView(payment: 'PAID', statuses: const ['PREPARING', 'READY_FOR_PICKUP']));
      expect(find.text('Preparing'), findsWidgets);
      expect(find.text('Ready'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('ONE rider card for the whole order', (tester) async {
      await show(tester, groupView(payment: 'PAID', statuses: const ['PICKED_UP', 'PICKED_UP'], driver: _rider));
      expect(find.text('On the way to campus'), findsOneWidget);
      expect(find.text('Your gate OTP'), findsNothing);
      await scrollTo(tester, find.text('YOUR DELIVERY PARTNER'));
      expect(find.text('YOUR DELIVERY PARTNER'), findsOneWidget);
      expect(find.text('Vikram'), findsOneWidget);
    });

    testWidgets('ONE gate OTP card at the gate (the server code), one total', (tester) async {
      await show(tester, groupView(payment: 'PAID', statuses: const ['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE'], driver: _rider, otp: '4821'));
      expect(find.text('Your gate OTP'), findsOneWidget);
      expect(find.textContaining('One code for all 2 restaurants'), findsOneWidget);
      for (final d in ['4', '8', '2', '1']) {
        expect(find.text(d), findsWidgets);
      }
      expect(find.text('Copy code'), findsOneWidget);
      expect(find.text('Your rider is at the gate'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('unpaid: pay again on the primary, and the cancel copy says it cancels the whole order', (tester) async {
      final (api, _) = await show(tester, groupView());
      expect(find.text('Payment not completed'), findsWidgets);
      expect(button('Try payment again · ₹260'), findsOneWidget);
      expect(find.text('This cancels your whole order, from all 2 restaurants.'), findsOneWidget);
      await tapButton(tester, 'Try payment again · ₹260');
      expect(api.paymentStarts, ['gx-order-1']);
    });

    testWidgets('cancel: confirmation says whole order, one request, every restaurant cancelled, refund text', (tester) async {
      final (api, _) = await show(tester, groupView(payment: 'PAID'));
      api.onCancel = (id) async {
        final g = groupView(payment: 'PAID', statuses: const ['CANCELLED', 'CANCELLED'], refund: 'PENDING', by: const ['CUSTOMER', 'SYSTEM'], reasons: const ['Cancelled by customer', 'Another restaurant in your order could not take it']);
        putGroup(api, g);
        return OrderResult.ok(g.orders.first);
      };
      await tapButton(tester, 'Cancel order');
      expect(find.textContaining('This cancels your whole order, from all 2 restaurants.'), findsWidgets);
      expect(find.textContaining('None of the restaurants has accepted yet'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Cancel order')).last);
      await settle(tester);
      expect(api.cancels, ['gx-order-1']);
      expect(find.text('This order was cancelled'), findsOneWidget);
      expect(find.text('You cancelled this order.'), findsOneWidget);
      expect(find.textContaining('Your refund is being processed'), findsOneWidget);
      expect(find.text('Cancelled'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('CANNOT_CANCEL from the server is shown plainly', (tester) async {
      final (api, _) = await show(tester, groupView(payment: 'PAID'));
      api.onCancel = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'CANNOT_CANCEL', message: 'A restaurant has already accepted its part.'));
      await tapButton(tester, 'Cancel order');
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Cancel order')).last);
      await settle(tester);
      expect(find.text('A restaurant has already accepted its part.'), findsOneWidget);
    });

    testWidgets('a restaurant rejected: whole order cancelled with THAT restaurant\'s reason, refund wording only when refunded', (tester) async {
      await show(tester, groupView(payment: 'REFUNDED', refund: 'DONE', statuses: const ['CANCELLED', 'CANCELLED'], by: const ['SYSTEM', 'VENDOR'], reasons: const ['Another restaurant in your order could not take it', 'Out of paneer']));
      await scrollTo(tester, find.text('Cancelled and refunded'));
      expect(find.text('Cancelled and refunded'), findsOneWidget);
      expect(find.textContaining('Kitchen 2 couldn’t take its part, so your whole order was cancelled: Out of paneer'), findsOneWidget);
      expect(find.textContaining('Your refund of ₹260 has been issued'), findsOneWidget);
      expect(find.textContaining('Another restaurant in your order could not take it'), findsNothing, reason: 'the generic sibling text is not shown');
      expect(find.text('Order again'), findsOneWidget);
    });

    testWidgets('payment never completed: expired, no money talk', (tester) async {
      await show(tester, groupView(statuses: const ['CANCELLED', 'CANCELLED'], by: const ['SYSTEM', 'SYSTEM'], reasons: const ['Payment not completed', 'Another restaurant in your order could not take it']));
      await scrollTo(tester, find.text('This order was cancelled'));
      expect(find.text('This order was cancelled'), findsOneWidget);
      expect(find.textContaining('wasn’t paid within 15 minutes'), findsOneWidget);
      expect(find.text('No payment was taken for this order.'), findsOneWidget);
    });

    testWidgets('"Order again" puts every restaurant back in the cart', (tester) async {
      final api = FakeOrderApi();
      putGroup(api, groupView(payment: 'REFUNDED', refund: 'DONE', statuses: const ['CANCELLED', 'CANCELLED'], by: const ['SYSTEM', 'VENDOR'], reasons: const ['x', 'Out of paneer']));
      final orders = fakeOrders(api)..beginSession('u1');
      final cart = CartProvider();
      await pumpApp(tester, const LiveTrackingScreen(orderId: 'gx-order-1'), orders: orders, cart: cart, dhabas: catalog());
      await tapButton(tester, 'Order again');
      expect(cart.restaurants.map((r) => r.id), ['gx-ven-1', 'gx-ven-2']);
      expect(cart.itemCount, 3);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('360x640 at ${scale}x text: every state without overflow', (tester) async {
        for (final statuses in [
          const ['PLACED', 'PLACED'],
          const ['ACCEPTED', 'PREPARING'],
          const ['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE'],
          const ['CANCELLED', 'CANCELLED'],
        ]) {
          final cancelled = statuses.first == 'CANCELLED';
          await show(tester, groupView(payment: cancelled ? 'REFUNDED' : 'PAID', statuses: statuses, driver: _rider, otp: '4821', by: cancelled ? const ['SYSTEM', 'VENDOR'] : const [null, null], reasons: cancelled ? const ['Another restaurant in your order could not take it', 'Out of a very very long reason that has to wrap nicely'] : const [null, null], refund: cancelled ? 'DONE' : 'NONE'), textScale: scale);
          expect(tester.takeException(), isNull, reason: statuses.join(','));
          await tester.drag(find.byType(Scrollable).first, const Offset(0, -2000));
          await tester.pump();
          expect(tester.takeException(), isNull, reason: '${statuses.join(',')} scrolled');
        }
      });
    }
  });

  group('Orders list and reorder', () {
    Future<(FakeOrderApi, OrderProvider, CartProvider)> show(WidgetTester tester, {DhabaProvider? dhabas, double textScale = 1.3}) async {
      final api = FakeOrderApi();
      final past = DateTime.now().toUtc().subtract(const Duration(days: 2));
      final liveGroup = [for (final j in groupChildrenJson(groupId: 'live', statuses: const ['PREPARING', 'ACCEPTED'], paymentStatus: 'PAID', ids: const ['l-1', 'l-2'])) OrderModel.tryParse(j)!];
      final doneGroup = [for (final j in groupChildrenJson(groupId: 'done', statuses: const ['DELIVERED', 'DELIVERED'], paymentStatus: 'PAID', ids: const ['d-1', 'd-2'], updatedAt: past)) OrderModel.tryParse(j)!];
      final single = OrderModel.tryParse(orderJson(id: 'single-1', status: 'DELIVERED', paymentStatus: 'PAID', vendorName: 'Lone Dhaba', createdAt: past, updatedAt: past))!;
      api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'active' ? liveGroup : [...doneGroup, single], null));
      for (final o in [...liveGroup, ...doneGroup]) {
        api.server[o.id] = o;
      }
      api.groupServer['live'] = OrderGroupView.tryParse(groupViewJson(id: 'live', orders: [for (final j in groupChildrenJson(groupId: 'live', statuses: const ['PREPARING', 'ACCEPTED'], paymentStatus: 'PAID', ids: const ['l-1', 'l-2'])) j]))!;
      final orders = fakeOrders(api)..beginSession('u1');
      final cart = CartProvider();
      await pumpApp(tester, const OrderHistoryScreen(selectedHostel: 'BH2'), orders: orders, cart: cart, dhabas: dhabas ?? catalog(), textScale: textScale);
      return (api, orders, cart);
    }

    testWidgets('ONE card per combined order (merged by group id), a lone order stays as it is', (tester) async {
      await show(tester);
      expect(find.text('Kitchen 1 + Kitchen 2'), findsNWidgets(2), reason: 'one live card, one delivered card');
      expect(find.textContaining('2 restaurants'), findsNWidgets(2));
      expect(button('Track this order'), findsOneWidget);
      expect(find.text('₹260'), findsWidgets);
      await scrollTo(tester, find.text('Lone Dhaba'));
      expect(find.text('Lone Dhaba'), findsOneWidget);
      expect(find.text('Rate'), findsOneWidget, reason: 'only the lone order can be rated; a combined order has no rating');
      expect(tester.takeException(), isNull);
    });

    testWidgets('tapping a live combined order opens the group tracking screen', (tester) async {
      await show(tester);
      await tapButton(tester, 'Track this order');
      expect(find.byType(LiveTrackingScreen), findsOneWidget);
      expect(find.text('Your 2 restaurants'), findsOneWidget);
    });

    testWidgets('reorder puts every restaurant\'s dishes back and opens the cart', (tester) async {
      final (_, _, cart) = await show(tester);
      await scrollTo(tester, button('Reorder').first);
      await tester.tap(button('Reorder').first);
      await settle(tester);
      expect(cart.restaurants.map((r) => r.id), ['gx-ven-1', 'gx-ven-2']);
      expect(cart.itemCount, 3);
      expect(find.text('Your cart'), findsOneWidget);
    });

    testWidgets('reorder skips a restaurant that is no longer in the app and says so', (tester) async {
      final (_, _, cart) = await show(tester, dhabas: catalog(second: false));
      await scrollTo(tester, button('Reorder').first);
      await tester.tap(button('Reorder').first);
      await settle(tester);
      expect(cart.restaurants.map((r) => r.id), ['gx-ven-1']);
      expect(find.textContaining('Kitchen 2 was left out'), findsOneWidget);
    });

    testWidgets('reorder respects the restaurant limit', (tester) async {
      final (_, _, cart) = await show(tester);
      cart.setMaxRestaurants(1);
      await scrollTo(tester, button('Reorder').first);
      await tester.tap(button('Reorder').first);
      await settle(tester);
      expect(cart.restaurants.map((r) => r.id), ['gx-ven-1']);
      expect(find.textContaining('over the limit of 1'), findsOneWidget);
    });

    testWidgets('2x text on a small phone: no overflow', (tester) async {
      await show(tester, textScale: 2.0);
      expect(tester.takeException(), isNull);
    });
  });
}
