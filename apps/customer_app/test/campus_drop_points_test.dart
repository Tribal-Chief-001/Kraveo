// Campus drop points, the checkout "Confirm your delivery point" sheet and the tracking map
// (Docs/19_campus_maps_contract.md section 3). The real Google map is never created here: a
// fake MapViewFactory stands in for it, which is also how "map unavailable" is simulated.
import 'dart:async';

import 'package:customer_app/models/customer_user.dart';
import 'package:customer_app/models/drop_point.dart';
import 'package:customer_app/models/geo.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/screens/checkout_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:customer_app/widgets/animated_rider_map.dart';
import 'package:customer_app/widgets/map/google_map_factory.dart';
import 'package:customer_app/widgets/map/map_view.dart';
import 'package:customer_app/widgets/map/tracking_map.dart';
import 'package:customer_app/widgets/ui/hostel_pill.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'support/order_fakes.dart';

// ---- helpers ---------------------------------------------------------------------------------

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

Map<String, dynamic> student({String? hostel = 'Block 2'}) => {'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': hostel, 'avatarId': 3, 'kraveoCoins': 120};

SessionProvider signedIn({String? hostel = 'Block 2'}) => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())..beginForTest(student(hostel: hostel));

CartProvider cartWithThali() {
  final cart = CartProvider();
  cart.addItem(
    item: const MenuItemModel(id: 'm-thali', vendorId: 'ven-1', name: 'Paneer Thali', price: 120, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true),
    dhabaId: 'ven-1',
    dhabaName: 'Sharma Highway Dhaba',
  );
  return cart; // estimate: 120 + 25 = 145
}

/// 360x640 at 1.3x text: the smallest phone the app supports.
Future<void> pumpApp(WidgetTester tester, Widget child, {required OrderProvider orders, CartProvider? cart, SessionProvider? session}) async {
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
      ChangeNotifierProvider<DhabaProvider>.value(value: DhabaProvider()..markLiveForTest(['ven-1'])),
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
  await tester.ensureVisible(f.first);
  await tester.pump();
  await tester.tap(f.first);
  await settle(tester);
}

Finder chip(String name) => find.widgetWithText(KChoiceChip, name);
const sheetTitle = 'Confirm your delivery point';

Future<void> tapChip(WidgetTester tester, String name) async {
  await tester.ensureVisible(chip(name));
  await tester.pump();
  await tester.tap(chip(name));
  await tester.pump();
}

/// A stand-in for the Google map. Records every spec it was asked to draw.
class FakeMapFactory extends MapViewFactory {
  FakeMapFactory({this.available = true, this.throwOnBuild = false, this.becomesReady = true});

  final bool available;
  final bool throwOnBuild;
  final bool becomesReady;
  final List<MapViewSpec> specs = [];
  final Set<MapViewSpec> _signalled = {};

  @override
  Future<bool> isAvailable() async => available;

  @override
  Widget build(BuildContext context, MapViewSpec spec) {
    specs.add(spec);
    if (throwOnBuild) throw StateError('platform view is not available');
    if (becomesReady && _signalled.add(spec)) scheduleMicrotask(spec.onReady);
    return const SizedBox.expand(key: ValueKey('fake-map'));
  }
}

OrderModel liveOrder({
  String id = 't-1',
  String status = 'PICKED_UP',
  String dropoffHostel = 'BH2',
  bool? hasLocation,
  Map<String, dynamic>? dropoff,
}) =>
    OrderModel.tryParse(orderJson(
      id: id,
      status: status,
      paymentStatus: 'PAID',
      dropoffHostel: dropoffHostel,
      vendorHasLocation: hasLocation,
      dropoff: dropoff,
      driver: {'id': 'd', 'name': 'Ravi'},
    ))!;

void main() {
  setUpAll(loadKraveoFonts);
  setUp(() => FakeRealtime.created.clear());

  group('Drop point data', () {
    test('the 11 points, in the contract order, with the contract coordinates', () {
      expect(kHostelBlocks, ['BH1', 'BH2', 'BH3', 'BH4', 'BH5', 'Special Block', 'BH6', 'BH7', 'BH8', 'GH1', 'GH2']);
      expect(kDropPointNames, kHostelBlocks);
      final expected = <String, (DropGroup, double, double)>{
        'BH1': (DropGroup.boys, 23.074861, 76.859889),
        'BH2': (DropGroup.boys, 23.073556, 76.859861),
        'BH3': (DropGroup.boys, 23.073556, 76.859861),
        'BH4': (DropGroup.boys, 23.073361, 76.858389),
        'BH5': (DropGroup.boys, 23.073361, 76.858389),
        'Special Block': (DropGroup.boys, 23.073361, 76.858389),
        'BH6': (DropGroup.boys, 23.072750, 76.860000),
        'BH7': (DropGroup.boys, 23.072889, 76.859222),
        'BH8': (DropGroup.boys, 23.072889, 76.859222),
        'GH1': (DropGroup.girls, 23.074778, 76.851972),
        'GH2': (DropGroup.girls, 23.074917, 76.853194),
      };
      expect(kDropPoints, hasLength(11));
      for (final p in kDropPoints) {
        expect((p.group, p.lat, p.lng), expected[p.name], reason: p.name);
      }
    });

    test('normalisation table: canonical, legacy, case, spaces, rejects', () {
      const table = <String, String?>{
        // canonical
        'BH1': 'BH1', 'bh8': 'BH8', ' BH 3 ': 'BH3', 'GH1': 'GH1', 'gh2': 'GH2', 'Special Block': 'Special Block', 'special   block': 'Special Block', 'SPECIAL BLOCK': 'Special Block',
        // legacy boys
        'Block 1': 'BH1', 'block 6': 'BH6', 'BLOCK  3': 'BH3', 'Block3': 'BH3', 'Boys Hostel Block 3': 'BH3', 'boys hostel block 6': 'BH6', '  Boys   Hostel   Block 1 ': 'BH1',
        // legacy girls
        'Girls Gate 1': 'GH1', 'girls gate 2': 'GH2', 'Girls Hostel Gate 1': 'GH1', 'GIRLS HOSTEL GATE 2': 'GH2',
        // rejected
        'VIT Main Gate': null, 'Main Gate': null, 'Block 7': null, 'Block 0': null, 'Block 42': null, 'Boys Hostel Block 7': null, 'Girls Gate 3': null,
        'BH9': null, 'BH0': null, 'GH3': null, 'Somewhere else': null, '': null, '   ': null,
      };
      table.forEach((raw, want) {
        expect(normalizeDropPoint(raw), want, reason: '"$raw"');
        expect(normalizeHostelBlock(raw, kHostelBlocks), want, reason: 'normalizeHostelBlock("$raw")');
      });
      expect(normalizeDropPoint(null), isNull);
      expect(normalizeHostelBlock(null, kHostelBlocks), isNull);
      expect(normalizeHostelBlock('BH2', const ['BH1']), isNull, reason: 'must be in the list that is offered');
    });

    test('dropPointByName understands legacy names too', () {
      expect(dropPointByName('Block 2')?.name, 'BH2');
      expect(dropPointByName('Girls Gate 2')?.lat, 23.074917);
      expect(dropPointByName('VIT Main Gate'), isNull);
    });

    test('the saved profile value is shown normalised (SessionProvider)', () {
      expect(signedIn(hostel: 'Boys Hostel Block 3').hostel, 'BH3');
      expect(signedIn(hostel: 'Girls Gate 1').deliveryPoint, 'GH1');
      expect(signedIn(hostel: 'VIT Main Gate').deliveryPoint, isNull, reason: 'removed point: the student chooses again');
      expect(signedIn(hostel: 'GH2').selectedHostel, 'GH2');
    });
  });

  group('Geometry', () {
    test('distance and the "about N min" estimate', () {
      final bh2 = GeoPoint(dropPointByName('BH2')!.lat, dropPointByName('BH2')!.lng);
      expect(distanceMeters(bh2, bh2), 0);
      final far = GeoPoint(bh2.lat - 0.009956, bh2.lng); // about 1.1 km south
      expect(distanceMeters(far, bh2), closeTo(1107, 15));
      expect(approxMinutes(far, bh2), 5); // 1.1 km at 15 km/h = 4.4 min, rounded up
      expect(approxMinutes(bh2, bh2), 1, reason: 'never "0 min"');
      expect(approxMinutes(null, bh2), isNull);
      expect(approxMinutes(far, null), isNull);
      expect(approxMinutes(const GeoPoint(double.nan, 0), bh2), isNull);
      expect(approxMinutes(const GeoPoint(10, 10), bh2), isNull, reason: 'a fix that is nowhere near campus is not an estimate');
    });
  });

  group('OrderModel map fields', () {
    test('new server: dropoff and vendor hasLocation are parsed', () {
      final o = OrderModel.tryParse(orderJson(dropoff: {'name': 'BH2', 'lat': 23.073556, 'lng': 76.859861}, vendorHasLocation: true))!;
      expect(o.dropoff?.name, 'BH2');
      expect(o.dropoffPlace?.lat, 23.073556);
      expect(o.vendorHasLocation, isTrue);
      expect(o.vendorPlace?.lat, 23.07);
    });

    test('old server: nothing new is sent and nothing breaks', () {
      final o = OrderModel.tryParse(orderJson(dropoffHostel: 'Block 3'))!;
      expect(o.dropoff, isNull);
      expect(o.vendorHasLocation, isFalse);
      expect(o.vendorPlace, isNull, reason: 'a placeholder pin is never drawn without hasLocation');
      expect(o.dropoffPlace?.name, 'BH3', reason: 'looked up in the app\'s own table');
      expect(o.dropoffPlace?.lat, 23.073556);
    });

    test('unknown drop point and junk values stay null', () {
      final o = OrderModel.tryParse(orderJson(dropoffHostel: 'VIT Main Gate', dropoff: {'name': 'x', 'lat': 'abc'}, vendorHasLocation: false))!;
      expect(o.dropoff, isNull);
      expect(o.dropoffPlace, isNull);
      expect(o.vendorPlace, isNull);
      expect(OrderModel.tryParse(orderJson(dropoff: {'name': 'BH1', 'lat': 999, 'lng': 0}))!.dropoff, isNull, reason: 'out of range');
    });
  });

  group('Drop point picker', () {
    testWidgets('lists the 11 points grouped Boys / Girls and marks the current one', (tester) async {
      String? picked;
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.customer(),
        home: Scaffold(body: HostelPill(selectedHostel: 'BH4', hostelBlocks: kHostelBlocks, onChanged: (v) => picked = v)),
      ));
      await tester.tap(find.text('BH4'));
      await settle(tester);
      expect(find.text('Where should we deliver?'), findsOneWidget);
      expect(find.text('BOYS'), findsOneWidget);
      expect(find.text('GIRLS'), findsOneWidget);
      expect(tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).map((c) => c.label).toList(), kHostelBlocks);
      expect(tester.widget<KChoiceChip>(chip('BH4')).selected, isTrue);
      expect(tester.widget<KChoiceChip>(chip('BH5')).selected, isFalse);
      await tapChip(tester, 'GH2');
      await settle(tester);
      expect(picked, 'GH2');
    });
  });

  group('Checkout: delivering to + confirm sheet', () {
    Future<(FakeOrderApi, OrderProvider, FakeGateway, CartProvider, SessionProvider)> open(WidgetTester tester, {String selected = 'Block 2', FakeOrderApi? api, SessionProvider? session}) async {
      api ??= FakeOrderApi();
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final orders = fakeOrders(api, gateway: gateway);
      final cart = cartWithThali();
      final s = session ?? signedIn();
      await pumpApp(tester, CheckoutScreen(selectedHostel: selected), orders: orders, cart: cart, session: s);
      return (api, orders, gateway, cart, s);
    }

    testWidgets('shows a "Delivering to <point>" row with Change, never the old pill', (tester) async {
      await open(tester);
      expect(find.text('Delivering to'), findsOneWidget);
      expect(find.text('BH2'), findsOneWidget, reason: 'the stored "Block 2" is shown as BH2');
      expect(find.text('Change'), findsOneWidget);
      expect(find.byType(HostelPill), findsNothing);

      await tester.tap(find.text('Change'));
      await settle(tester);
      expect(find.text('Where should we deliver?'), findsOneWidget);
      await tapChip(tester, 'BH5');
      await settle(tester);
      expect(find.text('BH5'), findsOneWidget);
      expect(find.text('BH2'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Pay opens the sheet: title, grouped chips, current point preselected, nothing is placed yet', (tester) async {
      final (api, _, gateway, _, _) = await open(tester);
      await tapButton(tester, 'Pay ₹145');
      expect(find.text(sheetTitle), findsOneWidget);
      expect(find.text('BOYS'), findsOneWidget);
      expect(find.text('GIRLS'), findsOneWidget);
      expect(find.byType(KChoiceChip), findsNWidgets(11));
      expect(tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).where((c) => c.selected).map((c) => c.label), ['BH2']);
      expect(button('Confirm and pay'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(api.creates, isEmpty);
      expect(gateway.opened, isEmpty);
      expect(tester.takeException(), isNull, reason: 'no overflow at 360x640 with 1.3x text');
    });

    testWidgets('Confirm and pay keeps the current point; the order is created for it', (tester) async {
      final (api, _, _, _, session) = await open(tester);
      await tapButton(tester, 'Pay ₹145');
      await tapButton(tester, 'Confirm and pay');
      expect(find.text(sheetTitle), findsNothing);
      expect(api.creates, hasLength(1));
      expect(api.creates.single.dropoffHostel, 'BH2');
      expect(session.hostel, 'BH2');
    });

    testWidgets('choosing another point places the order there and never touches the saved profile point', (tester) async {
      final (api, orders, _, _, session) = await open(tester);
      await tapButton(tester, 'Pay ₹145');
      await tapChip(tester, 'GH1');
      expect(tester.widget<KChoiceChip>(chip('GH1')).selected, isTrue);
      expect(tester.widget<KChoiceChip>(chip('BH2')).selected, isFalse);
      await tapButton(tester, 'Confirm and pay');
      expect(api.creates.single.dropoffHostel, 'GH1');
      expect(session.hostel, 'BH2', reason: 'the profile point is unchanged');
      expect(session.user?.hostelBlock, 'Block 2', reason: 'and nothing was saved to the server');
      expect(orders.orderById('order-1'), isNotNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Cancel (and the close button) place nothing and charge nothing; paying again works', (tester) async {
      final (api, _, gateway, _, _) = await open(tester);
      await tapButton(tester, 'Pay ₹145');
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(find.text(sheetTitle), findsNothing);
      expect(api.creates, isEmpty);
      expect(gateway.opened, isEmpty);
      expect(button('Pay ₹145'), findsOneWidget);
      expect(tester.widget<KButton>(button('Pay ₹145')).loading, isFalse);

      await tapButton(tester, 'Pay ₹145');
      await tester.tap(find.byIcon(LucideIcons.x));
      await settle(tester);
      expect(api.creates, isEmpty);

      await tapButton(tester, 'Pay ₹145');
      await tapButton(tester, 'Confirm and pay');
      expect(api.creates, hasLength(1));
    });

    testWidgets('the sheet appears once per payment attempt: paying or retrying the created order never asks again', (tester) async {
      final (api, _, gateway, _, _) = await open(tester);
      await tapButton(tester, 'Pay ₹145');
      await tapButton(tester, 'Confirm and pay');
      // The server priced it at ₹245 (not the ₹145 estimate), so the bill is shown first.
      expect(find.text('Updated total: ₹245'), findsOneWidget);
      expect(find.text(sheetTitle), findsNothing);

      await tapButton(tester, 'Pay ₹245');
      expect(find.text(sheetTitle), findsNothing);
      expect(gateway.opened, hasLength(1));
      expect(button('Try payment again · ₹245'), findsOneWidget);

      await tapButton(tester, 'Try payment again · ₹245');
      expect(find.text(sheetTitle), findsNothing);
      expect(gateway.opened, hasLength(2));
      expect(api.creates, hasLength(1), reason: 'same order, no second POST');
      expect(api.paymentStarts.toSet(), hasLength(1));
    });

    testWidgets('same cart + same point replays the same idempotency key; a different point gets a new one', (tester) async {
      final api = FakeOrderApi()..onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      await open(tester, api: api);
      await tapButton(tester, 'Pay ₹145');
      await tapButton(tester, 'Confirm and pay');
      await tapButton(tester, 'Pay ₹145');
      await tapButton(tester, 'Confirm and pay');
      expect(api.creates, hasLength(2));
      expect(api.creates[1].clientRequestId, api.creates[0].clientRequestId, reason: 'a retry of the same request is safe');
      expect(api.creates[1].dropoffHostel, 'BH2');

      await tapButton(tester, 'Pay ₹145');
      await tapChip(tester, 'GH2');
      await tapButton(tester, 'Confirm and pay');
      expect(api.creates, hasLength(3));
      expect(api.creates[2].dropoffHostel, 'GH2');
      expect(api.creates[2].clientRequestId, isNot(api.creates[0].clientRequestId), reason: 'a different point is a different order');
    });

    testWidgets('a legacy saved value is normalised: preselected and sent as the new name', (tester) async {
      final (api, _, _, _, _) = await open(tester, selected: 'Boys Hostel Block 3');
      expect(find.text('BH3'), findsOneWidget);
      await tapButton(tester, 'Pay ₹145');
      expect(tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).where((c) => c.selected).map((c) => c.label), ['BH3']);
      await tapButton(tester, 'Confirm and pay');
      expect(api.creates.single.dropoffHostel, 'BH3');
    });

    testWidgets('a removed point ("VIT Main Gate") asks the student to choose again, no sheet and no order', (tester) async {
      final (api, _, _, _, _) = await open(tester, selected: 'VIT Main Gate', session: signedIn(hostel: 'VIT Main Gate'));
      expect(find.text('Choose drop-off point'), findsOneWidget);
      expect(find.text('Delivering to'), findsNothing);
      await tapButton(tester, 'Choose drop-off');
      expect(find.text('Where should we deliver?'), findsOneWidget);
      expect(find.text(sheetTitle), findsNothing);
      expect(api.creates, isEmpty);
    });
  });

  group('Tracking map', () {
    Future<(FakeOrderApi, OrderProvider)> show(WidgetTester tester, OrderModel order, MapViewFactory factory) async {
      final api = FakeOrderApi()..server[order.id] = order;
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, LiveTrackingScreen(orderId: order.id, mapFactory: factory), orders: orders);
      return (api, orders);
    }

    testWidgets('map unavailable (no key / no Play services): the animated map is shown, nothing crashes', (tester) async {
      final f = FakeMapFactory(available: false);
      await show(tester, liveOrder(), f);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
      expect(find.byKey(const ValueKey('fake-map')), findsNothing);
      expect(f.specs, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('building the map throws: the animated map takes over', (tester) async {
      final f = FakeMapFactory(throwOnBuild: true);
      await show(tester, liveOrder(), f);
      expect(f.specs, isNotEmpty);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
      expect(find.byKey(const ValueKey('fake-map')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('onMapCreated never fires: the animated map stays visible meanwhile, then replaces the map after 6 s', (tester) async {
      final f = FakeMapFactory(becomesReady: false);
      await show(tester, liveOrder(), f); // settle() lets 4 s pass
      expect(find.byKey(const ValueKey('fake-map')), findsOneWidget, reason: 'the map is mounted and waiting');
      expect(find.byType(AnimatedRiderMap), findsOneWidget, reason: 'never a blank box while it loads');
      await tester.pump(const Duration(seconds: 3));
      expect(find.byKey(const ValueKey('fake-map')), findsNothing);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('map ready: the real map replaces the strip; pins come from the order', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(hasLocation: true), f);
      expect(find.byKey(const ValueKey('fake-map')), findsOneWidget);
      expect(find.byType(AnimatedRiderMap), findsNothing);
      final spec = f.specs.last;
      expect(spec.dropoff, const GeoPoint(23.073556, 76.859861));
      expect(spec.dropoffName, 'BH2');
      expect(spec.restaurant, const GeoPoint(23.07, 76.85), reason: 'drawn because the server says hasLocation');
      expect(tester.takeException(), isNull, reason: 'no overflow at 360x640 with 1.3x text');
    });

    testWidgets('the restaurant pin is left out without hasLocation (placeholder pin / old server); legacy drop names still map', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(dropoffHostel: 'Block 3'), f);
      expect(f.specs.last.restaurant, isNull);
      expect(f.specs.last.dropoff, const GeoPoint(23.073556, 76.859861));

      final server = FakeMapFactory();
      await show(tester, liveOrder(id: 't-2', hasLocation: false, dropoff: {'name': 'GH1', 'lat': 23.074778, 'lng': 76.851972}), server);
      expect(server.specs.last.restaurant, isNull);
      expect(server.specs.last.dropoff, const GeoPoint(23.074778, 76.851972), reason: 'the server\'s dropoff wins');
    });

    testWidgets('a drop point nobody can place keeps the animated map', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(dropoffHostel: 'VIT Main Gate'), f);
      expect(f.specs, isEmpty);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
    });

    testWidgets('delivered / cancelled orders do not load a map', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(status: 'DELIVERED'), f);
      expect(f.specs, isEmpty);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
    });

    testWidgets('the rider glides between fixes, and a fix does not notify the order provider (no screen rebuild)', (tester) async {
      final f = FakeMapFactory();
      final (_, orders) = await show(tester, liveOrder(), f);
      final socket = FakeRealtime.created.single..simulateConnect();
      var notifications = 0;
      orders.addListener(() => notifications++);
      final spec = f.specs.last;
      expect(spec.rider.value, isNull);

      socket.emitRider({'orderId': 't-1', 'driverId': 'd', 'lat': 23.0636, 'lng': 76.8598});
      await tester.pump();
      expect(spec.rider.value, const GeoPoint(23.0636, 76.8598), reason: 'the first fix places the marker');

      socket.emitRider({'orderId': 't-1', 'driverId': 'd', 'lat': 23.0646, 'lng': 76.8598});
      await tester.pump(); // ticker starts
      await tester.pump(const Duration(milliseconds: 500));
      final mid = spec.rider.value!;
      expect(mid.lat, greaterThan(23.0636));
      expect(mid.lat, lessThan(23.0646), reason: 'halfway through the glide, not a jump');
      await tester.pump(const Duration(milliseconds: 700));
      expect(spec.rider.value, const GeoPoint(23.0646, 76.8598));
      expect(notifications, 0, reason: 'rider fixes repaint the marker only');
      expect(tester.takeException(), isNull);
    });

    testWidgets('on the way: "Rider is about N min away", labelled as a rough estimate', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(), f);
      expect(find.textContaining('Rider is about'), findsNothing, reason: 'no fix yet');
      FakeRealtime.created.single
        ..simulateConnect()
        ..emitRider({'orderId': 't-1', 'driverId': 'd', 'lat': 23.0636, 'lng': 76.8598});
      await tester.pump();
      expect(find.text('Rider is about 5 min away'), findsOneWidget);
      expect(find.textContaining('Rough estimate'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('before pickup the rider is neither drawn nor timed', (tester) async {
      final f = FakeMapFactory();
      await show(tester, liveOrder(status: 'ACCEPTED'), f);
      FakeRealtime.created.single
        ..simulateConnect()
        ..emitRider({'orderId': 't-1', 'driverId': 'd', 'lat': 23.0636, 'lng': 76.8598});
      await tester.pump();
      expect(f.specs.last.rider.value, isNull);
      expect(find.textContaining('Rider is about'), findsNothing);
    });

    testWidgets('a stale fix (older than 2 minutes) is not turned into an estimate', (tester) async {
      final rider = ValueNotifier<RiderLocation?>(RiderLocation(orderId: 't-1', lat: 23.0636, lng: 76.8598, receivedAt: DateTime(2026, 10, 5, 12, 0)));
      var now = DateTime(2026, 10, 5, 12, 1);
      final order = liveOrder();
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.customer(),
        home: Scaffold(body: StatefulBuilder(builder: (context, set) => TrackingMap(order: order, rider: rider, factory: FakeMapFactory(available: false), clock: () => now))),
      ));
      await tester.pump();
      expect(find.text('Rider is about 5 min away'), findsOneWidget);
      now = DateTime(2026, 10, 5, 12, 5);
      rider.value = RiderLocation(orderId: 't-1', lat: 23.0636, lng: 76.8598, receivedAt: DateTime(2026, 10, 5, 12, 0));
      await tester.pump();
      expect(find.textContaining('Rider is about'), findsNothing);
    });
  });

  group('Production factory', () {
    testWidgets('without the native side (tests, desktop, no key) it reports "not available" instead of throwing', (tester) async {
      GoogleMapViewFactory.resetCache();
      final available = await tester.runAsync(() => const GoogleMapViewFactory().isAvailable());
      expect(available, isFalse);
    });

    testWidgets('the default tracking screen (no injected factory) shows the animated map in tests', (tester) async {
      final order = liveOrder();
      final api = FakeOrderApi()..server[order.id] = order;
      final orders = fakeOrders(api)..beginSession('u1');
      await pumpApp(tester, LiveTrackingScreen(orderId: order.id), orders: orders);
      expect(find.byType(AnimatedRiderMap), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    test('normalisation also covers the session helper used by Home and Profile', () {
      expect(CustomerUser.fromJson({'id': 'x', 'hostelBlock': 'Girls Hostel Gate 2'}).hostelBlock, 'Girls Hostel Gate 2', reason: 'the raw value is kept; screens show the normalised one');
      expect(normalizeHostelBlock('Girls Hostel Gate 2', kHostelBlocks), 'GH2');
    });
  });
}
