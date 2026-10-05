import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/drop_point.dart';
import 'package:driver_app/models/geo.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/services/navigation.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'support/fake_rider.dart';

/// Docs/19 section 4: Navigate buttons, the additive `dropoff` / `hasLocation` fields, and the
/// campus table the app falls back on. No device, no Google Maps app: a fake launcher records
/// which links the app tried.

class FakeLauncher extends NavigationLauncher {
  FakeLauncher({this.accepts = const {'google.navigation', 'geo', 'https'}});
  final Set<String> accepts;
  final tried = <Uri>[];

  @override
  Future<bool> open(Uri uri) async {
    tried.add(uri);
    return accepts.contains(uri.scheme);
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

Future<RiderController> _rider(FakeRider f, List<OrderView> active) async {
  f.api.active = ApiResult.ok(active);
  final c = RiderController(f.services, myIds: {'u-rider'});
  await c.start();
  return c;
}

const _pin = {'hasLocation': true, 'lat': 23.0745, 'lng': 76.859};

void main() {
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('navigation URLs (pure)', () {
    const bh2 = GeoPoint(23.073556, 76.859861);

    test('the mode is one constant: driving', () {
      expect(kNavigationMode, 'd');
    });

    test('google.navigation first, then geo, then an https Google Maps link', () {
      final uris = navigationUris(bh2, label: 'BH2');
      expect(uris.map((u) => u.scheme), ['google.navigation', 'geo', 'https']);
      expect(uris[0].toString(), 'google.navigation:q=23.073556,76.859861&mode=d');
      expect(uris[1].toString(), 'geo:23.073556,76.859861?q=23.073556,76.859861(BH2)');
      expect(uris[2].host, 'www.google.com');
      expect(uris[2].path, '/maps/dir/');
      expect(uris[2].queryParameters, {'api': '1', 'destination': '23.073556,76.859861', 'travelmode': 'driving'});
      expect(uris[2].toString(), 'https://www.google.com/maps/dir/?api=1&destination=23.073556%2C76.859861&travelmode=driving');
    });

    test('numbers are always written as plain decimals with 6 places', () {
      final uris = navigationUris(const GeoPoint(23.07, 76.0000001));
      expect(uris[0].toString(), 'google.navigation:q=23.070000,76.000000&mode=d');
    });

    test('a label with spaces and brackets is encoded; no label gives a plain geo link', () {
      expect(navigationUris(bh2, label: 'Special Block (new)')[1].toString(), endsWith('(Special%20Block%20new)'));
      expect(navigationUris(bh2, label: '  ')[1].toString(), 'geo:23.073556,76.859861?q=23.073556,76.859861');
      expect(navigationUris(bh2)[1].toString(), 'geo:23.073556,76.859861?q=23.073556,76.859861');
    });

    test('an invalid coordinate gives no links at all (nothing is guessed)', () {
      expect(navigationUris(const GeoPoint(double.nan, 76.8)), isEmpty);
      expect(navigationUris(const GeoPoint(95, 76.8)), isEmpty);
      expect(navigationUris(const GeoPoint(23, 181)), isEmpty);
      expect(navigationUris(const GeoPoint(double.infinity, 0)), isEmpty);
    });

    test('openNavigation stops at the first link that opens', () async {
      final l = FakeLauncher();
      expect(await openNavigation(bh2, label: 'BH2', launcher: l), isTrue);
      expect(l.tried.map((u) => u.scheme), ['google.navigation']);
    });

    test('without the Google Maps app it falls back to geo, then to https', () async {
      final noGoogle = FakeLauncher(accepts: {'geo', 'https'});
      expect(await openNavigation(bh2, launcher: noGoogle), isTrue);
      expect(noGoogle.tried.map((u) => u.scheme), ['google.navigation', 'geo']);
      final onlyWeb = FakeLauncher(accepts: {'https'});
      expect(await openNavigation(bh2, launcher: onlyWeb), isTrue);
      expect(onlyWeb.tried.map((u) => u.scheme), ['google.navigation', 'geo', 'https']);
    });

    test('nothing can open the link: false, and an invalid point never even tries', () async {
      final none = FakeLauncher(accepts: {});
      expect(await openNavigation(bh2, launcher: none), isFalse);
      expect(none.tried, hasLength(3));
      final l = FakeLauncher();
      expect(await openNavigation(const GeoPoint(200, 0), launcher: l), isFalse);
      expect(l.tried, isEmpty);
    });
  });

  group('distance text', () {
    test('metres to the nearest 10, then kilometres', () {
      expect(formatDistance(3), 'under 10 m');
      expect(formatDistance(84), '80 m');
      expect(formatDistance(996), '1.0 km');
      expect(formatDistance(1234), '1.2 km');
      expect(formatDistance(null), isNull);
      expect(formatDistance(double.nan), isNull);
      expect(formatDistance(-1), isNull);
    });

    test('haversine: two BH pins are about 200 m apart', () {
      final d = distanceMeters(const GeoPoint(23.074861, 76.859889), const GeoPoint(23.073556, 76.859861));
      expect(d, inInclusiveRange(140, 150));
    });
  });

  group('OrderView: additive dropoff and vendor hasLocation', () {
    test('parses dropoff {name,lat,lng} and vendor hasLocation', () {
      final o = order(dropoff: {'name': 'BH2', 'lat': 23.073556, 'lng': 76.859861}, vendorExtra: _pin);
      expect(o.dropoff?.name, 'BH2');
      expect(o.dropPlace?.point, const GeoPoint(23.073556, 76.859861));
      expect(o.vendor?.hasLocation, isTrue);
      expect(o.vendor?.point, const GeoPoint(23.0745, 76.859));
    });

    test('an old server sends neither: tolerated, no restaurant pin, drop point from the campus table', () {
      final o = order(drop: 'Block 3');
      expect(o.dropoff, isNull);
      expect(o.vendor?.hasLocation, isFalse);
      expect(o.vendor?.point, isNull, reason: 'lat/lng alone are not trusted without hasLocation');
      expect(o.dropPlace?.name, 'BH3');
      expect(o.dropPlace?.lat, 23.073556);
      expect(o.dropLabel, 'Block 3', reason: 'the text on screen is still what the server stored');
    });

    test('hasLocation false (placeholder pin) gives no point even with numbers', () {
      final o = order(vendorExtra: {'hasLocation': false, 'lat': 23.0768, 'lng': 76.8524});
      expect(o.vendor?.point, isNull);
    });

    test('hasLocation true with out-of-range numbers is not a point', () {
      expect(order(vendorExtra: {'hasLocation': true, 'lat': 123.0, 'lng': 76.8}).vendor?.point, isNull);
      expect(order(vendorExtra: {'hasLocation': true, 'lat': null, 'lng': null}).vendor?.point, isNull);
      expect(order(vendorExtra: {'hasLocation': 'true'}).vendor?.hasLocation, isFalse, reason: 'only a real boolean true counts');
    });

    test('a broken dropoff is ignored; the table decides', () {
      for (final bad in [
        <String, dynamic>{'name': 'BH2', 'lat': 'x', 'lng': 76.8},
        <String, dynamic>{'name': 'BH2', 'lat': 91.0, 'lng': 76.8},
        <String, dynamic>{'lat': 23.0, 'lng': 76.8},
      ]) {
        final o = order(drop: 'BH4', dropoff: bad);
        expect(o.dropoff, isNull);
        expect(o.dropPlace?.name, 'BH4');
      }
    });

    test('the server dropoff wins over the table', () {
      final o = order(drop: 'BH4', dropoff: {'name': 'BH4', 'lat': 23.1, 'lng': 76.9});
      expect(o.dropPlace?.point, const GeoPoint(23.1, 76.9));
    });

    test('an unknown drop point (VIT Main Gate) has no pin', () {
      final o = order(drop: 'VIT Main Gate');
      expect(o.dropPlace, isNull);
      expect(o.dropLabel, 'VIT Main Gate');
    });

    test('the campus table matches the contract: 11 points, shared pins', () {
      expect(kDropPointNames, ['BH1', 'BH2', 'BH3', 'BH4', 'BH5', 'Special Block', 'BH6', 'BH7', 'BH8', 'GH1', 'GH2']);
      expect(dropPointByName('Girls Gate 2')?.name, 'GH2');
      expect(dropPointByName('Boys Hostel Block 6')?.name, 'BH6');
      expect(dropPointByName('Block 7'), isNull, reason: 'legacy blocks only go to 6');
      expect(dropPointByName('bh2')?.lat, dropPointByName('BH3')?.lat);
    });
  });

  group('Navigate buttons on the delivery screen (360x640, 1.3x text)', () {
    Future<(RiderController, FakeLauncher)> open(WidgetTester tester, OrderView o, {FakeLauncher? launcher}) async {
      await _smallPhone(tester);
      final f = FakeRider();
      final c = await _rider(f, [o]);
      final l = launcher ?? FakeLauncher();
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.driver(),
        home: ActiveDeliveryScreen(controller: c, onGoHome: () {}, navigationLauncher: l),
      ));
      await tester.pump(const Duration(milliseconds: 600));
      return (c, l);
    }

    // The Navigate button sits below the primary action; list rows are built lazily, so scroll.
    Future<void> reveal(WidgetTester tester, String key) async {
      await tester.scrollUntilVisible(find.byKey(ValueKey(key)), 150, scrollable: find.byType(Scrollable).first);
      await tester.pump(const Duration(milliseconds: 300));
    }

    Future<void> scrollToEnd(WidgetTester tester) async {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
      await tester.pump(const Duration(milliseconds: 400));
    }

    Future<void> tapButton(WidgetTester tester, String key) async {
      final f = find.byKey(ValueKey(key));
      await tester.ensureVisible(f);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(f);
      await tester.pump();
    }

    testWidgets('before pickup with a real restaurant pin: enabled, opens Google Maps navigation', (tester) async {
      final (c, l) = await open(tester, order(status: 'READY_FOR_PICKUP', vendorExtra: _pin));
      await reveal(tester, 'navigate-restaurant');
      expect(find.text('Navigate to restaurant'), findsOneWidget);
      expect(tester.widget<KButton>(find.byKey(const ValueKey('navigate-restaurant'))).onPressed, isNotNull);
      expect(find.byKey(const ValueKey('restaurant-location-missing')), findsNothing);
      expect(find.byKey(const ValueKey('navigate-drop')), findsNothing);
      await tapButton(tester, 'navigate-restaurant');
      expect(l.tried.single.toString(), 'google.navigation:q=23.074500,76.859000&mode=d');
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('restaurant pin missing (hasLocation false): disabled and says why', (tester) async {
      final (c, l) = await open(tester, order(status: 'ACCEPTED', vendorExtra: {'hasLocation': false, 'lat': 23.0768, 'lng': 76.8524}));
      await reveal(tester, 'navigate-restaurant');
      expect(tester.widget<KButton>(find.byKey(const ValueKey('navigate-restaurant'))).onPressed, isNull);
      expect(find.text('Restaurant location not set - call the restaurant'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('navigate-restaurant')), warnIfMissed: false);
      await tester.pump();
      expect(l.tried, isEmpty);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('an old server (no hasLocation at all) is treated as "not set"', (tester) async {
      final (c, l) = await open(tester, order(status: 'PREPARING'));
      await reveal(tester, 'navigate-restaurant');
      expect(tester.widget<KButton>(find.byKey(const ValueKey('navigate-restaurant'))).onPressed, isNull);
      expect(find.text('Restaurant location not set - call the restaurant'), findsOneWidget);
      expect(l.tried, isEmpty);
      c.dispose();
    });

    testWidgets('after pickup: Navigate to the drop point uses its coordinates; no restaurant button', (tester) async {
      final (c, l) = await open(tester, order(status: 'PICKED_UP', drop: 'BH2', dropoff: {'name': 'BH2', 'lat': 23.073556, 'lng': 76.859861}));
      await reveal(tester, 'navigate-drop');
      expect(find.text('Navigate to BH2'), findsOneWidget);
      expect(find.byKey(const ValueKey('navigate-restaurant')), findsNothing);
      await tapButton(tester, 'navigate-drop');
      expect(l.tried.single.toString(), 'google.navigation:q=23.073556,76.859861&mode=d');
      c.dispose();
    });

    testWidgets('an older server without dropoff: the campus table gives the pin for a legacy name', (tester) async {
      final (c, l) = await open(tester, order(status: 'ARRIVED_AT_GATE', drop: 'Girls Gate 1'));
      await reveal(tester, 'navigate-drop');
      expect(find.text('Navigate to GH1'), findsOneWidget);
      await tapButton(tester, 'navigate-drop');
      expect(l.tried.single.toString(), 'google.navigation:q=23.074778,76.851972&mode=d');
      c.dispose();
    });

    testWidgets('an unknown drop point hides the button and keeps the name as text', (tester) async {
      final (c, l) = await open(tester, order(status: 'PICKED_UP', drop: 'VIT Main Gate'));
      await scrollToEnd(tester);
      expect(find.byKey(const ValueKey('navigate-drop')), findsNothing);
      expect(find.textContaining('Navigate to'), findsNothing);
      expect(find.text('VIT Main Gate'), findsWidgets);
      expect(l.tried, isEmpty);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('no maps app and no browser: a message, no crash', (tester) async {
      final (c, l) = await open(tester, order(status: 'READY_FOR_PICKUP', vendorExtra: _pin), launcher: FakeLauncher(accepts: {}));
      await reveal(tester, 'navigate-restaurant');
      await tapButton(tester, 'navigate-restaurant');
      await tester.pump(const Duration(milliseconds: 400));
      expect(l.tried, hasLength(3));
      expect(find.textContaining('Could not open Google Maps'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    for (final status in ['ACCEPTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
      testWidgets('$status with the longest names: no overflow', (tester) async {
        final (c, _) = await open(
          tester,
          order(
            status: status,
            vendorName: 'The Extra Long Campus Canteen And Juice Corner Number Two',
            drop: 'Special Block',
            vendorExtra: _pin,
            phone: status == 'ARRIVED_AT_GATE' ? '+91 9876500000' : null,
          ),
        );
        await reveal(tester, status == 'ACCEPTED' || status == 'READY_FOR_PICKUP' ? 'navigate-restaurant' : 'navigate-drop');
        expect(tester.takeException(), isNull);
        await scrollToEnd(tester);
        expect(tester.takeException(), isNull);
        c.dispose();
      });
    }
  });
}
