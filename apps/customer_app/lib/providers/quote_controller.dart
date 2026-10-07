import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/order_group.dart';
import '../services/order_api.dart';

enum QuoteStatus {
  /// Nothing to price (empty cart).
  idle,

  /// A request is waiting for the debounce or running: show the local estimate, marked as such.
  loading,

  /// [QuoteController.quote] is the server's price for the current cart.
  ready,

  /// No server price (see [QuoteController.error]): show the local estimate, marked as such.
  failed,
}

/// The checkout's price: `POST /orders/quote` for the current cart and coupon (Docs/22 4.1).
///
/// - Debounced (400 ms): a burst of cart / coupon changes sends one request.
/// - Race safe: every request carries a sequence number; an answer that is not about the latest
///   cart is dropped, also after [dispose]. (The HTTP client has no cancel; dropping is the cancel.)
/// - The same cart + coupon never asks twice (the quote endpoint is rate limited).
/// - It only ever fills in the bill: placing the order and the "Updated total" notice stay the
///   safety net, and the local estimate shows while there is no server price.
class QuoteController extends ChangeNotifier {
  QuoteController({required OrderApi api, this.debounce = const Duration(milliseconds: 400), this.onMaxRestaurants}) : _api = api;

  final OrderApi _api;
  final Duration debounce;

  /// Called with the server's `maxRestaurants` (the cart's restaurant limit), or 1 when the server
  /// has no quote / group endpoint (an old server: single-restaurant behaviour).
  final void Function(int max)? onMaxRestaurants;

  /// Codes after which a combined order cannot succeed until the cart changes.
  static const Set<String> blockingCodes = {'MULTI_DISABLED', 'TOO_MANY_RESTAURANTS', 'DUPLICATE_RESTAURANT', 'USE_SINGLE_ORDER'};

  QuoteStatus _status = QuoteStatus.idle;
  OrderQuote? _quote;
  OrderApiError? _error;
  QuoteRequest? _request;
  String? _key;
  Timer? _timer;
  int _seq = 0;
  bool _disposed = false;

  QuoteStatus get status => _status;
  bool get isLoading => _status == QuoteStatus.loading;
  OrderApiError? get error => _error;

  /// The server's price for the cart last passed to [request]; null while loading or failed.
  OrderQuote? get quote => _status == QuoteStatus.ready ? _quote : null;

  /// The server said this (old server) has no quote endpoint.
  bool get unsupported => _error?.kind == OrderErrorKind.notFound;

  /// The server's own explanation when it refused the cart (restaurant closed, coupon problem,
  /// too many restaurants...). Null for "no answer" cases (offline, timeout, server trouble,
  /// old server): those just show the estimate.
  String? get problem {
    final e = _error;
    if (e == null || _status != QuoteStatus.failed) return null;
    switch (e.kind) {
      case OrderErrorKind.rejected:
      case OrderErrorKind.conflict:
      case OrderErrorKind.rateLimited:
      case OrderErrorKind.forbidden:
        return orderErrorMessage(e, action: 'price your order');
      case OrderErrorKind.offline:
      case OrderErrorKind.timeout:
      case OrderErrorKind.unauthorized:
      case OrderErrorKind.notFound:
      case OrderErrorKind.server:
      case OrderErrorKind.badResponse:
        return null;
    }
  }

  /// The order cannot be placed with this cart (too many restaurants, feature off...).
  bool get blocksCheckout => _status == QuoteStatus.failed && blockingCodes.contains(_error?.code);

  /// Prices [request] (null = nothing to price). Safe to call on every rebuild: an unchanged cart
  /// is a no-op.
  void request(QuoteRequest? request) {
    if (_disposed) return;
    if (request == null || request.restaurants.isEmpty) {
      _timer?.cancel();
      _seq++;
      _request = null;
      _key = null;
      _quote = null;
      _error = null;
      if (_status != QuoteStatus.idle) {
        _status = QuoteStatus.idle;
        notifyListeners();
      }
      return;
    }
    if (request.key == _key) return;
    _start(request);
  }

  /// Asks again for the same cart (after a failure).
  void retry() {
    final r = _request;
    if (_disposed || r == null || _status == QuoteStatus.loading) return;
    _start(r);
  }

  void _start(QuoteRequest request) {
    _request = request;
    _key = request.key;
    _quote = null;
    _error = null;
    _status = QuoteStatus.loading;
    final seq = ++_seq;
    _timer?.cancel();
    _timer = Timer(debounce, () => unawaited(_run(request, seq)));
    notifyListeners();
  }

  Future<void> _run(QuoteRequest request, int seq) async {
    final r = await _api.quote(request);
    if (_disposed || seq != _seq) return; // the cart changed meanwhile: that answer is about an older cart
    final q = r.value;
    if (q != null) {
      _quote = q;
      _error = null;
      _status = QuoteStatus.ready;
      onMaxRestaurants?.call(q.maxRestaurants);
    } else {
      final e = r.error!;
      _quote = null;
      _error = e;
      _status = QuoteStatus.failed;
      if (e.kind == OrderErrorKind.notFound) {
        onMaxRestaurants?.call(1); // an old server knows no combined orders
      } else if (e.code == 'MULTI_DISABLED') {
        onMaxRestaurants?.call(1);
      } else if (e.code == 'TOO_MANY_RESTAURANTS' && e.maxRestaurants != null) {
        onMaxRestaurants?.call(e.maxRestaurants!);
      }
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
