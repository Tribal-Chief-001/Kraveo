import 'package:flutter/material.dart';
import '../models/menu_item.dart';
import '../models/cart_item.dart';
import '../models/customization.dart';
import '../models/order_group.dart';

/// The lines of one restaurant in the cart (Docs/22: a cart can hold several restaurants).
class CartRestaurant {
  const CartRestaurant({required this.id, required this.name, required this.items});

  final String id;
  final String name;
  final List<CartItem> items;

  double get subtotal => items.fold(0.0, (sum, i) => sum + i.totalPrice);
  int get itemCount => items.fold(0, (sum, i) => sum + i.quantity);
}

class CartProvider with ChangeNotifier {
  /// The server refuses more than this many of one dish in an order (`MAX_ITEM_QUANTITY`).
  static const int maxQuantityPerDish = 20;

  /// Friendly text for the snackbar shown when a dish is already at [maxQuantityPerDish].
  static const String maxQuantityMessage = 'You can order at most 20 of one dish at a time.';

  /// Shown instead of adding a dish when the cart already holds [maxRestaurants] other restaurants.
  String get maxRestaurantsMessage =>
      'You can order from at most $maxRestaurants restaurants at once. Remove one restaurant from your cart to add this one.';

  /// Restaurants in the order they were added: the first is the primary one (it carries the base
  /// fee, the coupon and the payment of a combined order).
  final List<String> _restaurantIds = [];
  final Map<String, String> _restaurantNames = {};
  final List<CartItem> _items = [];

  /// How many restaurants one order may hold (`maxRestaurants` of the last quote; 3 before the
  /// first quote answered). 1 means the feature is off: adding from another restaurant starts a
  /// new cart, as before.
  int _maxRestaurants = kDefaultMaxRestaurants;

  String? _appliedCouponCode;
  double _couponDiscountAmount = 0.0;
  String? _couponError;

  // Kraveo Coins balance (from the server). Coins are not redeemable on orders yet: POST /orders
  // has no coins field, so a local coin discount would show a total the server never charges.
  int _userKraveoCoins = 0;

  // Getters

  /// The primary (first-added) restaurant. Null for an empty cart.
  String? get dhabaId => _restaurantIds.isEmpty ? null : _restaurantIds.first;
  String? get dhabaName => _restaurantIds.isEmpty ? null : _restaurantNames[_restaurantIds.first];
  List<CartItem> get items => List.unmodifiable(_items);
  int get itemCount => _items.fold(0, (sum, item) => sum + item.quantity);

  int get maxRestaurants => _maxRestaurants;

  /// The cart's lines grouped by restaurant, in the order the restaurants were added.
  List<CartRestaurant> get restaurants => [
        for (final id in _restaurantIds)
          CartRestaurant(id: id, name: _restaurantNames[id] ?? '', items: List.unmodifiable(_items.where((i) => i.dhabaId == id))),
      ];
  int get restaurantCount => _restaurantIds.length;
  bool get isMultiRestaurant => _restaurantIds.length > 1;
  bool hasRestaurant(String id) => _restaurantIds.contains(id);

  /// The cart holds something from a restaurant other than [dhabaId].
  bool hasOtherRestaurant(String dhabaId) => _restaurantIds.any((r) => r != dhabaId);

  /// True when a dish of [dhabaId] can be added without replacing or refusing anything.
  bool canAddRestaurant(String dhabaId) => _restaurantIds.isEmpty || _restaurantIds.contains(dhabaId) || (_maxRestaurants > 1 && _restaurantIds.length < _maxRestaurants);

  /// Adding from [dhabaId] would replace the cart (the combined-order feature is off).
  bool wouldReplaceCart(String dhabaId) => _maxRestaurants <= 1 && hasOtherRestaurant(dhabaId);

  String? get appliedCouponCode => _appliedCouponCode;
  double get couponDiscountAmount => _couponDiscountAmount;
  String? get couponError => _couponError;

  int get userKraveoCoins => _userKraveoCoins;

  double get subtotal => _items.fold(0.0, (sum, item) => sum + item.totalPrice);

  /// Local estimate of the fees: the base fee plus the flat fee of every extra restaurant. The
  /// server's quote (`POST /orders/quote`) is the real number; this only fills in while it is
  /// loading or unavailable.
  double get baseDeliveryFee => _items.isEmpty ? 0.0 : kEstimateBaseFee;
  double get extraRestaurantFees => _restaurantIds.length <= 1 ? 0.0 : kEstimateExtraRestaurantFee * (_restaurantIds.length - 1);
  double get deliveryFee => baseDeliveryFee + extraRestaurantFees;
  // Docs/21: delivery, GST, packaging and the restaurant charge are one all-in Rs 25 (deliveryFee), so there is no second fee line.
  double get taxAndPackaging => 0.0;

  /// Local estimate only (same formula as the server today). Checkout shows the server's quote
  /// and always charges the server's totals.
  double get grandTotal {
    if (_items.isEmpty) return 0.0;
    final total = subtotal + deliveryFee + taxAndPackaging - _couponDiscountAmount;
    return total < 0 ? 0.0 : total;
  }

  /// True when one more of [itemId] fits under [maxQuantityPerDish] (all option variants of the
  /// dish count together, because the order sums them up).
  bool canAddMore(String itemId) => getItemQuantityInCart(itemId) < maxQuantityPerDish;

  /// Sets the restaurant limit from the server's quote. A cart that already holds more than the
  /// new limit is kept as it is (checkout tells the student what to remove).
  void setMaxRestaurants(int value) {
    final v = value < 1 ? 1 : value;
    if (v == _maxRestaurants) return;
    _maxRestaurants = v;
    notifyListeners();
  }

  /// Adds one of [item]. Returns false (and changes nothing) when the dish is already at
  /// [maxQuantityPerDish], or when the cart already holds [maxRestaurants] other restaurants
  /// (check [canAddRestaurant] first to tell the two apart). With [maxRestaurants] = 1 a dish of
  /// another restaurant replaces the cart: callers confirm first ([wouldReplaceCart]).
  bool addItem({
    required MenuItemModel item,
    required String dhabaId,
    required String dhabaName,
    List<CustomizationOption> selectedOptions = const [],
    String? specialInstructions,
  }) {
    if (wouldReplaceCart(dhabaId)) {
      clearCart();
    } else if (!canAddRestaurant(dhabaId)) {
      return false;
    }
    if (!canAddMore(item.id)) return false;
    if (!_restaurantIds.contains(dhabaId)) _restaurantIds.add(dhabaId);
    _restaurantNames[dhabaId] = dhabaName;

    // Check if identical item with exact same options & instructions exists
    final optionIds = selectedOptions.map((o) => o.id).toSet();
    final existingIndex = _items.indexWhere((ci) {
      if (ci.dhabaId != dhabaId) return false;
      if (ci.item.id != item.id) return false;
      if (ci.specialInstructions != specialInstructions) return false;
      final existingOptIds = ci.selectedOptions.map((o) => o.id).toSet();
      return optionIds.length == existingOptIds.length &&
          optionIds.containsAll(existingOptIds);
    });

    if (existingIndex >= 0) {
      _items[existingIndex].quantity += 1;
    } else {
      final cartItemId = '${item.id}_${DateTime.now().millisecondsSinceEpoch}';
      _items.add(
        CartItem(
          cartItemId: cartItemId,
          item: item,
          dhabaId: dhabaId,
          dhabaName: dhabaName,
          quantity: 1,
          selectedOptions: selectedOptions,
          specialInstructions: specialInstructions,
        ),
      );
    }

    _recalculateDiscount();
    notifyListeners();
    return true;
  }

  /// One more of a cart line. Returns false when its dish is already at [maxQuantityPerDish].
  bool incrementItem(String cartItemId) {
    final index = _items.indexWhere((i) => i.cartItemId == cartItemId);
    if (index < 0) return false;
    if (!canAddMore(_items[index].item.id)) return false;
    _items[index].quantity += 1;
    _recalculateDiscount();
    notifyListeners();
    return true;
  }

  void decrementItem(String cartItemId) {
    final index = _items.indexWhere((i) => i.cartItemId == cartItemId);
    if (index >= 0) {
      if (_items[index].quantity > 1) {
        _items[index].quantity -= 1;
      } else {
        _items.removeAt(index);
      }
      _afterRemoval();
    }
  }

  void removeItem(String cartItemId) {
    _items.removeWhere((i) => i.cartItemId == cartItemId);
    _afterRemoval();
  }

  /// Removes every line of one restaurant (the other restaurants stay).
  void removeRestaurant(String dhabaId) {
    _items.removeWhere((i) => i.dhabaId == dhabaId);
    _afterRemoval();
  }

  /// Forgets restaurants that no longer have a line; empties everything when nothing is left.
  void _afterRemoval() {
    _restaurantIds.removeWhere((id) => !_items.any((i) => i.dhabaId == id));
    _restaurantNames.removeWhere((id, _) => !_restaurantIds.contains(id));
    if (_items.isEmpty) {
      clearCart();
    } else {
      _recalculateDiscount();
      notifyListeners();
    }
  }

  bool applyCoupon(String code) {
    _couponError = null;
    final cleanCode = code.trim().toUpperCase();

    if (cleanCode.isEmpty) {
      _appliedCouponCode = null;
      _couponDiscountAmount = 0.0;
      _couponError = 'Please enter a coupon code';
      notifyListeners();
      return false;
    }

    if (cleanCode == 'VITFIRST') {
      if (subtotal < 100) {
        _appliedCouponCode = null;
        _couponDiscountAmount = 0.0;
        _couponError = 'Minimum subtotal of ₹100 required for VITFIRST';
        notifyListeners();
        return false;
      }
      _appliedCouponCode = 'VITFIRST';
      // 20% off up to max ₹50
      _couponDiscountAmount = (subtotal * 0.20).clamp(0.0, 50.0);
      notifyListeners();
      return true;
    } else if (cleanCode == 'KRAVEO50') {
      if (subtotal < 150) {
        _appliedCouponCode = null;
        _couponDiscountAmount = 0.0;
        _couponError = 'Minimum subtotal of ₹150 required for KRAVEO50';
        notifyListeners();
        return false;
      }
      _appliedCouponCode = 'KRAVEO50';
      _couponDiscountAmount = 50.0;
      notifyListeners();
      return true;
    } else {
      _appliedCouponCode = null;
      _couponDiscountAmount = 0.0;
      _couponError = 'That code isn\'t valid.';
      notifyListeners();
      return false;
    }
  }

  /// Seeds the balance from the backend when a student signs in.
  void setKraveoCoins(int coins) {
    _userKraveoCoins = coins < 0 ? 0 : coins;
    notifyListeners();
  }

  /// Wipes everything tied to the previous student (cart, coupon, coins) on logout.
  void resetForLogout() {
    _userKraveoCoins = 0;
    clearCart();
  }

  void addKraveoCoins(int coins) {
    _userKraveoCoins += coins;
    notifyListeners();
  }

  void removeCoupon() {
    _appliedCouponCode = null;
    _couponDiscountAmount = 0.0;
    _couponError = null;
    notifyListeners();
  }

  void _recalculateDiscount() {
    if (_appliedCouponCode != null) {
      applyCoupon(_appliedCouponCode!);
    }
  }

  void clearCart() {
    _restaurantIds.clear();
    _restaurantNames.clear();
    _items.clear();
    _appliedCouponCode = null;
    _couponDiscountAmount = 0.0;
    _couponError = null;
    notifyListeners();
  }


  int getItemQuantityInCart(String itemId) {
    return _items
        .where((ci) => ci.item.id == itemId)
        .fold(0, (sum, ci) => sum + ci.quantity);
  }
}
