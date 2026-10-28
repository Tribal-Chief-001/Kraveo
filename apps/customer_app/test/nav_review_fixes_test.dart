// Review fixes for the swipeable shell (Docs/bughunt/BANNERS_NAV_review.md): M4 no feed rebuild on
// swipe, M5 map only when shown + background warm-up, M6 no Track watch churn, L2 back/target
// during an animation, L5 banner refresh timer, L11 order switcher hand-off.
import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/banner_provider.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/order_history_screen.dart';
import 'package:customer_app/screens/profile_screen.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/widgets/map/tracking_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'campus_drop_points_test.dart' show FakeMapFactory, liveOrder;
import 'support/order_fakes.dart';
import 'support/sample_catalog.dart';

Future<void> _loadFonts() async {
  const fonts = {
    'packages/kraveo_ui/Bricolage': 'packages/kraveo_ui/assets/fonts/BricolageGrotesque.ttf',
    'packages/kraveo_ui/Jakarta': 'packages/kraveo_ui/assets/fonts/PlusJakartaSans.ttf',
  };
  for (final e in fonts.entries) {
    final loader = FontLoader(e.key)..addFont(rootBundle.load(e.value));
    await loader.load();
  }
}

class _CountingBanners extends BannerProvider {
  int refreshes = 0;
  @override
  Future<void> refresh() {
    refreshes++;
    return Future.value();
  }
}

OrderModel _order(String id, {String vendor = 'Sharma Highway Dhaba'}) => OrderModel.tryParse(
      orderJson(id: id, status: 'PICKED_UP', paymentStatus: 'PAID', dropoffHostel: 'BH2', vendorName: vendor, driver: {'id': 'd', 'name': 'Ravi'}),
    )!;

Future<(FakeOrderApi, OrderProvider)> _ordersWith(List<OrderModel> live) async {
  final api = FakeOrderApi();
  for (final o in live) {
    api.server[o.id] = o;
  }
  api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'history' ? const [] : live, null));
  final orders = fakeOrders(api)..beginSession('u1');
  await orders.refreshActive();
  return (api, orders);
}

Future<void> _pumpShell(WidgetTester tester, {OrderProvider? orders, BannerProvider? banners}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final session = SessionProvider(initial: SessionStatus.checking)
    ..beginForTest({'id': 'u1', 'name': 'Aarav Sharma', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 1', 'avatarId': 2});
  await tester.pumpWidget(MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionProvider>.value(value: session),
      ChangeNotifierProvider<DhabaProvider>.value(value: sampleCatalogProvider()),
      ChangeNotifierProvider<CartProvider>.value(value: CartProvider()),
      ChangeNotifierProvider<OrderProvider>.value(value: orders ?? (fakeOrders(FakeOrderApi())..beginSession('u1'))),
      if (banners != null) ChangeNotifierProvider<BannerProvider>.value(value: banners),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: const HomeScreen()),
  ));
  await _settle(tester);
}

Future<void> _settle(WidgetTester tester, {int ms = 1000}) async {
  for (var i = 0; i < ms ~/ 20; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

PageController _pager(WidgetTester t) => t.widget<PageView>(find.byType(PageView).first).controller!;
double _page(WidgetTester t) => _pager(t).page!;
Finder _navItem(IconData icon) => find.descendant(of: find.byType(KFluidNav), matching: find.byIcon(icon));

void main() {
  setUpAll(_loadFonts);
  setUp(() => FakeRealtime.created.clear());

  testWidgets('M4: swiping, tapping and aborted drags never rebuild the Home feed', (tester) async {
    await _pumpShell(tester);
    await _settle(tester, ms: 3000); // first frames + the background warm-up are done
    final base = debugHomeFeedBuilds;
    expect(base, greaterThan(0));

    await tester.flingFrom(const Offset(180, 520), const Offset(-250, 0), 1500); // Home -> Track
    await _settle(tester);
    final g = await tester.startGesture(const Offset(180, 330)); // a wobble that springs back
    await g.moveBy(const Offset(-50, 0));
    await g.moveBy(const Offset(50, 0));
    await tester.pump();
    await g.up();
    await _settle(tester);
    await tester.tap(_navItem(LucideIcons.user));
    await _settle(tester);
    await tester.tap(_navItem(LucideIcons.house));
    await _settle(tester);
    expect(_page(tester), 0);
    expect(debugHomeFeedBuilds, base, reason: 'the pager state lives in notifiers; the feed was not rebuilt');
  });

  group('Track tab and the order provider (M6)', () {
    testWidgets('a drag that springs back causes no unwatch, no GET; leaving and returning does', (tester) async {
      final (api, orders) = await _ordersWith([_order('t-1')]);
      await _pumpShell(tester, orders: orders);
      await tester.tap(_navItem(LucideIcons.bike));
      await _settle(tester);
      expect(orders.isWatching('t-1'), isTrue);
      final gets = api.fetchedIds.length;

      final g = await tester.startGesture(const Offset(180, 330));
      await g.moveBy(const Offset(40, 0)); // slop
      for (var i = 0; i < 4; i++) {
        await g.moveBy(const Offset(10, 0));
        await tester.pump(const Duration(milliseconds: 16));
        expect(orders.isWatching('t-1'), isTrue, reason: 'the page is still mostly on Track');
      }
      for (var i = 0; i < 8; i++) {
        await g.moveBy(const Offset(-10, 0));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await g.up();
      await _settle(tester);
      expect(_page(tester), 1);
      expect(orders.isWatching('t-1'), isTrue);
      expect(api.fetchedIds.length, gets, reason: 'no refresh GET after the wobble');

      await tester.flingFrom(const Offset(180, 330), const Offset(-250, 0), 1500);
      await _settle(tester);
      expect(_page(tester), 2);
      expect(orders.isWatching('t-1'), isFalse, reason: 'really left Track');
      await tester.tap(_navItem(LucideIcons.bike));
      await _settle(tester);
      expect(orders.isWatching('t-1'), isTrue);
      expect(api.fetchedIds.length, gets + 1, reason: 'one refresh on return');
    });
  });

  group('the real map (M5)', () {
    Future<void> pumpTrack(WidgetTester tester, FakeMapFactory f, bool visible) async {
      final (_, orders) = await _ordersWith([liveOrder()]);
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionProvider>.value(value: SessionProvider(initial: SessionStatus.signedIn)),
          ChangeNotifierProvider<DhabaProvider>.value(value: DhabaProvider()),
          ChangeNotifierProvider<CartProvider>.value(value: CartProvider()),
          ChangeNotifierProvider<OrderProvider>.value(value: orders),
        ],
        child: MaterialApp(theme: KraveoTheme.customer(), home: LiveTrackingScreen(visible: visible, mapFactory: f)),
      ));
      await _settle(tester, ms: 600);
    }

    testWidgets('not created while the tab is only passing by; created once shown, and kept afterwards', (tester) async {
      final f = FakeMapFactory();
      await pumpTrack(tester, f, false);
      expect(f.specs, isEmpty);
      expect(find.byKey(const ValueKey('fake-map')), findsNothing);
      expect(find.byType(TrackingMap), findsOneWidget);

      await pumpTrack(tester, f, true);
      await _settle(tester, ms: 600);
      expect(f.specs, isNotEmpty);
      expect(find.byKey(const ValueKey('fake-map')), findsOneWidget);

      await pumpTrack(tester, f, false); // swiped away: the map stays (no re-creation next time)
      expect(find.byKey(const ValueKey('fake-map')), findsOneWidget);
    });

    testWidgets('in the shell the map stays off while Home is shown, even after the background warm-up', (tester) async {
      final (_, orders) = await _ordersWith([liveOrder()]);
      await _pumpShell(tester, orders: orders);
      await _settle(tester, ms: 3000);
      final track = find.byType(TrackingMap, skipOffstage: false);
      expect(track, findsOneWidget, reason: 'Track was built in the background');
      expect(tester.widget<TrackingMap>(track).mapEnabled, isFalse);
      await tester.tap(_navItem(LucideIcons.bike));
      await _settle(tester);
      expect(tester.widget<TrackingMap>(find.byType(TrackingMap)).mapEnabled, isTrue);
    });
  });

  group('background warm-up of the other tabs', () {
    testWidgets('Orders, Me and Track are built after Home is up; hidden tabs stay out of the semantics tree', (tester) async {
      final handle = tester.ensureSemantics();
      await _pumpShell(tester);
      expect(find.byType(OrderHistoryScreen, skipOffstage: false), findsNothing, reason: 'not before the warm-up delay');
      await _settle(tester, ms: 3000);
      expect(find.byType(LiveTrackingScreen, skipOffstage: false), findsOneWidget);
      expect(find.byType(OrderHistoryScreen, skipOffstage: false), findsOneWidget);
      expect(find.byType(ProfileScreen, skipOffstage: false), findsOneWidget);
      expect(find.semantics.byPredicate((n) => n.label.contains('Delete account')), findsNothing, reason: 'the Me tab is hidden from screen readers');
      expect(find.semantics.byPredicate((n) => n.label.contains('No active order')), findsNothing);

      await tester.tap(_navItem(LucideIcons.user));
      await _settle(tester);
      expect(find.semantics.byPredicate((n) => n.label.contains('Home, tab 1 of 4')), findsOneWidget);
      handle.dispose();
    });

    testWidgets('no warm-up work is left running after the screen is gone', (tester) async {
      await _pumpShell(tester);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
      expect(tester.takeException(), isNull);
    });
  });

  group('back button and animation target (L2)', () {
    late int exits;
    void mockPlatform(WidgetTester tester) {
      exits = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'SystemNavigator.pop') exits++;
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    }

    testWidgets('back at several moments of a Home -> Me animation always returns to Home and never leaves the app', (tester) async {
      mockPlatform(tester);
      for (final ms in [20, 60, 120, 200, 300]) {
        await _pumpShell(tester);
        await tester.tap(_navItem(LucideIcons.user));
        await tester.pump();
        await tester.pump(Duration(milliseconds: ms));
        await tester.binding.handlePopRoute();
        await _settle(tester);
        expect(_page(tester), 0, reason: 'back after $ms ms');
        expect(exits, 0, reason: 'back after $ms ms must not exit');
        await tester.pumpWidget(const SizedBox());
      }
    });

    testWidgets('back on a settled Home leaves the app (unchanged)', (tester) async {
      mockPlatform(tester);
      await _pumpShell(tester);
      await tester.binding.handlePopRoute();
      await _settle(tester, ms: 200);
      expect(exits, 1);
    });

    testWidgets('tapping the same target again does not restart the animation', (tester) async {
      await _pumpShell(tester);
      await tester.tap(_navItem(LucideIcons.user));
      await tester.pump();
      await _settle(tester, ms: 100);
      await tester.tap(_navItem(LucideIcons.user));
      await tester.tap(_navItem(LucideIcons.user));
      await _settle(tester, ms: 360); // 460 ms after the first tap; a restart would end at ~480+
      expect(_page(tester), 3);
    });
  });

  group('banner refresh timer (L5)', () {
    testWidgets('refreshes every 10 minutes while Home is shown and the app is in front; catches up when back on Home', (tester) async {
      final banners = _CountingBanners();
      await _pumpShell(tester, banners: banners);
      final first = banners.refreshes;
      expect(first, greaterThanOrEqualTo(1));

      await tester.pump(kBannerRefreshInterval);
      expect(banners.refreshes, first + 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(kBannerRefreshInterval);
      expect(banners.refreshes, first + 1, reason: 'app in the background');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      final afterResume = banners.refreshes; // the existing on-resume refresh

      await tester.tap(_navItem(LucideIcons.receiptText));
      await _settle(tester);
      await tester.pump(kBannerRefreshInterval);
      expect(banners.refreshes, afterResume, reason: 'Home is not the shown tab');
      await tester.tap(_navItem(LucideIcons.house));
      await _settle(tester);
      expect(banners.refreshes, afterResume + 1, reason: 'one catch-up refresh on return to Home');
    });
  });

  testWidgets('L11: the Track order switcher hands its overscroll to the tab pager', (tester) async {
    final (_, orders) = await _ordersWith([for (var i = 0; i < 5; i++) _order('t-$i', vendor: 'Kitchen number $i with a long name')]);
    await _pumpShell(tester, orders: orders);
    await tester.tap(_navItem(LucideIcons.bike));
    await _settle(tester);
    final switcher = find.byKey(const ValueKey('order-switcher'));
    expect(switcher, findsOneWidget);
    final list = tester.state<ScrollableState>(find.descendant(of: switcher, matching: find.byType(Scrollable)));
    expect(list.position.maxScrollExtent, greaterThan(100));
    list.position.jumpTo(list.position.maxScrollExtent);
    await tester.pump();
    await tester.flingFrom(tester.getCenter(switcher), const Offset(-250, 0), 2500);
    await _settle(tester);
    expect(_page(tester), 2);
  });
}
