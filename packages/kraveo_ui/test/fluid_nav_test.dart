import 'dart:ui' show Tristate;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

const _items = [
  KNavItem(Icons.home, 'Home'),
  KNavItem(Icons.pedal_bike, 'Track'),
  KNavItem(Icons.receipt, 'Orders'),
  KNavItem(Icons.person, 'Me'),
];

final _blob = find.byKey(const ValueKey('k-fluid-nav-blob'));

Widget _host(
  Widget nav, {
  double textScale = 1,
  bool reduce = false,
  ThemeData? theme,
}) {
  return MediaQuery(
    data: const MediaQueryData(),
    child: MaterialApp(
      theme: theme ?? KraveoTheme.customer(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale), disableAnimations: reduce),
        child: child!,
      ),
      home: Scaffold(
        extendBody: true,
        body: const SizedBox.expand(),
        bottomNavigationBar: nav,
      ),
    ),
  );
}

/// Phone-sized surface: MaterialApp reads the width from the test view, not from a MediaQuery above it.
void _width(WidgetTester t, double w) {
  t.view.physicalSize = Size(w, 800);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
}

Rect _itemRect(WidgetTester t, int i) => t.getRect(find.byType(KPressable).at(i));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('selected tab shows its label, the others show only an icon', (tester) async {
    final pos = ValueNotifier<double>(0);
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {})));
    await tester.pump();
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Track'), findsNothing);
    expect(find.byIcon(Icons.home), findsOneWidget);
    expect(find.byIcon(Icons.person), findsOneWidget);
    expect(tester.getSize(find.byType(KFluidNav)).height, greaterThanOrEqualTo(68));

    pos.value = 2;
    await tester.pump();
    expect(find.text('Orders'), findsOneWidget);
    expect(find.text('Home'), findsNothing);
  });

  testWidgets('tap reports the index of the tapped item, with one haptic tick', (tester) async {
    final ticks = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'HapticFeedback.vibrate') ticks.add(call);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final pos = ValueNotifier<double>(0);
    final taps = <int>[];
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (i) {
      taps.add(i);
      pos.value = i.toDouble(); // the shell would animate the pager here
    })));
    await tester.tap(find.byType(KPressable).at(2));
    await tester.pump();
    expect(taps, [2]);
    expect(ticks.length, 1, reason: 'the tap tick is not doubled by the selection change');

    pos.value = 3; // swipe-driven change: its own tick
    await tester.pump();
    expect(ticks.length, 2);
    await tester.tap(find.byType(KPressable).at(3));
    await tester.pump();
    expect(taps, [2, 3], reason: 're-tapping the selected tab still reports it');
    expect(ticks.length, 2);
  });

  testWidgets('highlight and icon tint follow the page position at 0, 0.5 and 1.0', (tester) async {
    final pos = ValueNotifier<double>(0);
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {})));
    await tester.pump();
    final k = KraveoTokens.customer;
    Color tintOf(IconData d) => tester.widget<Icon>(find.byIcon(d)).color!;

    expect((tester.getCenter(_blob).dx - _itemRect(tester, 0).center.dx).abs(), lessThan(0.5));
    expect(tintOf(Icons.home), k.onBrand);
    expect(tintOf(Icons.pedal_bike), k.inkFaint);

    pos.value = 0.5;
    await tester.pump();
    await tester.pump(const Duration(seconds: 1)); // let the stretch spring settle
    final mid = (_itemRect(tester, 0).center.dx + _itemRect(tester, 1).center.dx) / 2;
    expect((tester.getCenter(_blob).dx - mid).abs(), lessThan(0.5));
    expect(tintOf(Icons.home), tintOf(Icons.pedal_bike), reason: 'equally close to both');
    expect(tintOf(Icons.home), isNot(k.onBrand));
    expect(tintOf(Icons.home), isNot(k.inkFaint));

    pos.value = 1;
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect((tester.getCenter(_blob).dx - _itemRect(tester, 1).center.dx).abs(), lessThan(0.5));
    expect(tintOf(Icons.pedal_bike), k.onBrand);
    expect(tintOf(Icons.home), k.inkFaint);
    expect(find.text('Track'), findsOneWidget);
  });

  testWidgets('follows a real PageController while the finger drags', (tester) async {
    final controller = PageController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(_host(KFluidNav(items: _items, controller: controller, onTap: (_) {})));
    // No pager attached yet: shows the initial page.
    expect((tester.getCenter(_blob).dx - _itemRect(tester, 0).center.dx).abs(), lessThan(0.5));

    await tester.pumpWidget(MaterialApp(
      theme: KraveoTheme.customer(),
      home: Scaffold(
        body: PageView(controller: controller, children: [for (var i = 0; i < 4; i++) Center(child: Text('page $i'))]),
        bottomNavigationBar: KFluidNav(items: _items, controller: controller, onTap: (_) {}),
      ),
    ));
    await tester.pump();
    final before = tester.getCenter(_blob).dx;
    final g = await tester.startGesture(const Offset(200, 300));
    await g.moveBy(const Offset(-120, 0));
    await tester.pump();
    final during = tester.getCenter(_blob).dx;
    expect(during, greaterThan(before), reason: 'the highlight moved with the finger, before it was released');
    expect(find.text('Home'), findsOneWidget, reason: 'still closest to Home');
    await g.moveBy(const Offset(-350, 0));
    await tester.pump();
    await g.up();
    await tester.pumpAndSettle();
    expect(controller.page, 1);
    expect(find.text('Track'), findsOneWidget);
    expect((tester.getCenter(_blob).dx - _itemRect(tester, 1).center.dx).abs(), lessThan(0.5));
  });

  testWidgets('a label that does not fit (2x text on a 360 dp screen) falls back to icon only', (tester) async {
    _width(tester, 360);
    final pos = ValueNotifier<double>(0);
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {})));
    await tester.pump();
    expect(find.text('Home'), findsOneWidget, reason: 'fits at 1x');
    pos.value = 2;
    await tester.pump();
    expect(find.text('Orders'), findsOneWidget, reason: 'the longest label fits at 1x on 360 dp');

    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {}), textScale: 2));
    await tester.pump();
    expect(find.text('Orders'), findsNothing);
    expect(find.text('Home'), findsNothing);
    expect(tester.takeException(), isNull, reason: 'no overflow');
    for (var i = 0; i < 4; i++) {
      expect(_itemRect(tester, i).width, greaterThanOrEqualTo(48));
      expect(_itemRect(tester, i).height, greaterThanOrEqualTo(48));
    }
  });

  testWidgets('every item is at least 48 dp wide and tall, also with five items on 320 dp', (tester) async {
    _width(tester, 320);
    final pos = ValueNotifier<double>(1);
    final five = [..._items, const KNavItem(Icons.star, 'More')];
    await tester.pumpWidget(_host(KFluidNav(items: five, position: pos, onTap: (_) {})));
    await tester.pump();
    for (var i = 0; i < 5; i++) {
      expect(_itemRect(tester, i).width, greaterThanOrEqualTo(48), reason: 'item $i');
      expect(_itemRect(tester, i).height, greaterThanOrEqualTo(48));
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('badge shows the count, caps at 99+ and disappears at zero', (tester) async {
    final pos = ValueNotifier<double>(0);
    Widget nav(int b) => _host(KFluidNav(
          items: [_items[0], KNavItem(Icons.pedal_bike, 'Track', badge: b), _items[2], _items[3]],
          position: pos,
          onTap: (_) {},
        ));
    await tester.pumpWidget(nav(0));
    await tester.pumpAndSettle();
    expect(find.text('3'), findsNothing);
    await tester.pumpWidget(nav(3));
    await tester.pump(const Duration(milliseconds: 120));
    final mid = tester.widget<ScaleTransition>(find.ancestor(of: find.text('3'), matching: find.byType(ScaleTransition)).first).scale.value;
    expect(mid, greaterThan(0));
    expect(mid, lessThan(1.2), reason: 'popping in');
    await tester.pumpAndSettle();
    expect(find.text('3'), findsOneWidget);
    await tester.pumpWidget(nav(250));
    await tester.pumpAndSettle();
    expect(find.text('99+'), findsOneWidget);
    await tester.pumpWidget(nav(0));
    await tester.pumpAndSettle();
    expect(find.text('99+'), findsNothing);
  });

  testWidgets('each item is a tab for accessibility with label, position and selected state', (tester) async {
    final handle = tester.ensureSemantics();
    final pos = ValueNotifier<double>(0);
    final taps = <int>[];
    await tester.pumpWidget(_host(KFluidNav(
      items: [_items[0], const KNavItem(Icons.pedal_bike, 'Track', badge: 2), _items[2], _items[3]],
      position: pos,
      onTap: taps.add,
    )));
    await tester.pump();
    final home = tester.getSemantics(find.bySemanticsLabel('Home, tab 1 of 4'));
    expect(home.flagsCollection.isSelected, Tristate.isTrue);
    expect(home.role, SemanticsRole.tab);
    final track = tester.getSemantics(find.bySemanticsLabel('Track, 2 new, tab 2 of 4'));
    expect(track.flagsCollection.isSelected, Tristate.isFalse);
    expect(find.bySemanticsLabel('Me, tab 4 of 4'), findsOneWidget);
    tester.semantics.tap(find.semantics.byLabel('Me, tab 4 of 4'));
    expect(taps, [3]);
    handle.dispose();
  });

  testWidgets('reduce motion: no stretch while moving; animations end in the same resting place', (tester) async {
    Future<(double, double)> run(bool reduce) async {
      final pos = ValueNotifier<double>(0);
      await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {}), reduce: reduce));
      await tester.pump();
      for (final v in [0.15, 0.3, 0.45, 0.6]) {
        pos.value = v;
        await tester.pump(const Duration(milliseconds: 16));
      }
      final moving = tester.getSize(_blob).width;
      for (var i = 0; i < 120; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      return (moving, tester.getSize(_blob).width);
    }

    final normal = await run(false);
    final reduced = await run(true);
    expect(normal.$1, greaterThan(reduced.$1 + 1), reason: 'the highlight stretches while it moves fast');
    expect((normal.$2 - reduced.$2).abs(), lessThan(0.5), reason: 'and settles at the same size');
  });

  testWidgets('reduce motion: badge appears instantly', (tester) async {
    final pos = ValueNotifier<double>(0);
    Widget nav(int b) => _host(KFluidNav(items: [_items[0], KNavItem(Icons.pedal_bike, 'Track', badge: b), _items[2], _items[3]], position: pos, onTap: (_) {}), reduce: true);
    await tester.pumpWidget(nav(0));
    await tester.pumpWidget(nav(4));
    await tester.pump();
    expect(find.text('4'), findsOneWidget);
    expect(tester.widget<ScaleTransition>(find.ancestor(of: find.text('4'), matching: find.byType(ScaleTransition)).first).scale.value, 1);
  });

  testWidgets('dark theme (driver tokens) renders with its own colours and no exception', (tester) async {
    final pos = ValueNotifier<double>(1);
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {}), theme: KraveoTheme.driver()));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(tester.widget<Icon>(find.byIcon(Icons.pedal_bike)).color, KraveoTokens.driver.onBrand);
    expect(tester.widget<Icon>(find.byIcon(Icons.home)).color, KraveoTokens.driver.inkFaint);
    expect(find.text('Track'), findsOneWidget);
  });

  testWidgets('selected icon pops when the tab changes and returns to rest', (tester) async {
    final pos = ValueNotifier<double>(0);
    await tester.pumpWidget(_host(KFluidNav(items: _items, position: pos, onTap: (_) {})));
    await tester.pump();
    double scaleOf(IconData d) => tester.widget<Transform>(find.ancestor(of: find.byIcon(d), matching: find.byType(Transform)).first).transform.getMaxScaleOnAxis();
    final rest = scaleOf(Icons.pedal_bike);
    pos.value = 1;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final popped = scaleOf(Icons.pedal_bike);
    await tester.pump(const Duration(seconds: 1));
    final settled = scaleOf(Icons.pedal_bike);
    expect(popped, greaterThan(settled));
    expect(settled, greaterThan(rest), reason: 'the selected icon rests slightly larger');
  });

  test('exactly one of controller / position is required', () {
    expect(() => KFluidNav(items: _items, onTap: (_) {}), throwsAssertionError);
    expect(() => KFluidNav(items: _items, onTap: (_) {}, controller: PageController(), position: ValueNotifier(0.0)), throwsAssertionError);
  });
}
