import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/screens/sales_analytics.dart';
import 'package:vendor_app/screens/stock_manager.dart';
import 'package:vendor_app/screens/kitchen_queue.dart';
import 'package:vendor_app/services/menu_stock_controller.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/widgets/first_run_card.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/stock_card.dart';
import 'support/catalog_fakes.dart';
import 'support/fakes.dart';

/// Phase 1 of Docs/21: the restaurant sees only ITS price and each dish's approval status; new dishes and price changes
/// go to Kraveo for approval; orders show only what the restaurant earns. Also: an OLD server keeps working.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  DishModel dish(String id, String name, DishStatus status, {double price = 100, double? pending, String? reason, bool inStock = true, String category = 'Main Course'}) =>
      DishModel(id: id, name: name, category: category, price: price, status: status, pendingPrice: pending, rejectionReason: reason, inStock: inStock, statusKnown: true);

  // ------------------------------------------------------------------------------------------------ model

  group('DishModel parsing', () {
    test('reads the status words, the restaurant price, the pending price and the reason', () {
      final live = DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'status': 'LIVE', 'isAvailable': true})!;
      expect((live.status, live.price, live.statusKnown, live.isLive), (DishStatus.live, 90.0, true, true));
      final pending = DishModel.fromJson({'id': 'b', 'name': 'Dal', 'price': 80, 'status': 'PENDING'})!;
      expect((pending.status, pending.isLive), (DishStatus.pending, false));
      final change = DishModel.fromJson({'id': 'c', 'name': 'Rice', 'price': 70, 'pendingPrice': 85, 'status': 'CHANGE_PENDING'})!;
      expect((change.status, change.price, change.pendingPrice, change.isLive, change.editPrice), (DishStatus.changePending, 70.0, 85.0, true, 85.0));
      final rejected = DishModel.fromJson({'id': 'd', 'name': 'Roti', 'price': 10, 'status': 'REJECTED', 'rejectionReason': 'Photo missing'})!;
      expect((rejected.status, rejected.rejectionReason, rejected.isLive), (DishStatus.rejected, 'Photo missing', false));
    });

    test('an old server sends no status: the dish is live and the app knows it has no approval step', () {
      final d = DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'isAvailable': false})!;
      expect((d.status, d.statusKnown, d.isLive, d.inStock, d.pendingPrice), (DishStatus.live, false, true, false, null));
    });

    test('a waiting price on a live dish counts as a price change; a word we do not know is NOT shown as live', () {
      final d = DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'status': 'LIVE', 'pendingPrice': 99})!;
      expect((d.status, d.pendingPrice), (DishStatus.changePending, 99.0));
      expect(DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'status': 'SOMETHING_NEW'})!.status, DishStatus.pending);
      expect(DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'status': 'APPROVED'})!.status, DishStatus.live);
    });

    test('the customer price and commission are never read: only `price` (the restaurant price) is', () {
      final d = DishModel.fromJson({'id': 'a', 'name': 'Thali', 'price': 90, 'customerPrice': 120, 'commission': 30, 'status': 'LIVE'})!;
      expect(d.price, 90);
    });
  });

  // ------------------------------------------------------------------------------------------------ http

  group('HTTP: menu-manage with an old-server fallback', () {
    late List<http.Request> sent;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await VendorApiService.saveToken('jwt-abc');
      sent = [];
    });
    tearDown(() => VendorApiService.clearToken());

    Future<T> withServer<T>(Future<T> Function() body, http.Response Function(http.Request) handler) => http.runWithClient(body, () => MockClient((r) async {
          sent.add(r);
          return handler(r);
        }));

    const backend = HttpVendorBackend();

    test('reads GET /vendors/:id/menu-manage with status, pending price and reason', () async {
      final res = await withServer(
        () => backend.fetchMenu('ven-42'),
        (_) => http.Response(
            jsonEncode({
              'data': [
                {'id': 'm1', 'name': 'Thali', 'price': 90, 'status': 'LIVE', 'isAvailable': true, 'category': 'Main Course'},
                {'id': 'm2', 'name': 'Dal', 'price': 80, 'status': 'PENDING'},
                {'id': 'm3', 'name': 'Rice', 'price': 70, 'status': 'CHANGE_PENDING', 'pendingPrice': 75},
                {'id': 'm4', 'name': 'Roti', 'price': 10, 'status': 'REJECTED', 'rejectionReason': 'Too cheap'},
              ]
            }),
            200),
      );
      expect(sent, hasLength(1));
      expect(sent.single.url.path, endsWith('/vendors/ven-42/menu-manage'));
      expect(res.data!.map((d) => d.status), [DishStatus.live, DishStatus.pending, DishStatus.changePending, DishStatus.rejected]);
      expect(res.data![2].pendingPrice, 75);
      expect(res.data![3].rejectionReason, 'Too cheap');
    });

    test('an OLD server (404 on menu-manage) falls back to GET /menus/:id and every dish is live', () async {
      final res = await withServer(
        () => backend.fetchMenu('ven-42'),
        (r) => r.url.path.endsWith('/menu-manage')
            ? http.Response('<html>Cannot GET</html>', 404)
            : http.Response(jsonEncode({'data': [{'id': 'm1', 'name': 'Thali', 'price': 90, 'isAvailable': true, 'category': 'Main Course'}]}), 200),
      );
      expect(sent.map((r) => r.url.path.split('/api').last), ['/vendors/ven-42/menu-manage', '/menus/ven-42']);
      expect(sent.last.headers['Authorization'], 'Bearer jwt-abc');
      expect(res.ok, isTrue);
      expect((res.data!.single.status, res.data!.single.statusKnown), (DishStatus.live, false));
    });

    test('other failures do NOT fall back: a 500, a 403 and a dead network are reported as they are', () async {
      final server = await withServer(() => backend.fetchMenu('ven-42'), (_) => http.Response('{"message":"boom"}', 500));
      expect((server.failure, sent.length), (ApiFailure.server, 1));
      sent.clear();
      final forbidden = await withServer(() => backend.fetchMenu('ven-42'), (_) => http.Response('{"code":"FORBIDDEN"}', 403));
      expect((forbidden.failure, sent.length), (ApiFailure.forbidden, 1));
      final offline = await http.runWithClient(() => backend.fetchMenu('ven-42'), () => MockClient((_) async => throw http.ClientException('no route')));
      expect(offline.failure, ApiFailure.offline);
    });

    test('POST answer carries status PENDING; PATCH price answer carries the pending price', () async {
      final added = await withServer(
          () => backend.addDish('ven-42', name: 'Lassi', category: 'Beverages', price: 40), (_) => http.Response('{"data":{"id":"m9","name":"Lassi","price":40,"status":"PENDING","isAvailable":true}}', 201));
      expect(sent.last.url.path, endsWith('/vendors/ven-42/items'));
      expect(jsonDecode(sent.last.body), {'name': 'Lassi', 'category': 'Beverages', 'price': 40.0, 'isVeg': true});
      expect(added.data!.status, DishStatus.pending);
      final changed = await withServer(
          () => backend.updateDish('m1', price: 99), (_) => http.Response('{"item":{"id":"m1","name":"Thali","price":90,"pendingPrice":99,"status":"CHANGE_PENDING"}}', 200));
      expect(jsonDecode(sent.last.body), {'price': 99.0});
      expect((changed.data!.price, changed.data!.pendingPrice, changed.data!.status), (90.0, 99.0, DishStatus.changePending));
      // a bare dish (no `item` / `data` wrapper) is read too
      final bare = await withServer(() => backend.updateDish('m1', price: 99), (_) => http.Response('{"id":"m1","name":"Thali","price":90,"pendingPrice":99,"status":"CHANGE_PENDING"}', 200));
      expect(bare.data!.pendingPrice, 99);
    });
  });

  // ------------------------------------------------------------------------------------------------ controller

  group('MenuStockController approval flow', () {
    late CatalogBackend backend;
    late MenuStockController menu;
    final errors = <dynamic>[];

    Future<void> start(List<DishModel> dishes) async {
      errors.clear();
      backend = CatalogBackend(dishes);
      menu = MenuStockController(backend: backend, vendorId: 'ven-42', priceDebounce: const Duration(milliseconds: 10))..onError = errors.add;
      await menu.load();
    }

    Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 60));

    tearDown(() => menu.dispose());

    test('a new dish is PENDING (sent for approval), is remembered as lastAdded and has no sold-out call', () async {
      await start([dish('m1', 'Thali', DishStatus.live)]);
      expect(await menu.addDish(name: 'Lassi', category: 'Beverages', price: 40, inStock: true), isNull);
      expect(menu.lastAdded!.status, DishStatus.pending);
      expect(menu.dishes.last.name, 'Lassi');
      expect(menu.waitingCount, 1);
      // even when "not in stock" is asked for, a pending dish gets no sold-out call
      await menu.addDish(name: 'Chaas', category: 'Beverages', price: 20, inStock: false);
      expect(backend.calls.where((c) => c.startsWith('dish:update')), isEmpty);
    });

    test('price change on a LIVE dish: the old price stays live, the new one is "pending", status CHANGE_PENDING', () async {
      await start([dish('m1', 'Thali', DishStatus.live, price: 100)]);
      final d = menu.dishes.single;
      menu.changePrice(d, 120);
      // shown at once
      expect((d.price, d.pendingPrice, d.status), (100.0, 120.0, DishStatus.changePending));
      await settle();
      expect(backend.calls.where((c) => c.startsWith('dish:update')), ['dish:update:m1::120.0']);
      expect((d.price, d.pendingPrice, d.status), (100.0, 120.0, DishStatus.changePending));
      expect(errors, isEmpty);
      // stepping again moves the pending value, never the live price
      menu.changePrice(d, d.editPrice + 10);
      await settle();
      expect((d.price, d.pendingPrice), (100.0, 130.0));
    });

    test('asking for the live price again cancels the pending request', () async {
      await start([dish('m1', 'Thali', DishStatus.changePending, price: 100, pending: 120)]);
      final d = menu.dishes.single;
      menu.changePrice(d, 100);
      await settle();
      expect((d.status, d.pendingPrice, d.price), (DishStatus.live, null, 100.0));
    });

    test('a failed price request rolls back to what the server last confirmed, with a message', () async {
      await start([dish('m1', 'Thali', DishStatus.live, price: 100)]);
      final d = menu.dishes.single;
      backend.dishAnswer = const ApiResult.failure(ApiFailure.offline);
      menu.changePrice(d, 120);
      await settle();
      expect((d.price, d.pendingPrice, d.status), (100.0, null, DishStatus.live));
      expect(errors, hasLength(1));
    });

    test('price on a PENDING dish edits it directly (it is not live, so there is nothing to keep)', () async {
      await start([dish('m1', 'New dish', DishStatus.pending, price: 100)]);
      final d = menu.dishes.single;
      menu.changePrice(d, 110);
      expect((d.price, d.pendingPrice), (110.0, null));
      await settle();
      expect((d.price, d.status), (110.0, DishStatus.pending));
    });

    test('a REJECTED dish is sent again with resubmit: PENDING at once; a failure restores the rejection', () async {
      await start([dish('m1', 'Roti', DishStatus.rejected, price: 10, reason: 'Price looks wrong')]);
      final d = menu.dishes.single;
      menu.changePrice(d, 50); // steppers are ignored while rejected
      expect(d.price, 10);
      backend.dishAnswer = const ApiResult.failure(ApiFailure.server);
      await menu.resubmit(d, 12);
      expect((d.status, d.price, d.rejectionReason), (DishStatus.rejected, 10.0, 'Price looks wrong'));
      expect(errors, hasLength(1));
      backend.dishAnswer = null;
      await menu.resubmit(d, 12);
      expect((d.status, d.price, d.rejectionReason), (DishStatus.pending, 12.0, null));
      expect(backend.calls.last, 'dish:update:m1::12.0');
      expect(menu.rejectedCount, 0);
    });

    test('sold-out is instant and only for live dishes (a price change pending dish is still live)', () async {
      await start([
        dish('live', 'A', DishStatus.live),
        dish('chg', 'B', DishStatus.changePending, price: 50, pending: 60),
        dish('pen', 'C', DishStatus.pending),
        dish('rej', 'D', DishStatus.rejected, reason: 'No'),
      ]);
      for (final d in menu.dishes) {
        await menu.toggleStock(d);
      }
      expect(backend.calls.where((c) => c.startsWith('dish:update')), ['dish:update:live:false:', 'dish:update:chg:false:']);
      expect(menu.dishes.map((d) => d.inStock), [false, false, true, true]);
      expect(errors, isEmpty);
    });

    test('OLD server dishes (no status): the price applies at once, as before', () async {
      errors.clear();
      final old = FakeBackend()..menu = [DishModel(id: 'm1', name: 'Thali', category: 'Main Course', price: 90)];
      menu = MenuStockController(backend: old, vendorId: 'ven-42', priceDebounce: const Duration(milliseconds: 10));
      await menu.load();
      final d = menu.dishes.single;
      menu.changePrice(d, 100);
      expect((d.price, d.pendingPrice, d.status), (100.0, null, DishStatus.live));
      await settle();
      expect((d.price, d.pendingPrice, d.status), (100.0, null, DishStatus.live));
      expect(menu.waitingCount, 0);
    });

    test('a fresh read after the admin decides shows the new state', () async {
      await start([dish('m1', 'Dal', DishStatus.pending, price: 80)]);
      backend.byId('m1').status = DishStatus.live;
      await menu.load();
      expect(menu.dishes.single.status, DishStatus.live);
      backend.byId('m1')
        ..status = DishStatus.rejected
        ..rejectionReason = 'Not on our list';
      await menu.load();
      expect((menu.dishes.single.status, menu.dishes.single.rejectionReason), (DishStatus.rejected, 'Not on our list'));
    });
  });

  // ------------------------------------------------------------------------------------------------ widgets

  void phone(WidgetTester tester, {Size size = const Size(360, 640), double scale = 1.3}) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
  }

  Widget host(Widget child) => MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!),
        home: Scaffold(body: child),
      );

  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  group('StockCard: status chip, "Your price", pending price, rejected', () {
    Widget card(DishModel d, {List<double>? updates, List<double>? resubmits, VoidCallback? onToggle}) => host(SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: StockCard(dish: d, onToggleStock: onToggle ?? () {}, onUpdatePrice: (p) => updates?.add(p), onResubmit: (p) => resubmits?.add(p)),
        ));

    testWidgets('live: "Live" chip, "Your price", the sold-out switch', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      await tester.pumpWidget(card(dish('m1', 'Thali', DishStatus.live, price: 90)));
      expect(find.byKey(const ValueKey('dish-status-live')), findsOneWidget);
      expect(find.text('Live'), findsOneWidget);
      expect(find.textContaining('Your price', findRichText: true), findsOneWidget);
      expect(find.text('IN STOCK'), findsOneWidget);
    });

    testWidgets('pending: "Pending approval", price steppers work, NO sold-out switch', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final updates = <double>[];
      await tester.pumpWidget(card(dish('m1', 'Dal', DishStatus.pending, price: 80), updates: updates));
      expect(find.text('Pending approval'), findsOneWidget);
      expect(find.byKey(const ValueKey('pending-note')), findsOneWidget);
      expect(find.text('IN STOCK'), findsNothing);
      expect(find.text('SOLD OUT'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('price-plus')));
      expect(updates, [90.0]);
    });

    testWidgets('price change pending: the live price stays, the new value + "Sent for approval" is shown, the switch works', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final updates = <double>[];
      var toggled = 0;
      await tester.pumpWidget(card(dish('m1', 'Rice', DishStatus.changePending, price: 70, pending: 85), updates: updates, onToggle: () => toggled++));
      expect(find.text('Price change pending'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('your-price'))).data, '₹70');
      expect(tester.widget<Text>(find.byKey(const ValueKey('pending-price'))).data, 'New price ₹85 · Sent for approval');
      // steppers continue from the requested value, not from the live one
      await tester.tap(find.byKey(const ValueKey('price-plus')));
      expect(updates, [95.0]);
      await tester.tap(find.text('IN STOCK'));
      expect(toggled, 1);
    });

    testWidgets('rejected: chip + reason + "Send again" (resubmit with the same price); no steppers, no switch', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final resubmits = <double>[];
      await tester.pumpWidget(card(dish('m1', 'Roti', DishStatus.rejected, price: 10, reason: 'Price looks wrong'), resubmits: resubmits));
      expect(find.text('Rejected'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('rejection-reason'))).data, 'Reason: Price looks wrong');
      expect(find.byKey(const ValueKey('price-plus')), findsNothing);
      expect(find.byKey(const ValueKey('price-minus')), findsNothing);
      expect(find.text('IN STOCK'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('resubmit-m1')));
      expect(resubmits, [10.0]);
    });

    testWidgets('rejected: the price sheet says "send again" and always resubmits, even with the same price', (tester) async {
      phone(tester, size: const Size(400, 900));
      final resubmits = <double>[];
      await tester.pumpWidget(card(dish('m1', 'Roti', DishStatus.rejected, price: 10, reason: 'x'), resubmits: resubmits));
      await tester.tap(find.byKey(const ValueKey('your-price')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Fix price, send again'), findsOneWidget);
      await tester.tap(find.widgetWithText(KButton, 'Send for approval'));
      await tester.pump();
      expect(resubmits, [10.0]);
    });

    testWidgets('live: the price sheet explains the approval, and "Send for approval" is not sent when nothing changed', (tester) async {
      phone(tester, size: const Size(400, 900));
      final updates = <double>[];
      await tester.pumpWidget(card(dish('m1', 'Thali', DishStatus.live, price: 90), updates: updates));
      await tester.tap(find.byKey(const ValueKey('your-price')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('old price stays live until it is approved'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('price-field')), '95');
      await tester.tap(find.widgetWithText(KButton, 'Send for approval'));
      await tester.pump();
      expect(updates, [95.0]);
    });

    testWidgets('price change pending: the sheet starts from the requested price', (tester) async {
      phone(tester, size: const Size(400, 900));
      await tester.pumpWidget(card(dish('m1', 'Rice', DishStatus.changePending, price: 70, pending: 85)));
      await tester.tap(find.byKey(const ValueKey('your-price')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.widget<TextField>(find.byKey(const ValueKey('price-field'))).controller!.text, '85');
    });

    testWidgets('OLD server dish (no status): no chip, no approval wording, the switch and a plain "Save price"', (tester) async {
      phone(tester, size: const Size(400, 900));
      await tester.pumpWidget(card(DishModel(id: 'm1', name: 'Thali', category: 'Main Course', price: 90)));
      expect(find.byKey(const ValueKey('chip-m1')), findsNothing);
      expect(find.text('IN STOCK'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('your-price')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Save price'), findsOneWidget);
      expect(find.textContaining('approv'), findsNothing);
    });
  });

  group('Menu tab with approval', () {
    testWidgets('a status chip on every dish, the waiting banner and the filter', (tester) async {
      phone(tester, size: const Size(400, 2400), scale: 1.0);
      final backend = CatalogBackend([
        dish('a', 'Live Thali', DishStatus.live),
        dish('b', 'Pending Dal', DishStatus.pending),
        dish('c', 'Changing Rice', DishStatus.changePending, price: 70, pending: 85),
        dish('d', 'Rejected Roti', DishStatus.rejected, reason: 'Price looks wrong'),
      ]);
      final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      expect(find.text('Live'), findsOneWidget);
      expect(find.text('Pending approval'), findsOneWidget);
      expect(find.text('Price change pending'), findsOneWidget);
      expect(find.text('Rejected'), findsOneWidget);
      expect(find.text('2 waiting for approval · 1 not approved'), findsOneWidget);
      // In stock counts only the two live dishes
      expect(find.bySemanticsLabel(RegExp(r'^In stock: 2')), findsOneWidget);
      // the banner filters to dishes that need attention
      await tester.tap(find.byKey(const ValueKey('approval-banner')));
      await pumpScreen(tester);
      expect(find.text('Live Thali'), findsNothing);
      expect(find.text('Pending Dal'), findsOneWidget);
      expect(find.text('Rejected Roti'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('approval-banner')));
      await pumpScreen(tester);
      expect(find.text('Live Thali'), findsOneWidget);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('only pending dishes: the banner says customers see the menu after approval', (tester) async {
      phone(tester, size: const Size(400, 900), scale: 1.0);
      final menu = MenuStockController(backend: CatalogBackend([dish('b', 'Pending Dal', DishStatus.pending)]), vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      expect(find.textContaining('Customers will see your menu once Kraveo approves a dish'), findsOneWidget);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('empty menu mentions approval', (tester) async {
      phone(tester, size: const Size(400, 900), scale: 1.0);
      final menu = MenuStockController(backend: CatalogBackend([]), vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      expect(find.text('Your menu is empty'), findsOneWidget);
      expect(find.textContaining('Kraveo checks every new dish'), findsOneWidget);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('adding a dish shows "Sent to Kraveo for approval" and the dish appears as Pending approval', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final backend = CatalogBackend([dish('a', 'Live Thali', DishStatus.live)]);
      final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      await tester.tap(find.bySemanticsLabel('Add a new dish'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const ValueKey('add-dish-approval-note')), findsOneWidget);
      expect(find.textContaining('Your price', findRichText: true), findsWidgets);
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Masala Dosa');
      await tester.enterText(fields.at(1), '70');
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('Sent to Kraveo for approval'), findsOneWidget);
      expect(backend.calls, contains('dish:add:ven-42:Masala Dosa:70.0'));
      expect(find.text('Pending approval'), findsOneWidget);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('OLD server menu (no status): no chips, no banner, plain "added to menu" message', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final backend = FakeBackend()..menu = [DishModel(id: 'a', name: 'Thali', category: 'Main Course', price: 90)];
      final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      expect(find.byKey(const ValueKey('approval-banner')), findsNothing);
      expect(find.text('Live'), findsNothing);
      expect(find.text('IN STOCK'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Add a new dish'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Lassi');
      await tester.enterText(fields.at(1), '40');
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('added to menu'), findsOneWidget);
      expect(find.textContaining('approval'), findsNothing);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the sold-out switch on a live dish saves at once and a rejected dish can be sent again from the list', (tester) async {
      phone(tester, size: const Size(400, 1400), scale: 1.0);
      final backend = CatalogBackend([dish('a', 'Live Thali', DishStatus.live), dish('d', 'Rejected Roti', DishStatus.rejected, price: 10, reason: 'Price looks wrong')]);
      final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
      await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
      await pumpScreen(tester);
      await tester.tap(find.text('IN STOCK'));
      await pumpScreen(tester);
      expect(find.text('SOLD OUT'), findsWidgets);
      expect(backend.calls, contains('dish:update:a:false:'));
      await tester.ensureVisible(find.byKey(const ValueKey('resubmit-d')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('resubmit-d')));
      await pumpScreen(tester);
      expect(backend.calls, contains('dish:update:d::10.0'));
      expect(find.text('Rejected'), findsNothing);
      expect(find.text('Pending approval'), findsOneWidget);
      menu.dispose();
      await tester.pumpWidget(const SizedBox());
    });
  });

  testWidgets('first-run card on the Orders tab: approval help text, and the "waiting" variant', (tester) async {
    phone(tester, size: const Size(360, 640));
    Widget card(bool waiting) => host(SingleChildScrollView(child: FirstRunCard(hasDishes: waiting, isOpen: true, onAddDish: () {}, onOpenStore: () {}, waitingApproval: waiting)));
    await tester.pumpWidget(card(false));
    expect(find.textContaining('Kraveo approves each new dish first', findRichText: true), findsOneWidget);
    await tester.pumpWidget(card(true));
    expect(find.textContaining('Waiting for Kraveo to approve your dish', findRichText: true), findsOneWidget);
  });

  // ------------------------------------------------------------------------------------------------ orders

  group('Orders show only what the restaurant earns', () {
    test('the model takes the vendor view as is: earned = subtotal = total; the customer fields are absent', () {
      final o = OrderModel.fromJson(vendorOrderJson(earned: 205.5))!;
      expect((o.earned, o.totalAmount, o.deliveryFee, o.discount, o.taxAndPackaging), (205.5, 205.5, null, null, null));
    });

    test('earned falls back to the food subtotal, then to the item lines, for old payloads', () {
      expect(OrderModel.fromJson(orderJson())!.earned, 205); // old shape: subtotal is the food total
      final noSubtotal = orderJson(items: [
        {'id': 'i1', 'name': 'A', 'quantity': 2, 'price': 40.0},
        {'id': 'i2', 'name': 'B', 'quantity': 1, 'price': 15.5},
      ])
        ..remove('subtotal');
      expect(OrderModel.fromJson(noSubtotal)!.earned, 95.5);
      expect(OrderModel.fromJson({...orderJson(), 'vendorSubtotal': 180.0})!.earned, 180);
    });

    testWidgets('the order card says "You earn" with the item lines at the restaurant prices; no fees, discount or total', (tester) async {
      phone(tester);
      SharedPreferences.setMockInitialValues({});
      // A payload that (wrongly) still carries customer money: the app must not show any of it.
      final j = vendorOrderJson(id: 'ord-v1', earned: 205, items: [
        {'id': 'i1', 'menuItemId': 'm1', 'name': 'Paneer Butter Masala', 'quantity': 1, 'price': 180.0},
        {'id': 'i2', 'menuItemId': 'm2', 'name': 'Tandoori Roti', 'quantity': 2, 'price': 12.5},
      ])
        ..['deliveryFee'] = 25.0
        ..['discount'] = 30.0
        ..['couponCode'] = 'WELCOME';
      final backend = FakeBackend()..put(OrderModel.fromJson(j)!);
      final c = await startController(backend);
      await tester.pumpWidget(host(KitchenQueueScreen(controller: c, onOpenIncoming: (_) {})));
      await pumpScreen(tester);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('earn-ord-v1')), 200, scrollable: find.byType(Scrollable).last);
      expect(find.textContaining('You earn ₹205'), findsOneWidget);
      expect(find.byKey(const ValueKey('item-price-i1')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('item-price-i1'))).data, '₹180');
      expect(tester.widget<Text>(find.byKey(const ValueKey('item-price-i2'))).data, '₹12.50 each · ₹25');
      for (final banned in ['Customer pays', 'Food ₹', 'delivery', 'Delivery', 'discount', 'Discount', 'WELCOME', 'Total', 'packaging', '₹230', '₹245']) {
        expect(find.textContaining(banned), findsNothing, reason: banned);
      }
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the new-order takeover shows only "You earn ₹X" (paise when present) and the items at the restaurant prices', (tester) async {
      phone(tester);
      SharedPreferences.setMockInitialValues({});
      final c = await startController(FakeBackend()..put(OrderModel.fromJson(vendorOrderJson(id: 'ord-1', status: 'PLACED', earned: 205.5, items: [
            {'id': 'i1', 'name': 'Paneer Butter Masala', 'quantity': 1, 'price': 180.0},
            {'id': 'i2', 'name': 'Tandoori Roti', 'quantity': 2, 'price': 12.75},
          ]))!));
      await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-1', controller: c)));
      await tester.pump(const Duration(milliseconds: 500));
      expect(tester.widget<Text>(find.byKey(const ValueKey('you-earn'))).data, '₹205.50');
      expect(find.textContaining('You earn'), findsOneWidget);
      expect(find.text('₹180'), findsOneWidget);
      expect(find.text('₹25.50'), findsOneWidget);
      for (final banned in ['Customer pays', 'Food ₹', 'delivery', 'packaging', '₹245']) {
        expect(find.textContaining(banned), findsNothing, reason: banned);
      }
      c.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('earnings add up the earned amounts of today\'s accepted orders and say so', (tester) async {
      phone(tester);
      final now = DateTime.now();
      final orders = [
        OrderModel.fromJson(vendorOrderJson(id: 'a', status: 'ACCEPTED', earned: 150.25))!,
        OrderModel.fromJson(vendorOrderJson(id: 'b', status: 'DELIVERED', earned: 99.75))!,
        OrderModel.fromJson(vendorOrderJson(id: 'c', status: 'PLACED', earned: 500))!, // not accepted yet: not counted
      ];
      await tester.pumpWidget(host(SalesAnalyticsScreen(orders: orders, now: now)));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('₹250'), findsOneWidget);
      expect(find.textContaining('What you earned'), findsOneWidget);
      expect(find.textContaining('before Kraveo fees'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  // ------------------------------------------------------------------------------------------------ layout

  for (final scale in [1.0, 1.3]) {
    group('no overflow at 360x640, text x$scale', () {
      testWidgets('menu with a dish in every approval state, then the add-dish sheet', (tester) async {
        phone(tester, scale: scale);
        final backend = CatalogBackend([
          dish('a', 'Paneer Butter Masala With Extra Long Name', DishStatus.live, price: 1250.5),
          dish('b', 'Pending Dal Makhani Special', DishStatus.pending),
          dish('c', 'Changing Rice Pulao With A Long Name', DishStatus.changePending, price: 70, pending: 85.25),
          dish('d', 'Rejected Roti', DishStatus.rejected, price: 10, reason: 'Please use the photo of your own dish and a clearer name for it'),
        ]);
        final menu = MenuStockController(backend: backend, vendorId: 'ven-42');
        await tester.pumpWidget(host(StockManagerScreen(controller: menu)));
        await pumpScreen(tester);
        for (final key in ['chip-a', 'chip-b', 'chip-c', 'chip-d']) {
          await tester.scrollUntilVisible(find.byKey(ValueKey(key)), 200, scrollable: find.byType(Scrollable).first);
        }
        await tester.scrollUntilVisible(find.byKey(const ValueKey('resubmit-d')), 200, scrollable: find.byType(Scrollable).first);
        await tester.scrollUntilVisible(find.byKey(const ValueKey('approval-banner')), -300, scrollable: find.byType(Scrollable).first);
        await tester.tap(find.bySemanticsLabel('Add a new dish'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byKey(const ValueKey('add-dish-approval-note')), findsOneWidget);
        menu.dispose();
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('price sheets (live and rejected dish), empty menu, first-run card', (tester) async {
        phone(tester, scale: scale);
        final updates = <double>[];
        await tester.pumpWidget(host(SingleChildScrollView(child: StockCard(dish: dish('a', 'Thali', DishStatus.live), onToggleStock: () {}, onUpdatePrice: updates.add))));
        await tester.tap(find.byKey(const ValueKey('your-price')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byKey(const ValueKey('price-helper')), findsOneWidget);
        await tester.pumpWidget(const SizedBox());

        await tester.pumpWidget(host(SingleChildScrollView(child: StockCard(dish: dish('r', 'Roti', DishStatus.rejected, price: 10, reason: 'Please use a clearer name'), onToggleStock: () {}, onUpdatePrice: updates.add))));
        await tester.tap(find.byKey(const ValueKey('your-price')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.text('Fix price, send again'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());

        final empty = MenuStockController(backend: CatalogBackend([]), vendorId: 'ven-42');
        await tester.pumpWidget(host(StockManagerScreen(controller: empty)));
        await pumpScreen(tester);
        expect(find.text('Your menu is empty'), findsOneWidget);
        empty.dispose();
        await tester.pumpWidget(host(SingleChildScrollView(child: FirstRunCard(hasDishes: true, isOpen: false, onAddDish: () {}, onOpenStore: () {}, waitingApproval: true))));
        await tester.pump();
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('order card and takeover with the vendor view and long item names', (tester) async {
        phone(tester, scale: scale);
        SharedPreferences.setMockInitialValues({});
        final items = [
          for (var i = 0; i < 4; i++) {'id': 'i$i', 'name': 'Paneer Butter Masala Special Thali $i', 'quantity': i + 1, 'price': 1180.5},
        ];
        final backend = FakeBackend()
          ..put(OrderModel.fromJson(vendorOrderJson(id: 'ord-0001', status: 'ACCEPTED', earned: 12345.5, items: items))!)
          ..put(OrderModel.fromJson(vendorOrderJson(id: 'ord-0002', status: 'PLACED', earned: 12345.5, items: items))!);
        final c = await startController(backend);
        await tester.pumpWidget(host(KitchenQueueScreen(controller: c, onOpenIncoming: (_) {})));
        await pumpScreen(tester);
        await tester.scrollUntilVisible(find.byKey(const ValueKey('earn-ord-0001')), 200, scrollable: find.byType(Scrollable).last);
        await tester.pumpWidget(host(IncomingOrderDialog(orderId: 'ord-0002', controller: c)));
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.byKey(const ValueKey('you-earn')), findsOneWidget);
        c.dispose();
        await tester.pumpWidget(const SizedBox());
      });
    });
  }
}
