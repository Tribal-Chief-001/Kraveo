import 'package:flutter/material.dart';
import '../models/menu_item.dart';
import '../models/cart_item.dart';
import '../models/customization.dart';

class CartProvider with ChangeNotifier {
  String? _dhabaId;
  String? _dhabaName;
  final List<CartItem> _items = [];

  String? _appliedCouponCode;
  double _couponDiscountAmount = 0.0;
  String? _couponError;

  // Kraveo Coins Rewards State
  int _userKraveoCoins = 80; // Default student coin balance
  bool _isKraveoCoinsRedeemed = false;
  double _kraveoCoinsDiscountAmount = 0.0;

  // Getters
  String? get dhabaId => _dhabaId;
  String? get dhabaName => _dhabaName;
  List<CartItem> get items => List.unmodifiable(_items);
  int get itemCount => _items.fold(0, (sum, item) => sum + item.quantity);

  String? get appliedCouponCode => _appliedCouponCode;
  double get couponDiscountAmount => _couponDiscountAmount;
  String? get couponError => _couponError;

  int get userKraveoCoins => _userKraveoCoins;
  bool get isKraveoCoinsRedeemed => _isKraveoCoinsRedeemed;
  double get kraveoCoinsDiscountAmount => _kraveoCoinsDiscountAmount;

  double get subtotal => _items.fold(0.0, (sum, item) => sum + item.totalPrice);

  double get deliveryFee => _items.isEmpty ? 0.0 : 25.0;
  double get taxAndPackaging => _items.isEmpty ? 0.0 : 15.0;

  double get grandTotal {
    if (_items.isEmpty) return 0.0;
    final total = subtotal + deliveryFee + taxAndPackaging - _couponDiscountAmount - _kraveoCoinsDiscountAmount;
    return total < 0 ? 0.0 : total;
  }

  void addItem({
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
  }

  void incrementItem(String cartItemId) {
    final index = _items.indexWhere((i) => i.cartItemId == cartItemId);
    if (index >= 0) {
      _items[index].quantity += 1;
      _recalculateDiscount();
      notifyListeners();
    }
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
    } else if (cleanCode == 'KRAVEO20') {
      if (subtotal < 80) {
        _appliedCouponCode = null;
        _couponDiscountAmount = 0.0;
        _couponError = 'Minimum subtotal of ₹80 required for KRAVEO20';
        notifyListeners();
        return false;
      }
      _appliedCouponCode = 'KRAVEO20';
      _couponDiscountAmount = 20.0;
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
      _couponError = 'Invalid code. Try "VITFIRST" or "KRAVEO20" for OFF!';
      notifyListeners();
      return false;
    }
  }

  void toggleKraveoCoinsRedemption() {
    if (_isKraveoCoinsRedeemed) {
      _isKraveoCoinsRedeemed = false;
      _kraveoCoinsDiscountAmount = 0.0;
    } else {
      if (_userKraveoCoins < 50) {
        _couponError = 'Need 50 Kraveo Coins to redeem Flat ₹20 OFF';
        notifyListeners();
        return;
      }
      _isKraveoCoinsRedeemed = true;
      _kraveoCoinsDiscountAmount = 20.0;
    }
    notifyListeners();
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

  void consumeRedeemedCoins() {
    if (_isKraveoCoinsRedeemed) {
      _userKraveoCoins = (_userKraveoCoins - 50).clamp(0, 999999);
      _isKraveoCoinsRedeemed = false;
      _kraveoCoinsDiscountAmount = 0.0;
      notifyListeners();
    }
  }

  void clearCart() {
    _dhabaId = null;
    _dhabaName = null;
    _items.clear();
    _appliedCouponCode = null;
    _couponDiscountAmount = 0.0;
    _kraveoCoinsDiscountAmount = 0.0;
    _isKraveoCoinsRedeemed = false;
    _couponError = null;
    notifyListeners();
  }


  int getItemQuantityInCart(String itemId) {
    return _items
        .where((ci) => ci.item.id == itemId)
        .fold(0, (sum, ci) => sum + ci.quantity);
  }
}
