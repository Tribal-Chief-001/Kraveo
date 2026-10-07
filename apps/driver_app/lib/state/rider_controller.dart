import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/geo.dart';
import '../models/order_view.dart';
import '../services/location_source.dart';
import '../services/rider_orders_api.dart';
import '../services/rider_socket.dart';

/// Everything the rider screens need from the outside world. Tests pass fakes.
class RiderServices {
  RiderServices({
    required this.api,
    required this.socket,
    required this.location,
    this.pollInterval = const Duration(seconds: 15),
    this.locationInterval = kLocationInterval,
    this.minPostGap = const Duration(seconds: 9),
    DateTime Function()? clock,
    Duration Function()? uptime,
  })  : now = clock ?? DateTime.now,
        uptime = uptime ?? _stopwatchUptime();

  static Duration Function() _stopwatchUptime() {
    final watch = Stopwatch()..start();
    return () => watch.elapsed;
  }

  factory RiderServices.real() => RiderServices(api: HttpRiderOrdersApi(), socket: IoRiderSocket(), location: GeolocatorLocationSource());

  final RiderOrdersApi api;
  final RiderSocket socket;
  final LocationSource location;
  final Duration pollInterval;
  final Duration locationInterval;

  /// A streamed position is posted to Kraveo at most this often (battery and data). A little
  /// under [locationInterval] so the phone's own 10 s cadence is not halved by timing jitter.
  final Duration minPostGap;
  final DateTime Function() now;

  /// A monotonic clock (not the wall clock) for the posting throttle. Tests pass their own.
  final Duration Function() uptime;
}

/// What the GPS line on screen says. "ok" is the only state in which a position is sent.
enum LocationState { off, waiting, ok, serviceOff, permissionDenied, permissionDeniedForever, unavailable }

enum NoticeKind { delivered, cancelled, reassigned }

/// A delivery that ended without the rider finishing the normal flow on this screen, or the
/// "delivered" confirmation. Shown as a card until the rider taps OK.
class DeliveryNotice {
  const DeliveryNotice(this.kind, this.order);
  final NoticeKind kind;
  final OrderView order;
}

enum OtpOutcomeKind { delivered, wrong, locked, network, error }

class OtpOutcome {
  const OtpOutcome(this.kind, {this.attemptsLeft, this.message});
  final OtpOutcomeKind kind;
  final int? attemptsLeft;
  final String? message;
}

/// The rider's live state: duty, the offer pool, the one active delivery, GPS and history.
///
/// Rules (contract `Docs/16_order_flow_contract.md`):
/// * The server is the only source of truth. Nothing is shown as accepted, picked up or delivered
///   unless the server said so (REST response, socket `order_updated`, or a poll).
/// * Socket events are a speed-up; REST polling every 15 s (and on resume) is the backbone.
/// * A failed poll never wipes what is on screen; it only marks the data as stale.
/// * Copies of the same order are merged by `updatedAt`.
class RiderController extends ChangeNotifier {
  RiderController(this.services, {Set<String> myIds = const {}}) : _myIds = myIds.where((e) => e.isNotEmpty).toSet();

  static const String dutyPrefKey = 'kraveo_driver_duty_online';
  static const supportMessage = 'Contact Kraveo support – this delivery is locked.';

  final RiderServices services;
  final Set<String> _myIds;
  RiderOrdersApi get _api => services.api;
  DateTime _now() => services.now();

  final _messages = StreamController<String>.broadcast(sync: true);

  /// One-off messages for a snackbar.
  Stream<String> get messages => _messages.stream;

  bool _disposed = false;
  bool _started = false;
  StreamSubscription<RiderSocketEvent>? _socketSub;
  Timer? _pollTimer;
  Timer? _locTimer;
  StreamSubscription<LocationReading>? _trackSub;
  bool _foreground = true;

  // ---- duty ----
  bool _onDuty = false;
  bool _dutyBusy = false;
  bool _pendingOffSync = false;
  bool _dutyOffInFlight = false;
  DateTime? _lastDutyChangeAt;
  bool get onDuty => _onDuty;
  bool get dutyBusy => _dutyBusy;

  // ---- offers ----
  List<OrderView> _offers = const [];
  final Set<String> _dismissed = {};
  final Map<String, DateTime> _removedAt = {};
  bool _offersLoaded = false;
  bool _offersStale = false;
  String? _claimingId;
  List<OrderView> get offers => List.unmodifiable(_offers);
  bool get offersLoaded => _offersLoaded;
  bool get offersStale => _offersStale;
  String? get claimingId => _claimingId;

  // ---- active delivery ----
  OrderView? _active;
  int _otherActive = 0;
  bool _activeChecked = false;
  bool _activeStale = false;
  bool _actionBusy = false;
  String? _actionError;
  /// Orders whose gate code Kraveo locked (5 wrong codes). The value is the `updatedAt` of the first copy of the
  /// order seen after the lock (null until that copy arrives); a copy newer than that means someone (an admin
  /// resetting the lock) changed the order, so the lock is lifted. The 5th wrong code itself also bumps
  /// `updatedAt`, which is why the baseline is the post-lock copy and not the copy that was on screen.
  final Map<String, DateTime?> _lockedAt = {};
  DeliveryNotice? _notice;
  String? _releasingId;
  DateTime? _lastSync;
  OrderView? get active => _active;

  /// More live orders assigned to this rider than the one on screen (only possible via admin).
  int get otherActiveCount => _otherActive;

  /// True once the first `GET /orders?scope=active` has answered (restore after restart).
  bool get activeChecked => _activeChecked;
  bool get activeStale => _activeStale;
  bool get actionBusy => _actionBusy;
  String? get actionError => _actionError;
  bool get activeLocked => _active != null && _lockedAt.containsKey(_active!.id);
  DeliveryNotice? get notice => _notice;
  DateTime? get lastSync => _lastSync;
  bool get socketConnected => services.socket.isConnected;

  // ---- GPS ----
  LocationState _location = LocationState.off;
  DateTime? _lastFixAt;
  bool _locBusy = false;
  bool _posting = false;
  bool _lastLocationPostFailed = false;
  Duration? _lastPostAt;
  int _trackFailures = 0;
  final ValueNotifier<GeoPoint?> _position = ValueNotifier<GeoPoint?>(null);
  LocationState get location => _location;

  /// The rider's own latest real fix, for the map card (null when off duty or no fix yet).
  /// A separate notifier so a GPS fix repaints the map only, not every screen.
  ValueListenable<GeoPoint?> get myPosition => _position;

  /// True while the foreground-service position stream is running (always false for a source
  /// that cannot stream, which is polled on a timer instead).
  bool get isTracking => _trackSub != null;

  /// Location is shared while the rider is on duty AND while a delivery is in hand, even after the rider
  /// switched the duty off: the customer's live map must not freeze mid-delivery.
  bool get sharingLocation => _onDuty || _active != null;
  DateTime? get lastFixAt => _lastFixAt;
  bool get lastLocationPostFailed => _lastLocationPostFailed;

  // ---- history ----
  List<OrderView> _history = const [];
  String? _historyCursor;
  bool _historyHasMore = false;
  bool _historyLoading = false;
  bool _historyLoaded = false;
  bool _historyError = false;
  List<OrderView> get history => List.unmodifiable(_history);
  bool get historyHasMore => _historyHasMore;
  bool get historyLoading => _historyLoading;
  bool get historyLoaded => _historyLoaded;
  bool get historyError => _historyError;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _say(String message) {
    if (!_disposed && !_messages.isClosed) _messages.add(message);
  }

  /// Whether a copy of an order still names this rider. A copy without a driver (released /
  /// unassigned) or with someone else's id is never trusted alone: the app double-checks with the
  /// rider's own order list before it takes a delivery off the screen.
  bool _isMine(OrderView o) {
    final d = o.driver;
    if (d == null) return false;
    final id = d.id;
    return id == null || _myIds.isEmpty || _myIds.contains(id);
  }

  // =====================================================================================
  // Lifecycle
  // =====================================================================================

  /// Restores the active delivery (app killed while carrying food) and the saved duty choice.
  Future<void> start() async {
    if (_started || _disposed) return;
    _started = true;
    _socketSub = services.socket.events.listen(_onSocket);
    var wantDuty = false;
    try {
      final prefs = await SharedPreferences.getInstance();
      wantDuty = prefs.getBool(dutyPrefKey) ?? false;
    } catch (_) {}
    await refreshActive();
    if (_disposed) return;
    if (wantDuty) await setDuty(true, restoring: true);
    _resumeSharingForActive();
    _updateConnection();
    _startPolling();
    unawaited(loadHistory());
  }

  /// App came back to the foreground: catch up at once and resume polling.
  void resume() {
    if (_disposed || !_started) return;
    _foreground = true;
    _startPolling();
    unawaited(pollNow());
  }

  /// App went to the background: stop polling (GPS keeps its own timer while on duty).
  void pause() {
    _foreground = false;
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void _startPolling() {
    _pollTimer?.cancel();
    if (!_foreground || _disposed) return;
    _pollTimer = Timer.periodic(services.pollInterval, (_) => pollNow());
  }

  /// One REST sync: the rider's own orders always, and the pool while on duty and free.
  Future<void> pollNow() async {
    if (_disposed) return;
    if (_pendingOffSync && !_onDuty) unawaited(_syncOff());
    await refreshActive();
    if (_onDuty && _active == null) await refreshOffers();
  }

  /// A combined delivery listens to the order room of EVERY stop (each restaurant's order is its own room).
  static Iterable<String> _roomIds(OrderView o) => o.isGroup ? {o.id, for (final s in o.stops) s.orderId} : [o.id];

  void _watch(OrderView o) {
    for (final id in _roomIds(o)) {
      services.socket.watchOrder(id);
    }
  }

  void _unwatch(OrderView o) {
    for (final id in _roomIds(o)) {
      services.socket.unwatchOrder(id);
    }
  }

  void _updateConnection() {
    if (_disposed) return;
    final want = _onDuty || _active != null;
    if (want) {
      unawaited(services.socket.connect());
      if (_active != null) _watch(_active!);
    } else {
      services.socket.disconnect();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    _locTimer?.cancel();
    unawaited(_trackSub?.cancel());
    _trackSub = null;
    _position.dispose();
    _socketSub?.cancel();
    services.socket.dispose();
    _messages.close();
    super.dispose();
  }

  // =====================================================================================
  // Duty
  // =====================================================================================

  Future<void> _saveDutyPref(bool value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(dutyPrefKey, value);
    } catch (_) {}
  }

  /// ON needs the server's OK (otherwise the switch stays OFF and says why). OFF always works
  /// locally at once; the server is told as soon as it can be reached.
  Future<void> setDuty(bool on, {bool restoring = false}) async {
    if (_disposed || _dutyBusy) return;
    if (!on) {
      final wasOn = _onDuty;
      _onDuty = false;
      _lastDutyChangeAt = _now();
      // A delivery in hand keeps its live location (customer map, admin) until it is finished or released.
      if (_active == null) _stopLocation();
      _offers = const [];
      _offersLoaded = false;
      _offersStale = false;
      _updateConnection();
      _notify();
      await _saveDutyPref(false);
      _dutyOffInFlight = true;
      final ApiResult<String?> r;
      try {
        r = await _api.setDuty(false);
      } finally {
        _dutyOffInFlight = false;
      }
      if (_disposed) return;
      if (!r.ok && r.failure != ApiFailure.unauthorized && r.failure != ApiFailure.notApproved) {
        _pendingOffSync = true;
        _say('You are off duty on this phone. Kraveo will be told when the internet is back.');
      } else {
        _pendingOffSync = false;
        if (wasOn) {
          _say(_active != null
              ? 'You are off duty. Your location is still shared with the customer until you finish this delivery.'
              : 'You are off duty. Location sharing is off.');
        }
      }
      return;
    }

    if (_onDuty) return;
    _dutyBusy = true;
    _lastDutyChangeAt = _now();
    _notify();
    final r = await _api.setDuty(true);
    if (_disposed) return;
    _dutyBusy = false;
    _lastDutyChangeAt = _now();
    if (r.ok) {
      _onDuty = true;
      _pendingOffSync = false;
      await _saveDutyPref(true);
      _startLocation();
      _updateConnection();
      _notify();
      if (!restoring) _say('You are on duty. Live location is on.');
      if (_active == null) await refreshOffers();
      return;
    }
    _onDuty = false;
    await _saveDutyPref(false);
    _notify();
    switch (r.failure) {
      case ApiFailure.unauthorized:
        break; // the session gate takes the rider to login
      case ApiFailure.notApproved:
        _say('Your account is not active right now, so you cannot go on duty.');
      case ApiFailure.rateLimited:
        _say('Too many tries. Wait a moment and try again.');
      case ApiFailure.server:
      case ApiFailure.badResponse:
        _say('Could not go on duty – Kraveo is having trouble. Try again.');
      default:
        _say('Could not go on duty – check internet');
    }
  }

  /// Logout: stop GPS and offers on this phone and forget "on duty" (the session tells the server).
  Future<void> stopForLogout() async {
    _onDuty = false;
    _lastDutyChangeAt = _now();
    _stopLocation(); // logging out ends the session, so nothing can be sent for a delivery in hand either
    _offers = const [];
    services.socket.disconnect();
    await _saveDutyPref(false);
    _notify();
  }

  /// The server says this rider is off duty: mirror it without another server call.
  void _goOffLocally() {
    _onDuty = false;
    _lastDutyChangeAt = _now();
    if (_active == null) _stopLocation();
    _offers = const [];
    _offersLoaded = false;
    _updateConnection();
    unawaited(_saveDutyPref(false));
    _notify();
  }

  Future<void> _syncOff() async {
    final r = await _api.setDuty(false);
    if (r.ok && !_onDuty) _pendingOffSync = false;
  }

  /// The server went ON for this rider while the phone shows off (restore failed on a weak network, or the
  /// rider logged in again): show the truth and start sharing, without another server call.
  Future<void> _goOnLocally() async {
    _onDuty = true;
    _lastDutyChangeAt = _now();
    _pendingOffSync = false;
    unawaited(_saveDutyPref(true));
    _startLocation();
    _updateConnection();
    _notify();
    if (_active == null) await refreshOffers();
  }

  /// Mirrors the duty Kraveo holds for this rider (`driver.dutyStatus` of the login / `GET /partner/me`
  /// answer, read at [asOf]). The server is the truth unless this phone has a change of its own that Kraveo
  /// has not seen yet (a switch in flight, an "I went off duty" still waiting to be sent, or a switch made
  /// after [asOf]). A missing or unknown value changes nothing (older server).
  Future<void> reconcileDuty(String? serverStatus, {DateTime? asOf}) async {
    if (_disposed || !_started) return;
    final s = serverStatus?.trim().toUpperCase() ?? '';
    final serverOn = switch (s) {
      'ONLINE' || 'IN_TRANSIT' => true,
      'OFFLINE' => false,
      _ => null,
    };
    if (serverOn == null || serverOn == _onDuty) return;
    if (_dutyBusy || _dutyOffInFlight || _pendingOffSync) return;
    final changedAt = _lastDutyChangeAt;
    if (asOf != null && changedAt != null && changedAt.isAfter(asOf)) return;
    if (serverOn) {
      await _goOnLocally();
    } else {
      _goOffLocally();
      unawaited(_saveDutyPref(false));
      _say('Kraveo has you off duty. Go on duty again to receive orders.');
    }
  }

  /// A delivery is in hand but the duty switch is off (the app was restarted, or Kraveo assigned the order):
  /// keep the customer's live map alive.
  void _resumeSharingForActive() {
    if (_disposed || _active == null || _onDuty) return;
    if (_location != LocationState.off || _trackSub != null || _locTimer != null) return;
    _startLocation();
  }

  /// A delivery ended (finished or released) while the duty switch is off: location sharing stops now.
  void _stopSharingIfIdle() {
    if (_onDuty || _active != null) return;
    if (_location == LocationState.off && _trackSub == null && _locTimer == null) return;
    _stopLocation();
  }

  // =====================================================================================
  // GPS
  // =====================================================================================

  /// Going on duty: take one reading at once (it also shows the permission prompt and gives the
  /// first fix quickly), then keep sharing. A source that can stream gets a foreground-service
  /// position stream (updates continue with the screen off); otherwise, and whenever the stream
  /// cannot run, the original 10 s timer polls `read()`.
  void _startLocation() {
    _cancelTracking();
    _locTimer?.cancel();
    _locTimer = null;
    _location = LocationState.waiting;
    _lastPostAt = null;
    _trackFailures = 0;
    unawaited(_locationTick().whenComplete(() {
      if (!sharingLocation || _disposed) return;
      // Only start the foreground service once a reading worked (permission is settled);
      // otherwise poll, which names the problem and retries.
      if (_location == LocationState.ok) {
        _ensureSharing();
      } else {
        _startGpsTimer();
      }
    }));
  }

  void _stopLocation() {
    _locTimer?.cancel();
    _locTimer = null;
    _cancelTracking();
    _trackFailures = 0;
    _lastPostAt = null;
    _location = LocationState.off;
    if (!_disposed) _position.value = null;
  }

  void _cancelTracking() {
    final sub = _trackSub;
    _trackSub = null;
    if (sub != null) unawaited(sub.cancel()); // stops the foreground service and its notification
  }

  /// Streams when it can (and has not failed repeatedly), polls otherwise.
  void _ensureSharing() {
    if (!sharingLocation || _disposed || _trackSub != null) return;
    if (_trackFailures < _maxTrackFailures) {
      Stream<LocationReading>? stream;
      try {
        stream = services.location.track();
      } catch (_) {
        stream = null;
      }
      if (stream != null) {
        _locTimer?.cancel();
        _locTimer = null;
        _trackSub = stream.listen(_onTracked, onError: (_) => _trackLost(), onDone: _trackLost, cancelOnError: false);
        return;
      }
    }
    _startGpsTimer();
  }

  void _startGpsTimer() {
    _locTimer ??= Timer.periodic(services.locationInterval, (_) => _locationTick());
  }

  static const int _maxTrackFailures = 3;

  /// The stream broke (permission/GPS problem, plugin error, ended): fall back to polling, which
  /// names the problem on screen and starts the stream again once a reading works.
  void _trackLost() {
    if (_trackSub == null) return;
    _cancelTracking();
    _trackFailures++;
    _startGpsTimer();
  }

  /// One streamed reading. Shown at once, but posted only if the last post is at least
  /// [RiderServices.minPostGap] old and none is in flight.
  void _onTracked(LocationReading reading) {
    if (!sharingLocation || _disposed) return;
    if (!reading.hasFix) {
      _applyProblem(reading.problem!);
      _trackLost();
      _notify();
      return;
    }
    final changed = _location != LocationState.ok;
    _location = LocationState.ok;
    _lastFixAt = _now();
    _position.value = GeoPoint(reading.lat!, reading.lng!);
    final last = _lastPostAt;
    final due = last == null || services.uptime() - last >= services.minPostGap;
    if (due && !_posting && !_locBusy) {
      unawaited(_post(reading));
    } else if (changed) {
      _notify();
    }
  }

  Future<void> _post(LocationReading reading) async {
    _posting = true;
    _lastPostAt = services.uptime();
    try {
      final r = await _api.postLocation(reading.lat!, reading.lng!, heading: reading.heading);
      if (_disposed) return;
      _lastLocationPostFailed = !r.ok;
      _notify();
    } finally {
      _posting = false;
    }
  }

  void _applyProblem(LocationProblem problem) {
    _location = switch (problem) {
      LocationProblem.serviceOff => LocationState.serviceOff,
      LocationProblem.permissionDenied => LocationState.permissionDenied,
      LocationProblem.permissionDeniedForever => LocationState.permissionDeniedForever,
      LocationProblem.unavailable => LocationState.unavailable,
    };
    _position.value = null;
  }

  /// One GPS reading (polling, the first reading after going on duty, and the "fix" buttons).
  /// A real fix is posted; anything else is shown as a problem and nothing is sent. There is
  /// no fallback position: Kraveo would rather show "location unavailable" than a made-up
  /// point on the map.
  Future<void> _locationTick() async {
    if (!sharingLocation || _locBusy || _disposed) return;
    _locBusy = true;
    try {
      final reading = await services.location.read();
      if (!sharingLocation || _disposed) return;
      if (reading.hasFix) {
        _location = LocationState.ok;
        _lastFixAt = _now();
        _position.value = GeoPoint(reading.lat!, reading.lng!);
        _lastPostAt = services.uptime();
        final r = await _api.postLocation(reading.lat!, reading.lng!, heading: reading.heading);
        _lastLocationPostFailed = !r.ok;
      } else {
        _applyProblem(reading.problem!);
      }
      _notify();
    } finally {
      _locBusy = false;
    }
    // A reading worked while only the timer is running: (re)start the position stream.
    if (sharingLocation && !_disposed && _trackSub == null && _location == LocationState.ok) _ensureSharing();
  }

  /// The "Allow location" / "Turn on GPS" buttons.
  Future<void> fixLocation() async {
    _trackFailures = 0; // the rider acted: let the stream try again
    switch (_location) {
      case LocationState.permissionDenied:
        await services.location.requestPermission();
      case LocationState.permissionDeniedForever:
        await services.location.openSettingsFor(LocationProblem.permissionDeniedForever);
      case LocationState.serviceOff:
        await services.location.openSettingsFor(LocationProblem.serviceOff);
      default:
        break;
    }
    await _locationTick();
  }

  // =====================================================================================
  // Offers (the pool)
  // =====================================================================================

  static bool _poolable(OrderView o) =>
      (o.paymentStatus == null || o.paymentStatus == 'PAID') &&
      o.driver == null &&
      (o.status == OrderStatus.accepted || o.status == OrderStatus.preparing || o.status == OrderStatus.readyForPickup);

  Future<void> refreshOffers() async {
    if (!_onDuty || _disposed) return;
    final startedAt = _now();
    final r = await _api.fetchAvailable();
    if (!_onDuty || _disposed) return;
    if (!r.ok) {
      _offersStale = true;
      _offersLoaded = true;
      _notify();
      return;
    }
    _offersStale = false;
    _offersLoaded = true;
    _removedAt.removeWhere((_, t) => _now().difference(t) > const Duration(minutes: 2));
    _offers = r.value!.where((o) {
      if (!_poolable(o) || _dismissed.contains(o.id)) return false;
      // Gone over the socket after this request left: the poll answer is older than that news.
      final gone = _removedAt[o.id];
      return gone == null || gone.isBefore(startedAt);
    }).toList();
    _notify();
  }

  void _removeOffer(String id) {
    _removedAt[id] = _now();
    final before = _offers.length;
    _offers = _offers.where((o) => o.id != id).toList();
    if (_offers.length != before) _notify();
  }

  /// "Not for me": hides an offer on this phone only.
  void dismissOffer(String id) {
    _dismissed.add(id);
    _offers = _offers.where((o) => o.id != id).toList();
    _notify();
  }

  /// Atomic claim. Returns true only when the server confirmed this rider now has the order.
  Future<bool> claim(OrderView offer) async {
    if (_disposed || _claimingId != null) return false;
    if (_active != null) {
      _say('You already have an active delivery. Finish it first.');
      return false;
    }
    if (!_onDuty) {
      _say('Go on duty to accept orders.');
      return false;
    }
    _claimingId = offer.id;
    _notify();
    final r = await _api.claim(offer.id);
    if (_disposed) return false;
    _claimingId = null;

    if (r.ok) {
      _removeOffer(offer.id);
      final o = r.value;
      if (o != null && o.id == offer.id && !o.status.isTerminal) {
        // A combined order: the claim answer is ONE child; the others arrive with the rider's own list right away.
        _setActive(o.isGroup ? (OrderView.mergeGroup([o]) ?? o) : o);
        if (o.isGroup) await refreshActive();
      } else {
        await refreshActive();
      }
      if (_active?.id == offer.id) {
        _say(_active!.isGroup ? 'Order accepted. Collect it from ${_active!.stops.length} restaurants.' : 'Order accepted. Go to ${_active!.restaurantName}.');
        return true;
      }
      _say('Accepted, but the order details did not load yet. They will appear in a moment.');
      _notify();
      return false;
    }

    switch (r.failure) {
      case ApiFailure.conflict:
        switch (r.code) {
          case 'ALREADY_TAKEN':
            _removeOffer(offer.id);
            _say('Another rider took this order.');
          case 'RIDER_BUSY':
            _say('You already have an active delivery. Finish it first.');
            await refreshActive();
          case 'RIDER_OFFLINE':
            // Kraveo has this rider off duty (e.g. logged out elsewhere): show the truth, stop offers and GPS.
            _goOffLocally();
            _say('Kraveo has you off duty. Go on duty again to accept orders.');
          case 'ORDER_NOT_AVAILABLE':
            _removeOffer(offer.id);
            _say('This order is no longer available.');
          default:
            _say(r.message ?? 'This order could not be accepted.');
            unawaited(refreshOffers());
        }
      case ApiFailure.notFound:
        _removeOffer(offer.id);
        _say('This order is no longer available.');
      case ApiFailure.badRequest:
        _say(r.message ?? 'This order could not be accepted.');
        unawaited(refreshOffers());
      case ApiFailure.notApproved:
        _say('Your account is not active right now.');
      case ApiFailure.forbidden:
        _say(r.code == 'RIDER_PROFILE_MISSING'
            ? 'Your rider profile is not set up. Contact Kraveo support.'
            : (r.message ?? 'Kraveo did not let you take this order.'));
      case ApiFailure.rateLimited:
        _say('Too many tries. Wait a few seconds.');
      case ApiFailure.offline:
      case ApiFailure.timeout:
        // The request may have reached Kraveo. Ask before saying anything.
        await refreshActive();
        if (_active?.id == offer.id) {
          _say(_active!.isGroup ? 'Order accepted. Collect it from ${_active!.stops.length} restaurants.' : 'Order accepted. Go to ${_active!.restaurantName}.');
          return true;
        }
        _say('No internet – the order was not accepted. Try again.');
      case ApiFailure.unauthorized:
        break;
      default:
        _say('Kraveo is having trouble. Try again.');
    }
    _notify();
    return false;
  }

  // =====================================================================================
  // Active delivery
  // =====================================================================================

  void _setActive(OrderView o) {
    _active = o;
    _actionError = null;
    _offers = const [];
    // A "delivered" / "moved away" notice for the previous job must not hide the new one. A cancelled order
    // with the food already picked up stays: the rider must read what to do with it.
    final n = _notice;
    if (n != null && !(n.kind == NoticeKind.cancelled && n.order.pickedUpAt != null)) _notice = null;
    _watch(o);
    _updateConnection();
    _resumeSharingForActive();
    _notify();
  }

  /// `GET /orders?scope=active`. Restores the delivery after a restart, notices admin changes.
  Future<void> refreshActive() async {
    if (_disposed) return;
    final r = await _api.fetchActive();
    if (_disposed) return;
    if (!r.ok) {
      _activeStale = true;
      _activeChecked = true;
      _notify();
      return;
    }
    _activeStale = false;
    _activeChecked = true;
    _lastSync = _now();
    final list = r.value!;
    // A combined order comes back as one OrderView per restaurant: fold them into ONE delivery (Docs/22).
    final groups = <String, List<OrderView>>{};
    for (final o in list) {
      final g = o.group;
      if (g != null) (groups[g.id] ??= []).add(o);
    }
    final jobs = <OrderView>[
      for (final o in list)
        if (o.group == null) o,
      for (final copies in groups.values)
        if (OrderView.mergeGroup(copies) case final merged?) merged,
    ];
    final live = jobs.where((o) => !o.status.isTerminal).toList()
      ..sort((a, b) => (a.createdAt ?? DateTime(2000)).compareTo(b.createdAt ?? DateTime(2000)));

    final current = _active;
    if (current != null) {
      if (current.isGroup) {
        final copies = groups[current.group!.id];
        if (copies != null && copies.isNotEmpty) {
          _applyGroup(current, copies);
        } else {
          await _resolveMissing(current);
        }
      } else {
        final same = list.where((o) => o.id == current.id).toList();
        if (same.isNotEmpty) {
          _apply(same.first);
        } else {
          await _resolveMissing(current);
        }
      }
    }
    if (_active == null && live.isNotEmpty) _setActive(live.first);
    _otherActive = _active == null ? 0 : live.where((o) => o.id != _active!.id).length;
    _notify();
  }

  /// Merge a fresh copy of the active order (REST or socket) using `updatedAt`.
  void _apply(OrderView incoming) {
    final cur = _active;
    if (cur == null) return;
    if (cur.isGroup) {
      if (incoming.group?.id == cur.group!.id) _applyGroup(cur, [incoming]);
      return;
    }
    if (incoming.id != cur.id) return;
    if (!incoming.isAtLeastAsNewAs(cur)) return;
    _reviewLock(incoming);
    if (incoming.status == OrderStatus.delivered) {
      _finish(incoming, NoticeKind.delivered);
      return;
    }
    if (incoming.status == OrderStatus.cancelled) {
      _finish(incoming, NoticeKind.cancelled);
      return;
    }
    _active = incoming;
    _notify();
  }

  /// A fresher copy of one or more children of the combined delivery on screen: merge them in (each child by its own
  /// `updatedAt`), then act on the result exactly like a single order. The server delivers and cancels every child
  /// at once, so one delivered / cancelled child closes the whole delivery.
  void _applyGroup(OrderView cur, Iterable<OrderView> copies) {
    final merged = cur.mergedWith(copies);
    if (merged == null) return;
    _reviewLock(merged);
    if (merged.status == OrderStatus.delivered) {
      _finish(merged, NoticeKind.delivered);
      return;
    }
    if (merged.status == OrderStatus.cancelled) {
      _finish(merged, NoticeKind.cancelled);
      return;
    }
    _active = merged;
    _notify();
  }

  /// The order is locked: remember the first copy seen after the lock; a newer copy than that means an admin
  /// acted (a locked order is not changed by further attempts, they are refused before any write), so the
  /// lock is lifted. If it was lifted wrongly, the next attempt gets a free 423 and locks it again.
  void _reviewLock(OrderView incoming) {
    if (!_lockedAt.containsKey(incoming.id)) return;
    final seen = incoming.updatedAt;
    if (seen == null) return;
    final base = _lockedAt[incoming.id];
    if (base == null) {
      _lockedAt[incoming.id] = seen;
    } else if (seen.isAfter(base)) {
      _lockedAt.remove(incoming.id);
      _say('Kraveo unlocked this delivery. You can enter the customer\'s code again.');
    }
  }

  /// The active order is no longer in this rider's list: find out why before removing it.
  Future<void> _resolveMissing(OrderView cur) async {
    final r = await _api.fetchOrder(cur.id);
    if (_disposed || _active?.id != cur.id) return;
    if (r.ok) {
      final o = r.value!;
      if (o.status.isTerminal) {
        _apply(o);
        if (_active?.id == cur.id) _finish(cur.isGroup ? (cur.mergedWith([o]) ?? o) : o, o.status == OrderStatus.delivered ? NoticeKind.delivered : NoticeKind.cancelled);
      } else if (_isMine(o)) {
        _apply(o);
      } else {
        _finish(cur.isGroup ? cur : o, NoticeKind.reassigned);
      }
      return;
    }
    if (r.failure == ApiFailure.notFound || r.failure == ApiFailure.forbidden) {
      _finish(cur, NoticeKind.reassigned);
      return;
    }
    _activeStale = true; // network or server trouble: keep showing what we have
    _notify();
  }

  /// Re-reads one order after an action failed in a way that may hide a success.
  Future<void> _refreshOne(String id) async {
    final cur = _active;
    if (cur == null || !_roomIds(cur).contains(id)) return;
    final leadId = cur.id;
    final r = await _api.fetchOrder(id);
    if (_disposed || _active?.id != leadId) return;
    if (r.ok) {
      final o = r.value!;
      if (o.status.isTerminal || _isMine(o)) {
        _apply(o);
      } else {
        // Looks like it is no longer ours: confirm against the rider's own list first.
        await refreshActive();
      }
    } else if (r.failure == ApiFailure.notFound || r.failure == ApiFailure.forbidden) {
      _finish(cur, NoticeKind.reassigned);
    }
  }

  void _finish(OrderView o, NoticeKind kind) {
    _unwatch(_active != null && _active!.id == o.id ? _active! : o);
    final releasedByMe = kind == NoticeKind.reassigned && _releasingId == o.id;
    _active = null;
    _lockedAt.remove(o.id);
    _otherActive = 0;
    _actionError = null;
    _actionBusy = false;
    _releasingId = null;
    if (releasedByMe) {
      _say('Job released. It is back with other riders.');
    } else {
      _notice = DeliveryNotice(kind, o);
    }
    if (kind == NoticeKind.delivered) {
      _history = [o, ..._history.where((h) => h.id != o.id && (o.group == null || h.group?.id != o.group!.id))];
    }
    _updateConnection();
    _stopSharingIfIdle();
    _notify();
    if (_onDuty) unawaited(refreshOffers());
    if (kind == NoticeKind.delivered) unawaited(loadHistory());
  }

  void dismissNotice() {
    _notice = null;
    _notify();
  }

  /// "Picked up" (only once the restaurant marked it READY_FOR_PICKUP) and "Arrived at the drop point".
  /// A combined order is picked up stop by stop ([pickUpStop]); "Arrived" is ONE step for the whole order, allowed only
  /// once every restaurant handed over its food.
  Future<void> advance(OrderStatus target) async {
    final cur = _active;
    if (cur == null || _actionBusy || _disposed) return;
    if (cur.isGroup && target == OrderStatus.pickedUp) return; // per stop only: see pickUpStop
    final allowed = (target == OrderStatus.pickedUp && cur.status == OrderStatus.readyForPickup) ||
        (target == OrderStatus.arrivedAtGate && cur.status == OrderStatus.pickedUp);
    if (!allowed) {
      _actionError = target == OrderStatus.pickedUp
          ? 'Restaurant is still preparing. Wait until it is marked ready.'
          : (cur.isGroup ? 'Pick up the food from every restaurant first.' : 'Mark the order as picked up first.');
      _notify();
      return;
    }
    await _sendStatus(cur, cur.id, target);
  }

  /// "Picked up" for ONE restaurant of a combined order. Only that restaurant's own READY_FOR_PICKUP counts.
  Future<void> pickUpStop(String orderId) async {
    final cur = _active;
    if (cur == null || !cur.isGroup || _actionBusy || _disposed) return;
    final stop = cur.stops.where((s) => s.orderId == orderId).firstOrNull;
    if (stop == null || stop.pickedUp) return;
    if (stop.status != OrderStatus.readyForPickup) {
      _actionError = '${stop.name} is still preparing. Wait until it is marked ready.';
      _notify();
      return;
    }
    await _sendStatus(cur, orderId, OrderStatus.pickedUp);
  }

  OrderStatus? _statusNow(OrderStatus target, String id) {
    final a = _active;
    if (a == null) return null;
    if (a.isGroup && target == OrderStatus.pickedUp) return a.stops.where((s) => s.orderId == id).firstOrNull?.status;
    return a.status;
  }

  Future<void> _sendStatus(OrderView cur, String id, OrderStatus target) async {
    _actionBusy = true;
    _actionError = null;
    _notify();
    final r = await _api.updateStatus(id, target);
    if (_disposed) return;
    _actionBusy = false;
    if (r.ok) {
      final o = r.value;
      if (o != null && o.id == id) {
        _apply(o);
      } else {
        await _refreshOne(id);
      }
      _notify();
      return;
    }
    switch (r.failure) {
      case ApiFailure.offline:
      case ApiFailure.timeout:
        _actionError = 'No internet. This step was not saved – try again.';
        _notify();
        await _refreshOne(id); // it may have reached Kraveo after all
        if (_statusNow(target, id) == target) _actionError = null;
      case ApiFailure.conflict:
      case ApiFailure.badRequest:
        // INVALID_TRANSITION / ORDER_CLOSED / INVALID_STATUS: the server's status differs from ours. Re-read it.
        _actionError = switch (r.code) {
          'INVALID_TRANSITION' => target == OrderStatus.pickedUp
              ? 'The restaurant has not marked this order ready yet.'
              : 'Kraveo did not accept this step. Showing the latest status.',
          'GROUP_NOT_PICKED_UP' => 'Pick up the food from every restaurant first.',
          'ORDER_CLOSED' => 'This order is already closed.',
          _ => r.message ?? 'Kraveo did not accept this step.',
        };
        await _refreshOne(id);
      case ApiFailure.forbidden when r.code == 'ROLE_NOT_ALLOWED':
        _actionError = r.message ?? 'Kraveo did not allow this step.';
      case ApiFailure.notFound:
      case ApiFailure.forbidden:
        await _resolveMissing(cur);
      case ApiFailure.notApproved:
        _actionError = 'Your account is not active right now.';
      case ApiFailure.unauthorized:
        break;
      default:
        _actionError = 'Kraveo is having trouble. Try again.';
    }
    _notify();
  }

  /// Checks the code the customer reads out. The app never knows the right code; only Kraveo does.
  Future<OtpOutcome> verifyOtp(String code) async {
    final cur = _active;
    if (cur == null) return const OtpOutcome(OtpOutcomeKind.error, message: 'This delivery is no longer on your phone.');
    if (cur.status != OrderStatus.arrivedAtGate) {
      return const OtpOutcome(OtpOutcomeKind.error, message: 'Mark "Arrived at the drop point" first.');
    }
    final r = await _api.verifyGateOtp(cur.id, code);
    if (_disposed) return const OtpOutcome(OtpOutcomeKind.error);
    if (r.ok) {
      final o = r.value;
      if (o != null && o.id == cur.id && o.status == OrderStatus.delivered) {
        _apply(o);
      } else {
        await _refreshOne(cur.id);
        // Kraveo answered 2xx for the code: the delivery is done even if the copy is not.
        if (_active?.id == cur.id) _finish(cur.isGroup ? cur : (o ?? cur), NoticeKind.delivered);
      }
      return const OtpOutcome(OtpOutcomeKind.delivered);
    }
    switch (r.failure) {
      case ApiFailure.locked:
        // Free for the rider: Kraveo answers a locked order before it counts an attempt.
        _lockedAt.putIfAbsent(cur.id, () => null);
        _notify();
        return const OtpOutcome(OtpOutcomeKind.locked);
      case ApiFailure.badRequest when r.code == 'OTP_INVALID':
        if (r.attemptsLeft != null && r.attemptsLeft! <= 0) {
          _lockedAt.putIfAbsent(cur.id, () => null);
          _notify();
          return const OtpOutcome(OtpOutcomeKind.locked);
        }
        // Kraveo is counting attempts again, so it is not locked (an admin reset it).
        if (_lockedAt.containsKey(cur.id)) {
          _lockedAt.remove(cur.id);
          _notify();
        }
        return OtpOutcome(OtpOutcomeKind.wrong, attemptsLeft: r.attemptsLeft);
      case ApiFailure.badRequest:
      case ApiFailure.conflict:
        // NOT_AT_GATE / ORDER_CLOSED / PAYMENT_NOT_CONFIRMED...: the order is not where we think. Re-read it.
        await _refreshOne(cur.id);
        if (_notice?.kind == NoticeKind.delivered && _notice?.order.id == cur.id) return const OtpOutcome(OtpOutcomeKind.delivered);
        if (_active?.id != cur.id) return const OtpOutcome(OtpOutcomeKind.error, message: 'This delivery changed. Check the screen.');
        return OtpOutcome(OtpOutcomeKind.error,
            message: switch (r.code) {
              'NOT_AT_GATE' => 'Kraveo does not have you at the drop point yet. Mark "Arrived" first.',
              'ORDER_CLOSED' => 'This order is already closed.',
              _ => r.message ?? 'Kraveo could not check the code right now.',
            });
      case ApiFailure.offline:
      case ApiFailure.timeout:
        // The code may have been accepted just before the connection dropped. Ask Kraveo.
        await _refreshOne(cur.id);
        if (_active == null && _notice?.kind == NoticeKind.delivered && _notice?.order.id == cur.id) {
          return const OtpOutcome(OtpOutcomeKind.delivered);
        }
        return const OtpOutcome(OtpOutcomeKind.network);
      case ApiFailure.notFound:
      case ApiFailure.forbidden:
        await _resolveMissing(cur);
        return const OtpOutcome(OtpOutcomeKind.error, message: 'This delivery is no longer assigned to you.');
      case ApiFailure.notApproved:
        return const OtpOutcome(OtpOutcomeKind.error, message: 'Your account is not active right now.');
      case ApiFailure.rateLimited:
        return const OtpOutcome(OtpOutcomeKind.error, message: 'Too many tries. Wait a moment.');
      default:
        return const OtpOutcome(OtpOutcomeKind.error, message: 'Kraveo is having trouble. Try again.');
    }
  }

  /// Gives the job back to the pool. Only before pickup.
  Future<void> release() async {
    final cur = _active;
    if (cur == null || _actionBusy || _disposed) return;
    if (!cur.canRelease) {
      _actionError = cur.isGroup
          ? 'You already have food from one of the restaurants. Only Kraveo support can move this delivery now.'
          : 'You already have the food. Only Kraveo support can move this delivery now.';
      _notify();
      return;
    }
    _actionBusy = true;
    _actionError = null;
    _releasingId = cur.id;
    _notify();
    final r = await _api.release(cur.id);
    if (_disposed) return;
    _actionBusy = false;
    if (r.ok) {
      _unwatch(cur);
      _active = null;
      _lockedAt.remove(cur.id);
      _releasingId = null;
      _otherActive = 0;
      _updateConnection();
      _stopSharingIfIdle();
      _say('Job released. It is back with other riders.');
      _notify();
      if (_onDuty) await refreshOffers();
      return;
    }
    switch (r.failure) {
      case ApiFailure.offline:
      case ApiFailure.timeout:
        _actionError = 'No internet – the job was NOT released. Try again.';
        await _refreshOne(cur.id); // if it did go through, the order is no longer ours
      case ApiFailure.conflict:
      case ApiFailure.badRequest:
        _actionError = r.code == 'CANNOT_RELEASE'
            ? (cur.isGroup
                ? 'This combined order can no longer be released (food from one restaurant was already picked up). Contact Kraveo support.'
                : 'This job can no longer be released (the food was already picked up). Contact Kraveo support.')
            : (r.message ?? 'This job can no longer be released.');
        await _refreshOne(cur.id);
      case ApiFailure.notFound:
      case ApiFailure.forbidden:
        await _resolveMissing(cur);
      case ApiFailure.notApproved:
        _actionError = 'Your account is not active right now.';
      case ApiFailure.unauthorized:
        break;
      default:
        _actionError = 'Kraveo is having trouble. Try again.';
    }
    if (_active?.id != cur.id) _actionError = null;
    _releasingId = null;
    _notify();
  }

  // =====================================================================================
  // Socket
  // =====================================================================================

  void _onSocket(RiderSocketEvent e) {
    if (_disposed) return;
    switch (e) {
      case OfferAvailable(:final order):
        if (!_onDuty || _active != null || !_poolable(order) || _dismissed.contains(order.id)) return;
        _removedAt.remove(order.id);
        final existing = _offers.indexWhere((o) => o.id == order.id);
        if (existing >= 0) {
          if (order.isAtLeastAsNewAs(_offers[existing])) _offers = [..._offers]..[existing] = order;
        } else {
          _offers = [order, ..._offers];
        }
        _notify();
      case OfferUnavailable(:final id):
        _removeOffer(id);
      case OrderUpdated(:final order):
        final cur = _active;
        if (cur != null && cur.isGroup && order.group?.id == cur.group!.id) {
          if (order.status.isTerminal || _isMine(order)) {
            _applyGroup(cur, [order]);
          } else {
            unawaited(refreshActive()); // confirm with the REST list before removing anything
          }
        } else if (cur != null && cur.id == order.id) {
          if (order.status.isTerminal || _isMine(order)) {
            _apply(order);
          } else {
            unawaited(refreshActive()); // confirm with the REST list before removing anything
          }
        } else {
          final i = _offers.indexWhere((o) => o.id == order.id);
          if (i >= 0) {
            if (!_poolable(order)) {
              _removeOffer(order.id);
            } else if (order.isAtLeastAsNewAs(_offers[i])) {
              _offers = [..._offers]..[i] = order;
              _notify();
            }
          }
        }
      case SocketConnectionChanged(:final connected):
        if (connected) unawaited(pollNow()); // catch up on anything missed while disconnected
        _notify();
    }
  }

  // =====================================================================================
  // History and delivery fees
  // =====================================================================================

  /// Loads the first pages of `GET /orders?scope=history`: enough to cover the last 7 days.
  Future<void> loadHistory() async {
    if (_historyLoading || _disposed) return;
    _historyLoading = true;
    _notify();
    final weekAgo = _now().subtract(const Duration(days: 8));
    final collected = <OrderView>[];
    String? cursor;
    var hasMore = false;
    var failed = false;
    for (var page = 0; page < 6; page++) {
      final r = await _api.fetchHistory(cursor: cursor);
      if (_disposed) return;
      if (!r.ok) {
        failed = true;
        break;
      }
      collected.addAll(r.value!.orders);
      cursor = r.value!.nextCursor;
      hasMore = cursor != null;
      final oldest = r.value!.orders.isEmpty ? null : r.value!.orders.last.finishedAt;
      if (!hasMore || oldest == null || oldest.isBefore(weekAgo)) break;
    }
    _historyLoading = false;
    if (failed && collected.isEmpty) {
      _historyError = true; // keep whatever was on screen
      _notify();
      return;
    }
    _historyError = failed;
    _historyLoaded = true;
    _history = _dedupe(collected);
    _historyCursor = cursor;
    _historyHasMore = hasMore && !failed;
    _notify();
  }

  Future<void> loadMoreHistory() async {
    if (_historyLoading || !_historyHasMore || _disposed) return;
    _historyLoading = true;
    _notify();
    final r = await _api.fetchHistory(cursor: _historyCursor);
    if (_disposed) return;
    _historyLoading = false;
    if (r.ok) {
      _history = _dedupe([..._history, ...r.value!.orders]);
      _historyCursor = r.value!.nextCursor;
      _historyHasMore = _historyCursor != null;
      _historyError = false;
    } else {
      _historyError = true;
    }
    _notify();
  }

  /// One entry per order, and ONE entry per combined order: its children (each its own OrderView in the history list)
  /// are folded into a single delivery, so a combined order counts as one trip with the sum of its delivery fees.
  static List<OrderView> _dedupe(List<OrderView> list) {
    final flat = <OrderView>[
      for (final o in list)
        if (o.groupParts.isNotEmpty) ...o.groupParts else o,
    ];
    final seen = <String>{};
    final groups = <String, List<OrderView>>{};
    for (final o in flat) {
      final g = o.group;
      if (g != null) (groups[g.id] ??= []).add(o);
    }
    final out = <OrderView>[];
    final done = <String>{};
    for (final o in flat) {
      final g = o.group;
      if (g == null) {
        if (seen.add(o.id)) out.add(o);
      } else if (done.add(g.id)) {
        out.add(OrderView.mergeGroup(groups[g.id]!) ?? o);
      }
    }
    return out;
  }

  /// Orders this rider delivered (the only ones that count for fees).
  List<OrderView> get delivered => _history.where((o) => o.status == OrderStatus.delivered).toList();

  static DateTime _day(DateTime t) {
    final l = t.toLocal();
    return DateTime(l.year, l.month, l.day);
  }

  /// Delivered orders on the local calendar day of [day].
  List<OrderView> deliveredOn(DateTime day) {
    final d = _day(day);
    return delivered.where((o) => o.finishedAt != null && _day(o.finishedAt!) == d).toList();
  }

  static double feesOf(Iterable<OrderView> orders) => orders.fold(0.0, (s, o) => s + (o.deliveryFee ?? 0));

  List<OrderView> get deliveredToday => deliveredOn(_now());

  /// The last 7 local days, oldest first (for the chart).
  List<DateTime> get last7Days {
    final today = _day(_now());
    return [for (var i = 6; i >= 0; i--) today.subtract(Duration(days: i))];
  }

  List<OrderView> get deliveredThisWeek {
    final from = last7Days.first;
    return delivered.where((o) => o.finishedAt != null && !_day(o.finishedAt!).isBefore(from)).toList();
  }
}
