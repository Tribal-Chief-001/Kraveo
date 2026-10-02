import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/order_model.dart';
import 'audio_alert_service.dart';
import 'order_socket.dart';
import 'vendor_api_service.dart';
import 'vendor_backend.dart';

/// The loud kitchen alarm, behind an interface so tests can see when it rings.
abstract class AlarmSink {
  bool get isRinging;
  Future<void> start();
  Future<void> stop();
}

class AudioAlarmSink implements AlarmSink {
  const AudioAlarmSink();
  @override
  bool get isRinging => AudioAlertService.isPlaying;
  @override
  Future<void> start() => AudioAlertService.startLoudAlarm();
  @override
  Future<void> stop() => AudioAlertService.stopAlarm();
}

enum OrderAction { accept, reject, startCooking, markReady }

/// What happened to a tap on Accept / Reject / Start cooking / Mark ready.
class ActionOutcome {
  const ActionOutcome.success()
      : ok = true,
        ignored = false,
        failure = null,
        message = null,
        code = null,
        current = null;

  /// A second tap while the first one is still on its way: nothing was sent.
  const ActionOutcome.ignored()
      : ok = false,
        ignored = true,
        failure = null,
        message = null,
        code = null,
        current = null;

  const ActionOutcome.failed(ApiFailure this.failure, {this.message, this.code, this.current})
      : ok = false,
        ignored = false;

  final bool ok;
  final bool ignored;
  final ApiFailure? failure;

  /// The server's explanation (400 / 409), when it gave one.
  final String? message;

  /// The server's machine code (INVALID_TRANSITION, CANNOT_REJECT, ORDER_CLOSED, ...), when it gave one.
  final String? code;

  /// The order as the server has it now (e.g. cancelled meanwhile), or null when it is gone.
  final OrderModel? current;
}

/// The single source of truth for the kitchen's orders.
///
/// * Truth comes from the server: `GET /orders?scope=active` every [pollInterval] (and on app resume, on socket
///   reconnect and on demand), `new_order_alert` / `order_updated` over the socket, and action responses.
///   Everything is merged by `updatedAt` (see [OrderModel.isSupersededBy]); the socket is only a speed-up.
/// * A failed poll never wipes the screen: the last known orders stay, with [syncFailure] set.
/// * An order only disappears when the server says so (a fresh `GET /orders/:id` answers 404/403).
/// * The alarm rings exactly while a paid order is waiting for Accept / Reject and no answer is on its way.
/// * Accept / Reject wait for the server. Start cooking / Mark ready show the new state at once and roll back
///   if the server refuses (the optimistic state is an overlay, never written into the server copy).
class OrderQueueController extends ChangeNotifier {
  OrderQueueController({
    required this.backend,
    required this.vendorId,
    this.socket,
    Future<String?> Function()? tokenProvider,
    this.pollInterval = const Duration(seconds: 15),
    DateTime Function()? clock,
    AlarmSink? alarm,
  })  : _tokenProvider = tokenProvider ?? VendorApiService.getSavedToken,
        _clock = clock ?? DateTime.now,
        alarm = alarm ?? const AudioAlarmSink();

  static const String prepTimesPrefKey = 'kraveo_vendor_prep_minutes';
  static const int defaultPrepMinutes = 15;
  static const int _activePageSize = 50;
  static const int _maxActivePages = 4;
  static const int _historyPageSize = 30;

  final VendorBackend backend;
  final String vendorId;
  final OrderSocket? socket;
  final Duration pollInterval;
  final AlarmSink alarm;
  final Future<String?> Function() _tokenProvider;
  final DateTime Function() _clock;

  final Map<String, OrderModel> _orders = {};
  final Map<String, OrderStatus> _overlay = {};
  final Map<String, OrderAction> _busy = {};
  final Map<String, DateTime> _receivedAt = {};
  final Map<String, int> _prepMinutes = {};
  final Map<String, Set<int>> _ticked = {};

  Timer? _pollTimer;
  Future<void>? _refreshing;
  bool _started = false;
  bool _disposed = false;
  bool _ringing = false;
  bool _loadedOnce = false;
  ApiFailure? _syncFailure;
  DateTime? _lastSyncAt;
  DateTime? _pollPausedUntil;
  Duration _clockOffset = Duration.zero;
  bool? _roomJoined;

  String? _historyCursor;
  bool _historyHasMore = true;
  bool _historyLoading = false;
  bool _historyLoadedOnce = false;
  ApiFailure? _historyFailure;
  DateTime? _oldestHistoryLoaded;

  // ------------------------------------------------------------------ state

  bool get isDisposed => _disposed;

  /// True until the first successful load (the screen shows "Loading orders", never a false "no orders").
  bool get loadedOnce => _loadedOnce;

  /// Why the last poll failed (null when the list is fresh).
  ApiFailure? get syncFailure => _syncFailure;
  DateTime? get lastSyncAt => _lastSyncAt;

  bool get historyHasMore => _historyHasMore;
  bool get historyLoading => _historyLoading;
  bool get historyLoadedOnce => _historyLoadedOnce;
  ApiFailure? get historyFailure => _historyFailure;

  /// The server refused the restaurant's live-alert room: new orders arrive by the 15-second poll only.
  bool get liveAlertsRefused => _roomJoined == false;

  /// True while the alarm is meant to ring.
  bool get ringing => _ringing;

  /// The server's clock as best we know it (phone clock + the offset seen in the last response's `Date`).
  DateTime now() => _clock().add(_clockOffset);

  OrderModel _effective(OrderModel o) {
    final target = _overlay[o.id];
    if (target != null && !o.status.isTerminal && o.status.rank < target.rank) return o.copyWith(status: target);
    return o;
  }

  Iterable<OrderModel> get _all => _orders.values.map(_effective);

  OrderModel? byId(String id) {
    final o = _orders[id];
    return o == null ? null : _effective(o);
  }

  bool isBusy(String id) => _busy.containsKey(id);
  OrderAction? busyAction(String id) => _busy[id];

  /// Paid orders waiting for Accept / Reject, the one closest to its deadline first.
  List<OrderModel> get incoming => _all.where((o) => o.isIncoming).toList()..sort((a, b) => a.acceptDeadline.compareTo(b.acceptDeadline));

  /// Accepted, cooking and ready orders.
  List<OrderModel> get kitchen => _all.where((o) => o.status.isKitchen).toList();

  /// Picked up, at the gate, delivered, cancelled (and unknown states), newest first.
  List<OrderModel> get finished => _all.where((o) => !o.status.isKitchen && !o.isIncoming && o.status != OrderStatus.placed).toList()
    ..sort((a, b) => b.createdAt.compareTo(a.createdAt));

  /// Every order the app knows about (for the earnings screen).
  List<OrderModel> get allOrders => _all.toList();

  int prepMinutesFor(String id) => _prepMinutes[id] ?? defaultPrepMinutes;

  /// When the kitchen's own "ready in N minutes" target runs out (a kitchen aid; the server does not use it).
  DateTime prepDeadlineFor(OrderModel o) => (o.acceptedAt ?? o.paidAt ?? o.createdAt).add(Duration(minutes: prepMinutesFor(o.id)));

  bool isItemTicked(String orderId, int index) => _ticked[orderId]?.contains(index) ?? false;

  void toggleItem(String orderId, int index) {
    final set = _ticked.putIfAbsent(orderId, () => <int>{});
    if (!set.remove(index)) set.add(index);
    _notify();
  }

  // ------------------------------------------------------------------ lifecycle

  /// Loads the queue, connects the socket and starts the 15-second poll.
  Future<void> start() async {
    if (_started || _disposed) return;
    _started = true;
    await _loadPrepTimes();
    if (_disposed) return;
    _pollTimer = Timer.periodic(pollInterval, (_) => _tick());
    unawaited(_connectSocket());
    await refresh();
  }

  /// The app came back to the foreground (or was reopened): reload at once and revive the socket.
  Future<void> onResumed() {
    _pollPausedUntil = null;
    socket?.ensureConnected();
    return refresh();
  }

  void _tick() {
    if (_disposed) return;
    socket?.ensureConnected();
    final paused = _pollPausedUntil;
    if (paused != null && _clock().isBefore(paused)) return;
    refresh();
  }

  Future<void> _connectSocket() async {
    final s = socket;
    if (s == null) return;
    s.onOrderEvent = _onSocketEvent;
    s.onConnected = () => refresh();
    s.onRoomJoined = (ok) {
      if (_disposed || _roomJoined == ok) return;
      _roomJoined = ok;
      _notify();
    };
    final token = await _tokenProvider();
    if (_disposed || token == null || token.isEmpty) return;
    s.connect(token: token, vendorId: vendorId);
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    socket?.dispose();
    if (_ringing) {
      _ringing = false;
      alarm.stop();
    }
    super.dispose();
  }

  // ------------------------------------------------------------------ sync

  /// Reloads the active queue. Calls made while one is running share it.
  Future<void> refresh() {
    if (_disposed) return Future.value();
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<void> _doRefresh() async {
    final startedAt = DateTime.now();
    final seen = <String>{};
    String? cursor;
    var complete = false;
    for (var page = 0; page < _maxActivePages; page++) {
      final res = await backend.fetchOrders(OrderScope.active, cursor: cursor, limit: _activePageSize);
      if (_disposed) return;
      if (!res.ok) {
        // Keep everything on screen; say that it may be stale.
        _syncFailure = res.failure;
        if (res.failure == ApiFailure.rateLimited) {
          _pollPausedUntil = _clock().add(Duration(seconds: (res.retryAfterSeconds ?? 30).clamp(5, 300)));
        }
        _notify();
        return;
      }
      _learnServerTime(res.serverTime);
      for (final o in res.data!.orders) {
        seen.add(o.id);
        _mergeIn(o, fromPoll: true);
      }
      cursor = res.data!.nextCursor;
      if (cursor == null) {
        complete = true;
        break;
      }
    }

    _loadedOnce = true;
    _syncFailure = null;
    _lastSyncAt = _clock();
    _notify();

    if (!complete) return; // with a partial list we cannot tell what has left it

    // Live orders the server no longer lists: ask about each one before letting it go.
    final missing = _orders.values
        .where((o) => !o.status.isTerminal && !seen.contains(o.id) && !(_receivedAt[o.id]?.isAfter(startedAt) ?? false))
        .map((o) => o.id)
        .toList();
    for (final id in missing) {
      if (_disposed) return;
      await _refetch(id);
    }
    if (missing.isNotEmpty) _notify();
  }

  void _learnServerTime(DateTime? serverTime) {
    if (serverTime == null) return;
    final offset = serverTime.difference(_clock());
    // The Date header has 1-second resolution; ignore noise, keep real clock skew.
    _clockOffset = offset.abs() < const Duration(seconds: 3) ? Duration.zero : offset;
  }

  /// Re-reads one order. A 404/403 is the server saying "gone": only then does it leave the screen.
  Future<void> _refetch(String id) async {
    final res = await backend.fetchOrder(id);
    if (_disposed) return;
    if (res.ok) {
      _mergeIn(res.data!);
    } else if (res.failure == ApiFailure.notFound || res.failure == ApiFailure.forbidden) {
      _forget(id);
    }
  }

  void _forget(String id) {
    _orders.remove(id);
    _overlay.remove(id);
    _ticked.remove(id);
    _receivedAt.remove(id);
  }

  /// Merges one server copy. Returns true when it changed what we hold.
  bool _mergeIn(OrderModel o, {bool fromPoll = false}) {
    // Contract 1.2: the restaurant never sees an unpaid order. Enforced here too.
    if (!o.isVisibleToVendor) return false;
    if (!fromPoll) _receivedAt[o.id] = DateTime.now();
    final existing = _orders[o.id];
    if (existing != null && !existing.isSupersededBy(o)) return false;
    _orders[o.id] = o;
    if (o.status.isTerminal) _ticked.remove(o.id);
    return true;
  }

  void _onSocketEvent(String event, Object? payload) {
    if (_disposed) return;
    Object? raw = payload;
    if (raw is List && raw.isNotEmpty) raw = raw.first;
    if (raw is Map && raw['data'] is Map && raw['id'] == null) raw = raw['data'];
    final o = OrderModel.fromJson(raw);
    if (o == null) {
      // Something we cannot read: fetch the truth instead of guessing.
      refresh();
      return;
    }
    if (_mergeIn(o)) _notify();
  }

  // ------------------------------------------------------------------ history

  /// Loads the next page of `GET /orders?scope=history`.
  Future<void> loadMoreHistory() async {
    if (_disposed || _historyLoading || !_historyHasMore) return;
    _historyLoading = true;
    _historyFailure = null;
    _notify();
    final res = await backend.fetchOrders(OrderScope.history, cursor: _historyCursor, limit: _historyPageSize);
    if (_disposed) return;
    _historyLoading = false;
    if (res.ok) {
      for (final o in res.data!.orders) {
        _mergeIn(o, fromPoll: true);
        if (_oldestHistoryLoaded == null || o.createdAt.isBefore(_oldestHistoryLoaded!)) _oldestHistoryLoaded = o.createdAt;
      }
      _historyCursor = res.data!.nextCursor;
      _historyHasMore = _historyCursor != null;
      _historyLoadedOnce = true;
    } else {
      _historyFailure = res.failure;
    }
    _notify();
  }

  /// Starts history over from the newest page (keeps what is on screen until the new pages arrive).
  Future<void> reloadHistory() async {
    if (_historyLoading) return;
    _historyCursor = null;
    _historyHasMore = true;
    _oldestHistoryLoaded = null;
    await loadMoreHistory();
  }

  /// True when every order created since [since] has been loaded (or there is no older history).
  bool historyCovers(DateTime since) =>
      _historyLoadedOnce && (!_historyHasMore || (_oldestHistoryLoaded != null && _oldestHistoryLoaded!.isBefore(since)));

  /// Loads history pages until [since] is covered (bounded, for the earnings screen).
  Future<void> loadHistorySince(DateTime since, {int maxPages = 10}) async {
    for (var i = 0; i < maxPages && !_disposed; i++) {
      if (historyCovers(since) || !_historyHasMore) return;
      await loadMoreHistory();
      if (_historyFailure != null) return;
    }
  }

  // ------------------------------------------------------------------ actions

  Future<ActionOutcome> accept(String id, {int? prepMinutes}) => _act(id, OrderAction.accept, prepMinutes: prepMinutes);

  /// [reason] must be 3-200 characters; the customer is shown it.
  Future<ActionOutcome> reject(String id, String reason) => _act(id, OrderAction.reject, reason: reason);

  Future<ActionOutcome> startCooking(String id) => _act(id, OrderAction.startCooking);

  Future<ActionOutcome> markReady(String id) => _act(id, OrderAction.markReady);

  static OrderStatus _targetOf(OrderAction a) => switch (a) {
        OrderAction.accept => OrderStatus.accepted,
        OrderAction.reject => OrderStatus.cancelled,
        OrderAction.startCooking => OrderStatus.preparing,
        OrderAction.markReady => OrderStatus.readyForPickup,
      };

  bool _reached(OrderAction action, OrderModel? o) {
    if (o == null) return false;
    return switch (action) {
      OrderAction.reject => o.status == OrderStatus.cancelled && o.cancelledBy == CancelledBy.vendor,
      _ => o.status == _targetOf(action),
    };
  }

  Future<ActionOutcome> _act(String id, OrderAction action, {String? reason, int? prepMinutes}) async {
    if (_disposed) return const ActionOutcome.ignored();
    if (_busy.containsKey(id)) return const ActionOutcome.ignored();
    final before = byId(id);
    if (before == null) return const ActionOutcome.failed(ApiFailure.notFound);
    final cleanReason = reason?.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (action == OrderAction.reject && (cleanReason == null || cleanReason.length < 3 || cleanReason.length > 200)) {
      return const ActionOutcome.failed(ApiFailure.invalid, message: 'Reason must be 3-200 characters.');
    }

    final optimistic = action == OrderAction.startCooking || action == OrderAction.markReady;
    _busy[id] = action;
    if (optimistic) _overlay[id] = _targetOf(action);
    _notify();

    final ApiResult<OrderModel> res = action == OrderAction.reject
        ? await backend.reject(id, cleanReason!)
        : await backend.updateStatus(id, _targetOf(action));
    if (_disposed) return const ActionOutcome.ignored();

    // Roll back the overlay whatever happened: from here on only the server's copy is shown.
    _busy.remove(id);
    _overlay.remove(id);

    if (res.ok) {
      final data = res.data;
      if (data != null) {
        _mergeIn(data);
      } else {
        await _refetch(id);
      }
      if (action == OrderAction.accept) _setPrepMinutes(id, prepMinutes ?? defaultPrepMinutes);
      _notify();
      return const ActionOutcome.success();
    }

    switch (res.failure!) {
      case ApiFailure.conflict:
      case ApiFailure.invalid:
      case ApiFailure.timeout:
      case ApiFailure.server:
      case ApiFailure.notFound:
        // Find out what really happened (cancelled meanwhile? did a timed-out call get through?).
        await _refetch(id);
      default:
        break;
    }
    if (_disposed) return const ActionOutcome.ignored();
    _notify();
    final now = byId(id);
    if (_reached(action, now)) {
      if (action == OrderAction.accept) _setPrepMinutes(id, prepMinutes ?? defaultPrepMinutes);
      return const ActionOutcome.success();
    }
    return ActionOutcome.failed(res.failure!, message: res.message, code: res.code, current: now);
  }

  // ------------------------------------------------------------------ alarm

  /// Restarts the alarm if an order is still waiting (e.g. after the "test alarm" button stopped it).
  void resyncAlarm() => _syncAlarm(force: true);

  void _syncAlarm({bool force = false}) {
    final should = !_disposed && _orders.values.any((o) => o.isIncoming && !_busy.containsKey(o.id));
    if (should) {
      _ringing = true;
      if (force || !alarm.isRinging) alarm.start();
    } else if (_ringing) {
      _ringing = false;
      alarm.stop();
    }
  }

  void _notify() {
    if (_disposed) return;
    _syncAlarm();
    notifyListeners();
  }

  // ------------------------------------------------------------------ prep times (kitchen aid, on this phone only)

  Future<void> _loadPrepTimes() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(prepTimesPrefKey);
      if (raw == null) return;
      final map = jsonDecode(raw);
      if (map is Map) {
        map.forEach((k, v) {
          if (v is num && v > 0 && v <= 120) _prepMinutes[k.toString()] = v.toInt();
        });
      }
    } catch (_) {}
  }

  void _setPrepMinutes(String id, int minutes) {
    _prepMinutes[id] = minutes;
    // Keep only orders that are still in the kitchen.
    _prepMinutes.removeWhere((key, _) => key != id && (_orders[key] == null || _orders[key]!.status.isTerminal));
    final snapshot = Map<String, int>.from(_prepMinutes);
    SharedPreferences.getInstance().then((prefs) => prefs.setString(prepTimesPrefKey, jsonEncode(snapshot))).catchError((_) => false);
  }
}
