import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/services/failure_messages.dart';
import 'package:vendor_app/services/menu_stock_controller.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'support/fakes.dart';

void main() {
  late FakeBackend backend;
  late MenuStockController menu;
  final errors = <FailureText>[];

  setUp(() async {
    errors.clear();
    backend = FakeBackend()..menu = [DishModel(id: 'm1', name: 'Thali', category: 'Main Course', price: 90)];
    menu = MenuStockController(backend: backend, vendorId: 'ven-42', priceDebounce: const Duration(milliseconds: 10))..onError = errors.add;
    await menu.load();
  });

  tearDown(() => menu.dispose());

  test('loads the real menu for the real vendor id', () {
    expect(backend.calls, contains('menu:ven-42'));
    expect(menu.dishes.single.name, 'Thali');
    expect(menu.loadedOnce, isTrue);
  });

  test('a failed load keeps what is on screen and reports it', () async {
    backend.menuFailure = ApiFailure.offline;
    await menu.load();
    expect(menu.loadFailure, ApiFailure.offline);
    expect(menu.dishes, isNotEmpty);
  });

  test('sold-out switch saves; when saving fails it flips back and says so', () async {
    await menu.toggleStock(menu.dishes.single);
    expect(menu.dishes.single.inStock, isFalse);
    expect(backend.calls.last, 'dish:update:m1:false:');
    backend.dishAnswer = const ApiResult.failure(ApiFailure.offline);
    await menu.toggleStock(menu.dishes.single);
    expect(menu.dishes.single.inStock, isFalse); // rolled back to the saved value
    expect(errors, hasLength(1));
  });

  test('price taps are sent once after the cook stops; a failure restores the saved price', () async {
    final d = menu.dishes.single;
    menu.changePrice(d, 100);
    menu.changePrice(d, 110);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(backend.calls.where((c) => c.startsWith('dish:update')).toList(), ['dish:update:m1::110.0']);
    expect(d.price, 110);
    backend.dishAnswer = const ApiResult.failure(ApiFailure.server);
    menu.changePrice(d, 120);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(d.price, 110);
    expect(errors, hasLength(1));
  });

  test('adding a dish posts it; a failure is returned so the sheet can stay open', () async {
    expect(await menu.addDish(name: 'Lassi', category: 'Beverages', price: 40, inStock: true), isNull);
    expect(menu.dishes.map((d) => d.name), contains('Lassi'));
    backend.dishAnswer = const ApiResult.failure(ApiFailure.invalid, message: 'Item name and price are required.');
    final problem = await menu.addDish(name: 'X', category: 'Snacks', price: 10, inStock: true);
    expect(problem, isNotNull);
    expect(menu.dishes.length, 2);
  });
}
