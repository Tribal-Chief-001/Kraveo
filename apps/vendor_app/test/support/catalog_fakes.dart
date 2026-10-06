import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'fakes.dart';

/// A fake of the CURRENT server's catalog endpoints (Docs/21 section 4): a new dish is PENDING, a price on a live dish
/// becomes a pending request (the live price stays), a price on a pending dish edits it, a price on a rejected dish sends
/// it again, and the sold-out switch is refused for dishes that are not live. Orders and the rest come from [FakeBackend].
class CatalogBackend extends FakeBackend {
  CatalogBackend(List<DishModel> dishes) {
    menu = dishes;
  }

  /// Simulates "the admin approved / rejected it" between two reads.
  DishModel byId(String id) => menu.firstWhere((d) => d.id == id);

  /// What the server would send for a dish (menu-manage shape): `price` = the restaurant's price.
  static DishModel copyOf(DishModel d) => DishModel(
        id: d.id,
        name: d.name,
        category: d.category,
        price: d.price,
        inStock: d.inStock,
        status: d.status,
        pendingPrice: d.pendingPrice,
        rejectionReason: d.rejectionReason,
        statusKnown: true,
      );

  @override
  Future<ApiResult<List<DishModel>>> fetchMenu(String vendorId) async {
    calls.add('menu:$vendorId');
    if (menuFailure != null) return ApiResult.failure(menuFailure!);
    return ApiResult.success([for (final d in menu) copyOf(d)]);
  }

  @override
  Future<ApiResult<DishModel>> addDish(String vendorId, {required String name, required String category, required double price, bool isVeg = true}) async {
    calls.add('dish:add:$vendorId:$name:$price');
    lastIsVeg = isVeg;
    if (dishAnswer != null) return dishAnswer!;
    final d = DishModel(id: 'new-${menu.length}', name: name, category: category, price: price, status: DishStatus.pending, statusKnown: true);
    menu.add(d);
    return ApiResult.success(copyOf(d));
  }

  @override
  Future<ApiResult<DishModel>> updateDish(String itemId, {bool? isAvailable, double? price}) async {
    calls.add('dish:update:$itemId:${isAvailable ?? ''}:${price ?? ''}');
    if (dishAnswer != null) return dishAnswer!;
    final d = menu.where((x) => x.id == itemId).firstOrNull;
    if (d == null) return const ApiResult.failure(ApiFailure.notFound);
    if (isAvailable != null) {
      if (!d.isLive) return const ApiResult.failure(ApiFailure.invalid, message: 'Only live dishes can be marked sold out.');
      d.inStock = isAvailable;
    }
    if (price != null) {
      switch (d.status) {
        case DishStatus.pending:
          d.price = price;
        case DishStatus.rejected:
          d.price = price;
          d.status = DishStatus.pending;
          d.rejectionReason = null;
        case DishStatus.live || DishStatus.changePending:
          if (price == d.price) {
            d.pendingPrice = null;
            d.status = DishStatus.live;
          } else {
            d.pendingPrice = price;
            d.status = DishStatus.changePending;
          }
      }
    }
    return ApiResult.success(copyOf(d));
  }
}

/// Order JSON as the CURRENT server sends it to a restaurant: item prices are the restaurant's, `subtotal` and
/// `totalAmount` both equal what the restaurant earns, and no fee / discount / tax fields are present.
Map<String, dynamic> vendorOrderJson({String id = 'ord-v1', String status = 'ACCEPTED', double earned = 205, List<Map<String, dynamic>>? items}) {
  final j = orderJson(id: id, status: status, items: items);
  for (final key in const ['deliveryFee', 'taxAndPackaging', 'discount']) {
    j.remove(key);
  }
  j['subtotal'] = earned;
  j['totalAmount'] = earned;
  return j;
}
