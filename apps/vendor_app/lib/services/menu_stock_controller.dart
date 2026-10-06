import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/dish_model.dart';
import 'failure_messages.dart';
import 'vendor_backend.dart';

/// The Menu tab's data: the restaurant's real menu with each dish's approval status (`GET /vendors/:id/menu-manage`,
/// or `GET /menus/:vendorId` on an old server, where every dish is live). Stock switches (live dishes only) and
/// price changes show at once and roll back to the last value the server confirmed if saving fails.
///
/// Approval (Docs/21): a new dish is PENDING until Kraveo approves it; a new price on a LIVE dish is a request
/// (the dish stays live at the old price and shows the new one as "sent for approval"); a REJECTED dish can be sent
/// again. A restaurant only ever handles its own price.
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

  /// The dish fields last confirmed by the server (or loaded), to roll back to when saving fails.
  final Map<String, _Saved> _confirmed = {};
  final Map<String, bool> _confirmedStock = {};
  final Map<String, int> _stockSeq = {};
  final Map<String, int> _priceSeq = {};
  final Map<String, Timer> _priceTimers = {};
  bool _disposed = false;

  /// Set by [addDish] to the dish the server just created, so the screen can say "sent for approval".
  DishModel? lastAdded;

  /// Dishes waiting for Kraveo (new, or a price change).
  int get waitingCount => dishes.where((d) => d.status == DishStatus.pending || d.status == DishStatus.changePending).length;

  /// Dishes Kraveo did not approve.
  int get rejectedCount => dishes.where((d) => d.status == DishStatus.rejected).length;

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
        _confirmed[d.id] = _Saved.of(d);
      }
      loadedOnce = true;
    } else {
      loadFailure = res.failure; // keep whatever is on screen
    }
    _notify();
  }

  Future<void> toggleStock(DishModel d) async {
    if (!d.isLive) return; // a dish customers cannot see yet has no sold-out switch
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

  /// The owner set a new price (stepper or typed). A pending dish is simply edited; a live dish shows the new price
  /// as "sent for approval" and keeps the old one live; on an old server the price is applied at once. A rejected
  /// dish is changed through [resubmit] instead.
  void changePrice(DishModel d, double price) {
    if (price <= 0 || d.status == DishStatus.rejected) return;
    if (d.statusKnown && d.isLive) {
      if (price == d.price && d.pendingPrice == null) return; // nothing to ask for
      d.pendingPrice = price == d.price ? null : price;
      d.status = d.pendingPrice == null ? DishStatus.live : DishStatus.changePending;
    } else {
      d.price = price;
    }
    _notify();
    _priceTimers[d.id]?.cancel();
    _priceTimers[d.id] = Timer(priceDebounce, () => _sendPrice(d));
  }

  Future<void> _sendPrice(DishModel d) async {
    _priceTimers.remove(d.id);
    final want = d.editPrice;
    final seq = (_priceSeq[d.id] ?? 0) + 1;
    _priceSeq[d.id] = seq;
    final res = await backend.updateDish(d.id, price: want);
    if (_disposed) return;
    final saved = res.ok ? _savedFrom(d, res.data, want) : null;
    if (saved != null) _confirmed[d.id] = saved;
    if (seq != _priceSeq[d.id] || _priceTimers.containsKey(d.id)) return;
    if (saved != null) {
      saved.applyTo(d);
    } else {
      _confirmed[d.id]?.applyTo(d);
      onError?.call(failureText(res.failure!, serverMessage: res.message, code: res.code));
    }
    _notify();
  }

  /// A rejected dish is sent to Kraveo again, with [price] (the same price when the owner changed nothing).
  Future<void> resubmit(DishModel d, double price) async {
    if (d.status != DishStatus.rejected || price <= 0) return;
    final before = _Saved.of(d);
    d.price = price;
    d.status = DishStatus.pending;
    d.rejectionReason = null;
    _notify();
    final res = await backend.updateDish(d.id, price: price);
    if (_disposed) return;
    if (res.ok) {
      final saved = _savedFrom(d, res.data, price, sentAgain: true);
      _confirmed[d.id] = saved;
      saved.applyTo(d);
    } else {
      before.applyTo(d);
      onError?.call(failureText(res.failure!, serverMessage: res.message, code: res.code));
    }
    _notify();
  }

  /// What the server confirmed for a price request. A current server answers with the dish (status + pending price);
  /// without a readable answer we assume what we asked for happened (an approval-aware dish becomes "sent for
  /// approval"; on an old server the new price is simply live).
  _Saved _savedFrom(DishModel d, DishModel? answer, double want, {bool sentAgain = false}) {
    if (answer != null && answer.statusKnown) return _Saved.of(answer);
    if (!d.statusKnown) return _Saved(price: answer?.price ?? want, status: DishStatus.live);
    if (sentAgain || d.status == DishStatus.pending) return _Saved(price: want, status: DishStatus.pending);
    final live = _confirmed[d.id]?.price ?? d.price;
    return want == live ? _Saved(price: live, status: DishStatus.live) : _Saved(price: live, pending: want, status: DishStatus.changePending);
  }

  /// Creates a dish on the server. Returns null on success, or what went wrong.
  Future<FailureText?> addDish({required String name, required String category, required double price, required bool inStock, bool isVeg = true}) async {
    final res = await backend.addDish(vendorId, name: name, category: category, price: price, isVeg: isVeg);
    if (_disposed) return null;
    if (!res.ok) return failureText(res.failure!, serverMessage: res.message, code: res.code);
    final dish = res.data!;
    _confirmedStock[dish.id] = dish.inStock;
    _confirmed[dish.id] = _Saved.of(dish);
    dishes.add(dish);
    lastAdded = dish;
    _notify();
    if (!inStock && dish.inStock && dish.isLive) await toggleStock(dish);
    return null;
  }

  @override
  void dispose() {
    _disposed = true;
    // Do not lose a price the cook just set: send it now (the result is not shown any more).
    for (final entry in _priceTimers.entries) {
      entry.value.cancel();
      final d = dishes.where((x) => x.id == entry.key).firstOrNull;
      if (d != null && d.status != DishStatus.rejected) unawaited(backend.updateDish(d.id, price: d.editPrice));
    }
    _priceTimers.clear();
    super.dispose();
  }
}

/// The price-related fields of a dish as the server last confirmed them.
class _Saved {
  _Saved({required this.price, this.pending, required this.status, this.reason});

  factory _Saved.of(DishModel d) => _Saved(price: d.price, pending: d.pendingPrice, status: d.status, reason: d.rejectionReason);

  final double price;
  final double? pending;
  final DishStatus status;
  final String? reason;

  void applyTo(DishModel d) {
    d.price = price;
    d.pendingPrice = pending;
    d.status = status;
    d.rejectionReason = reason;
  }
}
