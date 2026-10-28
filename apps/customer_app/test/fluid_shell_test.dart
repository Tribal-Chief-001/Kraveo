// The swipeable tab shell (PageView + KFluidNav) in HomeScreen: swiping, tapping, keep-alive,
// back button, the Track tab's `visible` flag, and the gesture rule for the tracking map.
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/screens/profile_screen.dart';
import 'package:customer_app/widgets/map/map_view.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

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

Future<OrderProvider> _orders() async {
  final o = fakeOrders(FakeOrderApi())..beginSession('u1');
  await o.refreshActive();
  return o;
}

Future<void> _pumpShell(WidgetTester tester) async {
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
      ChangeNotifierProvider<OrderProvider>.value(value: await _orders()),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: const HomeScreen()),
  ));
  await _settle(tester);
}

/// Small steps: the app has looping animations, so pumpAndSettle would never return.
Future<void> _settle(WidgetTester tester, {int ms = 1000}) async {
  for (var i = 0; i < ms ~/ 20; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

PageController _pager(WidgetTester t) => t.widget<PageView>(find.byType(PageView).first).controller!;
double _page(WidgetTester t) => _pager(t).page!;
Finder _navText(String s) => find.descendant(of: find.byType(KFluidNav), matching: find.text(s));
Finder _navItem(IconData icon) => find.descendant(of: find.byType(KFluidNav), matching: find.byIcon(icon));
// skipOffstage: false - a kept-alive tab that was swiped away is not "on stage" but still exists.
bool _trackVisible(WidgetTester t) => t.widget<LiveTrackingScreen>(find.byType(LiveTrackingScreen, skipOffstage: false)).visible;
final _blob = find.byKey(const ValueKey('k-fluid-nav-blob'));
ScrollableState _feed(WidgetTester t) => t.state<ScrollableState>(find.descendant(of: find.byType(CustomScrollView).first, matching: find.byType(Scrollable)).first);

void main() {
  setUpAll(_loadFonts);

  testWidgets('starts on Home with a four-tab nav; items are tabs for screen readers', (tester) async {
    final handle = tester.ensureSemantics();
    await _pumpShell(tester);
    expect(_page(tester), 0);
    expect(_navText('Home'), findsOneWidget);
    expect(find.bySemanticsLabel('Home, tab 1 of 4'), findsOneWidget);
    expect(find.bySemanticsLabel('Track, tab 2 of 4'), findsOneWidget);
    expect(find.bySemanticsLabel('Orders, tab 3 of 4'), findsOneWidget);
    expect(find.bySemanticsLabel('Me, tab 4 of 4'), findsOneWidget);
    expect(find.byType(LiveTrackingScreen), findsNothing, reason: 'other tabs are built when first reached');
    expect(tester.takeException(), isNull);
    handle.dispose();
  });

  testWidgets('swiping left on the Home feed moves to Track; the nav highlight follows the finger and then rests on Track', (tester) async {
    await _pumpShell(tester);
    final home = tester.getCenter(_blob).dx;
    final g = await tester.startGesture(const Offset(180, 300));
    await g.moveBy(const Offset(-60, 0));
    await g.moveBy(const Offset(-120, 0));
    await tester.pump();
    expect(_page(tester), inInclusiveRange(0.2, 0.8), reason: 'the page follows the finger');
    expect(tester.getCenter(_blob).dx, greaterThan(home), reason: 'the highlight moved before the finger was lifted');
    expect(_trackVisible(tester), isFalse, reason: 'Track is not the settled tab while being dragged in');
    await g.moveBy(const Offset(-150, 0));
    await g.up();
    await _settle(tester);
    expect(_page(tester), 1);
    expect(_navText('Track'), findsOneWidget);
    expect(_navText('Home'), findsNothing);
    expect(_trackVisible(tester), isTrue, reason: 'settled on Track');

    // And on to Orders and Me, then back with a right swipe.
    await tester.fling(find.byType(PageView).first, const Offset(-300, 0), 1500);
    await _settle(tester);
    expect(_page(tester), 2);
    expect(_trackVisible(tester), isFalse);
    expect(_navText('Orders'), findsOneWidget);
    await tester.fling(find.byType(PageView).first, const Offset(-300, 0), 1500);
    await _settle(tester);
    expect(_page(tester), 3);
    await tester.fling(find.byType(PageView).first, const Offset(300, 0), 1500);
    await _settle(tester);
    expect(_page(tester), 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping a tab animates the pager (also across tabs) and the Track flag is true only once settled', (tester) async {
    await _pumpShell(tester);
    await tester.tap(_navItem(LucideIcons.bike));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(_page(tester), inExclusiveRange(0, 1), reason: 'animating, not jumping');
    expect(_trackVisible(tester), isFalse);
    await _settle(tester);
    expect(_page(tester), 1);
    expect(_trackVisible(tester), isTrue);

    // Far jump: Track -> Me animates through Orders, and Track stops being "visible" at once.
    await tester.tap(_navItem(LucideIcons.user));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(_page(tester), inExclusiveRange(1, 3));
    expect(_trackVisible(tester), isFalse);
    await _settle(tester);
    expect(_page(tester), 3);
    expect(_navText('Me'), findsOneWidget);

    // Tapping the tab you are on does nothing.
    await tester.tap(_navItem(LucideIcons.user));
    await _settle(tester);
    expect(_page(tester), 3);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tabs stay alive: Home scroll position and the Track screen state survive swipes', (tester) async {
    await _pumpShell(tester);
    await tester.drag(find.byType(PageView).first, const Offset(0, -250));
    await _settle(tester);
    final scrolled = _feed(tester).position.pixels;
    expect(scrolled, greaterThan(100));

    await tester.fling(find.byType(PageView).first, const Offset(-300, 0), 1500);
    await _settle(tester);
    final trackState = tester.state(find.byType(LiveTrackingScreen));
    await tester.fling(find.byType(PageView).first, const Offset(-300, 0), 1500);
    await _settle(tester);
    await tester.fling(find.byType(PageView).first, const Offset(300, 0), 1500);
    await _settle(tester);
    await tester.fling(find.byType(PageView).first, const Offset(300, 0), 1500);
    await _settle(tester);

    expect(_page(tester), 0);
    expect(_feed(tester).position.pixels, scrolled, reason: 'same scroll position');
    expect(find.byType(LiveTrackingScreen, skipOffstage: false), findsOneWidget, reason: 'Track was not rebuilt from scratch');
    expect(tester.state(find.byType(LiveTrackingScreen, skipOffstage: false)), same(trackState));
    expect(tester.takeException(), isNull);
  });

  testWidgets('system back from any other tab goes to Home first (animated), Home itself is left alone', (tester) async {
    await _pumpShell(tester);
    for (final icon in [LucideIcons.receiptText, LucideIcons.user, LucideIcons.bike]) {
      await tester.tap(_navItem(icon));
      await _settle(tester);
      expect(_page(tester), isNot(0));
      await tester.binding.handlePopRoute();
      await _settle(tester);
      expect(_page(tester), 0, reason: 'back from $icon');
      expect(_navText('Home'), findsOneWidget);
    }
  });

  testWidgets('back while a tap animation is still running also returns to Home', (tester) async {
    await _pumpShell(tester);
    await tester.tap(_navItem(LucideIcons.user));
    await tester.pump(const Duration(milliseconds: 40)); // far from halfway
    await tester.binding.handlePopRoute();
    await _settle(tester);
    expect(_page(tester), 0);
  });

  testWidgets('a button inside a tab can switch tabs (the _goToTab callers): Track "Explore kitchens" -> Home', (tester) async {
    await _pumpShell(tester);
    await tester.tap(_navItem(LucideIcons.bike));
    await _settle(tester);
    expect(find.text('No active order'), findsOneWidget);
    await tester.tap(find.text('Explore kitchens'));
    await _settle(tester);
    expect(_page(tester), 0);
    expect(_trackVisible(tester), isFalse);
  });

  testWidgets('reduce motion: a tap jumps straight to the tab, no animation', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const _NoAnimations();
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await _pumpShell(tester);
    await tester.tap(_navItem(LucideIcons.receiptText));
    await tester.pump();
    expect(_page(tester), 2, reason: 'no in-between frames');
    await _settle(tester, ms: 200);
    expect(_navText('Orders'), findsOneWidget);
  });

  testWidgets('swiping on the category chips past their end moves to the next tab (hand-off)', (tester) async {
    await _pumpShell(tester);
    final chips = find.byWidgetPredicate((w) => w is ListView && w.scrollDirection == Axis.horizontal);
    if (chips.evaluate().isEmpty) return; // no chip row for this catalog: nothing to hand off
    final list = tester.state<ScrollableState>(find.descendant(of: chips, matching: find.byType(Scrollable)));
    list.position.jumpTo(list.position.maxScrollExtent);
    await tester.pump();
    await tester.fling(chips, const Offset(-250, 0), 2500);
    await _settle(tester);
    expect(_page(tester), 1);
  });


  // ===================================================== whole-page swiping (owner requirement) ====
  group('every part of every page swipes the tabs', () {
    // Left edge, the strip behind the floating nav (bottom padding), right edge, and a middle point.
    const spots = {
      'left edge': Offset(6, 330),
      'right edge': Offset(354, 330),
      'strip behind the floating nav': Offset(180, 636),
      'left of the nav pill': Offset(8, 600),
    };
    const tabs = [LucideIcons.house, LucideIcons.bike, LucideIcons.receiptText, LucideIcons.user];

    for (var tab = 0; tab < 3; tab++) {
      for (final spot in spots.entries) {
        testWidgets('tab $tab: a swipe left on the ${spot.key} goes to tab ${tab + 1}, a swipe right comes back', (tester) async {
          await _pumpShell(tester);
          if (tab > 0) {
            await tester.tap(_navItem(tabs[tab]));
            await _settle(tester);
          }
          expect(_page(tester), tab.toDouble());
          await tester.flingFrom(spot.value, const Offset(-250, 0), 1500);
          await _settle(tester);
          expect(_page(tester), tab + 1.0);
          await tester.flingFrom(spot.value, const Offset(250, 0), 1500);
          await _settle(tester);
          expect(_page(tester), tab.toDouble());
          expect(tester.takeException(), isNull);
        });
      }
    }

    testWidgets('the Me tab (last) swipes back to Orders from the middle of the page', (tester) async {
      await _pumpShell(tester);
      await tester.tap(_navItem(LucideIcons.user));
      await _settle(tester);
      await tester.flingFrom(const Offset(180, 400), const Offset(250, 0), 1500);
      await _settle(tester);
      expect(_page(tester), 2);
    });

    testWidgets('the short, non-scrolling "No active order" page takes swipes on its empty areas and follows the finger', (tester) async {
      await _pumpShell(tester);
      await tester.tap(_navItem(LucideIcons.bike));
      await _settle(tester);
      expect(find.text('No active order'), findsOneWidget);
      final g = await tester.startGesture(const Offset(180, 500)); // empty area below the card, above the nav
      await g.moveBy(const Offset(40, 0)); // slop
      await g.moveBy(const Offset(120, 0));
      await tester.pump();
      expect(_page(tester), lessThan(1), reason: 'the page follows the finger (towards Home)');
      expect(_page(tester), greaterThan(0.2));
      expect(_trackVisible(tester), isFalse);
      await g.moveBy(const Offset(200, 0));
      await g.up();
      await _settle(tester);
      expect(_page(tester), 0);
    });

    testWidgets('mostly vertical drags scroll (and do not swipe); mostly horizontal drags swipe (and do not scroll)', (tester) async {
      await _pumpShell(tester);
      await tester.dragFrom(const Offset(180, 320), const Offset(12, -220));
      await _settle(tester);
      expect(_page(tester), 0);
      expect(_feed(tester).position.pixels, greaterThan(100));
      final before = _feed(tester).position.pixels;
      // (Away from the category chips: that row is a nested horizontal scrollable and keeps its own drags.)
      await tester.flingFrom(const Offset(180, 520), const Offset(-220, 12), 1500);
      await _settle(tester);
      expect(_page(tester), 1);
      await tester.flingFrom(const Offset(180, 520), const Offset(220, 12), 1500);
      await _settle(tester);
      expect(_page(tester), 0);
      expect(_feed(tester).position.pixels, before, reason: 'the swipes did not move the feed');
    });

    testWidgets('pull-to-refresh on Home still works', (tester) async {
      await _pumpShell(tester);
      final g = await tester.startGesture(const Offset(180, 200));
      await g.moveBy(const Offset(0, 60));
      await g.moveBy(const Offset(0, 160));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(RefreshProgressIndicator), findsOneWidget);
      expect(_page(tester), 0);
      await g.up();
      await _settle(tester, ms: 3000);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a vertical drag scrolls the Me tab too', (tester) async {
      await _pumpShell(tester);
      await tester.tap(_navItem(LucideIcons.user));
      await _settle(tester);
      final profile = tester.state<ScrollableState>(find.descendant(of: find.byType(ProfileScreen), matching: find.byType(Scrollable)).first);
      await tester.dragFrom(const Offset(180, 400), const Offset(8, -260));
      await _settle(tester);
      expect(profile.position.pixels, greaterThan(50));
      expect(_page(tester), 3);
    });

    testWidgets('edges: a swipe right on Home and a swipe left on the last tab clamp (page stays valid, never a blank page)', (tester) async {
      await _pumpShell(tester);
      final g = await tester.startGesture(const Offset(180, 330));
      await g.moveBy(const Offset(60, 0));
      await g.moveBy(const Offset(150, 0));
      await tester.pump();
      expect(_page(tester), 0, reason: 'clamped: the pager cannot go before Home');
      expect(find.text('Kitchens near campus'), findsOneWidget);
      await g.up();
      await _settle(tester);
      await tester.flingFrom(const Offset(180, 330), const Offset(300, 0), 2500);
      await _settle(tester);
      expect(_page(tester), 0);

      await tester.tap(_navItem(LucideIcons.user));
      await _settle(tester);
      await tester.flingFrom(const Offset(180, 330), const Offset(-300, 0), 2500);
      await _settle(tester);
      expect(_page(tester), 3);
      expect(_navText('Me'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('edges on iOS (bouncing physics): the overscroll springs back to the same tab', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      try {
        await _pumpShell(tester);
        await tester.flingFrom(const Offset(180, 330), const Offset(300, 0), 2500);
        await _settle(tester, ms: 2000);
        expect(_page(tester), 0);
        expect(_navText('Home'), findsOneWidget);
        expect(tester.takeException(), isNull);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });

  group('gesture rule for the tracking map', () {
    Widget app(PageController c, Set<Factory<OneSequenceGestureRecognizer>> map, List<double> pans) => MaterialApp(
          home: Scaffold(
            body: PageView(controller: c, children: [
              Column(children: [
                _MapStandIn(recognizers: map, onPan: pans.add),
                const Expanded(child: Center(child: Text('card below the map'))),
              ]),
              const Center(child: Text('next tab')),
            ]),
          ),
        );

    testWidgets('a horizontal drag on the map pans the map and does not swipe the tabs; elsewhere it swipes the tabs', (tester) async {
      final c = PageController();
      addTearDown(c.dispose);
      final pans = <double>[];
      await tester.pumpWidget(app(c, trackingMapGestureRecognizers, pans));
      await tester.drag(find.byKey(const ValueKey('map')), const Offset(-200, 0));
      await tester.pumpAndSettle();
      expect(pans.fold<double>(0, (a, b) => a + b), lessThan(-100), reason: 'the map got the drag');
      expect(c.page, 0);

      await tester.fling(find.text('card below the map'), const Offset(-300, 0), 1500);
      await tester.pumpAndSettle();
      expect(c.page, 1, reason: 'the surrounding area swipes tabs');
    });

    testWidgets('control: without the recognizers the tab pager takes the drag (the bug being prevented)', (tester) async {
      final c = PageController();
      addTearDown(c.dispose);
      final pans = <double>[];
      await tester.pumpWidget(app(c, const {}, pans));
      await tester.fling(find.byKey(const ValueKey('map')), const Offset(-300, 0), 1500);
      await tester.pumpAndSettle();
      expect(c.page, 1);
      expect(pans, isEmpty);
    });

    testWidgets('a vertical drag on the map is not claimed by it (the page keeps scrolling)', (tester) async {
      final c = PageController();
      addTearDown(c.dispose);
      final pans = <double>[];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PageView(controller: c, children: [
            ListView(children: [
              _MapStandIn(recognizers: trackingMapGestureRecognizers, onPan: pans.add),
              for (var i = 0; i < 30; i++) SizedBox(height: 80, child: Text('row $i')),
            ]),
          ]),
        ),
      ));
      final list = tester.state<ScrollableState>(find.byType(Scrollable).last);
      await tester.drag(find.byKey(const ValueKey('map')), const Offset(0, -150));
      await tester.pumpAndSettle();
      expect(list.position.pixels, greaterThan(100));
      expect(pans, isEmpty);
    });
  });
}

class _NoAnimations extends FakeAccessibilityFeatures {
  const _NoAnimations();
  @override
  bool get disableAnimations => true;
}

/// Stands in for the GoogleMap platform view: the same recognizers, reports horizontal pans.
class _MapStandIn extends StatelessWidget {
  const _MapStandIn({required this.recognizers, required this.onPan});
  final Set<Factory<OneSequenceGestureRecognizer>> recognizers;
  final void Function(double dx) onPan;

  bool _has(Type t) => recognizers.any((f) => f.type == t);

  @override
  Widget build(BuildContext context) => RawGestureDetector(
        behavior: HitTestBehavior.opaque,
        gestures: {
          if (_has(HorizontalDragGestureRecognizer))
            HorizontalDragGestureRecognizer: GestureRecognizerFactoryWithHandlers<HorizontalDragGestureRecognizer>(
              HorizontalDragGestureRecognizer.new,
              (r) => r.onUpdate = (d) => onPan(d.delta.dx),
            ),
          if (_has(ScaleGestureRecognizer))
            ScaleGestureRecognizer: GestureRecognizerFactoryWithHandlers<ScaleGestureRecognizer>(
              ScaleGestureRecognizer.new,
              (r) => r.onUpdate = (d) => onPan(d.focalPointDelta.dx),
            ),
        },
        child: const SizedBox(key: ValueKey('map'), height: 220, width: double.infinity),
      );
}
