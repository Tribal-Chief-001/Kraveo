// Managed dish categories in the Add-dish form (Docs/23 section 6): the client, the picker (server list, Hindi label,
// fallback, CATEGORY_UNKNOWN, kept selection) and small-screen / large-font layout.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/models/dish_category.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/screens/stock_manager.dart';
import 'package:vendor_app/services/failure_messages.dart';
import 'package:vendor_app/services/menu_stock_controller.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/widgets/add_dish_modal.dart';
import 'package:vendor_app/widgets/ui/ui.dart';

import 'support/catalog_fakes.dart';
import 'support/fakes.dart';

// Copied from a real `GET /api/categories?for=dishes` answer (Docs/23 section 8.4; the dishes list has only active
// dish categories, in the admin's order, with their Hindi names when set).
Map<String, dynamic> _row(String name, {String? hi, int order = 1}) => {
      'id': 'id-${name.toLowerCase().replaceAll(' ', '-')}',
      'name': name,
      'nameHi': hi,
      'icon': 'restaurant',
      'forRestaurants': true,
      'forDishes': true,
      'showOnHome': true,
      'sortOrder': order,
      'restaurantCount': 1,
      'dishCount': 1,
    };

Map<String, dynamic> _body(List<Map<String, dynamic>> rows) => {'success': true, 'count': rows.length, 'data': rows};

final _realDishes = _body([
  _row('Biryani', hi: 'बिरयानी', order: 25),
  _row('North Indian', order: 26),
  _row('Main Course', order: 27),
]);

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(body is String ? body : jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// The current server for this feature: the catalog fake plus the categories capability.
class _CategoryBackend extends CatalogBackend implements DishCategorySource {
  _CategoryBackend(super.dishes);
  List<DishCategory>? answer;
  ApiResult<List<DishCategory>>? result;
  int fetches = 0;
  Completer<void>? categoriesGate;

  @override
  Future<ApiResult<List<DishCategory>>> fetchDishCategories() async {
    fetches++;
    await categoriesGate?.future;
    return result ?? ApiResult.success(answer ?? const []);
  }
}

void _phone(WidgetTester tester, {Size size = const Size(412, 1800), double textScale = 1.0}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.reset();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

Widget _host(Widget child) => MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: child));

Finder _chip(String name) => find.byKey(ValueKey('dish-category-$name'));
bool _selected(WidgetTester tester, String name) => tester.widget<VChoiceChip>(_chip(name)).selected;

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _fillAndSubmit(WidgetTester tester) async {
  final fields = find.byType(TextFormField);
  await tester.enterText(fields.at(0), 'Chicken Biryani');
  await tester.enterText(fields.at(1), '180');
  await tester.ensureVisible(find.text('Add to menu'));
  await tester.pump();
  await tester.tap(find.text('Add to menu'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ================================================================================== model + client ====
  group('DishCategory parsing and the client', () {
    test('the real answer parses in the server order with the Hindi name', () {
      final list = DishCategory.parseList((_realDishes)['data']);
      expect(list.map((c) => c.name), ['Biryani', 'North Indian', 'Main Course']);
      expect(list.first.nameHi, 'बिरयानी');
      expect(list[1].nameHi, isNull);
    });

    test('Hindi sublabel: the server nameHi, else the built-in map, else nothing', () {
      expect(const DishCategory('Biryani', nameHi: 'बिरयानी').hindiLabel, 'बिरयानी');
      expect(const DishCategory('Breads', nameHi: 'रोटियाँ').hindiLabel, 'रोटियाँ');
      expect(const DishCategory('Breads').hindiLabel, 'रोटी');
      expect(const DishCategory('Breads', nameHi: '  ').hindiLabel, 'रोटी');
      expect(const DishCategory('North Indian').hindiLabel, isNull);
    });

    test('garbled rows are dropped, repeats (any case) kept once, a non-list is empty', () {
      final list = DishCategory.parseList([null, 7, 'x', {'name': ''}, {'name': 3}, {'name': ' Snacks ', 'nameHi': 5}, {'name': 'SNACKS'}, {'name': 'Tea'}]);
      expect(list.map((c) => c.name), ['Snacks', 'Tea']);
      expect(list.first.nameHi, isNull);
      for (final bad in [null, 'x', 4, <String, dynamic>{}]) {
        expect(DishCategory.parseList(bad), isEmpty);
      }
    });

    test('the built-in six are the old ones, in the old order', () {
      expect(DishCategory.fallback.map((c) => c.name), ['Main Course', 'Breads', 'Beverages', 'Snacks', 'Desserts', 'Fast Food']);
      expect(DishCategory.fallback.every((c) => c.hindiLabel != null), isTrue);
    });

    Future<ApiResult<List<DishCategory>>> fetch(http.Response Function(http.Request) respond, {void Function(http.Request)? seen}) => http.runWithClient(
          () => const HttpVendorBackend().fetchDishCategories(),
          () => MockClient((req) async {
            seen?.call(req);
            return respond(req);
          }),
        );

    test('GET /categories?for=dishes and the real body', () async {
      late http.Request seen;
      final r = await fetch((_) => _json(_realDishes), seen: (q) => seen = q);
      expect(seen.method, 'GET');
      expect(seen.url.path, endsWith('/categories'));
      expect(seen.url.queryParameters, {'for': 'dishes'});
      expect(r.ok, isTrue);
      expect(r.data!.map((c) => c.name), ['Biryani', 'North Indian', 'Main Course']);
      expect(r.data!.first.nameHi, 'बिरयानी');
    });

    test('an empty list is a success with no rows', () async {
      final r = await fetch((_) => _json(_body([])));
      expect(r.ok, isTrue);
      expect(r.data, isEmpty);
    });

    test('404 (old server), 500, offline, HTML and a body without a list are failures, never exceptions', () async {
      expect((await fetch((_) => _json({'success': false}, 404))).failure, ApiFailure.notFound);
      expect((await fetch((_) => _json({'success': false}, 500))).ok, isFalse);
      expect((await fetch((_) => http.Response('<html>502</html>', 200))).ok, isFalse);
      expect((await fetch((_) => _json('[]'))).ok, isFalse);
      expect((await fetch((_) => _json({'success': true, 'data': 'x'}))).ok, isFalse);
      final offline = await http.runWithClient(() => const HttpVendorBackend().fetchDishCategories(), () => MockClient((_) async => throw http.ClientException('down')));
      expect(offline.failure, ApiFailure.offline);
    });

    test('CATEGORY_UNKNOWN (real 400 body) shows the server sentence and carries its code', () {
      final t = failureText(ApiFailure.invalid, serverMessage: 'Pick a category from the list.', code: 'CATEGORY_UNKNOWN');
      expect(t.english, 'Pick a category from the list.');
      expect(t.hindi, isNotEmpty);
      expect(t.code, 'CATEGORY_UNKNOWN');
      final custom = failureText(ApiFailure.invalid, serverMessage: 'Choose from the menu list.', code: 'CATEGORY_UNKNOWN');
      expect(custom.english, 'Choose from the menu list.');
      expect(failureText(ApiFailure.invalid, code: 'CATEGORY_UNKNOWN').english, 'Pick a category from the list.');
      expect(failureText(ApiFailure.invalid, serverMessage: 'x').code, isNull);
    });

    test('addDish still sends the category as a plain name string', () async {
      late http.Request seen;
      await http.runWithClient(
        () => const HttpVendorBackend().addDish('ven-1', name: 'Biryani', category: 'North Indian', price: 150),
        () => MockClient((req) async {
          seen = req;
          return http.Response('{"data":{"id":"m","name":"Biryani","price":150,"isAvailable":true}}', 201);
        }),
      );
      expect(jsonDecode(seen.body)['category'], 'North Indian');
      expect((jsonDecode(seen.body) as Map).containsKey('categoryId'), isFalse);
    });
  });

  // ============================================================================== controller ====
  group('MenuStockController.loadDishCategories', () {
    test('a backend without the capability (an old fake) gives null', () async {
      final c = MenuStockController(backend: FakeBackend(), vendorId: 'v');
      expect(await c.loadDishCategories(), isNull);
      c.dispose();
    });

    test('the list on success; null for empty, failure or a throwing backend', () async {
      final b = _CategoryBackend([])..answer = [const DishCategory('Biryani'), const DishCategory('Tea')];
      final c = MenuStockController(backend: b, vendorId: 'v');
      expect((await c.loadDishCategories())!.map((x) => x.name), ['Biryani', 'Tea']);
      b.answer = [];
      expect(await c.loadDishCategories(), isNull);
      b.result = const ApiResult.failure(ApiFailure.notFound);
      expect(await c.loadDishCategories(), isNull);
      c.dispose();
      final thrower = MenuStockController(backend: _ThrowingBackend(), vendorId: 'v');
      expect(await thrower.loadDishCategories(), isNull);
      thrower.dispose();
    });
  });

  // ==================================================================================== picker ====
  group('Add-dish picker', () {
    testWidgets('without a loader it shows the built-in six at once, Main Course picked, Hindi labels as before', (tester) async {
      _phone(tester);
      await tester.pumpWidget(_host(AddDishModal(onSubmit: (n, c, p, s, {bool isVeg = true}) async => null)));
      for (final c in DishCategory.fallback) {
        expect(_chip(c.name), findsOneWidget, reason: c.name);
      }
      expect(_selected(tester, 'Main Course'), isTrue);
      expect(find.text('मुख्य खाना'), findsOneWidget);
      expect(find.text('रोटी'), findsOneWidget);
      expect(find.byKey(const ValueKey('dish-categories-loading')), findsNothing);
    });

    testWidgets('while the list loads the fallback is usable and a spinner shows; then the server list replaces it', (tester) async {
      _phone(tester);
      final gate = Completer<List<DishCategory>?>();
      var loads = 0;
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async => null,
        loadCategories: () {
          loads++;
          return gate.future;
        },
      )));
      await tester.pump();
      expect(loads, 1);
      expect(find.byKey(const ValueKey('dish-categories-loading')), findsOneWidget);
      expect(_chip('Snacks'), findsOneWidget, reason: 'usable immediately');
      await tester.tap(_chip('Snacks'));
      await tester.pump();
      expect(_selected(tester, 'Snacks'), isTrue);

      gate.complete(DishCategory.parseList(_realDishes['data']));
      await _settle(tester);
      expect(find.byKey(const ValueKey('dish-categories-loading')), findsNothing);
      expect(_chip('Biryani'), findsOneWidget);
      expect(_chip('North Indian'), findsOneWidget);
      expect(_chip('Snacks'), findsNothing, reason: 'the server list replaced the six');
      expect(find.text('बिरयानी'), findsOneWidget, reason: 'server nameHi as the Hindi sublabel');
      expect(find.text('मुख्य खाना'), findsOneWidget, reason: 'no nameHi: the built-in map still names Main Course');
      expect(_selected(tester, 'Main Course'), isFalse, reason: 'Snacks (his pick) is gone, so nothing is picked');
      expect(_selected(tester, 'Biryani'), isFalse);
    });

    testWidgets('a pick that still exists survives the reload (server spelling); an untouched default that is gone becomes the first category', (tester) async {
      _phone(tester);
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async => null,
        loadCategories: () async => [const DishCategory('Starters'), const DishCategory('MAIN COURSE'), const DishCategory('Tea')],
      )));
      await _settle(tester);
      expect(_selected(tester, 'MAIN COURSE'), isTrue, reason: 'default Main Course exists (any case) and stays');

      await tester.pumpWidget(_host(AddDishModal(
        key: const ValueKey('second'),
        onSubmit: (n, c, p, s, {bool isVeg = true}) async => null,
        loadCategories: () async => [const DishCategory('Starters'), const DishCategory('Tea')],
      )));
      await _settle(tester);
      expect(_selected(tester, 'Starters'), isTrue, reason: 'nothing was chosen by the cook yet');
    });

    for (final (label, loader) in <(String, Future<List<DishCategory>?> Function())>[
      ('404 / failure (null)', () async => null),
      ('an empty list', () async => <DishCategory>[]),
      ('a throwing loader', () async => throw Exception('boom')),
    ]) {
      testWidgets('$label keeps the built-in six and the form works', (tester) async {
        _phone(tester);
        final sent = <String>[];
        await tester.pumpWidget(_host(AddDishModal(
          onSubmit: (n, c, p, s, {bool isVeg = true}) async {
            sent.add(c);
            return null;
          },
          loadCategories: loader,
        )));
        await _settle(tester);
        expect(find.byKey(const ValueKey('dish-categories-loading')), findsNothing);
        for (final c in DishCategory.fallback) {
          expect(_chip(c.name), findsOneWidget);
        }
        expect(_selected(tester, 'Main Course'), isTrue);
        await tester.tap(_chip('Beverages'));
        await tester.pump();
        await _fillAndSubmit(tester);
        expect(sent, ['Beverages']);
      });
    }

    testWidgets('the selected value is sent as the category NAME exactly as the server wrote it', (tester) async {
      _phone(tester);
      final sent = <String>[];
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async {
          sent.add(c);
          return null;
        },
        loadCategories: () async => DishCategory.parseList(_realDishes['data']),
      )));
      await _settle(tester);
      await tester.tap(_chip('North Indian'));
      await tester.pump();
      await _fillAndSubmit(tester);
      expect(sent, ['North Indian']);
    });

    testWidgets('CATEGORY_UNKNOWN: the server sentence is shown, the form keeps what was typed, the list reloads, a pick that still exists stays', (tester) async {
      _phone(tester);
      var round = 0;
      final lists = [
        [const DishCategory('Biryani'), const DishCategory('Tea'), const DishCategory('Snacks')],
        [const DishCategory('Biryani'), const DishCategory('Tea'), const DishCategory('Chaat', nameHi: 'चाट')],
      ];
      final sent = <String>[];
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async {
          sent.add(c);
          return sent.length == 1 ? failureText(ApiFailure.invalid, serverMessage: 'Pick a category from the list.', code: 'CATEGORY_UNKNOWN') : null;
        },
        loadCategories: () async => lists[round++ == 0 ? 0 : 1],
      )));
      await _settle(tester);
      await tester.tap(_chip('Tea'));
      await tester.pump();
      await _fillAndSubmit(tester);
      await _settle(tester);

      expect(round, 2, reason: 'reloaded after the refusal');
      expect(find.byKey(const ValueKey('add-dish-error')), findsOneWidget);
      expect(find.textContaining('Pick a category from the list.'), findsWidgets);
      expect(find.text('Chaat'), findsOneWidget, reason: 'the fresh list is on screen');
      expect(find.text('चाट'), findsOneWidget);
      expect(_chip('Snacks'), findsNothing);
      expect(_selected(tester, 'Tea'), isTrue, reason: 'previous pick still exists');
      expect(tester.widget<TextFormField>(find.byType(TextFormField).at(0)).controller!.text, 'Chicken Biryani');
      expect(tester.widget<TextFormField>(find.byType(TextFormField).at(1)).controller!.text, '180');

      // try again: goes through with the kept pick
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(sent, ['Tea', 'Tea']);
    });

    testWidgets('CATEGORY_UNKNOWN when the picked category is gone: the pick is cleared, Add asks to choose, nothing is sent', (tester) async {
      _phone(tester);
      var round = 0;
      final sent = <String>[];
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async {
          sent.add(c);
          return failureText(ApiFailure.invalid, serverMessage: 'Pick a category from the list.', code: 'CATEGORY_UNKNOWN');
        },
        loadCategories: () async => round++ == 0 ? [const DishCategory('Biryani'), const DishCategory('Tea')] : [const DishCategory('Biryani'), const DishCategory('Chaat')],
      )));
      await _settle(tester);
      await tester.tap(_chip('Tea'));
      await tester.pump();
      await _fillAndSubmit(tester);
      await _settle(tester);
      expect(sent, ['Tea']);
      expect(_selected(tester, 'Biryani'), isFalse);
      expect(_selected(tester, 'Chaat'), isFalse);

      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(sent, ['Tea'], reason: 'not sent without a category');
      expect(find.byKey(const ValueKey('add-dish-category-error')), findsOneWidget);

      await tester.ensureVisible(_chip('Chaat'));
      await tester.tap(_chip('Chaat'));
      await tester.pump();
      expect(find.byKey(const ValueKey('add-dish-category-error')), findsNothing);
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(sent, ['Tea', 'Chaat']);
    });

    testWidgets('another failure (offline) does not reload the list', (tester) async {
      _phone(tester);
      var loads = 0;
      await tester.pumpWidget(_host(AddDishModal(
        onSubmit: (n, c, p, s, {bool isVeg = true}) async => failureText(ApiFailure.offline),
        loadCategories: () async {
          loads++;
          return null;
        },
      )));
      await _settle(tester);
      await _fillAndSubmit(tester);
      expect(find.byKey(const ValueKey('add-dish-error')), findsOneWidget);
      expect(loads, 1);
    });

    testWidgets('closing the sheet while the list loads does not throw', (tester) async {
      _phone(tester);
      final gate = Completer<List<DishCategory>?>();
      await tester.pumpWidget(_host(AddDishModal(onSubmit: (n, c, p, s, {bool isVeg = true}) async => null, loadCategories: () => gate.future)));
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      gate.complete([const DishCategory('Late')]);
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  // ================================================================================ small screen ====
  group('Small screen and large font', () {
    testWidgets('360x640 at 1.3x text with 40 long category names: no overflow, the sheet scrolls to the Add button', (tester) async {
      _phone(tester, size: const Size(360, 640), textScale: 1.3);
      final many = [for (var i = 0; i < 40; i++) DishCategory('Category number $i with a long name', nameHi: 'बहुत लंबा हिंदी नाम $i')];
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!),
        home: Scaffold(body: AddDishModal(onSubmit: (n, c, p, s, {bool isVeg = true}) async => null, loadCategories: () async => many)),
      ));
      await _settle(tester);
      expect(find.text('Category number 0 with a long name'), findsOneWidget);
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      expect(find.text('Add to menu'), findsOneWidget);
      expect(tester.takeException(), isNull);
      // the very long (30 character) names the admin may create
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!),
        home: Scaffold(body: AddDishModal(key: UniqueKey(), onSubmit: (n, c, p, s, {bool isVeg = true}) async => null, loadCategories: () async => [DishCategory('W' * 30, nameHi: 'ह' * 30), const DishCategory('Tea')])),
      ));
      await _settle(tester);
      expect(tester.takeException(), isNull);
    });
  });

  // ============================================================================ whole Menu screen ====
  group('Menu tab end to end', () {
    testWidgets('the Add-dish sheet from the Menu tab loads the server list; the refusal reloads it', (tester) async {
      _phone(tester, size: const Size(412, 1800));
      final backend = _CategoryBackend([DishModel(id: 'd1', name: 'Thali', category: 'Main Course', price: 100, statusKnown: true, status: DishStatus.live)])
        ..answer = DishCategory.parseList(_realDishes['data']);
      final menu = MenuStockController(backend: backend, vendorId: 'ven-1');
      await tester.pumpWidget(_host(StockManagerScreen(controller: menu)));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.bySemanticsLabel('Add a new dish'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(backend.fetches, 1);
      expect(_chip('Biryani'), findsOneWidget);
      expect(_chip('Snacks'), findsNothing);

      backend.dishAnswer = const ApiResult.failure(ApiFailure.invalid, message: 'Pick a category from the list.', code: 'CATEGORY_UNKNOWN', statusCode: 400);
      backend.answer = [const DishCategory('Biryani'), const DishCategory('Main Course')];
      await tester.tap(_chip('Biryani'));
      await tester.pump();
      await _fillAndSubmit(tester);
      await tester.pump(const Duration(seconds: 1));
      expect(backend.fetches, 2);
      expect(find.byKey(const ValueKey('add-dish-error')), findsOneWidget);
      expect(find.textContaining('Pick a category from the list.'), findsWidgets);
      expect(_chip('North Indian'), findsNothing);
      expect(_selected(tester, 'Biryani'), isTrue);
      expect(backend.calls.where((c) => c.startsWith('dish:add')).length, 1);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });
}

class _ThrowingBackend extends FakeBackend implements DishCategorySource {
  @override
  Future<ApiResult<List<DishCategory>>> fetchDishCategories() async => throw StateError('boom');
}
