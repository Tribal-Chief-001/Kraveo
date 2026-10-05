import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/order.dart';
import '../services/customer_api_service.dart';
import '../services/order_api.dart';
import '../services/order_realtime.dart';
import '../services/payment_gateway.dart';
import 'cart_provider.dart';

/// What the student is about to order, as checkout sends it to `POST /orders`.
class CheckoutDraft {
  CheckoutDraft({
    required this.vendorId,
    required List<({String itemId, int quantity})> items,
    required this.dropoffHostel,
    required this.dropoffNotes,
    this.couponCode,
  }) : items = _aggregate(items);

  /// Builds the draft from the cart. Quantities of the same dish are summed: the server prices
  /// and stores dishes, not the app's local option variants.
  factory CheckoutDraft.fromCart(CartProvider cart, {required String dropoffHostel, required String dropoffNotes}) => CheckoutDraft(
        vendorId: cart.dhabaId ?? '',
        items: [for (final i in cart.items) (itemId: i.item.id, quantity: i.quantity)],
        dropoffHostel: dropoffHostel,
        dropoffNotes: dropoffNotes,
        couponCode: cart.appliedCouponCode,
      );

  final String vendorId;
  final List<({String itemId, int quantity})> items;
  final String dropoffHostel;
  final String dropoffNotes;
  final String? couponCode;

  static List<({String itemId, int quantity})> _aggregate(List<({String itemId, int quantity})> raw) {
    final totals = <String, int>{};
    for (final i in raw) {
      totals[i.itemId] = (totals[i.itemId] ?? 0) + i.quantity;
    }
    final ids = totals.keys.toList()..sort();
    return [for (final id in ids) (itemId: id, quantity: totals[id]!)];
  }

  /// Identifies "the same cart": a repeat checkout of an unchanged cart reuses the same
  /// idempotency key (and therefore the same server order).
  String get cartKey => [vendorId, for (final i in items) '${i.itemId}x${i.quantity}', (couponCode ?? '').toUpperCase()].join('|');
}

class _CheckoutAttempt {
  _CheckoutAttempt(this.cartKey, this.clientRequestId, this.dropoffHostel);
  final String cartKey;
  final String clientRequestId;

  /// The drop point this attempt was sent with. A request that has not produced an order yet
  /// must not be retried with the same idempotency key for a different point.
  final String dropoffHostel;
  String? orderId;
}

enum PaymentOutcomeKind {
  /// The server confirmed the payment.
  paid,

  /// Razorpay reported success but the server has not confirmed it yet (network trouble while
  /// verifying). The webhook will settle it; the app keeps polling. Never ask to pay again here.
  confirming,

  /// The student closed the payment sheet.
  cancelled,

  /// The payment (or starting it) failed; [PaymentOutcome.message] says why.
  failed,

  /// The order can no longer be paid (cancelled/expired); a new order is needed.
  orderClosed,
}

class PaymentOutcome {
  const PaymentOutcome(this.kind, {this.message, this.order});
  final PaymentOutcomeKind kind;
  final String? message;
  final OrderModel? order;
}

/// The single source of truth for the student's orders. Talks only to the real API
/// ([OrderApi]) and the order socket ([OrderRealtime]); there is no local order data.
///
/// - Active orders: `GET /orders?scope=active` on sign-in, app resume and pull-to-refresh.
/// - History: `GET /orders?scope=history`, paginated.
/// - A visible order is [watch]ed: polled every 15 s and joined on the socket; every copy is
///   merged by `updatedAt` so a late REST answer never overwrites a newer socket event.
/// - Checkout: [placeOrder] with a per-attempt `clientRequestId`, then [payForOrder] on the
///   same order as many times as needed.
class OrderProvider with ChangeNotifier {
  OrderProvider({
    OrderApi? api,
    OrderRealtime Function()? realtimeFactory,
    PaymentGateway? gateway,
    Future<String?> Function()? tokenProvider,
    DateTime Function()? clock,
    this.pollInterval = const Duration(seconds: 15),
    this.paymentSheetTimeout = const Duration(minutes: 10),
  })  : _api = api ?? const HttpOrderApi(),
        _realtimeFactory = realtimeFactory ?? SocketOrderRealtime.new,
        _gateway = gateway,
        _tokenProvider = tokenProvider ?? CustomerApiService.getSavedToken,
        _clock = clock ?? DateTime.now;

  final OrderApi _api;
  final OrderRealtime Function() _realtimeFactory;
  PaymentGateway? _gateway;
  final Future<String?> Function() _tokenProvider;
  final DateTime Function() _clock;
  final Duration pollInterval;
  final Duration paymentSheetTimeout;

  /// How long after a Razorpay success the app shows "confirming" instead of offering to pay
  /// again (so a slow confirmation never leads to a double payment).
  static const Duration confirmingWindow = Duration(minutes: 3);

  /// The server's `active` scope keeps finished orders for 10 minutes; the app does the same
  /// (with slack) so an older backend that ignores `scope` cannot resurrect old orders.
  static const Duration recentlyFinished = Duration(minutes: 12);

  static const int pageSize = 20;

  // ---- state ---------------------------------------------------------------------------------

  /// Bumped on logout/account switch: answers to requests from an older session are dropped.
  int _generation = 0;
  String? _userId;

  final Map<String, OrderModel> _orders = {};
  List<String> _activeIds = const [];
  List<String> _historyIds = const [];
  final Map<String, DateTime> _locallyAddedAt = {};
  final Map<String, RiderLocation> _riderLocations = {};

  /// One notifier per order so a rider fix repaints only the map that listens to it, not every
  /// screen that listens to this provider (fixes arrive every few seconds).
  final Map<String, ValueNotifier<RiderLocation?>> _riderNotifiers = {};
  final Set<String> _reviewed = {};
  final Map<String, DateTime> _paymentSubmittedAt = {};

  bool _activeLoading = false;
  bool _activeLoaded = false;
  OrderApiError? _activeError;
  Future<void>? _activeFuture;

  bool _historyLoading = false;
  bool _historyLoaded = false;
  String? _historyCursor;
  bool _historyHasMore = false;
  OrderApiError? _historyError;
  Future<void>? _historyFuture;

  _CheckoutAttempt? _attempt;
  Future<OrderResult<OrderModel>>? _placing;
  final Map<String, Future<PaymentOutcome>> _paying = {};
  final Set<String> _cancelling = {};
  final Map<String, Future<OrderModel?>> _refreshing = {};

  final Map<String, int> _watchers = {};
  Timer? _pollTimer;
  bool _pollInFlight = false;

  OrderRealtime? _realtime;
  bool _connecting = false;
  final Set<String> _joined = {};

  bool _disposed = false;

  // ---- reads ---------------------------------------------------------------------------------

  String? get userId => _userId;

  OrderModel? orderById(String id) => _orders[id];

  /// Orders in progress (newest first) followed by ones that finished in the last few minutes.
  List<OrderModel> get activeOrders {
    final list = _activeIds.map((id) => _orders[id]).whereType<OrderModel>().where(_isActiveNow).toList();
    list.sort((a, b) {
      if (a.isLive != b.isLive) return a.isLive ? -1 : 1;
      return b.createdAt.compareTo(a.createdAt);
    });
    return list;
  }

  /// Orders that are not delivered or cancelled yet.
  List<OrderModel> get liveOrders => activeOrders.where((o) => o.isLive).toList();

  /// The order the Track tab and the Home bar show: the newest live one, else the most recently
  /// finished one (so the final state is visible for a while), else null.
  OrderModel? get currentOrder {
    final list = activeOrders;
    return list.isEmpty ? null : list.first;
  }

  /// The newest live order, or null. (Home bar, profile.)
  OrderModel? get activeOrder {
    final live = liveOrders;
    return live.isEmpty ? null : live.first;
  }

  List<OrderModel> get history => _historyIds.map((id) => _orders[id]).whereType<OrderModel>().toList();

  /// Alias kept for screens/tests written against the previous API.
  List<OrderModel> get orderHistory => history;

  bool get isLoadingActive => _activeLoading;
  bool get hasLoadedActive => _activeLoaded;
  OrderApiError? get activeError => _activeError;

  bool get isLoadingHistory => _historyLoading && _historyCursor == null;
  bool get isLoadingMoreHistory => _historyLoading && _historyCursor != null;
  bool get hasLoadedHistory => _historyLoaded;
  bool get historyHasMore => _historyHasMore;
  OrderApiError? get historyError => _historyError;

  bool get isPlacingOrder => _placing != null;
  bool isPaying(String orderId) => _paying.containsKey(orderId);
  bool isCancelling(String orderId) => _cancelling.contains(orderId);
  bool hasReviewed(String orderId) => _reviewed.contains(orderId) || (_orders[orderId]?.isReviewed ?? false);
  RiderLocation? riderLocation(String orderId) => _riderLocations[orderId];

  /// The latest rider fix for [orderId] as a listenable. Changes do NOT notify this provider's
  /// listeners (see [riderLocation] for a plain read).
  ValueListenable<RiderLocation?> riderLocationListenable(String orderId) => _riderNotifiers.putIfAbsent(orderId, () => ValueNotifier<RiderLocation?>(_riderLocations[orderId]));

  void _setRider(String orderId, RiderLocation? loc) {
    if (loc == null) {
      _riderLocations.remove(orderId);
    } else {
      _riderLocations[orderId] = loc;
    }
    _riderNotifiers[orderId]?.value = loc;
  }

  /// Razorpay said "paid" recently and the server has not confirmed yet.
  bool isConfirmingPayment(String orderId) {
    final at = _paymentSubmittedAt[orderId];
    final order = _orders[orderId];
    if (at == null || order == null || !order.awaitsPayment) return false;
    return _clock().difference(at) < confirmingWindow;
  }

  /// True when a payment was reported by Razorpay but never confirmed within the window.
  bool paymentUnconfirmed(String orderId) {
    final at = _paymentSubmittedAt[orderId];
    final order = _orders[orderId];
    return at != null && order != null && order.awaitsPayment && !isConfirmingPayment(orderId);
  }

  /// The unpaid order this cart already created (back-navigation into checkout shows it again
  /// instead of creating a second order), or null.
  OrderModel? openCheckoutOrder(CheckoutDraft draft) {
    final a = _attempt;
    if (a == null || a.orderId == null || a.cartKey != draft.cartKey) return null;
    final order = _orders[a.orderId];
    return order != null && order.isLive ? order : null;
  }

  bool _isActiveNow(OrderModel o) => o.isLive || _clock().toUtc().difference(o.updatedAt) <= recentlyFinished;

  // ---- session -------------------------------------------------------------------------------

  /// Called when a student is signed in: restores their active order(s) and the first page of
  /// history from the server. A different user wipes everything from the previous one first.
  void beginSession(String userId) {
    if (_userId != userId) {
      _reset();
      _userId = userId;
    }
    unawaited(refreshActive());
    unawaited(loadHistory(refresh: true));
  }

  /// Forgets everything (logout, account deletion, session expiry, account switch).
  /// [notify] false only drops the data (safe to call mid-build); listeners refresh later.
  void resetForLogout({bool notify = true}) {
    _reset();
    _userId = null;
    if (notify) _notify();
  }

  void _reset() {
    _generation++;
    _pollTimer?.cancel();
    _pollTimer = null;
    _pollInFlight = false;
    _realtime?.dispose();
    _realtime = null;
    _connecting = false;
    _joined.clear();
    _watchers.clear();
    _orders.clear();
    _activeIds = const [];
    _historyIds = const [];
    _locallyAddedAt.clear();
    _riderLocations.clear();
    _riderNotifiers.clear(); // (not reset in place: this may run mid-build)
    _reviewed.clear();
    _paymentSubmittedAt.clear();
    _activeLoading = false;
    _activeLoaded = false;
    _activeError = null;
    _activeFuture = null;
    _historyLoading = false;
    _historyLoaded = false;
    _historyCursor = null;
    _historyHasMore = false;
    _historyError = null;
    _historyFuture = null;
    _attempt = null;
    _placing = null;
    _paying.clear();
    _cancelling.clear();
    _refreshing.clear();
  }

  /// App came back to the foreground: catch up on anything missed while in the background.
  void onAppResumed() {
    if (_userId == null) return;
    unawaited(refreshActive());
    for (final id in _watchers.keys.toList()) {
      unawaited(refreshOrder(id));
    }
    unawaited(_syncRealtime());
  }

  // ---- loading -------------------------------------------------------------------------------

  /// `GET /orders?scope=active`. Concurrent calls share one request.
  Future<void> refreshActive() => _activeFuture ??= _refreshActive().whenComplete(() => _activeFuture = null);

  Future<void> _refreshActive() async {
    final gen = _generation;
    final startedAt = _clock();
    _activeLoading = true;
    _notify();
    final r = await _api.fetchOrders(scope: 'active', limit: pageSize);
    if (gen != _generation) return;
    _activeLoading = false;
    final page = r.value;
    if (page != null) {
      final ids = <String>[];
      for (final o in page.orders) {
        final kept = _merge(o);
        if (_isActiveNow(kept) && !ids.contains(kept.id)) ids.add(kept.id);
      }
      // Keep orders this device created/learned about after the request left (a POST /orders
      // that finished while this list was in flight must not vanish).
      for (final id in _activeIds) {
        final added = _locallyAddedAt[id];
        final o = _orders[id];
        if (!ids.contains(id) && o != null && o.isLive && added != null && !added.isBefore(startedAt)) ids.add(id);
      }
      _activeIds = ids;
      _activeLoaded = true;
      _activeError = null;
    } else {
      _activeError = r.error;
    }
    _notify();
    unawaited(_syncRealtime());
  }

  /// `GET /orders?scope=history`. [refresh] starts again from the first page.
  Future<void> loadHistory({bool refresh = false}) {
    if (_historyFuture != null) return _historyFuture!;
    if (!refresh && _historyLoaded && !_historyHasMore) return Future.value();
    return _historyFuture = _loadHistory(refresh || !_historyLoaded).whenComplete(() => _historyFuture = null);
  }

  Future<void> loadMoreHistory() => _historyHasMore ? loadHistory() : Future.value();

  Future<void> _loadHistory(bool fromStart) async {
    final gen = _generation;
    if (fromStart) _historyCursor = null;
    final cursor = _historyCursor;
    _historyLoading = true;
    _notify();
    final r = await _api.fetchOrders(scope: 'history', limit: pageSize, cursor: cursor);
    if (gen != _generation) return;
    _historyLoading = false;
    final page = r.value;
    if (page != null) {
      final ids = fromStart ? <String>[] : [..._historyIds];
      for (final o in page.orders) {
        final kept = _merge(o);
        if (!ids.contains(kept.id)) ids.add(kept.id);
      }
      _historyIds = ids;
      _historyCursor = page.nextCursor;
      _historyHasMore = page.nextCursor != null;
      _historyLoaded = true;
      _historyError = null;
    } else {
      _historyError = r.error;
    }
    _notify();
  }

  /// `GET /orders/:id`, merged by `updatedAt`. Returns the freshest copy (or null on failure).
  Future<OrderModel?> refreshOrder(String orderId) => _refreshing[orderId] ??= _refreshOrder(orderId).whenComplete(() {
        // Block body: returning the removed Future here would make whenComplete wait on itself.
        _refreshing.remove(orderId);
      });

  Future<OrderModel?> _refreshOrder(String orderId) async {
    final gen = _generation;
    final r = await _api.fetchOrder(orderId);
    if (gen != _generation) return null;
    final o = r.value;
    if (o == null) return _orders[orderId];
    _ingest(o);
    return _orders[orderId];
  }

  // ---- merging -------------------------------------------------------------------------------

  /// Stores [o] if it is newer than what we have; returns the copy that is kept.
  OrderModel _merge(OrderModel o) {
    final current = _orders[o.id];
    if (current != null && !o.isNewerThan(current)) return current;
    _orders[o.id] = o;
    if (o.isPaid || o.isTerminal) _paymentSubmittedAt.remove(o.id);
    if (o.isTerminal) _setRider(o.id, null);
    return o;
  }

  /// Merges [o] and places it in the right lists. Returns true when something changed.
  bool _ingest(OrderModel o) {
    final before = _orders[o.id];
    final kept = _merge(o);
    var changed = !identical(before, kept);
    if (kept.isLive && !_activeIds.contains(kept.id)) {
      _activeIds = [kept.id, ..._activeIds];
      _locallyAddedAt[kept.id] = _clock();
      changed = true;
    }
    if (kept.isTerminal && _historyLoaded && !_historyIds.contains(kept.id)) {
      final ids = [..._historyIds, kept.id];
      ids.sort((a, b) => (_orders[b]?.createdAt ?? DateTime(0)).compareTo(_orders[a]?.createdAt ?? DateTime(0)));
      _historyIds = ids;
      changed = true;
    }
    if (changed) {
      _notify();
      if (kept.isTerminal) _ensurePolling();
      unawaited(_syncRealtime());
    }
    return changed;
  }

  // ---- checkout ------------------------------------------------------------------------------

  /// `POST /orders` with this checkout attempt's idempotency key. While the cart is unchanged
  /// the same key is reused (retries after a timeout return the same order, never a duplicate)
  /// and an existing unpaid order is returned without another request. A second call while one
  /// is in flight returns the same future (double taps are harmless).
  Future<OrderResult<OrderModel>> placeOrder(CheckoutDraft draft) => _placing ??= _placeOrder(draft).whenComplete(() {
        _placing = null;
        _notify();
      });

  Future<OrderResult<OrderModel>> _placeOrder(CheckoutDraft draft) async {
    var attempt = _attempt;
    if (attempt != null && attempt.cartKey == draft.cartKey && attempt.orderId != null) {
      final existing = _orders[attempt.orderId];
      if (existing != null && existing.isLive) return OrderResult.ok(existing);
      attempt = null; // that order is finished (expired / cancelled): a new order needs a new key
    }
    if (attempt != null && attempt.orderId == null && attempt.dropoffHostel != draft.dropoffHostel) {
      attempt = null; // no order exists yet and the drop point changed: a new key for the new point
    }
    if (attempt == null || attempt.cartKey != draft.cartKey) {
      attempt = _CheckoutAttempt(draft.cartKey, newClientRequestId(), draft.dropoffHostel);
    }
    _attempt = attempt;
    final gen = _generation;
    _notify();
    final r = await _api.createOrder(CreateOrderRequest(
      vendorId: draft.vendorId,
      items: draft.items,
      dropoffHostel: draft.dropoffHostel,
      dropoffNotes: draft.dropoffNotes,
      couponCode: draft.couponCode,
      clientRequestId: attempt.clientRequestId,
    ));
    if (gen != _generation) return const OrderResult.fail(OrderApiError(OrderErrorKind.unauthorized));
    final order = r.value;
    if (order != null) {
      attempt.orderId = order.id;
      _ingest(order);
      return OrderResult.ok(_orders[order.id] ?? order);
    }
    return r;
  }

  /// Forget the checkout attempt (after a successful payment, or when the student cancels the
  /// unpaid order). The next checkout gets a fresh idempotency key.
  void clearCheckout() => _attempt = null;

  /// Starts (or retries) payment for an existing order: `create-order` -> Razorpay ->
  /// `verify-signature`. Always the same order; never creates a new one. Calls for an order that
  /// is already being paid return the in-flight attempt.
  Future<PaymentOutcome> payForOrder(String orderId, {String? contact}) {
    final inFlight = _paying[orderId];
    if (inFlight != null) return inFlight;
    final f = _pay(orderId, contact).whenComplete(() {
      _paying.remove(orderId);
      _notify();
    });
    _paying[orderId] = f;
    _notify();
    return f;
  }

  Future<PaymentOutcome> _pay(String orderId, String? contact) async {
    final gen = _generation;
    final session = await _api.createPayment(orderId);
    if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);
    if (session.value == null) {
      final error = session.error!;
      if (error.order != null) _ingest(error.order!);
      if (error.code == 'PAYMENT_WINDOW_EXPIRED' || error.code == 'ORDER_CLOSED') {
        // The server will not take money for this order any more (the expiry job may not have
        // cancelled it yet): the next checkout must create a new order.
        if (_attempt?.orderId == orderId) _attempt = null;
        unawaited(refreshOrder(orderId));
        return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: _orders[orderId], message: orderErrorMessage(error));
      }
      if (!error.isNetwork && error.kind != OrderErrorKind.server && error.kind != OrderErrorKind.unauthorized) {
        // Refused: maybe it was paid meanwhile (webhook, `ALREADY_PAID`) or it expired. Ask the server.
        final fresh = await refreshOrder(orderId);
        if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);
        if (fresh != null && fresh.isPaid) return PaymentOutcome(PaymentOutcomeKind.paid, order: fresh);
        if (fresh != null && fresh.isTerminal) return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: fresh, message: _closedMessage(fresh));
      }
      return PaymentOutcome(PaymentOutcomeKind.failed, message: orderErrorMessage(error, action: 'start the payment'));
    }

    final order = _orders[orderId];
    if (order != null && session.value!.amountPaise != order.totalPaise) {
      // The gateway would charge something other than the total we show: re-read the order
      // and refuse to open the sheet until both agree.
      final fresh = await refreshOrder(orderId);
      if (fresh == null || session.value!.amountPaise != fresh.totalPaise) {
        return const PaymentOutcome(PaymentOutcomeKind.failed, message: 'The amount to pay changed. Please check the updated bill and try again.');
      }
    }

    final GatewayResult g;
    try {
      g = await (_gateway ??= RazorpayPaymentGateway()).pay(session.value!, contact: contact).timeout(paymentSheetTimeout);
    } on TimeoutException {
      unawaited(refreshOrder(orderId));
      return const PaymentOutcome(PaymentOutcomeKind.failed, message: 'The payment window did not answer. If money was debited, it will show up on this order shortly; otherwise try again.');
    }
    if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);

    switch (g.kind) {
      case GatewayResultKind.cancelled:
        return const PaymentOutcome(PaymentOutcomeKind.cancelled, message: 'Payment not completed. Your order is saved: you can try again.');
      case GatewayResultKind.externalWallet:
        return const PaymentOutcome(PaymentOutcomeKind.failed, message: 'That wallet is not supported here. Please pay with UPI or a card.');
      case GatewayResultKind.failed:
        return PaymentOutcome(
          PaymentOutcomeKind.failed,
          message: g.networkProblem ? 'The payment could not reach the bank. Check your connection and try again.' : 'The payment did not go through. You can try again.',
        );
      case GatewayResultKind.success:
        break;
    }

    _paymentSubmittedAt[orderId] = _clock();
    _notify();
    final v = await _api.verifyPayment(g.proof!);
    if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);
    if (v.value != null) _ingest(v.value!);
    final verifyError = v.error;
    if (verifyError?.order != null) _ingest(verifyError!.order!);
    switch (verifyError?.code) {
      case 'ORDER_CANCELLED':
        // Paid after the order was cancelled/expired: the server refunds it automatically.
        _paymentSubmittedAt.remove(orderId);
        if (_attempt?.orderId == orderId) _attempt = null;
        unawaited(refreshOrder(orderId));
        return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: _orders[orderId], message: orderErrorMessage(verifyError!));
      case 'DUPLICATE_PAYMENT':
        unawaited(refreshOrder(orderId));
        return PaymentOutcome(PaymentOutcomeKind.paid, order: _orders[orderId], message: orderErrorMessage(verifyError!));
      case 'PAYMENT_AMOUNT_MISMATCH':
        // Not marked paid and support has to sort out the money: never ask to "confirm" forever.
        _paymentSubmittedAt.remove(orderId);
        _notify();
        return PaymentOutcome(PaymentOutcomeKind.failed, order: _orders[orderId], message: orderErrorMessage(verifyError!));
    }
    final fresh = await refreshOrder(orderId);
    if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);
    final latest = fresh ?? _orders[orderId];
    if (latest != null && latest.isPaid) return PaymentOutcome(PaymentOutcomeKind.paid, order: latest);
    if (v.ok) {
      // The server accepted the signature but the order is still unpaid on its side: it answers
      // PENDING_CONFIRMATION while Razorpay has not confirmed the capture yet (the webhook or the
      // server's own reconciliation finishes it). Keep the "confirming" state; polling/socket flips it.
      return PaymentOutcome(PaymentOutcomeKind.confirming, order: latest, message: 'Payment received. Waiting for the bank to confirm it; this can take a minute.');
    }
    if (latest != null && latest.isTerminal) return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: latest, message: _closedMessage(latest));
    // Razorpay took the payment but the server has not confirmed it (network, or a signature
    // problem the webhook may still resolve). Show "confirming" and never offer to pay again.
    return PaymentOutcome(PaymentOutcomeKind.confirming, order: latest, message: 'Payment received. We\'re confirming it with Kraveo; this can take a minute.');
  }

  static String _closedMessage(OrderModel o) => o.isPaymentNotCompletedCancel
      ? 'This order expired because payment was not completed in 15 minutes. Please place it again.'
      : 'This order was cancelled, so it can\'t be paid. Please place a new order.';

  // ---- actions on an order -------------------------------------------------------------------

  /// `POST /orders/:id/cancel` (only while PLACED). On a conflict the latest copy is loaded so
  /// the screen shows why.
  Future<OrderResult<OrderModel>> cancelOrder(String orderId, {String? reason}) async {
    if (_cancelling.contains(orderId)) return const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, message: 'Already cancelling this order.'));
    final gen = _generation;
    _cancelling.add(orderId);
    _notify();
    final r = await _api.cancelOrder(orderId, reason: reason);
    if (gen != _generation) return r;
    _cancelling.remove(orderId);
    if (r.value != null) {
      _ingest(r.value!);
      if (_attempt?.orderId == orderId) _attempt = null;
    } else if (!r.error!.isNetwork) {
      unawaited(refreshOrder(orderId));
    }
    _notify();
    return r;
  }

  /// `POST /reviews` for a delivered order. Coins are only credited when the server says so.
  Future<OrderResult<ReviewReceipt>> submitReview(ReviewRequest request) async {
    final gen = _generation;
    final r = await _api.submitReview(request);
    if (gen != _generation) return r;
    final alreadyReviewed = r.error?.kind == OrderErrorKind.rejected && (r.error?.message ?? '').toLowerCase().contains('already');
    if (r.ok || alreadyReviewed) {
      _reviewed.add(request.orderId);
      _notify();
    }
    return r;
  }

  // ---- watching (tracking screen visible) ----------------------------------------------------

  /// The tracking screen is showing [orderId]: load it now, poll every [pollInterval] while it
  /// is live, and listen on the socket. Balanced by [unwatch].
  void watch(String orderId) {
    _watchers[orderId] = (_watchers[orderId] ?? 0) + 1;
    unawaited(refreshOrder(orderId));
    _ensurePolling();
    unawaited(_syncRealtime());
  }

  void unwatch(String orderId) {
    final n = (_watchers[orderId] ?? 0) - 1;
    if (n <= 0) {
      _watchers.remove(orderId);
    } else {
      _watchers[orderId] = n;
    }
    _ensurePolling();
    unawaited(_syncRealtime());
  }

  bool get isPolling => _pollTimer != null;

  /// Whether a tracking screen is currently showing [orderId] (used to avoid a duplicate push banner).
  bool isWatching(String orderId) => _watchers.containsKey(orderId);

  Iterable<String> get _pollIds => _watchers.keys.where((id) => _orders[id]?.isTerminal != true);

  void _ensurePolling() {
    if (_pollIds.isEmpty) {
      _pollTimer?.cancel();
      _pollTimer = null;
    } else {
      _pollTimer ??= Timer.periodic(pollInterval, (_) => pollOnce());
    }
  }

  /// One polling round (also run by the timer).
  @visibleForTesting
  Future<void> pollOnce() async {
    if (_pollInFlight) return;
    _pollInFlight = true;
    final gen = _generation;
    try {
      for (final id in _pollIds.toList()) {
        await refreshOrder(id);
        if (gen != _generation) return;
      }
    } finally {
      if (gen == _generation) {
        _pollInFlight = false;
        _ensurePolling();
      }
    }
  }

  // ---- realtime ------------------------------------------------------------------------------

  Set<String> get _wantedRooms => {
        for (final id in _activeIds)
          if (_orders[id]?.isLive == true) id,
        for (final id in _watchers.keys)
          if (_orders[id]?.isTerminal != true) id,
      };

  bool get isSocketOpen => _realtime != null;

  Future<void> _syncRealtime() async {
    if (_disposed) return;
    final wanted = _wantedRooms;
    if (wanted.isEmpty || _userId == null) {
      _realtime?.dispose();
      _realtime = null;
      _joined.clear();
      return;
    }
    final rt = _realtime;
    if (rt == null) {
      if (_connecting) return;
      _connecting = true;
      final gen = _generation;
      final token = await _tokenProvider();
      if (gen != _generation || _disposed) return;
      _connecting = false;
      if (token == null || token.isEmpty || _realtime != null) return;
      final created = _realtimeFactory();
      _realtime = created;
      created.connect(
        token: token,
        onOrderUpdated: (payload) => _onSocketOrder(gen, payload),
        onRiderLocation: (payload) => _onSocketRider(gen, payload),
        onConnected: () => _onSocketConnected(gen),
      );
      return;
    }
    if (!rt.isConnected) return; // joined in onConnected
    for (final id in wanted.difference(_joined)) {
      _joinRoom(rt, id);
    }
  }

  /// Joins `order_<id>`; a refused join (`{ok:false}`) is forgotten so it is retried on the next
  /// sync. REST polling covers the order either way.
  void _joinRoom(OrderRealtime rt, String id) {
    final gen = _generation;
    _joined.add(id);
    rt.join(id, (ok) {
      if (!ok && gen == _generation && identical(rt, _realtime)) _joined.remove(id);
    });
  }

  @visibleForTesting
  Set<String> get joinedRooms => Set.unmodifiable(_joined);

  void _onSocketConnected(int gen) {
    if (gen != _generation || _realtime == null) return;
    _joined.clear();
    for (final id in _wantedRooms) {
      _joinRoom(_realtime!, id);
    }
    // Catch up on anything sent while we were disconnected.
    for (final id in _watchers.keys.toList()) {
      unawaited(refreshOrder(id));
    }
  }

  void _onSocketOrder(int gen, Object? payload) {
    if (gen != _generation) return;
    final o = OrderModel.tryParse(payload);
    if (o == null) return;
    // Only orders this student already knows about or is watching (rooms are server-checked,
    // this is defence in depth).
    if (!_orders.containsKey(o.id) && !_watchers.containsKey(o.id)) return;
    _ingest(o);
  }

  void _onSocketRider(int gen, Object? payload) {
    if (gen != _generation) return;
    final loc = RiderLocation.fromJson(payload, now: _clock());
    if (loc == null) return;
    final order = _orders[loc.orderId];
    if (order == null || order.isTerminal || order.rider == null) return;
    // Only the rider assigned to this order (the server already filters; defence in depth).
    if (loc.driverId != null && loc.driverId != order.rider!.id) return;
    _setRider(loc.orderId, loc);
  }

  // ---- plumbing ------------------------------------------------------------------------------

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Test seam: replace the payment sheet.
  @visibleForTesting
  set gateway(PaymentGateway value) => _gateway = value;

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _pollTimer?.cancel();
    _realtime?.dispose();
    super.dispose();
  }
}
