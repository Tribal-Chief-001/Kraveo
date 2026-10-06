import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/dish_model.dart';
import 'failure_messages.dart';
import 'vendor_backend.dart';

/// The Menu tab's data: the restaurant's real menu (`GET /menus/:vendorId`). Stock switches and price
/// changes show at once and roll back to the last value the server confirmed if saving fails.
class MenuStockController extends ChangeNotifier {
  MenuStockController({required this.backend, required this.vendorId, this.priceDebounce = const Duration(milliseconds: 700)});

  final VendorBackend backend;
  final String vendorId;

  /// Price steppers send one request after the cook stops tapping, not one per tap.
  final Duration priceDebounce;

  /// Set by the screen to show a snackbar when a change could not be saved.
  void Function(FailureText text)? onError;

  final List<DishModel> dishes = [];
  bool loading = false;
  bool loadedOnce = false;
  ApiFailure? loadFailure;

  final Map<String, bool> _confirmedStock = {};
  final Map<String, double> _confirmedPrice = {};
  final Map<String, int> _stockSeq = {};
  final Map<String, int> _priceSeq = {};
  final Map<String, Timer> _priceTimers = {};
  bool _disposed = false;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (loading || _disposed) return;
    loading = true;
    loadFailure = null;
    _notify();
    final res = await backend.fetchMenu(vendorId);
    if (_disposed) return;
    loading = false;
    if (res.ok) {
      dishes
        ..clear()
        ..addAll(res.data!);
      for (final d in dishes) {
        _confirmedStock[d.id] = d.inStock;
        _confirmedPrice[d.id] = d.price;
      }
      loadedOnce = true;
    } else {
      loadFailure = res.failure; // keep whatever is on screen
    }
    _notify();
  }

  Future<void> toggleStock(DishModel d) async {
    final want = !d.inStock;
    d.inStock = want;
    _notify();
    final seq = (_stockSeq[d.id] ?? 0) + 1;
    _stockSeq[d.id] = seq;
    final res = await backend.updateDish(d.id, isAvailable: want);
    if (_disposed) return;
    if (res.ok) _confirmedStock[d.id] = res.data?.inStock ?? want;
    if (seq != _stockSeq[d.id]) return; // a newer tap decides what is shown
    if (res.ok) {
      d.inStock = _confirmedStock[d.id]!;
    } else {
      d.inStock = _confirmedStock[d.id] ?? !want;
      onError?.call(failureText(res.failure!, serverMessage: res.message, code: res.code));
    }
    _notify();
  }

  void changePrice(DishModel d, double price) {
    if (price <= 0) return;
    d.price = price;
    _notify();
    _priceTimers[d.id]?.cancel();
    _priceTimers[d.id] = Timer(priceDebounce, () => _sendPrice(d));
  }

  Future<void> _sendPrice(DishModel d) async {
    _priceTimers.remove(d.id);
    final want = d.price;
    final seq = (_priceSeq[d.id] ?? 0) + 1;
    _priceSeq[d.id] = seq;
    final res = await backend.updateDish(d.id, price: want);
    if (_disposed) return;
    if (res.ok) _confirmedPrice[d.id] = res.data?.price ?? want;
    if (seq != _priceSeq[d.id] || _priceTimers.containsKey(d.id)) return;
    if (res.ok) {
      d.price = _confirmedPrice[d.id]!;
    } else {
      final back = _confirmedPrice[d.id];
      if (back != null) d.price = back;
      onError?.call(failureText(res.failure!, serverMessage: res.message, code: res.code));
    }
    _notify();
  }

  /// Creates a dish on the server. Returns null on success, or what went wrong.
  Future<FailureText?> addDish({required String name, required String category, required double price, required bool inStock, bool isVeg = true}) async {
    final res = await backend.addDish(vendorId, name: name, category: category, price: price, isVeg: isVeg);
    if (_disposed) return null;
    if (!res.ok) return failureText(res.failure!, serverMessage: res.message, code: res.code);
    final dish = res.data!;
    _confirmedStock[dish.id] = dish.inStock;
    _confirmedPrice[dish.id] = dish.price;
    dishes.add(dish);
    _notify();
    if (!inStock && dish.inStock) await toggleStock(dish);
    return null;
  }

  @override
  void dispose() {
    _disposed = true;
    // Do not lose a price the cook just set: send it now (the result is not shown any more).
    for (final entry in _priceTimers.entries) {
      entry.value.cancel();
      final d = dishes.where((x) => x.id == entry.key).firstOrNull;
      if (d != null) unawaited(backend.updateDish(d.id, price: d.price));
    }
    _priceTimers.clear();
    super.dispose();
  }
}
