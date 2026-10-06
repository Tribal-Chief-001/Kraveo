import 'package:flutter/material.dart';
import '../models/menu_item.dart';
import '../models/cart_item.dart';
import '../models/customization.dart';

class CartProvider with ChangeNotifier {
  /// The server refuses more than this many of one dish in an order (`MAX_ITEM_QUANTITY`).
  static const int maxQuantityPerDish = 20;

  /// Friendly text for the snackbar shown when a dish is already at [maxQuantityPerDish].
  static const String maxQuantityMessage = 'You can order at most 20 of one dish at a time.';

  String? _dhabaId;
  String? _dhabaName;
  final List<CartItem> _items = [];

  String? _appliedCouponCode;
  double _couponDiscountAmount = 0.0;
  String? _couponError;

  // Kraveo Coins balance (from the server). Coins are not redeemable on orders yet: POST /orders
  // has no coins field, so a local coin discount would show a total the server never charges.
  int _userKraveoCoins = 0;

  // Getters
  String? get dhabaId => _dhabaId;
  String? get dhabaName => _dhabaName;
  List<CartItem> get items => List.unmodifiable(_items);
  int get itemCount => _items.fold(0, (sum, item) => sum + item.quantity);

  String? get appliedCouponCode => _appliedCouponCode;
  double get couponDiscountAmount => _couponDiscountAmount;
  String? get couponError => _couponError;

  int get userKraveoCoins => _userKraveoCoins;

  double get subtotal => _items.fold(0.0, (sum, item) => sum + item.totalPrice);

  double get deliveryFee => _items.isEmpty ? 0.0 : 25.0;
  // Docs/21: delivery, GST, packaging and the restaurant charge are one all-in Rs 25 (deliveryFee), so there is no second fee line.
  double get taxAndPackaging => 0.0;

  /// Local estimate only (same formula as the server today). Checkout always shows and charges
  /// the server's totals from `POST /orders`.
  double get grandTotal {
    if (_items.isEmpty) return 0.0;
    final total = subtotal + deliveryFee + taxAndPackaging - _couponDiscountAmount;
    return total < 0 ? 0.0 : total;
  }

  /// True when one more of [itemId] fits under [maxQuantityPerDish] (all option variants of the
  /// dish count together, because the order sums them up).
  bool canAddMore(String itemId) => getItemQuantityInCart(itemId) < maxQuantityPerDish;

  /// Adds one of [item]. Returns false (and changes nothing) when the dish is already at
  /// [maxQuantityPerDish].
  bool addItem({
    required MenuItemModel item,
    required String dhabaId,
    required String dhabaName,
    List<CustomizationOption> selectedOptions = const [],
    String? specialInstructions,
  }) {
    // If cart is from another dhaba, reset to new dhaba
    if (_dhabaId != null && _dhabaId != dhabaId) {
      clearCart();
    }
    if (!canAddMore(item.id)) return false;
    _dhabaId = dhabaId;
    _dhabaName = dhabaName;

    // Check if identical item with exact same options & instructions exists
    final optionIds = selectedOptions.map((o) => o.id).toSet();
    final existingIndex = _items.indexWhere((ci) {
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
      if (_items.isEmpty) {
        clearCart();
      } else {
        _recalculateDiscount();
        notifyListeners();
      }
    }
  }

  void removeItem(String cartItemId) {
    _items.removeWhere((i) => i.cartItemId == cartItemId);
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
    _dhabaId = null;
    _dhabaName = null;
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
