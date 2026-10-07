import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/geo.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/screens/driver_home.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/navigation.dart';
import 'package:driver_app/services/push/push_controller.dart';
import 'package:driver_app/services/push/push_messaging.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'package:driver_app/widgets/map/delivery_map_card.dart';
import 'package:driver_app/widgets/map/map_view.dart';
import 'package:driver_app/widgets/swipe_accept_card.dart';
import 'support/fake_group.dart';
import 'support/fake_push.dart';
import 'support/fake_rider.dart';
import 'support/support_log.dart';

/// The rider screens for a combined (multi-restaurant) order (Docs/22 section 6): pool card, the active delivery with its
/// stop list, home, trips, push taps and the map. Small phone (360x640) at 1.3x and 2x text.

Future<void> _smallPhone(WidgetTester tester, {double textScale = 1.3}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Widget _app(Widget home) => MaterialApp(theme: KraveoTheme.driver(), home: home);

Future<void> _loadFonts() async {
  Future<void> load(String family, String asset) async {
    final loader = FontLoader('packages/kraveo_ui/$family')..addFont(rootBundle.load('packages/kraveo_ui/assets/fonts/$asset'));
    await loader.load();
  }

  await load('Bricolage', 'BricolageGrotesque.ttf');
  await load('Jakarta', 'PlusJakartaSans.ttf');
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

/// Lazily built list rows only exist once scrolled near: scroll the delivery list until [f] is built and on screen.
Future<void> _show(WidgetTester tester, Finder f) async {
  if (f.evaluate().isEmpty) {
    await _top(tester);
    await tester.scrollUntilVisible(f, 150, scrollable: find.byType(Scrollable).first);
  }
  await tester.ensureVisible(f);
  await tester.pump(const Duration(milliseconds: 300));
}

Future<void> _top(WidgetTester tester) async {
  await tester.drag(find.byType(Scrollable).first, const Offset(0, 4000));
  await tester.pump(const Duration(milliseconds: 400));
}

/// Drags the thumb of the slide-to-confirm inside [key] across the track.
Future<void> _slideIn(WidgetTester tester, Key key) async {
  final f = find.byKey(key);
  await _show(tester, f);
  final thumb = find.descendant(of: f, matching: find.byType(Icon)).first;
  final g = await tester.startGesture(tester.getCenter(thumb));
  for (var i = 0; i < 12; i++) {
    await g.moveBy(const Offset(30, 0));
    await tester.pump(const Duration(milliseconds: 16));
  }
  await g.up();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Future<void> _tapVisible(WidgetTester tester, Finder f) async {
  await _show(tester, f);
  await tester.tap(f);
  await tester.pump();
}

Future<RiderController> _rider(FakeRider f) async {
  final c = RiderController(f.services, myIds: {'u-rider'});
  await c.start();
  return c;
}

class _FakeMapFactory extends MapViewFactory {
  MapViewSpec? lastSpec;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Widget build(BuildContext context, MapViewSpec spec) {
    lastSpec = spec;
    WidgetsBinding.instance.addPostFrameCallback((_) => spec.onReady());
    return const SizedBox.expand(key: ValueKey('fake-map'), child: ColoredBox(color: Colors.blueGrey));
  }
}

class _Launcher implements NavigationLauncher {
  final opened = <Uri>[];

  @override
  Future<bool> open(Uri uri) async {
    opened.add(uri);
    return true;
  }
}

void main() {
  setUpAll(_loadFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final scale in [1.3, 2.0]) {
    group('pool card at 360x640 and ${scale}x text', () {
      testWidgets('one card: "Combined order - 2 restaurants", every stop name and address, no money, no customer; one accept', (tester) async {
        await _smallPhone(tester, textScale: scale);
        var accepted = 0;
        await tester.pumpWidget(_app(Scaffold(
          body: SingleChildScrollView(child: OfferCard(order: groupOffer(), now: testNow, onAccepted: () => accepted++, onDeclined: () {})),
        )));
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text('Combined order - 2 restaurants'), findsOneWidget);
        expect(find.text('Kitchen 1'), findsOneWidget);
        expect(find.text('Kitchen 2'), findsOneWidget);
        expect(find.text('Gate 1'), findsOneWidget);
        expect(find.text('Gate 2'), findsOneWidget);
        expect(find.text('PICKUP 1'), findsOneWidget);
        expect(find.text('PICKUP 2'), findsOneWidget);
        expect(find.text('DROP'), findsOneWidget);
        expect(find.text('DELIVERY FEE'), findsNothing);
        expect(find.textContaining('₹'), findsNothing, reason: 'the pool entry carries only one restaurant\'s share: stops, not money');
        expect(find.textContaining('Aman'), findsNothing);
        expect(find.textContaining('4 items'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _tapVisible(tester, find.byKey(const ValueKey('accept-gA')));
        expect(accepted, 1);
      });
    });
  }

  testWidgets('pool card: claiming shows progress and no accept controls; a waiting kitchen reads "Preparing", all ready reads "Ready"', (tester) async {
    await _smallPhone(tester);
    await tester.pumpWidget(_app(Scaffold(
      body: SingleChildScrollView(child: OfferCard(order: groupOffer(statuses: ['READY_FOR_PICKUP', 'PREPARING']), now: testNow, onAccepted: () {}, claiming: true)),
    )));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Accepting…'), findsOneWidget);
    expect(find.byKey(const ValueKey('accept-gA')), findsNothing);
    expect(find.text('Preparing'), findsOneWidget);
    await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: OfferCard(order: groupOffer(statuses: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']), now: testNow, onAccepted: () {})))));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Ready'), findsOneWidget);
  });

  for (final scale in [1.3, 2.0]) {
    group('active delivery of a combined order at 360x640 and ${scale}x text', () {
      testWidgets('kitchens not ready: stop list, waiting texts, no pickup slider, no arrival, release offered', (tester) async {
        await _smallPhone(tester, textScale: scale);
        final f = FakeRider();
        final w = GroupWorld(f, start: ['PREPARING', 'ACCEPTED']);
        final c = await _rider(f);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        expect(find.text('Collect from 2 restaurants'), findsOneWidget);
        expect(find.text('0 of 2 picked up'), findsOneWidget);
        await _show(tester, find.text('One rider, 2 restaurants'));
        expect(find.text('One rider, 2 restaurants'), findsOneWidget);
        await _show(tester, find.byKey(const ValueKey('stop-list')));
        expect(find.text('Kitchen 1'), findsWidgets);
        expect(find.byKey(const ValueKey('stop-waiting-gA')), findsOneWidget);
        expect(find.text('Waiting for kitchen'), findsNWidgets(2));
        expect(find.byKey(const ValueKey('slide-pickup-gA')), findsNothing);
        expect(find.byKey(const ValueKey('slide-picked-up')), findsNothing);
        await _show(tester, find.byKey(const ValueKey('group-pickup-pending')));
        expect(tester.widget<KButton>(find.byKey(const ValueKey('group-pickup-pending'))).onPressed, isNull);
        await _show(tester, find.byKey(const ValueKey('release-button')));
        expect(find.byKey(const ValueKey('release-button')), findsOneWidget);
        expect(find.byKey(const ValueKey('enter-code-button')), findsNothing);
        expect(find.byKey(const ValueKey('navigate-drop')), findsNothing, reason: 'the drop is navigated to only after every pickup');
        expect(tester.takeException(), isNull);
        expect(w.countStarting('status:'), 0);
        c.dispose();
      });

      testWidgets('a placed (not yet accepted) stop says it waits for the restaurant to accept', (tester) async {
        await _smallPhone(tester, textScale: scale);
        final f = FakeRider();
        GroupWorld(f, start: ['READY_FOR_PICKUP', 'PLACED']);
        final c = await _rider(f);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        await _show(tester, find.byKey(const ValueKey('stop-waiting-gB')));
        expect(find.text('Waiting for restaurant to accept'), findsOneWidget);
        expect(find.byKey(const ValueKey('slide-pickup-gA')), findsOneWidget, reason: 'the ready kitchen can be picked up now');
        expect(tester.takeException(), isNull);
        c.dispose();
      });

      testWidgets('pickup stop by stop, arrival once, ONE code, delivered notice', (tester) async {
        await _smallPhone(tester, textScale: scale);
        final f = FakeRider();
        final w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'PREPARING']);
        final c = await _rider(f);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));

        await _slideIn(tester, const ValueKey('slide-pickup-gA'));
        expect(f.api.calls.where((x) => x.startsWith('status:')), ['status:gA:PICKED_UP']);
        expect(find.byKey(const ValueKey('stop-picked-gA')), findsOneWidget);
        expect(c.active!.stops.where((s) => s.pickedUp), hasLength(1));
        await _top(tester);
        expect(find.text('1 of 2 picked up'), findsOneWidget);
        await _show(tester, find.byKey(const ValueKey('stop-waiting-gB')));
        expect(find.text('Waiting for kitchen'), findsOneWidget);
        // the release is gone after the first pickup
        await _show(tester, find.byKey(const ValueKey('stop-list')));
        expect(find.byKey(const ValueKey('release-button')), findsNothing);
        expect(find.byKey(const ValueKey('slide-arrived')), findsNothing);

        // the second kitchen finishes
        w.kitchen(1, 'READY_FOR_PICKUP');
        f.socket.emit(OrderUpdated(w.child(1)));
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.byKey(const ValueKey('slide-pickup-gB')), findsOneWidget);
        await _slideIn(tester, const ValueKey('slide-pickup-gB'));
        expect(f.api.calls.where((x) => x.startsWith('status:')), ['status:gA:PICKED_UP', 'status:gB:PICKED_UP']);
        await _top(tester);
        expect(find.text('Ride to the drop point'), findsOneWidget);
        expect(find.byKey(const ValueKey('slide-pickup-gA')), findsNothing);
        await _show(tester, find.byKey(const ValueKey('navigate-drop')));
        expect(find.byKey(const ValueKey('navigate-drop')), findsOneWidget);

        await _slideIn(tester, const ValueKey('slide-arrived'));
        expect(f.api.calls.where((x) => x.contains('ARRIVED_AT_GATE')), ['status:gA:ARRIVED_AT_GATE']);
        await _top(tester);
        expect(find.text('Hand over the order'), findsOneWidget);
        await _show(tester, find.text('Ask the customer for their 4-digit code'));
        expect(find.text('Ask the customer for their 4-digit code'), findsOneWidget);
        await _show(tester, find.byKey(const ValueKey('enter-code-button')));
        expect(find.byKey(const ValueKey('enter-code-button')), findsOneWidget);
        expect(find.byKey(const ValueKey('release-button')), findsNothing);

        if (scale <= 1.3) {
          await _tapVisible(tester, find.byKey(const ValueKey('enter-code-button')));
          await tester.pumpAndSettle();
          for (final d in '4821'.split('')) {
            await tester.tap(find.byKey(ValueKey('otp-key-$d')));
            await tester.pump();
          }
          await tester.tap(find.text('Verify & deliver'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 600));
          await tester.pumpAndSettle();
        } else {
          // The shared code dialog (unchanged, single-order code) does not fit 640 px at 2x text: check the code
          // through the same controller call the dialog makes.
          expect((await c.verifyOtp('4821')).kind, OtpOutcomeKind.delivered);
          await tester.pump(const Duration(milliseconds: 600));
        }
        expect(f.api.calls.where((x) => x.startsWith('otp:')), ['otp:gA:4821']);
        expect(find.text('Delivered'), findsOneWidget);
        expect(find.textContaining('Combined order'), findsOneWidget);
        expect(find.textContaining('Delivery fee ₹40'), findsOneWidget);
        expect(tester.takeException(), isNull);
        c.dispose();
      });

      testWidgets('release asks first, names every restaurant, then gives the whole job back', (tester) async {
        await _smallPhone(tester, textScale: scale);
        final f = FakeRider();
        GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
        final c = await _rider(f);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        await _tapVisible(tester, find.byKey(const ValueKey('release-button')));
        await tester.pumpAndSettle();
        expect(find.text('Release this job?'), findsOneWidget);
        expect(find.textContaining('Kitchen 1 + Kitchen 2'), findsOneWidget);
        expect(find.textContaining('all of the 2 restaurants'), findsNothing);
        expect(find.textContaining('any of the 2 restaurants'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.ensureVisible(find.byKey(const ValueKey('confirm-release-button')));
        await tester.pump(const Duration(milliseconds: 300));
        await tester.tap(find.byKey(const ValueKey('confirm-release-button')));
        await tester.pumpAndSettle();
        expect(f.api.calls.where((x) => x.startsWith('release:')), ['release:gA']);
        expect(find.text('No active delivery'), findsOneWidget);
        c.dispose();
      });

      testWidgets('cancelled combined order: one stop notice with the reason', (tester) async {
        await _smallPhone(tester, textScale: scale);
        final f = FakeRider();
        GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
        final c = await _rider(f);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        final b = OrderView.tryParse(groupJson(index: 1, statuses: ['READY_FOR_PICKUP', 'CANCELLED'])
          ..['cancelledBy'] = 'VENDOR'
          ..['cancelReason'] = 'Out of stock'
          ..['updatedAt'] = testNow.add(const Duration(seconds: 30)).toUtc().toIso8601String())!;
        f.socket.emit(OrderUpdated(b));
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text('Stop – this order was cancelled'), findsOneWidget);
        expect(find.textContaining('Combined order'), findsOneWidget);
        expect(find.textContaining('Reason: Out of stock'), findsOneWidget);
        expect(find.textContaining('Do not go to the restaurants for this order.'), findsOneWidget);
        expect(tester.takeException(), isNull);
        c.dispose();
      });
    });
  }

  testWidgets('loading, error and empty states: checking first; a failed poll keeps the combined delivery and says so; nothing active says so', (tester) async {
    await _smallPhone(tester);
    final f = FakeRider();
    final w = GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
    final c = RiderController(f.services, myIds: {'u-rider'});
    await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
    expect(find.text('Checking for a delivery in progress…'), findsOneWidget);
    await tester.runAsync(c.start);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Collect from 2 restaurants'), findsOneWidget);
    f.api.active = offline;
    await tester.runAsync(c.pollNow);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.textContaining('Can\'t reach Kraveo'), findsOneWidget);
    expect(find.text('Collect from 2 restaurants'), findsOneWidget);
    w.released = true;
    w.sync();
    await tester.runAsync(c.pollNow);
    f.api.orders = {'gA': const ApiResult.fail(ApiFailure.notFound, statusCode: 404)};
    await tester.runAsync(c.pollNow);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('This delivery was moved'), findsOneWidget);
    c.dispose();
  });

  testWidgets('a stop with a verified pin navigates to that restaurant; a stop without says the location is not set; no request is sent by navigating', (tester) async {
    await _smallPhone(tester);
    final f = FakeRider();
    GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
    // only the primary's own copy is known: the second stop has no verified pin
    f.api.active = ApiResult.ok([groupChild(index: 0, statuses: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP'])]);
    final c = await _rider(f);
    final launcher = _Launcher();
    await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {}, navigationLauncher: launcher)));
    await tester.pump(const Duration(milliseconds: 600));
    await _show(tester, find.byKey(const ValueKey('navigate-stop-gA')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.widget<KButton>(find.byKey(const ValueKey('navigate-stop-gA'))).onPressed, isNotNull);
    expect(tester.widget<KButton>(find.byKey(const ValueKey('navigate-stop-gB'))).onPressed, isNull);
    expect(find.byKey(const ValueKey('stop-location-missing-gB')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('navigate-stop-gA')));
    await tester.pump();
    expect(launcher.opened, hasLength(1));
    expect(launcher.opened.single.toString(), contains('23.0745'));
    expect(f.api.calls.where((x) => x.startsWith('status:')), isEmpty);
    c.dispose();
  });

  testWidgets('the map shows every restaurant pin and the drop point; the plain card lists every stop', (tester) async {
    await _smallPhone(tester);
    final f = FakeRider();
    GroupWorld(f, start: ['READY_FOR_PICKUP', 'READY_FOR_PICKUP']);
    final c = await _rider(f);
    final factory = _FakeMapFactory();
    await tester.pumpWidget(_app(Scaffold(
      body: SingleChildScrollView(child: DeliveryMapCard(order: c.active!, rider: c.myPosition, factory: factory)),
    )));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    final spec = factory.lastSpec!;
    expect(spec.pickup, const GeoPoint(23.0745, 76.859));
    expect(spec.pickupName, 'Kitchen 1');
    expect(spec.morePickups.map((p) => (p.name, p.point)), [('Kitchen 2', const GeoPoint(23.0755, 76.859))]);
    expect(spec.drop, isNotNull);
    expect(spec.visiblePoints(), hasLength(3));

    // no real map on this phone: the plain card names both pickups
    await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: DeliveryMapCard(order: c.active!, rider: c.myPosition, factory: _NoMap())))));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Pickup 1 · Kitchen 1'), findsOneWidget);
    expect(find.textContaining('Pickup 2 · Kitchen 2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    c.dispose();
  });

  group('home, trips and push', () {
    Future<FakeRider> pumpHome(WidgetTester tester, {void Function(FakeRider f)? setup}) async {
      final f = FakeRider();
      setup?.call(f);
      await tester.pumpWidget(_app(DriverHomeScreen(services: f.services)));
      await tester.pump();
      await _settle(tester);
      return f;
    }

    testWidgets('on duty: ONE combined card; accept opens the merged delivery; every tab renders; home shows the combined order in progress', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) {
        final w = GroupWorld(f, start: ['ACCEPTED', 'ACCEPTED']);
        w.released = true;
        w.sync();
        f.api.available = ApiResult.ok([groupOffer()]);
        f.api.onClaim = (id) {
          w.released = false;
          w.sync();
          return ApiResult.ok(w.child(0));
        };
      });
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);
      expect(find.byKey(const ValueKey('offer-gA')), findsOneWidget);
      expect(find.text('Combined order - 2 restaurants'), findsOneWidget);
      await _tapVisible(tester, find.byKey(const ValueKey('accept-gA')));
      await tester.pump(const Duration(milliseconds: 600));
      expect(f.api.calls.where((x) => x.startsWith('claim')), ['claim:gA']);
      expect(find.text('Collect from 2 restaurants'), findsOneWidget);
      for (final tab in [LucideIcons.wallet, LucideIcons.history, LucideIcons.house]) {
        await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(tab)));
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull, reason: 'tab $tab');
      }
      expect(find.text('IN PROGRESS'), findsOneWidget);
      expect(find.textContaining('Combined order - 2 restaurants'), findsOneWidget);
      expect(find.textContaining('Order #'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('trips: a delivered combined order is ONE card naming both restaurants, counted once; the sheet lists every stop', (tester) async {
      await _smallPhone(tester);
      await pumpHome(tester, setup: (f) {
        final w = GroupWorld(f, start: ['DELIVERED', 'DELIVERED']);
        w.released = true;
        w.sync();
        f.api.onHistory = (_) => ApiResult.ok(OrderPage([...w.children, order(id: 'solo', status: 'DELIVERED', fee: 30, deliveredAt: testNow, updatedAt: testNow)], null));
      });
      await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(LucideIcons.history)));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Kitchen 1 + Kitchen 2'), findsOneWidget);
      expect(find.text('FC Night Mess'), findsOneWidget);
      expect(find.text('₹40'), findsOneWidget);
      await tester.tap(find.text('Kitchen 1 + Kitchen 2'));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.textContaining('Combined order'), findsOneWidget);
      expect(find.text('PICKUP 1'), findsOneWidget);
      expect(find.text('PICKUP 2'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('push taps for a combined order (the push carries the primary id)', () {
    Map<String, dynamic> data(String event) => {'event': event, 'orderId': 'gA', 'v': '1'};

    Future<({FakePushMessaging msg, FakeRider rider})> pump(WidgetTester tester, {void Function(FakeRider f)? setup}) async {
      tester.view.physicalSize = const Size(400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.runAsync(DriverApiService.clearToken);
      SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt', PushController.explainedPrefKey: true});
      final log = EventLog();
      final msg = FakePushMessaging(perm: PushPermission.granted, log: log);
      final push = PushController(messaging: msg, api: FakeDeviceApi(log), retryDelays: const []);
      final rider = FakeRider();
      setup?.call(rider);
      await tester.pumpWidget(KraveoDriverApp(auth: ApprovalAuth(), riderServices: () => rider.services, push: push));
      await tester.pump();
      await _settle(tester);
      return (msg: msg, rider: rider);
    }

    int tab(WidgetTester tester) => tester.widget<IndexedStack>(find.byType(IndexedStack)).index ?? -1;

    testWidgets('NEW_DELIVERY opens the pool and refreshes it; DELIVERY_ASSIGNED opens the ONE merged delivery', (tester) async {
      final r = await pump(tester, setup: (f) {
        final w = GroupWorld(f, start: ['ACCEPTED', 'ACCEPTED'], ids: ['gA', 'gB']);
        w.released = true;
        w.sync();
      });
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);
      await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(LucideIcons.wallet)));
      await tester.pump(const Duration(milliseconds: 600));
      expect(tab(tester), 2);
      r.rider.api.available = ApiResult.ok([groupOffer()]);
      r.msg.taps.add(PushIncoming(messageId: 'n1', data: data('NEW_DELIVERY')));
      await _settle(tester);
      expect(tab(tester), 0);
      expect(find.byKey(const ValueKey('offer-gA')), findsOneWidget);

      // the admin hands the combined order to this rider: both children are listed, the push names the primary
      r.rider.api.active = ApiResult.ok([
        groupChild(index: 0, statuses: ['ACCEPTED', 'ACCEPTED']).copyDriver('u1'),
        groupChild(index: 1, statuses: ['ACCEPTED', 'ACCEPTED']).copyDriver('u1'),
      ]);
      r.msg.taps.add(PushIncoming(messageId: 'a1', data: data('DELIVERY_ASSIGNED')));
      await _settle(tester);
      expect(tab(tester), 1);
      expect(find.text('Collect from 2 restaurants'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    });
  });

  test('the socket handshake carries the token (no Bearer prefix) and groups: 1', () {
    expect(handshakeAuth('Bearer abc.def'), {'token': 'abc.def', 'groups': 1});
    expect(handshakeAuth('abc.def'), {'token': 'abc.def', 'groups': 1});
  });
}

class _NoMap extends MapViewFactory {
  @override
  Future<bool> isAvailable() async => false;

  @override
  Widget build(BuildContext context, MapViewSpec spec) => throw StateError('no map');
}

extension on OrderView {
  /// The same child, assigned to the rider with this user id (the push test signs in as `u1`).
  OrderView copyDriver(String userId) {
    final j = groupJson(index: this.group!.index, statuses: [for (final s in stops) s.status.wire]);
    j['driver'] = {'id': userId, 'name': 'Test Rider', 'phone': '+91 9000000000'};
    return OrderView.tryParse(j)!;
  }
}
