import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/order.dart';
import '../models/order_group.dart';
import '../services/customer_api_service.dart';
import '../services/order_api.dart';
import '../services/order_realtime.dart';
import '../services/payment_gateway.dart';
import 'cart_provider.dart';

/// What the student is about to order, as checkout sends it to `POST /orders` (one restaurant)
/// or `POST /order-groups` (two or more, Docs/22).
class CheckoutDraft {
  CheckoutDraft({
    required this.vendorId,
    required List<({String itemId, int quantity})> items,
    required this.dropoffHostel,
    required this.dropoffNotes,
    this.couponCode,
    List<RestaurantCart> extraRestaurants = const [],
  })  : items = _aggregate(items),
        extraRestaurants = [for (final r in extraRestaurants) RestaurantCart(vendorId: r.vendorId, items: _aggregate(r.items))];

  /// Builds the draft from the cart. Quantities of the same dish are summed: the server prices
  /// and stores dishes, not the app's local option variants. The first restaurant is the
  /// primary one (it carries the base fee, the coupon and the payment of a combined order).
  factory CheckoutDraft.fromCart(CartProvider cart, {required String dropoffHostel, required String dropoffNotes}) {
    final all = cart.restaurants;
    if (all.length <= 1) {
      return CheckoutDraft(
        vendorId: cart.dhabaId ?? '',
        items: [for (final i in cart.items) (itemId: i.item.id, quantity: i.quantity)],
        dropoffHostel: dropoffHostel,
        dropoffNotes: dropoffNotes,
        couponCode: cart.appliedCouponCode,
      );
    }
    return CheckoutDraft(
      vendorId: all.first.id,
      items: [for (final i in all.first.items) (itemId: i.item.id, quantity: i.quantity)],
      dropoffHostel: dropoffHostel,
      dropoffNotes: dropoffNotes,
      couponCode: cart.appliedCouponCode,
      extraRestaurants: [
        for (final r in all.skip(1)) RestaurantCart(vendorId: r.id, items: [for (final i in r.items) (itemId: i.item.id, quantity: i.quantity)]),
      ],
    );
  }

  final String vendorId;
  final List<({String itemId, int quantity})> items;
  final String dropoffHostel;
  final String dropoffNotes;
  final String? couponCode;

  /// The restaurants after the first one. Empty for a normal single-restaurant order.
  final List<RestaurantCart> extraRestaurants;

  /// Two or more restaurants: placed with `POST /order-groups`.
  bool get isGroup => extraRestaurants.isNotEmpty;

  /// Every restaurant of the order, primary first.
  List<RestaurantCart> get restaurants => [RestaurantCart(vendorId: vendorId, items: items), ...extraRestaurants];

  /// The same cart as a price-quote request (`POST /orders/quote`).
  QuoteRequest get quoteRequest => QuoteRequest(restaurants: restaurants, couponCode: couponCode);

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
  String get cartKey {
    if (!isGroup) return [vendorId, for (final i in items) '${i.itemId}x${i.quantity}', (couponCode ?? '').toUpperCase()].join('|');
    // Order of the restaurants does not matter for "the same cart".
    final parts = [for (final r in restaurants) '${r.vendorId}:${[for (final i in r.items) '${i.itemId}x${i.quantity}'].join(',')}']..sort();
    return ['group', ...parts, (couponCode ?? '').toUpperCase()].join('|');
  }
}

class _CheckoutAttempt {
  _CheckoutAttempt(this.cartKey, this.clientRequestId, this.dropoffHostel, this.dropoffNotes);
  final String cartKey;
  final String clientRequestId;

  /// The drop point and delivery note this attempt was sent with. A request that has not
  /// produced an order yet must not be retried with the same idempotency key for a different
  /// point or note: the server treats the pair (key, request body) as one order and answers
  /// 409 CLIENT_REQUEST_MISMATCH otherwise.
  final String dropoffHostel;
  final String dropoffNotes;
  /// The id to pay and cancel: the order, or the PRIMARY child of a combined order.
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

  /// A cancelled, paid order keeps being polled / listened to for this long after its last
  /// update, so the screen can turn "refund is being processed" into "refunded" by itself.
  static const Duration refundWatchWindow = Duration(minutes: 10);

  static const int pageSize = 20;

  // ---- state ---------------------------------------------------------------------------------

  /// Bumped on logout/account switch: answers to requests from an older session are dropped.
  int _generation = 0;
  String? _userId;

  final Map<String, OrderModel> _orders = {};
  List<String> _activeIds = const [];
  List<String> _historyIds = const [];
  final Map<String, DateTime> _locallyAddedAt = {};

  /// Group total from `GET /order-groups/:id` / the place answer: stands in for the sum of the
  /// children while some of them are not loaded yet. Groups themselves are never stored: they are
  /// derived from the child orders in [_orders] (see [_view]).
  final Map<String, double> _groupTotals = {};
  final Map<String, Future<OrderResult<OrderGroupView>>> _groupRefreshing = {};
  final Set<String> _completionTried = {};
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

  /// Why the last `GET /orders/:id` for an order we do not hold failed (cleared once it loads).
  final Map<String, OrderApiError> _loadErrors = {};

  final Map<String, int> _watchers = {};
  Timer? _pollTimer;
  bool _pollInFlight = false;

  OrderRealtime? _realtime;
  bool _connecting = false;
  final Set<String> _joined = {};

  bool _disposed = false;

  // ---- reads ---------------------------------------------------------------------------------

  String? get userId => _userId;

  /// The API this provider talks to (the checkout's price quote uses the same one).
  OrderApi get api => _api;

  /// The order as the screens show it: for a single order the server copy, for a part of a
  /// combined order the COMPOSITE of the whole group (id = the primary child's id).
  OrderModel? orderById(String id) => _view(id);

  OrderModel? _view(String id) {
    final o = _orders[id];
    if (o == null) return null;
    final gid = o.group?.id;
    return gid == null ? o : _composite(gid) ?? o;
  }

  OrderModel? _composite(String groupId) {
    final kids = _orders.values.where((o) => o.group?.id == groupId).toList();
    return kids.isEmpty ? null : OrderModel.composite(kids, groupTotal: _groupTotals[groupId]);
  }

  /// One entry per combined order (its composite), single orders as they are; first occurrence wins.
  List<OrderModel> _collapse(Iterable<OrderModel> kids) {
    final out = <OrderModel>[];
    final seen = <String>{};
    for (final o in kids) {
      final gid = o.group?.id;
      if (gid == null) {
        out.add(o);
      } else if (seen.add(gid)) {
        out.add(_composite(gid) ?? o);
      }
    }
    return out;
  }

  /// Orders in progress (newest first) followed by ones that finished in the last few minutes.
  /// A combined order is ONE entry.
  List<OrderModel> get activeOrders {
    final list = _collapse(_activeIds.map((id) => _orders[id]).whereType<OrderModel>()).where(_isActiveNow).toList();
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

  List<OrderModel> get history => _collapse(_historyIds.map((id) => _orders[id]).whereType<OrderModel>());

  /// Alias kept for screens/tests written against the previous API.
  List<OrderModel> get orderHistory => history;

  /// True only when the student's orders are loaded and none of them counts as an earlier order
  /// for the first-order coupon (the server ignores cancelled ones). False while unknown, so the
  /// VITFIRST promo never shows to someone it would be refused for.
  bool get isFirstTimeCustomer {
    if (!_historyLoaded || !_activeLoaded) return false;
    if (_orders.values.any((o) => o.status != OrderProgressStatus.cancelled)) return false;
    return !_historyHasMore; // more history pages might hold a delivered order
  }

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

  /// A `GET /orders/:id` for [orderId] is running.
  bool isRefreshing(String orderId) => _refreshing.containsKey(orderId);

  /// Why [orderId] could not be loaded (it is not in memory and the server refused or did not
  /// answer), or null. Lets the tracking screen show an error with Retry instead of a spinner.
  OrderApiError? loadErrorFor(String orderId) => _orders.containsKey(orderId) ? null : _loadErrors[orderId];

  /// True when the server said this order is not ours / does not exist: no point polling it.
  bool _isGone(String id) {
    final e = _loadErrors[id];
    return !_orders.containsKey(id) && e != null && (e.kind == OrderErrorKind.notFound || e.kind == OrderErrorKind.forbidden);
  }

  /// Whether [o] still needs live updates: it is in progress, or it was cancelled after payment
  /// and its refund result has not arrived yet (for [refundWatchWindow] after its last update).
  bool _needsUpdates(OrderModel o) => o.isLive || (o.isRefundInProgress && _clock().toUtc().difference(o.updatedAt) <= refundWatchWindow);
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
    final order = _view(a.orderId!);
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
    _groupTotals.clear();
    _groupRefreshing.clear();
    _completionTried.clear();
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
    _loadErrors.clear();
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
      _ensureGroupsComplete();
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
      _ensureGroupsComplete();
    } else {
      _historyError = r.error;
    }
    _notify();
  }

  /// `GET /orders/:id`, merged by `updatedAt`. Returns the freshest copy (or null on failure).
  ///
  /// A part of a combined order refreshes the WHOLE group with one `GET /order-groups/:id` (so
  /// the screen never shows restaurants at different moments); the freshest composite is returned.
  Future<OrderModel?> refreshOrder(String orderId) {
    final gid = _orders[orderId]?.group?.id;
    if (gid != null) return _refreshViaGroup(orderId, gid);
    return _refreshSingle(orderId);
  }

  Future<OrderModel?> _refreshSingle(String orderId) => _refreshing[orderId] ??= _refreshOrder(orderId).whenComplete(() {
        // Block body: returning the removed Future here would make whenComplete wait on itself.
        _refreshing.remove(orderId);
      });

  Future<OrderModel?> _refreshViaGroup(String orderId, String groupId) async {
    final gen = _generation;
    final r = await refreshGroup(groupId);
    if (gen != _generation) return null;
    final e = r.error;
    // An answer that is not about the network (the group endpoint refused or is missing): read
    // the part itself, so polling can never go blind.
    if (e != null && !e.isNetwork && e.kind != OrderErrorKind.unauthorized) {
      await _refreshSingle(orderId);
      if (gen != _generation) return null;
    }
    return _view(orderId);
  }

  /// `GET /order-groups/:id`: loads every part of a combined order and merges them like any
  /// order. Concurrent calls share one request.
  Future<OrderResult<OrderGroupView>> refreshGroup(String groupId) => _groupRefreshing[groupId] ??= _refreshGroup(groupId).whenComplete(() {
        _groupRefreshing.remove(groupId);
      });

  Future<OrderResult<OrderGroupView>> _refreshGroup(String groupId) async {
    final gen = _generation;
    final r = await _api.fetchGroup(groupId);
    if (gen != _generation) return const OrderResult.fail(OrderApiError(OrderErrorKind.unauthorized));
    final g = r.value;
    if (g != null) _storeGroup(g);
    return r;
  }

  void _storeGroup(OrderGroupView g) {
    _groupTotals[g.id] = g.total;
    for (final child in g.orders) {
      _ingest(child);
    }
  }

  /// A list page can hold only some parts of a combined order: fetch the rest once.
  void _ensureGroupsComplete() {
    final loaded = <String, int>{};
    final sizes = <String, int>{};
    for (final o in _orders.values) {
      final g = o.group;
      if (g == null) continue;
      loaded[g.id] = (loaded[g.id] ?? 0) + 1;
      sizes[g.id] = g.size;
    }
    for (final gid in loaded.keys) {
      if (loaded[gid]! < sizes[gid]! && !_groupRefreshing.containsKey(gid) && _completionTried.add(gid)) {
        unawaited(refreshGroup(gid).then((r) {
          if (!r.ok) _completionTried.remove(gid); // try again on the next list load
        }));
      }
    }
  }

  Future<OrderModel?> _refreshOrder(String orderId) async {
    final gen = _generation;
    final r = await _api.fetchOrder(orderId);
    if (gen != _generation) return null;
    final o = r.value;
    if (o == null) {
      final error = r.error;
      if (error != null && !_orders.containsKey(orderId)) {
        final changed = _loadErrors[orderId]?.kind != error.kind;
        _loadErrors[orderId] = error;
        if (changed) {
          _notify();
          if (_isGone(orderId)) {
            _ensurePolling();
            unawaited(_syncRealtime());
          }
        }
      }
      return _view(orderId);
    }
    final hadError = _loadErrors.remove(orderId) != null;
    _ingest(o);
    if (hadError) _ensurePolling(); // polling was switched off for a missing order: it exists now
    if (o.group != null) _ensureGroupsComplete(); // the other restaurants of a combined order
    return _view(orderId);
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
      final existing = _view(attempt.orderId!);
      if (existing != null && existing.isLive) return OrderResult.ok(existing);
      attempt = null; // that order is finished (expired / cancelled): a new order needs a new key
    }
    if (attempt != null && attempt.orderId == null && (attempt.dropoffHostel != draft.dropoffHostel || attempt.dropoffNotes != draft.dropoffNotes)) {
      attempt = null; // no order exists yet and the drop point or note changed: a new key for the new request
    }
    if (attempt == null || attempt.cartKey != draft.cartKey) {
      attempt = _CheckoutAttempt(draft.cartKey, newClientRequestId(), draft.dropoffHostel, draft.dropoffNotes);
    }
    _attempt = attempt;
    final gen = _generation;
    _notify();
    var r = await _createOrder(draft, attempt);
    if (gen != _generation) return const OrderResult.fail(OrderApiError(OrderErrorKind.unauthorized));
    if (r.error?.code == 'CLIENT_REQUEST_MISMATCH') {
      // The key was already used for a different body (should not happen after the re-key above,
      // but a lost response plus an edit elsewhere could): start a fresh checkout id and retry once.
      attempt = _CheckoutAttempt(draft.cartKey, newClientRequestId(), draft.dropoffHostel, draft.dropoffNotes);
      _attempt = attempt;
      r = await _createOrder(draft, attempt);
      if (gen != _generation) return const OrderResult.fail(OrderApiError(OrderErrorKind.unauthorized));
    }
    final order = r.value;
    if (order != null) {
      attempt.orderId = order.id;
      // A combined order was merged part by part in [_createGroup]; [order] is its composite.
      if (!draft.isGroup) _ingest(order);
      return OrderResult.ok(_view(order.id) ?? order);
    }
    return r;
  }

  Future<OrderResult<OrderModel>> _createOrder(CheckoutDraft draft, _CheckoutAttempt attempt) {
    if (draft.isGroup) return _createGroup(draft, attempt);
    return _api.createOrder(CreateOrderRequest(
      vendorId: draft.vendorId,
      items: draft.items,
      dropoffHostel: draft.dropoffHostel,
      dropoffNotes: draft.dropoffNotes,
      couponCode: draft.couponCode,
      clientRequestId: attempt.clientRequestId,
    ));
  }

  /// `POST /order-groups` (two or more restaurants). The parts are merged into the order store
  /// here; the returned order is the composite of the whole group (id = the primary part, the id
  /// to pay). Same idempotency key for the same cart and drop point as the single flow.
  Future<OrderResult<OrderModel>> _createGroup(CheckoutDraft draft, _CheckoutAttempt attempt) async {
    final gen = _generation;
    final r = await _api.createGroup(CreateGroupRequest(
      restaurants: draft.restaurants,
      dropoffHostel: draft.dropoffHostel,
      dropoffNotes: draft.dropoffNotes,
      couponCode: draft.couponCode,
      clientRequestId: attempt.clientRequestId,
    ));
    if (gen != _generation) return const OrderResult.fail(OrderApiError(OrderErrorKind.unauthorized));
    final g = r.value;
    if (g == null) return OrderResult.fail(r.error!);
    _storeGroup(g);
    final primary = _orders[g.payOrderId] ?? g.orders.first;
    return OrderResult.ok(_view(primary.id) ?? OrderModel.composite(g.orders, groupTotal: g.total));
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
        return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: _view(orderId), message: orderErrorMessage(error));
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

    final order = _view(orderId);
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
        return PaymentOutcome(PaymentOutcomeKind.orderClosed, order: _view(orderId), message: orderErrorMessage(verifyError!));
      case 'DUPLICATE_PAYMENT':
        unawaited(refreshOrder(orderId));
        return PaymentOutcome(PaymentOutcomeKind.paid, order: _view(orderId), message: orderErrorMessage(verifyError!));
      case 'PAYMENT_AMOUNT_MISMATCH':
        // Not marked paid and support has to sort out the money: never ask to "confirm" forever.
        _paymentSubmittedAt.remove(orderId);
        _notify();
        return PaymentOutcome(PaymentOutcomeKind.failed, order: _view(orderId), message: orderErrorMessage(verifyError!));
    }
    final fresh = await refreshOrder(orderId);
    if (gen != _generation) return const PaymentOutcome(PaymentOutcomeKind.failed);
    final latest = fresh ?? _view(orderId);
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
      // Cancelling any part cancels the whole combined order: load the other parts.
      final gid = r.value!.group?.id;
      if (gid != null) unawaited(refreshGroup(gid));
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
  bool isWatching(String orderId) {
    if (_watchers.containsKey(orderId)) return true;
    final gid = _orders[orderId]?.group?.id;
    return gid != null && _watchers.keys.any((w) => _orders[w]?.group?.id == gid);
  }

  Iterable<String> get _pollIds => _watchers.keys.where(_isWatchedAndWanted);

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
          if (_orders[id] != null && _needsUpdates(_orders[id]!)) id,
        for (final id in _watchers.keys)
          if (_isWatchedAndWanted(id)) ..._roomsOf(id),
      };

  /// The order rooms to join for a watched order: itself, or every part of its combined order.
  Iterable<String> _roomsOf(String id) {
    final g = _orders[id]?.group;
    if (g == null) return [id];
    return {id, for (final s in g.stops) s.orderId, for (final o in _orders.values) if (o.group?.id == g.id) o.id};
  }

  /// A watched order (loaded, or not loaded yet but not known to be missing) that still needs updates.
  bool _isWatchedAndWanted(String id) {
    final o = _view(id);
    return o == null ? !_isGone(id) : _needsUpdates(o);
  }

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
      final String? token;
      try {
        token = await _tokenProvider();
      } catch (e) {
        debugPrint('[Orders] could not read the session token for the socket: ${e.runtimeType}');
        return; // polling still covers the watched orders; the next sync tries again
      } finally {
        // (After a logout `_reset` already cleared the flag for the new session; leave it alone.)
        if (gen == _generation) _connecting = false;
      }
      if (gen != _generation || _disposed) return;
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
    final gid = o.group?.id;
    final knownGroup = gid != null && _orders.values.any((x) => x.group?.id == gid);
    if (!_orders.containsKey(o.id) && !_watchers.containsKey(o.id) && !knownGroup) return;
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
    // One rider carries every part of a combined order: the group's map listens on the primary id.
    final g = order.group;
    if (g != null) {
      for (final o in _orders.values) {
        if (o.group?.id == g.id && o.id != loc.orderId && o.group!.primary) {
          _setRider(o.id, RiderLocation(orderId: o.id, driverId: loc.driverId, lat: loc.lat, lng: loc.lng, heading: loc.heading, at: loc.at, receivedAt: loc.receivedAt));
        }
      }
    }
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
