// Per-restaurant menu order (Docs/26 section 3 and 5): the dish model's sortOrder and how the
// restaurant menu screen orders its category tabs and dishes.
import 'package:customer_app/models/dhaba.dart';
import 'package:customer_app/models/food_category.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/dhaba_menu_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/category_fixtures.dart';

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

MenuItemModel _d(String id, String category, [int? order]) =>
    MenuItemModel.fromJson({...dishJson(id, 'v1', 'Dish $id', category), if (order != null) 'sortOrder': order});

List<String> _ids(List<MenuItemModel> l) => [for (final i in l) i.id];

void main() {
  setUpAll(_loadKraveoFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() => CustomerApiService.httpClientOverride = null);

  group('MenuItemModel.sortOrder parsing', () {
    test('a positive int is kept', () => expect(_d('a', 'X', 30).sortOrder, 30));
    test('missing, null, garbled, negative, NaN and zero all give 0', () {
      expect(_d('a', 'X').sortOrder, 0);
      for (final raw in [null, 'abc', '', -5, '-5', double.nan, double.infinity, true, <int>[], 0]) {
        expect(MenuItemModel.fromJson({...dishJson('a', 'v1', 'n', 'X'), 'sortOrder': raw}).sortOrder, 0, reason: '$raw');
      }
    });
    test('a numeric string and a whole double are accepted', () {
      expect(MenuItemModel.fromJson({...dishJson('a', 'v1', 'n', 'X'), 'sortOrder': '20'}).sortOrder, 20);
      expect(MenuItemModel.fromJson({...dishJson('a', 'v1', 'n', 'X'), 'sortOrder': 40.0}).sortOrder, 40);
    });
  });

  group('menuOrdered / menuOrderedCategories', () {
    test('all zero: the very same list, nothing changes', () {
      final l = [_d('a', 'Z'), _d('b', 'A'), _d('c', 'Z')];
      expect(hasMenuOrder(l), isFalse);
      expect(identical(menuOrdered(l), l), isTrue);
    });
    test('positive: by sortOrder, tabs by first appearance', () {
      final l = [_d('a', 'Pizza', 30), _d('b', 'Chai', 10), _d('c', 'Pasta', 20)];
      expect(_ids(menuOrdered(l)), ['b', 'c', 'a']);
      expect(menuOrderedCategories(menuOrdered(l)), ['Chai', 'Pasta', 'Pizza']);
    });
    test('mixed: zero rows go after the ordered ones, keeping server order', () {
      final l = [_d('a', 'A', 0), _d('b', 'B', 20), _d('c', 'C', 0), _d('d', 'D', 10)];
      expect(_ids(menuOrdered(l)), ['d', 'b', 'a', 'c']);
    });
    test('ties are stable (server order)', () {
      final l = [_d('a', 'A', 10), _d('b', 'B', 10), _d('c', 'C', 10), _d('d', 'D', 5)];
      expect(_ids(menuOrdered(l)), ['d', 'a', 'b', 'c']);
    });
    test('a category split across positions sits at its first dish', () {
      final l = [_d('a', 'Rolls', 10), _d('b', 'Chai', 20), _d('c', 'Rolls', 30), _d('d', 'Thali', 40)];
      expect(menuOrderedCategories(menuOrdered(l)), ['Rolls', 'Chai', 'Thali']);
    });
    test('spellings differing by case or spaces are one tab (first spelling wins)', () {
      final l = [_d('a', 'Pizza', 10), _d('b', 'Chai', 20), _d('c', ' pizza ', 30), _d('d', 'CHAI', 40)];
      expect(menuOrderedCategories(menuOrdered(l)), ['Pizza', 'Chai']);
    });
  });

  group('Restaurant menu screen', () {
    SessionProvider student() => SessionProvider(initial: SessionStatus.checking, googleAuth: _NoGoogle())
      ..beginForTest({'id': 'u1', 'name': 'Aarav', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'BH2', 'avatarId': 3, 'kraveoCoins': 120});

    // Server (file) order of the dishes is `rows`; the global category order puts Biryani, Thali, Pizza.
    Future<List<String>> openMenu(WidgetTester tester, List<Map<String, dynamic>> rows, {String? tap}) async {
      final models = [for (final r in rows) MenuItemModel.fromJson(r)];
      final p = DhabaProvider(
        dhabas: [Dhaba(id: 'v1', name: 'Alpha', category: 'Campus', rating: 4.5, eta: '20 min', bannerUrl: '', isAcceptingOrders: true, address: 'Kothri')],
        menus: {'v1': models},
      );
      p.setCategoriesForTest(
        home: [const FoodCategory(id: '1', name: 'Biryani', sortOrder: 1), const FoodCategory(id: '2', name: 'Thali', sortOrder: 2), const FoodCategory(id: '3', name: 'Pizza', sortOrder: 3)],
      );
      CustomerApiService.httpClientOverride = (FakeCatalogServer()
            ..vendors = [vendorJson('v1', 'Alpha', menu: rows)]
            ..answer('home', categoriesBody([categoryRow('Biryani', 1), categoryRow('Thali', 2), categoryRow('Pizza', 3)])))
          .client;
      tester.view.physicalSize = const Size(360, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionProvider>.value(value: student()),
          ChangeNotifierProvider<DhabaProvider>.value(value: p),
          ChangeNotifierProvider<CartProvider>.value(value: CartProvider()),
          ChangeNotifierProvider<OrderProvider>.value(value: OrderProvider()),
        ],
        child: MaterialApp(theme: KraveoTheme.customer(), home: DhabaMenuScreen(dhaba: p.byId('v1')!, selectedHostel: 'BH2')),
      ));
      for (var i = 0; i < 3; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      if (tap != null) {
        await tester.tap(find.widgetWithText(KChoiceChip, tap));
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
      }
      return [for (final c in tester.widgetList<KChoiceChip>(find.byType(KChoiceChip))) c.label];
    }

    Map<String, dynamic> row(String id, String category, [int? order]) => {...dishJson(id, 'v1', 'Dish $id', category), if (order != null) 'sortOrder': order};

    testWidgets('positive sortOrder: tabs follow the file order (Pizza first although it is last globally)', (tester) async {
      final labels = await openMenu(tester, [row('a', 'Pizza', 10), row('b', 'Biryani', 20), row('c', 'Thali', 30), row('d', 'Pizza', 40)]);
      expect(labels, ['All', 'Pizza', 'Biryani', 'Thali']);
    });

    testWidgets('all zero: unchanged, the global category order', (tester) async {
      final labels = await openMenu(tester, [row('a', 'Pizza'), row('b', 'Biryani'), row('c', 'Thali')]);
      expect(labels, ['All', 'Biryani', 'Thali', 'Pizza']);
    });

    testWidgets('a tab lists its dishes in file order and the All list is in file order', (tester) async {
      await openMenu(tester, [row('a', 'Pizza', 30), row('b', 'Biryani', 20), row('c', 'Pizza', 10)]);
      final y = {for (final n in ['Dish a', 'Dish b', 'Dish c']) n: tester.getTopLeft(find.text(n)).dy};
      expect(y['Dish c']!, lessThan(y['Dish b']!));
      expect(y['Dish b']!, lessThan(y['Dish a']!));
      await tester.tap(find.widgetWithText(KChoiceChip, 'Pizza'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Dish b'), findsNothing);
      expect(tester.getTopLeft(find.text('Dish c')).dy, lessThan(tester.getTopLeft(find.text('Dish a')).dy));
    });

    testWidgets('case-differing spellings are one tab and one filter', (tester) async {
      final labels = await openMenu(tester, [row('a', 'Pizza', 10), row('b', 'pizza', 20), row('c', 'Thali', 30)], tap: 'Pizza');
      expect(labels, ['All', 'Pizza', 'Thali']);
      expect(find.text('Dish a'), findsOneWidget);
      expect(find.text('Dish b'), findsOneWidget);
      expect(find.text('Dish c'), findsNothing);
    });
  });
}
