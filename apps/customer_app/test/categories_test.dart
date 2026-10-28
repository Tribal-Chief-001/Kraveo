// Managed categories / multi-category restaurants (Docs/23 section 5): models from real payloads, the
// categories client, Home chips (server list + fallback), matching, search, tab order, icons, image decode size.
import 'dart:async';
import 'dart:convert';

import 'package:customer_app/models/dhaba.dart';
import 'package:customer_app/models/food_category.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/dhaba_menu_screen.dart';
import 'package:customer_app/screens/home_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/widgets/dhaba_card.dart';
import 'package:customer_app/widgets/ui/category_icons.dart';
import 'package:customer_app/widgets/ui/k_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/category_fixtures.dart';
import 'support/shell_finders.dart';

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

Future<void> _loadKraveoFonts() async {
  const fonts = {
    'packages/kraveo_ui/Bricolage': 'packages/kraveo_ui/assets/fonts/BricolageGrotesque.ttf',
    'packages/kraveo_ui/Jakarta': 'packages/kraveo_ui/assets/fonts/PlusJakartaSans.ttf',
  };
  for (final entry in fonts.entries) {
    final loader = FontLoader(entry.key)..addFont(rootBundle.load(entry.value));
    await loader.load();
  }
}

SessionProvider _student() => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())
  ..beginForTest({'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'BH2', 'avatarId': 3, 'kraveoCoins': 120});

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Future<void> _pump(WidgetTester tester, Widget child, DhabaProvider dhabas, {Size size = const Size(360, 640), double textScale = 1.3}) async {
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
      ChangeNotifierProvider<SessionProvider>.value(value: _student()),
      ChangeNotifierProvider<DhabaProvider>.value(value: dhabas),
      ChangeNotifierProvider<CartProvider>.value(value: CartProvider()),
      ChangeNotifierProvider<OrderProvider>.value(value: OrderProvider()),
    ],
    child: MaterialApp(theme: KraveoTheme.customer(), home: child),
  ));
  await _settle(tester);
}

Dhaba _dhaba(String id, String name, {String category = 'Campus kitchen', List<Cuisine> cuisines = const [], List<String> tags = const []}) =>
    Dhaba(id: id, name: name, category: category, rating: 4.5, eta: '20 min', bannerUrl: '', isAcceptingOrders: true, address: 'Kothri', cuisines: cuisines, tags: tags);

List<FoodCategory> _cats(List<(String, int, String)> rows) => [for (final r in rows) FoodCategory(id: 'id-${r.$1}', name: r.$1, icon: r.$3, sortOrder: r.$2)];

void main() {
  setUpAll(_loadKraveoFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() => CustomerApiService.httpClientOverride = null);

  // ======================================================================================= models ====
  group('FoodCategory / Cuisine / Dhaba parsing (real payloads)', () {
    test('the real GET /categories rows parse with name, Hindi name, icon key and sort order', () {
      final list = FoodCategory.parseList(realHomeCategories()['data']);
      expect(list.map((c) => c.name), ['Biryani', 'North Indian']);
      expect(list.first.nameHi, 'बिरयानी');
      expect(list.last.nameHi, isNull);
      expect(list.map((c) => c.icon), ['biryani', 'restaurant']);
      expect(list.map((c) => c.sortOrder), [25, 26]);
    });

    test('garbled rows are dropped, garbled fields get defaults, a non-list is empty', () {
      final list = FoodCategory.parseList([
        'text',
        null,
        42,
        {'id': 1, 'name': 'No string id'},
        {'id': 'a', 'name': '   '},
        {'id': 'b', 'name': 'Good', 'icon': 7, 'sortOrder': 'x', 'nameHi': ''},
        {'id': 'c', 'name': ' Spaced ', 'icon': ' TEA ', 'sortOrder': 3.0},
      ]);
      expect(list.map((c) => c.name), ['Good', 'Spaced']);
      expect(list.first.icon, 'restaurant');
      expect(list.first.sortOrder, 0);
      expect(list.first.nameHi, isNull);
      expect(list.last.icon, 'tea');
      expect(list.last.sortOrder, 3);
      for (final bad in [null, 'x', 5, <String, dynamic>{}, {'data': []}]) {
        expect(FoodCategory.parseList(bad), isEmpty);
      }
    });

    test('Dhaba.fromJson reads the real cuisines + tags and shows them joined with " • "', () {
      final d = Dhaba.fromJson(realVendorWithCuisines());
      expect(d.cuisines.map((c) => c.name), ['North Indian', 'Biryani']);
      expect(d.cuisines.map((c) => c.icon), ['restaurant', 'biryani']);
      expect(d.cuisines.first.id, '02236158-229f-48fc-9fe8-4b1220e74ed7');
      expect(d.tags, ['North Indian', 'Biryani']);
      expect(d.cuisineLabel, 'North Indian • Biryani');
    });

    test('missing, empty or garbled cuisines fall back to the legacy category text and never throw', () {
      final base = realVendorWithCuisines();
      for (final cuisines in [null, <dynamic>[], 'nope', 5, {'a': 1}, [null, 3, 'x', <String, dynamic>{}, {'name': ''}]]) {
        final json = {...base, 'category': 'Fast Food • Maggi'};
        if (cuisines == null) {
          json.remove('cuisines');
        } else {
          json['cuisines'] = cuisines;
        }
        final d = Dhaba.fromJson(json);
        expect(d.cuisines, isEmpty, reason: '$cuisines');
        expect(d.cuisineLabel, 'Fast Food • Maggi', reason: '$cuisines');
      }
      // tags garbled too
      expect(Dhaba.fromJson({...base, 'tags': 'oops'}).tags, isEmpty);
      expect(Dhaba.fromJson({...base, 'tags': [1, null, 'Thali']}).tags, ['1', 'Thali']);
    });

    test('copyWith keeps and replaces cuisines', () {
      final d = Dhaba.fromJson(realVendorWithCuisines());
      expect(d.copyWith(isFavorite: true).cuisines.length, 2);
      expect(d.copyWith(cuisines: const []).cuisineLabel, 'North Indian • Biryani', reason: 'legacy text');
    });
  });

  // ======================================================================================== client ====
  group('CustomerApiService.fetchCategories', () {
    Future<List<FoodCategory>> fetch(http.Response Function(http.Request) respond, {String forWhat = 'home'}) {
      CustomerApiService.httpClientOverride = MockClient((req) async => respond(req));
      return CustomerApiService.fetchCategories(forWhat: forWhat);
    }

    test('asks GET /api/categories?for=home (no login) and parses the real answer', () async {
      late Uri url;
      Map<String, String>? headers;
      CustomerApiService.httpClientOverride = MockClient((req) async {
        url = req.url;
        headers = req.headers;
        return jsonResponse(realHomeCategories());
      });
      final list = await CustomerApiService.fetchCategories();
      expect(url.path, endsWith('/api/categories'));
      expect(url.queryParameters, {'for': 'home'});
      expect(headers!.containsKey('Authorization'), isFalse);
      expect(list.map((c) => c.name), ['Biryani', 'North Indian']);
    });

    test('an empty list is a valid, empty answer', () async {
      expect(await fetch((_) => http.Response(jsonEncode(categoriesBody([])), 200)), isEmpty);
    });

    test('404 (old server), 500, HTML, non-JSON, success:false and a non-list data all throw so the caller falls back', () async {
      for (final r in [
        () => http.Response('{"success":false,"message":"Not found"}', 404),
        () => http.Response('', 500),
        () => http.Response('<html>502 Bad Gateway</html>', 200),
        () => http.Response('[]', 200),
        () => http.Response('{"success":false,"data":[]}', 200),
        () => http.Response('{"success":true,"data":{"a":1}}', 200),
        () => http.Response('{"success":true}', 200),
      ]) {
        await expectLater(fetch((_) => r()), throwsA(anything));
      }
    });
  });

  // ======================================================================================== chips ====
  group('Home chips from the server list', () {
    DhabaProvider withMenus() => DhabaProvider(
          dhabas: [_dhaba('v1', 'Alpha'), _dhaba('v2', 'Beta')],
          menus: {
            'v1': [dishModel('v1', 'Thalis'), dishModel('v1', 'Beverages')],
            'v2': [dishModel('v2', 'Rolls')],
          },
        );

    test('before any server list the chips are exactly the derived ones (most common first)', () {
      final p = DhabaProvider(
        dhabas: [_dhaba('v1', 'Alpha'), _dhaba('v2', 'Beta')],
        menus: {
          'v1': [dishModel('v1', 'Thalis'), dishModel('v1', 'Beverages')],
          'v2': [dishModel('v2', 'Thalis'), dishModel('v2', 'Rolls')],
        },
      );
      expect(p.categories, ['All', 'Thalis', 'Beverages', 'Rolls']);
      expect(p.hasServerCategories, isFalse);
      expect(p.categoryChips.every((c) => c.iconKey == null), isTrue);
    });

    test('loading the real answer gives All + the server list in the server order, with icon keys', () async {
      final server = FakeCatalogServer()..answer('home', realHomeCategories());
      CustomerApiService.httpClientOverride = server.client;
      final p = withMenus();
      await p.loadCategories();
      expect(p.categories, ['All', 'Biryani', 'North Indian']);
      expect(p.categoryChips.map((c) => c.iconKey), [null, 'biryani', 'restaurant']);
      expect(p.hasServerCategories, isTrue);
      expect(server.categoryRequests.toSet(), {'home', 'dishes'});
    });

    test('at most 10 server chips are shown after All; names repeated in another case count once', () async {
      final rows = [for (var i = 0; i < 14; i++) categoryRow('Cat $i', i)]..insert(3, categoryRow('CAT 0', 99));
      final server = FakeCatalogServer()..answer('home', categoriesBody(rows));
      CustomerApiService.httpClientOverride = server.client;
      final p = withMenus();
      await p.loadCategories();
      expect(p.categories.length, 11);
      expect(p.categories.first, 'All');
      expect(p.categories.sublist(1), [for (var i = 0; i < 10; i++) 'Cat $i']);
    });

    test('404, an empty list, malformed JSON and a failing network all keep the derived chips', () async {
      for (final setup in <void Function(FakeCatalogServer)>[
        (s) {}, // 404 for both
        (s) => s.answer('home', categoriesBody([])),
        (s) => s.answer('home', '<html>nope</html>'),
        (s) => s.answer('home', {'success': true, 'data': 'x'}),
        (s) => s.answer('home', 'null'),
        (s) => s.answer('home', categoriesBody([]), status: 500),
      ]) {
        final server = FakeCatalogServer();
        setup(server);
        CustomerApiService.httpClientOverride = server.client;
        final p = withMenus();
        await p.loadCategories();
        expect(p.categories, ['All', 'Beverages', 'Rolls', 'Thalis'], reason: 'derived');
        expect(p.hasServerCategories, isFalse);
      }
      CustomerApiService.httpClientOverride = MockClient((_) async => throw const SocketLikeException());
      final p = withMenus();
      await p.loadCategories();
      expect(p.categories, ['All', 'Beverages', 'Rolls', 'Thalis']);
    });

    test('a failed refresh keeps the last good list; an empty refresh returns to the derived chips', () async {
      final server = FakeCatalogServer()..answer('home', realHomeCategories());
      CustomerApiService.httpClientOverride = server.client;
      final p = withMenus();
      await p.loadCategories();
      expect(p.categories, ['All', 'Biryani', 'North Indian']);

      server.answer('home', 'garbage', status: 502);
      server.answer('dishes', 'garbage', status: 502);
      await p.loadCategories();
      expect(p.categories, ['All', 'Biryani', 'North Indian'], reason: 'cached in memory');

      server.answer('home', categoriesBody([]));
      await p.loadCategories();
      expect(p.categories, ['All', 'Beverages', 'Rolls', 'Thalis']);
    });

    test('refreshHome never waits for the categories and never fails because of them', () async {
      final server = FakeCatalogServer()..vendors = [vendorJson('v1', 'Alpha')];
      final gate = Completer<void>();
      CustomerApiService.httpClientOverride = MockClient((req) async {
        if (req.url.path.endsWith('/categories')) {
          await gate.future;
          return jsonResponse(realHomeCategories());
        }
        return server.client.get(req.url).then((r) => r);
      });
      final p = DhabaProvider();
      expect(await p.refreshHome(), isTrue, reason: 'vendors are enough');
      expect(p.catalogStatus, CatalogStatus.ready);
      expect(p.hasServerCategories, isFalse, reason: 'still waiting for the categories');
      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(p.hasServerCategories, isTrue, reason: 'they arrive later and the chips update');
    });

    test('refreshHome (open, resume, pull-to-refresh) also refreshes the categories and tolerates an old server; loadCatalog alone does not', () async {
      final server = FakeCatalogServer()..vendors = [vendorJson('v1', 'Alpha')];
      CustomerApiService.httpClientOverride = server.client; // categories 404
      final p = DhabaProvider();
      expect(await p.loadCatalog(), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(server.categoryRequests, isEmpty, reason: 'the menu screen reloads the catalog only');
      expect(await p.refreshHome(), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(server.categoryRequests.toSet(), {'home', 'dishes'});
      expect(p.hasServerCategories, isFalse);
    });

    test('concurrent loads share one request pair; disposing during a load does not throw', () async {
      final server = FakeCatalogServer()..answer('home', realHomeCategories());
      CustomerApiService.httpClientOverride = server.client;
      final p = withMenus();
      await Future.wait([p.loadCategories(), p.loadCategories(), p.loadCategories()]);
      expect(server.categoryRequests.length, 2);
      final q = withMenus();
      final f = q.loadCategories();
      q.dispose();
      await f;
    });
  });

  // ===================================================================================== matching ====
  group('Home filtering by chip and by search', () {
    DhabaProvider catalog() {
      final p = DhabaProvider(
        dhabas: [
          _dhaba('tagged', 'Tagged Kitchen', category: 'North Indian • Biryani', cuisines: const [Cuisine(id: '1', name: 'Biryani', icon: 'biryani')], tags: const ['Biryani']),
          _dhaba('byDish', 'Dish Kitchen', category: 'Campus kitchen'),
          _dhaba('legacyTag', 'Tag Only Kitchen', tags: const ['biryani']),
          _dhaba('none', 'Plain Kitchen', cuisines: const [Cuisine(id: '2', name: 'Chai')]),
        ],
        menus: {
          'byDish': [dishModel('byDish', 'biryani')],
          'none': [dishModel('none', 'Thalis')],
        },
      );
      p.setCategoriesForTest(home: _cats([('Biryani', 1, 'biryani'), ('Chai', 2, 'tea')]));
      return p;
    }

    test('a chip matches a restaurant tagged with the category (cuisine or tag, any case) OR having a dish in it', () {
      final p = catalog();
      p.setSelectedCategoryIndex(p.categories.indexOf('Biryani'));
      expect(p.dhabas.map((d) => d.id), ['tagged', 'byDish', 'legacyTag']);
      p.setSelectedCategoryIndex(p.categories.indexOf('Chai'));
      expect(p.dhabas.map((d) => d.id), ['none']);
      p.setSelectedCategoryIndex(0);
      expect(p.dhabas.length, 4);
    });

    test('a selected chip that disappears after a refresh falls back to All', () {
      final p = catalog();
      p.setSelectedCategoryIndex(p.categories.indexOf('Chai'));
      p.setCategoriesForTest(home: _cats([('Biryani', 1, 'biryani')]));
      expect(p.selectedCategoryIndex, 0);
      expect(p.dhabas.length, 4);
    });

    test('search also matches cuisine names (case-insensitive, partial) next to name, legacy text, tags and dishes', () {
      final p = catalog();
      p.setSearchQuery('chai');
      expect(p.dhabas.map((d) => d.id), ['none']);
      p.setSearchQuery('  CHA ');
      expect(p.dhabas.map((d) => d.id), ['none']);
      p.setSearchQuery('biry');
      expect(p.dhabas.map((d) => d.id), ['tagged', 'byDish', 'legacyTag']);
      p.setSearchQuery('plain');
      expect(p.dhabas.map((d) => d.id), ['none']);
      p.setSearchQuery('zzz');
      expect(p.dhabas, isEmpty);
    });
  });

  // ====================================================================================== tab order ====
  group('Dish category tabs inside a restaurant', () {
    test('without a server list the menu order is kept', () {
      final p = DhabaProvider();
      expect(p.orderDishCategories(['Snacks', 'Beverages', 'Main Course']), ['Snacks', 'Beverages', 'Main Course']);
    });

    test('with a server list: by sortOrder, then unknown/legacy last alphabetically', () {
      final p = DhabaProvider();
      p.setCategoriesForTest(home: _cats([('Thali', 5, 'thali'), ('Biryani', 1, 'biryani')]), dishes: _cats([('Snacks', 3, 'snack'), ('Thali', 5, 'thali'), ('Biryani', 1, 'biryani')]));
      expect(p.orderDishCategories(['zebra dish', 'Snacks', 'Thali', 'Apple Pie', 'Biryani']), ['Biryani', 'Snacks', 'Thali', 'Apple Pie', 'zebra dish']);
      expect(p.orderDishCategories(['thali ', 'BIRYANI']), ['BIRYANI', 'thali '], reason: 'case and spaces are ignored when matching');
    });

    test('ties in sortOrder are alphabetical; the dishes list order is used for categories that are not on Home', () async {
      final server = FakeCatalogServer()
        ..answer('home', categoriesBody([categoryRow('Biryani', 10)]))
        ..answer('dishes', categoriesBody([categoryRow('Breads', 20, dishes: true, home: false), categoryRow('Biryani', 10), categoryRow('Chai', 20, home: false)]));
      CustomerApiService.httpClientOverride = server.client;
      final p = DhabaProvider();
      await p.loadCategories();
      expect(p.orderDishCategories(['Chai', 'Legacy', 'Breads', 'Biryani']), ['Biryani', 'Breads', 'Chai', 'Legacy']);
    });

    test('if only the dishes request fails, the Home list still orders the tabs', () async {
      final server = FakeCatalogServer()..answer('home', categoriesBody([categoryRow('Thali', 2), categoryRow('Biryani', 1)]));
      CustomerApiService.httpClientOverride = server.client;
      final p = DhabaProvider();
      await p.loadCategories();
      expect(p.orderDishCategories(['Thali', 'Biryani']), ['Biryani', 'Thali']);
    });

    testWidgets('the menu screen shows its tabs in the admin order', (tester) async {
      final p = DhabaProvider(
        dhabas: [_dhaba('v1', 'Alpha')],
        menus: {'v1': [dishModel('v1', 'Mystery'), dishModel('v1', 'Thali'), dishModel('v1', 'Biryani')]},
      );
      p.setCategoriesForTest(home: _cats([('Biryani', 1, 'biryani'), ('Thali', 2, 'thali'), ('Beverages', 3, 'tea')]));
      final server = FakeCatalogServer()
        ..vendors = [vendorJson('v1', 'Alpha', menu: [for (final c in ['Mystery', 'Thali', 'Biryani']) dishJson('d$c', 'v1', 'Dish $c', c)])]
        ..answer('home', categoriesBody([categoryRow('Biryani', 1), categoryRow('Thali', 2), categoryRow('Beverages', 3)]));
      CustomerApiService.httpClientOverride = server.client;
      await _pump(tester, DhabaMenuScreen(dhaba: p.byId('v1')!, selectedHostel: 'BH2'), p);
      final labels = tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).map((c) => c.label).toList();
      expect(labels, ['All', 'Biryani', 'Thali', 'Mystery']);
    });
  });

  // ======================================================================================== screens ====
  group('Screens', () {
    testWidgets('Home shows the server chips with their icons, All first, and filters by the chip', (tester) async {
      final server = FakeCatalogServer()
        ..vendors = [
          vendorJson('v1', 'Biryani House', category: 'North Indian • Biryani', cuisines: [
            {'id': '1', 'name': 'North Indian', 'icon': 'restaurant'},
            {'id': '2', 'name': 'Biryani', 'icon': 'biryani'},
          ], tags: ['North Indian', 'Biryani']),
          vendorJson('v2', 'Chai Corner', cuisines: [
            {'id': '3', 'name': 'Chai', 'icon': 'tea'}
          ], tags: ['Chai']),
        ]
        ..answer('home', categoriesBody([categoryRow('Biryani', 1, icon: 'biryani'), categoryRow('Chai', 2, icon: 'tea'), categoryRow('Mystery', 3, icon: 'zzz-unknown')]));
      CustomerApiService.httpClientOverride = server.client;
      final p = DhabaProvider();
      await _pump(tester, const HomeScreen(), p);
      final chips = tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).where((c) => ['All', 'Biryani', 'Chai', 'Mystery'].contains(c.label)).toList();
      expect(chips.map((c) => c.label), ['All', 'Biryani', 'Chai', 'Mystery']);
      expect(chips.map((c) => c.icon), [LucideIcons.utensilsCrossed, LucideIcons.soup, LucideIcons.coffee, LucideIcons.utensils], reason: 'unknown key -> keyword fallback -> generic');
      expect(find.text('Biryani House'), findsOneWidget);
      expect(find.text('North Indian • Biryani'), findsOneWidget, reason: 'cards show the cuisines joined with a bullet');

      await tester.tap(find.widgetWithText(KChoiceChip, 'Chai'));
      await _settle(tester);
      await tester.scrollUntilVisible(find.text('Chai Corner'), 200, scrollable: homeFeedScrollable());
      expect(find.text('Chai Corner'), findsOneWidget);
      expect(find.text('Biryani House'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('on an old server (404) Home still shows the derived chips and the legacy category text', (tester) async {
      final server = FakeCatalogServer()
        ..vendors = [
          vendorJson('v1', 'Alpha Dhaba', category: 'Fast Food • Maggi', menu: [dishJson('a1', 'v1', 'Thali', 'Thalis'), dishJson('a2', 'v1', 'Lassi', 'Beverages')]),
        ];
      CustomerApiService.httpClientOverride = server.client;
      await _pump(tester, const HomeScreen(), DhabaProvider());
      expect(tester.widgetList<KChoiceChip>(find.byType(KChoiceChip)).map((c) => c.label).take(3).toList(), ['All', 'Beverages', 'Thalis']);
      expect(find.text('Fast Food • Maggi'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the restaurant card and the menu header show cuisines joined with " • " (legacy text when none)', (tester) async {
      final withCuisines = Dhaba.fromJson(realVendorWithCuisines());
      final legacy = _dhaba('v9', 'Old Kitchen', category: 'Thalis • Parathas');
      await _pump(
        tester,
        Scaffold(body: ListView(children: [DhabaCard(dhaba: withCuisines, onTap: () {}), DhabaCard(dhaba: legacy, onTap: () {})])),
        DhabaProvider(),
      );
      expect(find.text('North Indian • Biryani'), findsOneWidget);
      expect(find.text('Thalis • Parathas'), findsOneWidget);

      final p = DhabaProvider(dhabas: [withCuisines], menus: const {});
      CustomerApiService.httpClientOverride = (FakeCatalogServer()..vendors = [realVendorWithCuisines()]).client;
      await _pump(tester, DhabaMenuScreen(dhaba: withCuisines, selectedHostel: 'BH2'), p);
      expect(find.text('North Indian • Biryani'), findsWidgets);
    });
  });

  // ========================================================================================= icons ====
  group('Category icons', () {
    const keys = [
      'restaurant', 'thali', 'rice', 'biryani', 'dosa', 'noodles', 'roll', 'burger', 'pizza', 'snack', 'bread', 'tandoor', 'egg',
      'chicken', 'fish', 'veg', 'sweet', 'dessert', 'icecream', 'tea', 'coffee', 'juice', 'shake', 'healthy', 'latenight',
    ];

    test('all 25 server keys map to an icon', () {
      expect(kCategoryIconKeys.keys.toSet(), keys.toSet());
      for (final k in keys) {
        expect(kCategoryIconKeys[k], isNotNull, reason: k);
      }
      expect(categoryIcon(key: 'biryani', label: 'Whatever'), LucideIcons.soup);
      expect(categoryIcon(key: ' LateNight ', label: 'x'), LucideIcons.moon);
    });

    test('an unknown or missing key uses the keyword table on the label, then the generic icon', () {
      expect(categoryIcon(key: 'rocket', label: 'Fast Food'), LucideIcons.sandwich);
      expect(categoryIcon(key: null, label: 'Beverages'), LucideIcons.cupSoda);
      expect(categoryIcon(key: '', label: 'Night Mess'), LucideIcons.moon);
      expect(categoryIcon(key: 'rocket', label: 'Something new'), LucideIcons.utensils);
      expect(categoryIcon(key: null, label: 'All'), LucideIcons.utensilsCrossed);
    });
  });

  // ===================================================================================== image cache ====
  group('KImage decode size (memory)', () {
    test('decodeSize: longest side x pixel ratio, rounded up to 100, capped at 1200', () {
      expect(KImage.decodeSize(360, 255, 3), 1100);
      expect(KImage.decodeSize(360, 255, 1), 400);
      expect(KImage.decodeSize(100, 100, 2), 200);
      expect(KImage.decodeSize(400, 300, 3), 1200);
      expect(KImage.decodeSize(1000, 1000, 3), KImage.maxDecodePixels, reason: 'capped');
      expect(KImage.decodeSize(10, 10, 1), 100, reason: 'at least 100');
      expect(KImage.decodeSize(0, 0, 2), KImage.maxDecodePixels, reason: 'no size known: still capped');
      expect(KImage.decodeSize(double.infinity, 200, 2), 400);
      expect(KImage.decodeSize(300, 300, 0), 300, reason: 'bad pixel ratio -> 1');
    });

    Future<ResizeImage> decodedImage(WidgetTester tester, {required Size box, required double dpr, String url = 'https://example.com/huge-banner.jpg'}) async {
      tester.view.physicalSize = const Size(1200, 2000);
      tester.view.devicePixelRatio = dpr;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.customer(),
        home: Align(alignment: Alignment.topLeft, child: SizedBox(width: box.width, height: box.height, child: KImage(url))),
      ));
      final image = tester.widget<Image>(find.byType(Image));
      expect(image.image, isA<ResizeImage>());
      return image.image as ResizeImage;
    }

    testWidgets('a banner is decoded no larger than its box x pixel ratio', (tester) async {
      final r = await decodedImage(tester, box: const Size(300, 200), dpr: 2);
      expect(r.width, 600);
      expect(r.height, 600);
      expect(r.policy, ResizeImagePolicy.fit, reason: 'aspect ratio kept');
    });

    testWidgets('and never above the cap, whatever the screen', (tester) async {
      final r = await decodedImage(tester, box: const Size(1000, 600), dpr: 3);
      expect(r.width, KImage.maxDecodePixels);
      expect(r.height, KImage.maxDecodePixels);
    });

    testWidgets('placeholder, empty-url fallback and error fallback are unchanged', (tester) async {
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.customer(), home: const SizedBox(width: 100, height: 100, child: KImage(''))));
      expect(find.byType(Image), findsNothing);
      expect(find.byIcon(LucideIcons.utensils), findsOneWidget);
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.customer(), home: const SizedBox(width: 100, height: 100, child: KImage('https://example.com/x.jpg'))));
      await tester.pump();
      final image = tester.widget<Image>(find.byType(Image));
      expect(image.errorBuilder, isNotNull);
      expect(image.frameBuilder, isNotNull);
    });
  });
}

class SocketLikeException implements Exception {
  const SocketLikeException();
}

int _n = 0;
MenuItemModel dishModel(String vendorId, String category) =>
    MenuItemModel(id: 'm-${_n++}', vendorId: vendorId, name: 'Dish $category', price: 100, category: category, description: 'd', imageUrl: '', isAvailable: true);
