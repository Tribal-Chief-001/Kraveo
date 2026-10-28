import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// A tab pager with, on its first tab, a nested horizontal PageView (a stand-in for the banner
/// carousel). [handoff] wraps the nested pager the way the carousel will.
Widget _app(PageController outer, PageController inner, {required bool handoff, bool scope = true, ScrollPhysics? physics}) {
  final nested = SizedBox(
    height: 200,
    child: PageView(
      key: const ValueKey('inner'),
      controller: inner,
      physics: physics ?? KTabPagerHandoff.pagePhysics,
      children: [for (var i = 0; i < 3; i++) Center(child: Text('banner $i'))],
    ),
  );
  Widget tabs = PageView(
    key: const ValueKey('outer'),
    controller: outer,
    children: [
      Column(children: [handoff ? KTabPagerHandoff(child: nested) : nested, const Text('tab 0 body')]),
      const Center(child: Text('tab 1')),
      const Center(child: Text('tab 2')),
    ],
  );
  if (scope) tabs = KTabPagerScope(controller: outer, child: tabs);
  return MaterialApp(home: Scaffold(body: tabs));
}

void main() {
  late PageController outer, inner;
  setUp(() {
    outer = PageController();
    inner = PageController();
  });
  tearDown(() {
    outer.dispose();
    inner.dispose();
  });

  testWidgets('a nested pager keeps its own drags while it has more pages', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(-300, 0), 1500);
    await tester.pumpAndSettle();
    expect(inner.page, 1);
    expect(outer.page, 0);
  });

  testWidgets('at the last nested page the swipe moves the tab pager, following the finger', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    inner.jumpToPage(2);
    await tester.pump();

    final g = await tester.startGesture(const Offset(300, 100));
    await g.moveBy(const Offset(-60, 0));
    await tester.pump();
    await g.moveBy(const Offset(-120, 0));
    await tester.pump();
    expect(outer.page, greaterThan(0.1), reason: 'the tab page is following the finger before release');
    expect(inner.page, 2);
    await g.moveBy(const Offset(-300, 0));
    await tester.pump();
    await g.up();
    await tester.pumpAndSettle();
    expect(outer.page, 1);
    expect(find.text('tab 1'), findsOneWidget);
  });

  testWidgets('a fast fling at the edge carries the tab pager to the next tab', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    inner.jumpToPage(2);
    await tester.pump();
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(-90, 0), 2500);
    await tester.pumpAndSettle();
    expect(outer.page, 1);
  });

  testWidgets('a short slow drag at the edge settles back on the same tab', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    inner.jumpToPage(2);
    await tester.pump();
    final g = await tester.startGesture(const Offset(300, 100));
    await g.moveBy(const Offset(-40, 0));
    await g.moveBy(const Offset(-40, 0));
    await tester.pump();
    expect(outer.page, greaterThan(0));
    await g.up();
    await tester.pumpAndSettle();
    expect(outer.page, 0);
  });

  testWidgets('at the first nested page a swipe right does nothing to the first tab', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(300, 0), 1500);
    await tester.pumpAndSettle();
    expect(outer.page, 0);
    expect(inner.page, 0);
  });

  testWidgets('hand-off works backwards: first nested page of a later tab goes to the previous tab', (tester) async {
    final outer2 = PageController(initialPage: 1);
    addTearDown(outer2.dispose);
    // Nested pager on tab 1 this time.
    await tester.pumpWidget(KTabPagerScope(
      controller: outer2,
      child: MaterialApp(
        home: Scaffold(
          body: PageView(controller: outer2, children: [
            const Center(child: Text('tab 0')),
            KTabPagerHandoff(
              child: PageView(key: const ValueKey('inner'), controller: inner, physics: KTabPagerHandoff.pagePhysics, children: const [Text('a'), Text('b')]),
            ),
          ]),
        ),
      ),
    ));
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(300, 0), 2000);
    await tester.pumpAndSettle();
    expect(outer2.page, 0);
  });

  testWidgets('without KTabPagerHandoff the nested pager swallows the swipe (the problem being solved)', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: false));
    inner.jumpToPage(2);
    await tester.pump();
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(-300, 0), 2500);
    await tester.pumpAndSettle();
    expect(outer.page, 0);
  });

  testWidgets('swipes outside the nested pager still page the tabs; vertical drags do nothing to the pager', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true));
    await tester.fling(find.text('tab 0 body'), const Offset(-300, 0), 1500);
    await tester.pumpAndSettle();
    expect(outer.page, 1);
    await tester.drag(find.text('tab 1'), const Offset(0, -200));
    await tester.pumpAndSettle();
    expect(outer.page, 1);
  });

  testWidgets('no KTabPagerScope above: the wrapper is inert and does not throw', (tester) async {
    await tester.pumpWidget(_app(outer, inner, handoff: true, scope: false));
    inner.jumpToPage(2);
    await tester.pump();
    await tester.fling(find.byKey(const ValueKey('inner')), const Offset(-300, 0), 2500);
    await tester.pumpAndSettle();
    expect(outer.page, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a nested plain horizontal list hands off with KTabPagerHandoff.listPhysics', (tester) async {
    await tester.pumpWidget(KTabPagerScope(
      controller: outer,
      child: MaterialApp(
        home: Scaffold(
          body: PageView(controller: outer, children: [
            KTabPagerHandoff(
              child: SizedBox(
                height: 60,
                child: ListView(scrollDirection: Axis.horizontal, physics: KTabPagerHandoff.listPhysics, children: [for (var i = 0; i < 4; i++) SizedBox(width: 300, child: Text('chip $i'))]),
              ),
            ),
            const Text('tab 1'),
          ]),
        ),
      ),
    ));
    await tester.drag(find.text('chip 0'), const Offset(-350, 0)); // not yet to the end of the list (extent 400)
    await tester.pumpAndSettle();
    expect(outer.page, 0, reason: 'the list used its own drag first');
    await tester.fling(find.text('chip 3'), const Offset(-300, 0), 3000); // past the end: the rest goes to the tab pager
    await tester.pumpAndSettle();
    expect(outer.page, 1);
  });

  testWidgets('KTabPagerScope.maybeOf finds the controller, or null', (tester) async {
    PageController? found;
    PageController? none = outer;
    await tester.pumpWidget(KTabPagerScope(
      controller: outer,
      child: Builder(builder: (context) {
        found = KTabPagerScope.maybeOf(context);
        return const SizedBox();
      }),
    ));
    expect(found, same(outer));
    await tester.pumpWidget(Builder(builder: (context) {
      none = KTabPagerScope.maybeOf(context);
      return const SizedBox();
    }));
    expect(none, isNull);
  });
}
