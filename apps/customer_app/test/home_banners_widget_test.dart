// The Home banner carousel (Docs/25 section 4): behaviour with fake time, gestures, accessibility,
// text scale, dark mode, image states, and its place on the real Home screen.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:customer_app/models/home_banner.dart';
import 'package:customer_app/providers/banner_provider.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/external_links.dart';
import 'package:customer_app/widgets/home_banner_carousel.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'support/banner_fixtures.dart';
import 'support/category_fixtures.dart' show jsonResponse;
import 'support/order_fakes.dart';
import 'support/sample_catalog.dart';

// ----------------------------------------------------------------------------------- fake photos ----
// A 1x1 PNG served for every image request, so the "photo arrived" path can run without a network.
final Uint8List _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

class _Headers implements HttpHeaders {
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _Request implements HttpClientRequest {
  @override
  final HttpHeaders headers = _Headers();
  @override
  Future<HttpClientResponse> close() async => _Response();
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _Response extends Stream<List<int>> implements HttpClientResponse {
  @override
  int get statusCode => 200;
  @override
  int get contentLength => _png.length;
  @override
  HttpClientResponseCompressionState get compressionState => HttpClientResponseCompressionState.notCompressed;
  @override
  StreamSubscription<List<int>> listen(void Function(List<int>)? onData, {Function? onError, void Function()? onDone, bool? cancelOnError}) =>
      Stream<List<int>>.value(_png).listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _PhotoClient implements HttpClient {
  _PhotoClient(this.gate);
  final Future<void> gate;
  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    await gate;
    return _Request();
  }
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

// ---------------------------------------------------------------------------------------- harness ----
final _navFirst = banner('a', title: 'Alpha', subtitle: 'First sub', linkUrl: 'https://forms.gle/AbC123', ctaLabel: 'Join now', theme: BannerTheme.light);
final _navSecond = banner('b', title: 'Bravo');
final _navThird = banner('c', title: 'Charlie', subtitle: 'Third sub', linkUrl: 'https://play.google.com/store/apps/details?id=x', ctaLabel: 'Get app');
List<HomeBanner> _three() => [_navFirst, _navSecond, _navThird];

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

void _phone(WidgetTester tester, {double textScale = 1.0}) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

class _Host {
  _Host(this.tester, this.provider, {required this.tabShown, required this.outer});
  final WidgetTester tester;
  final BannerProvider provider;
  final ValueNotifier<bool> tabShown;
  final PageController outer;
}

/// The carousel on a scrolling page, like Home: inside a tab pager (so the hand-off has somewhere to go).
/// The carousel lives on the middle tab (page 1) of three. [tabShown] plays the shell's TickerMode.
Future<_Host> _pumpStrip(
  WidgetTester tester, {
  List<HomeBanner>? banners,
  ThemeData? theme,
  double textScale = 1.0,
  bool reduceMotion = false,
  bool tabShown = true,
  BannerProvider? provider,
  bool longPage = false,
}) async {
  _phone(tester, textScale: textScale);
  final p = provider ?? BannerProvider();
  if (banners != null) p.showForTest(banners);
  final shown = ValueNotifier<bool>(tabShown);
  final outer = PageController(initialPage: 1);
  addTearDown(outer.dispose);
  await tester.pumpWidget(
    ChangeNotifierProvider<BannerProvider>.value(
      value: p,
      child: MaterialApp(
        theme: theme ?? KraveoTheme.customer(),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion), child: child!),
        home: Scaffold(
          body: KTabPagerScope(
            controller: outer,
            child: PageView(controller: outer, children: [
              const Center(child: Text('tab 0')),
              ValueListenableBuilder<bool>(
                valueListenable: shown,
                builder: (context, on, _) => TickerMode(
                  enabled: on,
                  child: SingleChildScrollView(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const SizedBox(height: 40, child: Text('above')),
                      const HomeBannerCarousel(),
                      const SizedBox(height: 16),
                      SizedBox(height: longPage ? 1500 : 40, child: const Text('below')),
                    ]),
                  ),
                ),
              ),
              const Center(child: Text('tab 2')),
            ]),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  return _Host(tester, p, tabShown: shown, outer: outer);
}

/// Ends the test cleanly: the widgets and the provider's timer are gone before the framework checks.
Future<void> _end(_Host h) async {
  await h.tester.pumpWidget(const SizedBox());
  h.provider.dispose();
}

// skipOffstage: false - the Home tab is kept alive (off stage) while another tab is shown.
PageController _strip(WidgetTester t) => t.widget<PageView>(find.descendant(of: find.byType(BannerStrip, skipOffstage: false), matching: find.byType(PageView, skipOffstage: false))).controller!;
double _page(WidgetTester t) => _strip(t).page!;
Finder _dot(int i) => find.byKey(ValueKey('banner-dot-$i'));
double _dotW(WidgetTester t, int i) => t.getSize(_dot(i)).width - 6; // minus its 3 + 3 margin
Finder _stripFinder() => find.byType(BannerStrip);
/// The painted cards, in page order (their size is read through the transforms: scale and press feedback).
Finder _cards() => find.byWidgetPredicate((w) => w is Container && w.foregroundDecoration != null);
Size _painted(WidgetTester t, Finder f) {
  final d = t.getBottomRight(f) - t.getTopLeft(f);
  return Size(d.dx, d.dy);
}

/// Fake time in small steps (a frame at a time keeps the animations honest).
Future<void> _wait(WidgetTester t, Duration d) async {
  var left = d.inMilliseconds;
  while (left > 0) {
    final step = left > 100 ? 100 : left;
    await t.pump(Duration(milliseconds: step));
    left -= step;
  }
}

List<Uri> _launched = [];

void main() {
  setUpAll(_loadFonts);
  setUp(() {
    _launched = [];
    ExternalLinks.launcher = (uri) async {
      _launched.add(uri);
      return true;
    };
  });
  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    debugNetworkImageHttpClientProvider = null;
    ExternalLinks.launcher = (uri) async => false;
  });

  group('look and structure', () {
    testWidgets('no banners: nothing is drawn and no height is taken (with an empty provider and with no provider at all)', (tester) async {
      final h = await _pumpStrip(tester, banners: const []);
      expect(_stripFinder(), findsNothing);
      expect(tester.getSize(find.byType(HomeBannerCarousel)).height, 0);
      expect(tester.getTopLeft(find.text('below')).dy - tester.getTopLeft(find.text('above')).dy, 56, reason: '40 + 16, the carousel adds nothing');
      await _end(h);

      _phone(tester);
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.customer(), home: const Scaffold(body: Column(children: [HomeBannerCarousel(), Text('x')]))));
      expect(tester.getSize(find.byType(HomeBannerCarousel)), Size.zero);
      expect(tester.takeException(), isNull);
    });

    testWidgets('banners show as 2:1 cards in a 0.9 viewport (the next card peeks), with title, subtitle and a CTA pill only with a link', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      expect(_strip(tester).viewportFraction, 0.9);
      expect(find.text('Alpha'), findsOneWidget);
      expect(find.text('First sub'), findsOneWidget);
      expect(find.text('Join now'), findsOneWidget);
      // The second card is built (peeks) and is partly on screen; the third is not built yet.
      expect(find.text('Bravo'), findsOneWidget);
      expect(find.text('Charlie'), findsNothing);
      final card = tester.getRect(find.byType(KPressable).first);
      expect(card.width / card.height, closeTo(2.0, 0.02));
      expect(card.width, closeTo(360 * 0.9 - 8, 0.5));
      expect(tester.getTopLeft(find.text('Bravo')).dx, greaterThan(300), reason: 'the second card starts near the right edge');
      expect(tester.takeException(), isNull);
      await _end(h);
    });

    testWidgets('the CTA pill needs both a label and a link: a link without a label and a label without a link show none', (tester) async {
      final h = await _pumpStrip(tester, banners: [
        banner('l', title: 'Link only', linkUrl: 'https://forms.gle/x'),
        banner('c', title: 'Label only', ctaLabel: 'Go now'),
      ]);
      await _wait(tester, const Duration(seconds: 1));
      expect(find.byIcon(Icons.arrow_forward), findsNothing);
      expect(find.text('Go now'), findsNothing);
      expect(find.text('Link only'), findsOneWidget);
      await _end(h);
    });

    testWidgets('dots: hidden for a single banner, one per banner otherwise', (tester) async {
      var h = await _pumpStrip(tester, banners: [_navFirst]);
      await _wait(tester, const Duration(seconds: 1));
      expect(_dot(0), findsNothing);
      await _end(h);
      h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      expect([for (var i = 0; i < 3; i++) _dot(i).evaluate().length], [1, 1, 1]);
      await _end(h);
    });

    testWidgets('a banner appearing later (first success after Home opened) animates in and takes space only then', (tester) async {
      final h = await _pumpStrip(tester, banners: const []);
      final belowBefore = tester.getTopLeft(find.text('below')).dy;
      h.provider.showForTest(_three());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      final mid = tester.getTopLeft(find.text('below')).dy;
      expect(mid, greaterThan(belowBefore));
      await _wait(tester, const Duration(seconds: 1));
      final after = tester.getTopLeft(find.text('below')).dy;
      expect(after, greaterThan(mid), reason: 'the space grew smoothly, not in one jump');
      expect(tester.takeException(), isNull);
      await _end(h);
    });
  });

  group('page position', () {
    testWidgets('dots follow the page position while swiping, not just the settled index', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      expect(_dotW(tester, 0), closeTo(22, 0.01));
      expect(_dotW(tester, 1), closeTo(6, 0.01));
      expect(_dotW(tester, 2), closeTo(6, 0.01));

      final g = await tester.startGesture(const Offset(180, 150));
      await g.moveBy(const Offset(-40, 0));
      await g.moveBy(const Offset(-80, 0));
      await tester.pump();
      final page = _page(tester);
      expect(page, inExclusiveRange(0.2, 0.8));
      expect(_dotW(tester, 0), closeTo(6 + 16 * (1 - page), 0.01));
      expect(_dotW(tester, 1), closeTo(6 + 16 * page, 0.01));
      expect(_dotW(tester, 2), closeTo(6, 0.01));
      await g.moveBy(const Offset(-100, 0)); // past halfway: it settles on the next card
      await g.up();
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      expect(_dotW(tester, 1), closeTo(22, 0.01));
      expect(_dotW(tester, 0), closeTo(6, 0.01));
      await _end(h);
    });

    testWidgets('neighbours are a little smaller than the centre card; the centre card is full size', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      expect(_painted(tester, _cards().at(0)).width, closeTo(316, 0.5));
      expect(_painted(tester, _cards().at(1)).width, closeTo(316 * 0.94, 1));
      await _end(h);
    });
  });

  group('auto-advance', () {
    testWidgets('moves on every ~5 s with a smooth animation and wraps from the last card to the first', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(milliseconds: 4900));
      expect(_page(tester), 0);
      await _wait(tester, const Duration(milliseconds: 200));
      expect(_page(tester), inExclusiveRange(0.0, 1.0), reason: 'in motion, not jumping');
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      await _wait(tester, const Duration(seconds: 5));
      expect(_page(tester), 2);
      await _wait(tester, const Duration(seconds: 5));
      expect(_page(tester), 0, reason: 'wrapped around');
      expect(tester.takeException(), isNull);
      await _end(h);
    });

    testWidgets('pauses while a finger is down and resumes about 3 s after it lifts', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      final g = await tester.startGesture(const Offset(180, 150));
      await _wait(tester, const Duration(seconds: 12));
      expect(_page(tester), 0, reason: 'nothing moves under the finger');
      await g.up();
      await _wait(tester, const Duration(milliseconds: 2800));
      expect(_page(tester), 0);
      await _wait(tester, const Duration(milliseconds: 1500));
      expect(_page(tester), 1);
      await _end(h);
    });

    testWidgets('a swipe by the student restarts the wait: no jump right after their own swipe', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 4));
      await tester.fling(find.byType(PageView).at(1), const Offset(-200, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      await _wait(tester, const Duration(seconds: 2)); // ~3 s after the lift: not yet
      expect(_page(tester), 1);
      await _wait(tester, const Duration(seconds: 2));
      expect(_page(tester), 2);
      await _end(h);
    });

    testWidgets('pauses while Home is not the shown tab and starts again ~3 s after it is shown', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 2));
      h.tabShown.value = false;
      await tester.pump();
      await _wait(tester, const Duration(seconds: 20));
      expect(_page(tester), 0);
      h.tabShown.value = true;
      await tester.pump();
      await _wait(tester, const Duration(milliseconds: 2800));
      expect(_page(tester), 0);
      await _wait(tester, const Duration(milliseconds: 1800));
      expect(_page(tester), 1);
      await _end(h);
    });

    testWidgets('starts paused when the tab is already hidden', (tester) async {
      final h = await _pumpStrip(tester, banners: _three(), tabShown: false);
      await _wait(tester, const Duration(seconds: 20));
      expect(_page(tester), 0);
      await _end(h);
    });

    testWidgets('pauses while the app is in the background and resumes after it returns', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await _wait(tester, const Duration(seconds: 20));
      expect(_page(tester), 0);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _wait(tester, const Duration(milliseconds: 4500));
      expect(_page(tester), 1);
      await _end(h);
    });

    testWidgets('never auto-advances when the platform asks to reduce motion (the student can still swipe)', (tester) async {
      final h = await _pumpStrip(tester, banners: _three(), reduceMotion: true);
      await _wait(tester, const Duration(seconds: 30));
      expect(_page(tester), 0);
      expect(find.text('Alpha'), findsOneWidget, reason: 'content is there at once, no entrance animation');
      await tester.fling(find.byType(PageView).at(1), const Offset(-200, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      await _end(h);
    });

    testWidgets('a single banner has no auto-advance and no pending timer', (tester) async {
      final h = await _pumpStrip(tester, banners: [_navFirst]);
      await _wait(tester, const Duration(seconds: 30));
      expect(_page(tester), 0);
      h.provider.dispose(); // the view event's timer is the only one left; the strip has none
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
    });

    testWidgets('everything is disposed with the strip: nothing fires afterwards', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      await _end(h);
      await tester.pump(const Duration(seconds: 30));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a list that shrinks under the student (refresh) keeps a valid page and keeps working', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await tester.fling(find.byType(PageView).at(1), const Offset(-300, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      await tester.fling(find.byType(PageView).at(1), const Offset(-300, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 2);
      h.provider.showForTest([_navFirst, _navSecond]);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      expect(tester.takeException(), isNull);
      h.provider.showForTest([_navFirst]);
      await _wait(tester, const Duration(seconds: 1));
      expect(_dot(0), findsNothing);
      expect(tester.takeException(), isNull);
      await _end(h);
    });
  });

  group('events', () {
    testWidgets('the card in front counts one view per session; later cards when they come in front; a hidden tab counts nothing', (tester) async {
      final events = <Map<String, dynamic>>[];
      CustomerApiService.httpClientOverride = MockClient((req) async {
        if (req.url.path.endsWith('/banners/events')) events.add(jsonDecode(req.body) as Map<String, dynamic>);
        return jsonResponse({'success': true});
      });
      final h = await _pumpStrip(tester, banners: _three(), tabShown: false);
      await _wait(tester, const Duration(seconds: 3));
      expect(events, isEmpty, reason: 'Home is not the shown tab');
      h.tabShown.value = true;
      await tester.pump();
      await _wait(tester, const Duration(seconds: 3));
      expect(events.length, 1);
      expect(events.single['views'], ['a']);
      await _wait(tester, const Duration(seconds: 6)); // moves to b
      await _wait(tester, const Duration(seconds: 5)); // c
      await _wait(tester, const Duration(seconds: 5)); // back to a: not counted again
      await h.provider.flushEvents();
      final views = events.expand((e) => (e['views'] as List)).toList();
      expect(views, ['a', 'b', 'c']);
      await _end(h);
    });
  });

  group('tap', () {
    testWidgets('opens the https link outside the app and records the click; a display-only card does nothing', (tester) async {
      final events = <Map<String, dynamic>>[];
      CustomerApiService.httpClientOverride = MockClient((req) async {
        if (req.url.path.endsWith('/banners/events')) events.add(jsonDecode(req.body) as Map<String, dynamic>);
        return jsonResponse({'success': true});
      });
      final h = await _pumpStrip(tester, banners: [_navFirst, _navSecond]);
      await _wait(tester, const Duration(seconds: 1));
      await tester.tap(find.text('Alpha'));
      await _wait(tester, const Duration(milliseconds: 300));
      expect(_launched, [Uri.parse('https://forms.gle/AbC123')]);
      await h.provider.flushEvents();
      expect(events.expand((e) => (e['clicks'] as List? ?? const [])).toList(), ['a']);
      expect(find.byType(SnackBar), findsNothing);

      await tester.fling(find.byType(PageView).at(1), const Offset(-200, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      await tester.tap(find.text('Bravo'));
      await _wait(tester, const Duration(milliseconds: 300));
      expect(_launched.length, 1, reason: 'no link, nothing opened');
      await h.provider.flushEvents();
      expect(events.expand((e) => (e['clicks'] as List? ?? const [])).toList(), ['a']);
      await _end(h);
    });

    testWidgets('a card scales down while pressed (KPressable)', (tester) async {
      final h = await _pumpStrip(tester, banners: [_navFirst, _navSecond]);
      await _wait(tester, const Duration(seconds: 1));
      final before = _painted(tester, _cards().first);
      final g = await tester.startGesture(tester.getCenter(find.text('Alpha')));
      await _wait(tester, const Duration(milliseconds: 300));
      expect(_painted(tester, _cards().first).width, lessThan(before.width * 0.99));
      await g.up();
      await _wait(tester, const Duration(seconds: 1));
      await _end(h);
    });

    testWidgets('when nothing can open the link, a friendly snackbar says so (false and thrown errors)', (tester) async {
      for (final failure in [() async => false, () async => throw PlatformException(code: 'x')]) {
        ExternalLinks.launcher = (uri) => failure();
        final h = await _pumpStrip(tester, banners: [_navFirst, _navSecond]);
        await _wait(tester, const Duration(seconds: 1));
        await tester.tap(find.text('Alpha'));
        await _wait(tester, const Duration(milliseconds: 300));
        expect(find.text('Couldn\'t open this link'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _wait(tester, const Duration(seconds: 5));
        await h.provider.flushEvents();
        await _end(h);
      }
    });

    testWidgets('a link that is not https never reaches the launcher even if it got into the list', (tester) async {
      const bad = HomeBanner(id: 'x', title: 'Sneaky', imageUrl: 'https://a.example.com/i.jpg', linkUrl: 'http://evil.example.com/', ctaLabel: 'Go');
      final h = await _pumpStrip(tester, banners: [bad, _navSecond]);
      await _wait(tester, const Duration(seconds: 1));
      await tester.tap(find.text('Sneaky'));
      await _wait(tester, const Duration(milliseconds: 300));
      expect(_launched, isEmpty);
      await _end(h);
    });
  });

  group('gestures', () {
    testWidgets('inside the list the carousel keeps its swipes; at the last and the first card the swipe moves the tab pager', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      await tester.fling(find.byType(PageView).at(1), const Offset(-250, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 1);
      expect(h.outer.page, 1, reason: 'the carousel used it');

      await tester.fling(find.byType(PageView).at(1), const Offset(-250, 0), 1500);
      await _wait(tester, const Duration(seconds: 1));
      expect(_page(tester), 2);
      expect(h.outer.page, 1);

      // Past the last card: the tab pager takes over, following the finger.
      final g = await tester.startGesture(const Offset(250, 150));
      await g.moveBy(const Offset(-60, 0));
      await g.moveBy(const Offset(-120, 0));
      await tester.pump();
      expect(h.outer.page, greaterThan(1.1));
      expect(_page(tester), 2);
      await g.moveBy(const Offset(-200, 0));
      await g.up();
      await _wait(tester, const Duration(seconds: 1));
      expect(h.outer.page, 2);
      expect(find.text('tab 2'), findsOneWidget);
      await _end(h);
    });

    testWidgets('a swipe right on the first card moves to the previous tab', (tester) async {
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      await tester.fling(find.byType(PageView).at(1), const Offset(250, 0), 2500);
      await _wait(tester, const Duration(seconds: 1));
      expect(h.outer.page, 0);
      await _end(h);
    });

    testWidgets('vertical scrolling of the page is never blocked by the carousel', (tester) async {
      final h = await _pumpStrip(tester, banners: _three(), longPage: true);
      await _wait(tester, const Duration(seconds: 1));
      final scrollable = tester.state<ScrollableState>(find.descendant(of: find.byType(SingleChildScrollView), matching: find.byType(Scrollable)).first);
      expect(scrollable.position.pixels, 0);
      await tester.drag(find.text('Alpha'), const Offset(0, -150));
      await tester.pump();
      expect(scrollable.position.pixels, greaterThan(100));
      expect(_page(tester), 0);
      await _end(h);
    });
  });

  group('accessibility and sizes', () {
    testWidgets('one label per card, a button only when it opens a link; the dots are not in the semantics tree', (tester) async {
      final handle = tester.ensureSemantics();
      final h = await _pumpStrip(tester, banners: _three());
      await _wait(tester, const Duration(seconds: 1));
      final withLink = tester.getSemantics(find.bySemanticsLabel('Alpha, First sub. Opens link'));
      expect(withLink.flagsCollection.isButton, isTrue);
      final plain = tester.getSemantics(find.bySemanticsLabel('Bravo'));
      expect(plain.flagsCollection.isButton, isFalse);
      expect(find.bySemanticsLabel('Alpha'), findsNothing, reason: 'title is not read a second time');
      expect(find.ancestor(of: _dot(0), matching: find.byType(ExcludeSemantics)), findsWidgets);
      expect(tester.takeException(), isNull);
      handle.dispose();
      await _end(h);
    });

    testWidgets('2x text size at 360x640: no overflow, the card grows a little and the text stays inside it', (tester) async {
      final h = await _pumpStrip(tester, banners: _three(), textScale: 2.0);
      await _wait(tester, const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      final card = tester.getRect(find.byType(KPressable).first);
      expect(card.height, greaterThan(card.width / 2), reason: 'taller than 2:1 for big text');
      for (final t in ['Alpha', 'First sub', 'Join now']) {
        final r = tester.getRect(find.text(t));
        expect(card.contains(r.topLeft) && card.contains(r.bottomRight), isTrue, reason: '$t inside the card: $r in $card');
      }
      await _end(h);
    });

    testWidgets('long titles and subtitles clamp to two lines each', (tester) async {
      final long = banner('l', title: 'A very long promo title that would run over many many lines of the card', subtitle: 'And an even longer subtitle that keeps on going and going and going and going and going', linkUrl: 'https://forms.gle/x', ctaLabel: 'Open');
      final h = await _pumpStrip(tester, banners: [long, _navSecond]);
      await _wait(tester, const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      expect(tester.widget<Text>(find.textContaining('A very long')).maxLines, 2);
      expect(tester.widget<Text>(find.textContaining('And an even')).maxLines, 2);
      await _end(h);
    });

    testWidgets('dark theme (tokens of the dark apps): builds, border and dots follow the tokens, no errors', (tester) async {
      final h = await _pumpStrip(tester, banners: _three(), theme: KraveoTheme.driver());
      await _wait(tester, const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      const dark = KraveoTokens.driver;
      final dotColor = (tester.widget<Container>(_dot(0)).decoration as BoxDecoration).color;
      expect(dotColor, dark.brand);
      final cardDecor = tester.widgetList<Container>(find.descendant(of: find.byType(KPressable).first, matching: find.byType(Container))).map((c) => c.foregroundDecoration).whereType<BoxDecoration>().first;
      expect((cardDecor.border as Border).top.color, dark.line);
      await _end(h);
    });
  });

  group('photo states', () {
    testWidgets('when the photo cannot be loaded the brand gradient and light text take over, even on a LIGHT card', (tester) async {
      final h = await _pumpStrip(tester, banners: [_navFirst, _navSecond]); // _navFirst is the LIGHT theme
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await _wait(tester, const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      expect(find.byType(KSkeleton), findsNothing, reason: 'no shimmer left once the photo failed');
      expect(tester.widget<Text>(find.text('Alpha')).style!.color, Colors.white);
      expect(find.byWidgetPredicate((w) => w is DecoratedBox && w.decoration is BoxDecoration && (w.decoration as BoxDecoration).gradient is LinearGradient), findsWidgets);
      await _end(h);
    });

    testWidgets('a shimmer shows while the photo is on its way; then the photo fades in over it, the shimmer stops, and the theme colour of the text stays (LIGHT = dark text)', (tester) async {
      final gate = Completer<void>();
      debugNetworkImageHttpClientProvider = () => _PhotoClient(gate.future);
      try {
        final h = await _pumpStrip(tester, banners: [_navFirst, _navSecond]);
        await _wait(tester, const Duration(milliseconds: 500));
        expect(find.byType(KSkeleton), findsWidgets);
        expect(tester.widget<RawImage>(find.byType(RawImage).first).image, isNull, reason: 'no photo yet');
        expect(tester.widgetList<TickerMode>(find.ancestor(of: find.byType(KSkeleton).first, matching: find.byType(TickerMode))).any((t) => !t.enabled), isFalse, reason: 'shimmering while loading');

        gate.complete();
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
        await _wait(tester, const Duration(seconds: 1));
        expect(tester.takeException(), isNull);
        expect(tester.widget<RawImage>(find.byType(RawImage).first).image, isNotNull);
        expect(tester.widgetList<TickerMode>(find.ancestor(of: find.byType(KSkeleton).first, matching: find.byType(TickerMode))).any((t) => !t.enabled), isTrue, reason: 'the shimmer stopped ticking');
        expect(tester.widget<Text>(find.text('Alpha')).style!.color, KraveoPalette.ink);
        expect(tester.widget<Text>(find.text('Bravo')).style!.color, Colors.white, reason: 'DARK card: light text');
        await _end(h);
      } finally {
        debugNetworkImageHttpClientProvider = null;
      }
    });
  });

  // ------------------------------------------------------------------------------ the real Home ----
  group('on the Home screen', () {
    SessionProvider session() => SessionProvider(initial: SessionStatus.checking)
      ..beginForTest({'id': 'u1', 'name': 'Aarav Sharma', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 1', 'avatarId': 2});

    Future<void> pumpHome(WidgetTester tester, {BannerProvider? banners}) async {
      _phone(tester);
      final orders = fakeOrders(FakeOrderApi())..beginSession('u1');
      await orders.refreshActive();
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionProvider>.value(value: session()),
          ChangeNotifierProvider<DhabaProvider>.value(value: sampleCatalogProvider()),
          ChangeNotifierProvider<CartProvider>.value(value: CartProvider()),
          ChangeNotifierProvider<OrderProvider>.value(value: orders),
          if (banners != null) ChangeNotifierProvider<BannerProvider>.value(value: banners),
        ],
        child: MaterialApp(theme: KraveoTheme.customer(), home: const HomeScreen()),
      ));
      await _wait(tester, const Duration(seconds: 1));
    }

    /// Answers /banners from [rows] (null = 500) and counts the calls; everything else fails quickly.
    List<String> serve({required List<Map<String, dynamic>>? Function() rows}) {
      final seen = <String>[];
      CustomerApiService.httpClientOverride = MockClient((req) async {
        seen.add('${req.method} ${req.url.path}');
        if (req.method == 'GET' && req.url.path.endsWith('/banners')) {
          final r = rows();
          return r == null ? jsonResponse({'success': false}, 500) : jsonResponse(bannersBody(r));
        }
        if (req.url.path.endsWith('/banners/events')) return jsonResponse({'success': true});
        return http.Response('{}', 500);
      });
      return seen;
    }

    int bannerGets(List<String> seen) => seen.where((s) => s == 'GET /api/banners').length;

    testWidgets('with no banners (no provider, an empty provider, or a server that has none) Home is laid out exactly as before', (tester) async {
      Map<String, Rect> anchors() => {
            for (final t in ['What are you\ncraving?', 'Kitchens near campus'])
              t: tester.getRect(find.text(t)),
            'search': tester.getRect(find.byType(TextField)),
          };

      serve(rows: () => null);
      await pumpHome(tester);
      final plain = anchors();

      final empty = BannerProvider();
      await pumpHome(tester, banners: empty);
      expect(anchors(), plain);
      expect(find.byType(BannerStrip), findsNothing);
      empty.dispose();

      serve(rows: () => []);
      final fromServer = BannerProvider();
      await pumpHome(tester, banners: fromServer);
      await _wait(tester, const Duration(seconds: 1));
      expect(anchors(), plain, reason: 'the server answered with an empty list');
      fromServer.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('banners load in the background and appear between the search field and the rest of Home', (tester) async {
      serve(rows: () => [bannerRow('a', title: 'Diwali Dhamaka', subtitle: 'Sweet deals', linkUrl: 'https://forms.gle/x', ctaLabel: 'Join'), bannerRow('b', title: 'Second')]);
      final p = BannerProvider();
      await pumpHome(tester, banners: p);
      await _wait(tester, const Duration(seconds: 2));
      expect(find.text('Diwali Dhamaka'), findsOneWidget);
      final search = tester.getRect(find.byType(TextField));
      final card = tester.getRect(find.byType(BannerStrip));
      final kitchens = tester.getRect(find.text('Kitchens near campus'));
      expect(card.top, greaterThanOrEqualTo(search.bottom));
      expect(kitchens.top, greaterThan(card.bottom), reason: 'the first-order promo / kitchens list follow the carousel');
      expect(tester.takeException(), isNull);
      p.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('loaded on open, on app resume and on pull-to-refresh; a failing refresh keeps the cards on screen', (tester) async {
      var answer = [bannerRow('a', title: 'Diwali Dhamaka'), bannerRow('b', title: 'Second')];
      var down = false;
      final seen = serve(rows: () => down ? null : answer);
      final p = BannerProvider();
      await pumpHome(tester, banners: p);
      await _wait(tester, const Duration(seconds: 1));
      expect(bannerGets(seen), 1, reason: 'open');
      expect(find.text('Diwali Dhamaka'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _wait(tester, const Duration(seconds: 1));
      expect(bannerGets(seen), 2, reason: 'resume');

      answer = [bannerRow('a', title: 'Diwali Dhamaka'), bannerRow('b', title: 'Second'), bannerRow('c', title: 'Third')];
      await tester.fling(find.byType(CustomScrollView).first, const Offset(0, 400), 1000);
      await _wait(tester, const Duration(seconds: 2));
      expect(bannerGets(seen), 3, reason: 'pull to refresh');
      expect(p.banners.length, 3);

      down = true;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _wait(tester, const Duration(seconds: 1));
      expect(bannerGets(seen), 4);
      expect(p.banners.length, 3, reason: 'failure keeps the last good list');
      expect(find.byType(BannerStrip), findsOneWidget);
      expect(tester.takeException(), isNull);
      p.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('auto-advance runs on Home, stops when another tab is the resting tab and the swipe past the last card moves the tab pager', (tester) async {
      serve(rows: () => [bannerRow('a', title: 'One'), bannerRow('b', title: 'Two'), bannerRow('c', title: 'Three')]);
      final p = BannerProvider();
      await pumpHome(tester, banners: p);
      await _wait(tester, const Duration(seconds: 1));
      PageController carousel() => _strip(tester);
      await _wait(tester, const Duration(seconds: 6));
      expect(carousel().page, 1, reason: 'Home is the shown tab');

      // Go to another tab with a tap on the nav; the carousel pauses while it is away.
      final shell = tester.widget<PageView>(find.byType(PageView).first).controller!;
      Finder navIcon(IconData i) => find.descendant(of: find.byType(KFluidNav), matching: find.byIcon(i));
      await tester.tap(navIcon(LucideIcons.receiptText));
      await _wait(tester, const Duration(seconds: 1));
      expect(shell.page, 2);
      final away = _strip(tester).page; // the Home tab is kept alive, off stage
      await _wait(tester, const Duration(seconds: 20));
      expect(_strip(tester).page, away, reason: 'paused while Orders is the resting tab');
      await tester.tap(navIcon(LucideIcons.house));
      await _wait(tester, const Duration(seconds: 1));
      expect(shell.page, 0);

      // Last card, then a swipe further: the shell moves to Track.
      carousel().jumpToPage(2);
      await _wait(tester, const Duration(milliseconds: 500));
      await tester.fling(find.byType(BannerStrip), const Offset(-250, 0), 2500);
      await _wait(tester, const Duration(seconds: 1));
      expect(shell.page, 1);
      p.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });
}
