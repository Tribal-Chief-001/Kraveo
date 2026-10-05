import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/geo.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'package:driver_app/widgets/map/delivery_map_card.dart';
import 'package:driver_app/widgets/map/google_map_factory.dart';
import 'package:driver_app/widgets/map/map_view.dart';
import 'support/fake_rider.dart';

/// Docs/19 section 4: the delivery map card. A fake factory stands in for the Google map (no
/// platform view in unit tests); the card must fall back to the plain card in every failure case
/// and never show a crash or a blank box.

class FakeMapFactory extends MapViewFactory {
  FakeMapFactory({this.available = true, this.throwsOnAvailable = false, this.throwsOnBuild = false});

  bool available;
  final bool throwsOnAvailable;
  final bool throwsOnBuild;
  int builds = 0;
  MapViewSpec? lastSpec;

  @override
  Future<bool> isAvailable() async {
    if (throwsOnAvailable) throw StateError('plugin exploded');
    return available;
  }

  @override
  Widget build(BuildContext context, MapViewSpec spec) {
    builds++;
    lastSpec = spec;
    if (throwsOnBuild) throw StateError('platform view failed');
    return const SizedBox.expand(key: ValueKey('fake-map'), child: ColoredBox(color: Colors.blueGrey));
  }
}

Future<void> _loadFonts() async {
  Future<void> load(String family, String asset) async {
    final loader = FontLoader('packages/kraveo_ui/$family')..addFont(rootBundle.load('packages/kraveo_ui/assets/fonts/$asset'));
    await loader.load();
  }

  await load('Bricolage', 'BricolageGrotesque.ttf');
  await load('Jakarta', 'PlusJakartaSans.ttf');
}

Future<void> _smallPhone(WidgetTester tester, {double textScale = 1.3}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

const _pin = {'hasLocation': true, 'lat': 23.0745, 'lng': 76.859};
final _bh2 = {'name': 'BH2', 'lat': 23.073556, 'lng': 76.859861};

Widget _card(OrderView o, ValueListenable<GeoPoint?> rider, MapViewFactory factory, {Duration timeout = kMapReadyTimeout}) => MaterialApp(
      theme: KraveoTheme.driver(),
      home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: DeliveryMapCard(order: o, rider: rider, factory: factory, readyTimeout: timeout))),
    );

void main() {
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final plain = find.byKey(const ValueKey('map-fallback-card'));
  final map = find.byKey(const ValueKey('fake-map'));

  group('fallback: the plain card (names and distances)', () {
    testWidgets('map not available on this phone: plain card, no map is ever built', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory(available: false);
      final me = ValueNotifier<GeoPoint?>(null);
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), me, factory));
      await tester.pump();
      expect(plain, findsOneWidget);
      expect(map, findsNothing);
      expect(factory.builds, 0);
      expect(find.text('Pickup · FC Night Mess'), findsOneWidget);
      expect(find.text('Drop · BH2'), findsOneWidget);
      expect(find.text('Distances appear once your location is found.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('with the rider\'s position the card shows straight-line distances', (tester) async {
      await _smallPhone(tester);
      final me = ValueNotifier<GeoPoint?>(const GeoPoint(23.0745, 76.8594)); // ~41 m from the pickup
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), me, FakeMapFactory(available: false)));
      await tester.pump();
      expect(find.text('40 m away'), findsOneWidget, reason: 'pickup');
      expect(find.textContaining('km away'), findsNothing);
      expect(find.textContaining('m away'), findsNWidgets(2), reason: 'pickup and drop');
      // The rider moves: only the distances change.
      me.value = const GeoPoint(23.0800, 76.8603);
      await tester.pump();
      expect(find.textContaining('km away'), findsNothing);
      expect(find.text('40 m away'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('restaurant without a real pin: card says so and still lists the drop point', (tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2), ValueNotifier<GeoPoint?>(null), FakeMapFactory(available: false)));
      await tester.pump();
      expect(find.text('Location not set'), findsOneWidget);
      expect(find.text('Drop · BH2'), findsOneWidget);
    });

    testWidgets('isAvailable throws: plain card', (tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_card(order(vendorExtra: _pin), ValueNotifier<GeoPoint?>(null), FakeMapFactory(throwsOnAvailable: true)));
      await tester.pump();
      expect(plain, findsOneWidget);
      expect(map, findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('build throws: plain card takes over, no exception reaches the screen', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory(throwsOnBuild: true);
      await tester.pumpWidget(_card(order(vendorExtra: _pin), ValueNotifier<GeoPoint?>(null), factory));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(factory.builds, greaterThan(0));
      expect(plain, findsOneWidget);
      expect(map, findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the map never reports ready: after 6 s the plain card replaces it', (tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_card(order(vendorExtra: _pin), ValueNotifier<GeoPoint?>(null), FakeMapFactory()));
      await tester.pump();
      expect(map, findsOneWidget);
      expect(plain, findsOneWidget, reason: 'while loading, the plain card is still there: never blank');
      await tester.pump(const Duration(seconds: 5));
      expect(map, findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      expect(map, findsNothing);
      expect(plain, findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the map fails after it was ready (onError): plain card again', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      await tester.pumpWidget(_card(order(vendorExtra: _pin), ValueNotifier<GeoPoint?>(null), factory));
      await tester.pump();
      factory.lastSpec!.onReady();
      await tester.pump();
      expect(plain, findsNothing);
      factory.lastSpec!.onError(StateError('tiles'));
      await tester.pump();
      expect(map, findsNothing);
      expect(plain, findsOneWidget);
    });

    testWidgets('nothing to show (no restaurant pin, unknown drop point): no card at all', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      await tester.pumpWidget(_card(order(drop: 'VIT Main Gate'), ValueNotifier<GeoPoint?>(null), factory));
      await tester.pump();
      expect(find.byKey(const ValueKey('delivery-map-none')), findsOneWidget);
      expect(plain, findsNothing);
      expect(map, findsNothing);
      expect(factory.builds, 0);
    });

    testWidgets('the default factory is "not available" off a device with a Maps key (tests, no plugin)', (tester) async {
      await tester.runAsync(() async {
      GoogleMapViewFactory.resetCache();
      expect(await const GoogleMapViewFactory().isAvailable(), isFalse);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      GoogleMapViewFactory.resetCache();
      expect(await const GoogleMapViewFactory().isAvailable(), isFalse);
      debugDefaultTargetPlatformOverride = null;
      GoogleMapViewFactory.resetCache();
      });
    });
  });

  group('the real map path (through the fake factory)', () {
    testWidgets('becomes visible once the map reports ready; the plain card goes away', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), ValueNotifier<GeoPoint?>(null), factory));
      await tester.pump();
      factory.lastSpec!.onReady();
      await tester.pump();
      expect(map, findsOneWidget);
      expect(plain, findsNothing);
      await tester.pump(const Duration(seconds: 10));
      expect(map, findsOneWidget, reason: 'the timeout is cancelled once ready');
      expect(tester.getSize(find.byKey(const ValueKey('delivery-map'))).height, kDeliveryMapHeight);
    });

    testWidgets('the map gets pickup, drop, names and the rider\'s own position', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      final me = ValueNotifier<GeoPoint?>(const GeoPoint(23.07, 76.85));
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), me, factory));
      await tester.pump();
      final spec = factory.lastSpec!;
      expect(spec.pickup, const GeoPoint(23.0745, 76.859));
      expect(spec.pickupName, 'FC Night Mess');
      expect(spec.drop, const GeoPoint(23.073556, 76.859861));
      expect(spec.dropName, 'BH2');
      expect(identical(spec.rider, me), isTrue);
      expect(spec.visiblePoints(riderPoint: me.value), hasLength(3));
      expect(spec.visiblePoints(), hasLength(2));
    });

    testWidgets('a placeholder restaurant pin is never drawn: the map shows the drop point only', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      await tester.pumpWidget(_card(order(drop: 'BH2', dropoff: _bh2), ValueNotifier<GeoPoint?>(null), factory));
      await tester.pump();
      expect(factory.lastSpec!.pickup, isNull);
      expect(factory.lastSpec!.drop, isNotNull);
    });

    testWidgets('a status change with the same pins keeps the same spec (no camera refit)', (tester) async {
      await _smallPhone(tester);
      final factory = FakeMapFactory();
      final me = ValueNotifier<GeoPoint?>(null);
      await tester.pumpWidget(_card(order(status: 'READY_FOR_PICKUP', drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), me, factory));
      await tester.pump();
      final first = factory.lastSpec;
      await tester.pumpWidget(_card(order(status: 'PICKED_UP', drop: 'BH2', dropoff: _bh2, vendorExtra: _pin), me, factory));
      await tester.pump();
      expect(identical(factory.lastSpec, first), isTrue);
    });
  });

  group('inside the delivery screen (360x640, 1.3x text)', () {
    Future<RiderController> pump(WidgetTester tester, OrderView o, MapViewFactory factory) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.active = ApiResult.ok([o]);
      final c = RiderController(f.services, myIds: {'u-rider'});
      await c.start();
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.driver(), home: ActiveDeliveryScreen(controller: c, onGoHome: () {}, mapFactory: factory)));
      await tester.pump(const Duration(milliseconds: 600));
      return c;
    }

    for (final status in ['ACCEPTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
      testWidgets('$status: plain card, no overflow', (tester) async {
        final c = await pump(tester, order(status: status, vendorName: 'The Extra Long Campus Canteen And Juice Corner Number Two', drop: 'Special Block', vendorExtra: _pin), FakeMapFactory(available: false));
        await tester.scrollUntilVisible(find.byKey(const ValueKey('delivery-map-card')), 150, scrollable: find.byType(Scrollable).first);
        await tester.pump(const Duration(milliseconds: 300));
        expect(plain, findsOneWidget);
        expect(tester.takeException(), isNull);
        c.dispose();
      });

      testWidgets('$status: real-map slot, no overflow', (tester) async {
        final factory = FakeMapFactory();
        final c = await pump(tester, order(status: status, drop: 'Special Block', vendorExtra: _pin), factory);
        factory.lastSpec!.onReady();
        await tester.pump();
        await tester.scrollUntilVisible(find.byKey(const ValueKey('delivery-map-card')), 150, scrollable: find.byType(Scrollable).first);
        await tester.pump(const Duration(milliseconds: 300));
        expect(map, findsOneWidget);
        expect(tester.takeException(), isNull);
        c.dispose();
      });
    }

    testWidgets('an order with no pins at all shows no map card and no empty gap card', (tester) async {
      final c = await pump(tester, order(status: 'ACCEPTED', drop: 'VIT Main Gate'), FakeMapFactory());
      expect(find.byKey(const ValueKey('delivery-map-card')), findsNothing);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('the rider\'s own fix reaches the card through the controller', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.active = ApiResult.ok([order(status: 'READY_FOR_PICKUP', drop: 'BH2', dropoff: _bh2, vendorExtra: _pin)]);
      final c = RiderController(f.services, myIds: {'u-rider'});
      await c.start();
      await tester.runAsync(() async {
        await c.setDuty(true);
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.driver(), home: ActiveDeliveryScreen(controller: c, onGoHome: () {}, mapFactory: FakeMapFactory(available: false))));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.scrollUntilVisible(find.byKey(const ValueKey('delivery-map-card')), 150, scrollable: find.byType(Scrollable).first);
      await tester.pump(const Duration(milliseconds: 300));
      expect(c.myPosition.value, isNotNull);
      expect(find.textContaining(' away'), findsWidgets);
      c.dispose();
    });
  });
}
