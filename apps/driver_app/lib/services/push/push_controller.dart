import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../models/partner_session.dart';
import '../../session/session_controller.dart';
import 'push_device_api.dart';
import 'push_messaging.dart';
import 'push_payload.dart';

/// The screen that reacts to pushes (the rider home). The controller hands it validated payloads only.
abstract class PushUiHandler {
  /// A push arrived while the app is open: refresh the pool / active order once. No banner is shown.
  void onPushForeground(PushPayload payload);

  /// The rider tapped a notification (cold start, background or foreground): go to the right place.
  void onPushTap(PushPayload payload);
}

/// Owns everything push on the rider side: Firebase start, channels, the permission state, the device token
/// lifecycle (`POST /devices` after login, again on refresh, `DELETE /devices` before logout) and routing of
/// incoming pushes. Push is an addition: any failure here leaves the app working on sockets and polling.
class PushController extends ChangeNotifier {
  PushController({
    required this.messaging,
    required this.api,
    Future<String?> Function()? appVersion,
    List<Duration> retryDelays = const [Duration(seconds: 30), Duration(minutes: 2), Duration(minutes: 10)],
    DateTime Function()? now,
  })  : _appVersion = appVersion,
        _retryDelays = retryDelays,
        _now = now ?? DateTime.now;

  /// SharedPreferences key: the explain-then-ask sheet was already shown on this phone.
  static const String explainedPrefKey = 'kraveo_driver_push_explained';

  /// A cold-start tap that nobody could act on for this long is stale and dropped.
  static const Duration pendingTapTtl = Duration(minutes: 2);

  final PushMessaging messaging;
  final PushDeviceApi api;
  final Future<String?> Function()? _appVersion;
  final List<Duration> _retryDelays;
  final DateTime Function() _now;

  SessionController? _session;
  bool _disposed = false;
  bool _started = false;
  Future<void>? _startFuture;
  bool _available = false;
  bool _eligible = false;
  String? _userId;
  PushPermission _permission = PushPermission.unknown;
  bool _explained = true; // until the preference is read, never nag

  StreamSubscription<String>? _refreshSub;
  StreamSubscription<PushIncoming>? _foregroundSub;
  StreamSubscription<PushIncoming>? _tapSub;

  // Token lifecycle.
  String? _registeredToken;
  String? _registeredFor;
  String? _inflightToken;
  Future<void>? _syncing;
  bool _rejected = false;
  int _retryIndex = 0;
  Timer? _retryTimer;

  // Incoming pushes.
  PushUiHandler? _ui;
  PushPayload? _pendingTap;
  DateTime? _pendingTapAt;
  final Map<String, DateTime> _seenForeground = {};
  final Map<String, DateTime> _seenTaps = {};

  /// Firebase started and push can work on this phone.
  bool get available => _available;

  PushPermission get permission => _permission;

  /// True once this signed-in, approved rider's device is known to Kraveo.
  bool get registered => _registeredToken != null;

  bool get eligible => _eligible;

  /// The persistent "Turn on notifications or you will miss deliveries" warning.
  bool get showBlockedBanner => _available && _eligible && _permission.isBlocked;

  /// The explain-then-ask sheet should be shown now (once per phone).
  bool get needsExplanation => _available && _eligible && !_explained && _permission == PushPermission.notDetermined;

  /// Banner button label: opens the phone settings when the system will not ask again.
  bool get mustOpenSettings => _permission == PushPermission.deniedPermanently;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  // ===================================================================================
  // Start and session
  // ===================================================================================

  /// Follows the login lifecycle: registers the device when an approved rider is signed in, forgets it when not.
  /// Also starts Firebase (once). Safe to call from `initState`: nothing here blocks the first frame.
  void attach(SessionController session) {
    if (_session == session) return;
    _session?.removeListener(_onSession);
    _session = session;
    session.beforeSignOut = _beforeSignOut;
    session.addListener(_onSession);
    unawaited(start());
    _onSession();
  }

  /// Firebase init, channels, listeners, cold-start message. Idempotent; never throws.
  Future<void> start() => _startFuture ??= _start();

  Future<void> _start() async {
    try {
      _available = await messaging.initialize();
    } catch (_) {
      _available = false;
    }
    if (_disposed) return;
    _started = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      _explained = prefs.getBool(explainedPrefKey) ?? false;
    } catch (_) {
      _explained = false;
    }
    if (!_available) {
      _notify();
      return;
    }
    try {
      await messaging.createChannels();
    } catch (_) {}
    try {
      _refreshSub = messaging.onTokenRefresh.listen(_onTokenRefresh, onError: (_) {});
      _foregroundSub = messaging.onForegroundMessage.listen(_onForeground, onError: (_) {});
      _tapSub = messaging.onNotificationTap.listen((m) => _onTap(m), onError: (_) {});
    } catch (_) {}
    await refreshPermission();
    try {
      final initial = await messaging.getInitialMessage();
      if (initial != null) _onTap(initial);
    } catch (_) {}
    if (_eligible) unawaited(syncToken());
    _notify();
  }

  void _onSession() {
    final s = _session;
    if (s == null || _disposed) return;
    final me = s.session;
    final eligible = s.status == SessionStatus.signedIn && me != null && me.approval == PartnerApproval.approved;
    final userId = eligible ? me.userId : null;
    if (eligible && (!_eligible || _userId != userId)) {
      _eligible = true;
      _userId = userId;
      _rejected = false;
      _retryIndex = 0;
      unawaited(_activate());
    } else if (!eligible && _eligible) {
      _deactivate();
    }
    // A cold-start tap is only worth keeping while a login might still be restored.
    if (s.status == SessionStatus.signedOut) _clearPendingTap();
  }

  Future<void> _activate() async {
    await start();
    if (_disposed || !_eligible) return;
    await refreshPermission();
    await syncToken();
    _deliverPendingTap();
    _notify();
  }

  /// The session ended without a clean logout (401, suspension): drop local state and rotate the phone's token so
  /// the previous account's pushes stop. Best effort.
  void _deactivate() {
    _eligible = false;
    _userId = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    _inflightToken = null;
    final hadToken = _registeredToken != null;
    _registeredToken = null;
    _registeredFor = null;
    _clearPendingTap();
    if (hadToken && _available) unawaited(_safe(messaging.deleteToken));
    _notify();
  }

  // ===================================================================================
  // Permission
  // ===================================================================================

  Future<void> refreshPermission() async {
    if (!_available) return;
    try {
      final p = await messaging.permission();
      if (_disposed) return;
      if (p != _permission) {
        _permission = p;
        _notify();
      }
    } catch (_) {}
  }

  /// The explain sheet was shown (whatever the rider answered): do not show it again.
  Future<void> markExplained() async {
    if (_explained) return;
    _explained = true;
    _notify();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(explainedPrefKey, true);
    } catch (_) {}
  }

  /// Shows the system prompt. Returns the resulting permission.
  Future<PushPermission> requestPermission() async {
    if (!_available) return _permission;
    PushPermission result;
    try {
      result = await messaging.requestPermission();
    } catch (_) {
      result = _permission;
    }
    if (_disposed) return result;
    _permission = result;
    _notify();
    if (result.isGranted && _eligible) unawaited(syncToken());
    return result;
  }

  /// The banner button: ask again where the system still will, otherwise open the phone settings.
  Future<void> fixPermission() async {
    if (!_available) return;
    if (_permission == PushPermission.deniedPermanently) {
      await _safe(messaging.openSettings);
      return;
    }
    final before = _permission;
    final result = await requestPermission();
    if (result.isGranted) return;
    // The system showed nothing (it will not ask again), or - Android 7-12 - there is no permission dialog at all and the switch
    // lives in the app's notification settings: go there instead of leaving the button dead. A refusal of a dialog that was just
    // shown (before == notDetermined, now denied) is respected: no second screen right after "Don't allow".
    if (result == PushPermission.notDetermined || result == PushPermission.deniedPermanently || before == PushPermission.denied) {
      await _safe(messaging.openSettings);
    }
  }

  /// The app came back to the foreground: the rider may have changed the setting, or an earlier register failed.
  Future<void> onAppResumed() async {
    if (!_started) return;
    await refreshPermission();
    if (_eligible && _registeredToken == null && !_rejected) unawaited(syncToken());
  }

  // ===================================================================================
  // Token lifecycle
  // ===================================================================================

  /// Reads the current FCM token and registers it, unless this exact token is already registered for this rider.
  Future<void> syncToken() {
    return _syncing ??= _doSync().whenComplete(() => _syncing = null);
  }

  Future<void> _doSync() async {
    if (!_available || !_eligible || _rejected) return;
    String? token;
    try {
      token = await messaging.getToken();
    } catch (_) {}
    if (token == null || token.isEmpty) {
      _scheduleRetry();
      return;
    }
    await _register(token);
  }

  void _onTokenRefresh(String token) {
    if (!_eligible || _rejected) return; // the next login reads a fresh token anyway
    unawaited(_register(token));
  }

  Future<void> _register(String token) async {
    if (!_eligible || token.isEmpty) return;
    final userId = _userId;
    if (_registeredToken == token && _registeredFor == userId) return; // already known: no duplicate POST
    if (_inflightToken == token) return;
    _inflightToken = token;
    DeviceCallResult result;
    try {
      String? version;
      try {
        version = await _appVersion?.call();
      } catch (_) {}
      result = await api.register(token: token, appVersion: version);
    } catch (_) {
      result = DeviceCallResult.retry;
    }
    if (_inflightToken == token) _inflightToken = null;
    // The rider logged out / changed while the call was in flight.
    if (_disposed || !_eligible || _userId != userId) return;
    switch (result) {
      case DeviceCallResult.ok:
        _registeredToken = token;
        _registeredFor = userId;
        _retryIndex = 0;
        _retryTimer?.cancel();
        _retryTimer = null;
        _notify();
      case DeviceCallResult.retry:
        _scheduleRetry();
      case DeviceCallResult.rejected:
        // The server will not take this device (old backend, role mismatch). Quietly stop for this session.
        _rejected = true;
      case DeviceCallResult.unauthorized:
        break; // the session gate already signs the rider out
    }
  }

  void _scheduleRetry() {
    if (_disposed || !_eligible || _rejected || _retryTimer != null) return;
    if (_retryIndex >= _retryDelays.length) return; // the next resume / token refresh tries again
    final delay = _retryDelays[_retryIndex++];
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (_eligible && _registeredToken == null) unawaited(syncToken());
    });
  }

  /// Called by the session controller at the start of a logout, BEFORE the login token is cleared. Removes this
  /// phone from the rider's account on the server and rotates the FCM token. Best effort and bounded, so a dead
  /// network can never trap the rider in the app.
  Future<void> _beforeSignOut() async {
    _retryTimer?.cancel();
    _retryTimer = null;
    if (!_available) return;
    // Never registered (e.g. a rider still waiting for approval): nothing to remove.
    if (!_eligible && _registeredToken == null && _inflightToken == null) return;
    try {
      await _signOutSteps().timeout(const Duration(seconds: 4));
    } catch (_) {}
    _registeredToken = null;
    _registeredFor = null;
    _inflightToken = null;
  }

  Future<void> _signOutSteps() async {
    var token = _registeredToken ?? _inflightToken;
    token ??= await _safe(messaging.getToken).timeout(const Duration(seconds: 2), onTimeout: () => null);
    if (token != null && token.isNotEmpty) {
      try {
        await api.unregister(token).timeout(const Duration(seconds: 3));
      } catch (_) {}
    }
    await _safe(messaging.deleteToken);
  }

  Future<T?> _safe<T>(Future<T> Function() call) async {
    try {
      return await call();
    } catch (_) {
      return null;
    }
  }

  // ===================================================================================
  // Incoming pushes
  // ===================================================================================

  /// Remembers [key] for [window] and says whether it was already seen.
  bool _seenBefore(Map<String, DateTime> seen, String key, Duration window) {
    final now = _now();
    seen.removeWhere((_, t) => now.difference(t) > window);
    if (seen.containsKey(key)) return true;
    seen[key] = now;
    return false;
  }

  String _key(PushIncoming m, PushPayload p) => m.messageId != null && m.messageId!.isNotEmpty ? 'id:${m.messageId}' : '${p.event.key}:${p.orderId}';

  void _onForeground(PushIncoming m) {
    try {
      final payload = PushPayload.tryParse(m.data);
      if (payload == null || !_eligible) return;
      if (_seenBefore(_seenForeground, _key(m, payload), const Duration(seconds: 10))) return;
      _ui?.onPushForeground(payload);
    } catch (_) {}
  }

  void _onTap(PushIncoming m) {
    try {
      final payload = PushPayload.tryParse(m.data);
      if (payload == null) return; // unknown payload: the app simply stays where it opened
      final status = _session?.status;
      if (status == SessionStatus.signedOut) return;
      if (_seenBefore(_seenTaps, _key(m, payload), const Duration(seconds: 30))) return;
      _pendingTap = payload;
      _pendingTapAt = _now();
      _deliverPendingTap();
    } catch (_) {}
  }

  void _deliverPendingTap() {
    final tap = _pendingTap;
    if (tap == null) return;
    final at = _pendingTapAt;
    if (at != null && _now().difference(at) > pendingTapTtl) {
      _clearPendingTap();
      return;
    }
    final ui = _ui;
    if (ui == null || !_eligible) return; // held until the home screen is up (cold start)
    _clearPendingTap();
    try {
      ui.onPushTap(tap);
    } catch (_) {}
  }

  void _clearPendingTap() {
    _pendingTap = null;
    _pendingTapAt = null;
  }

  /// The home screen starts listening. A tap that launched the app is delivered now.
  void attachUi(PushUiHandler handler) {
    _ui = handler;
    _deliverPendingTap();
  }

  void detachUi(PushUiHandler handler) {
    if (identical(_ui, handler)) _ui = null;
  }

  @override
  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    _refreshSub?.cancel();
    _foregroundSub?.cancel();
    _tapSub?.cancel();
    _session?.removeListener(_onSession);
    if (_session?.beforeSignOut == _beforeSignOut) _session?.beforeSignOut = null;
    super.dispose();
  }
}

/// Makes the [PushController] reachable from the home screen (null in tests that do not use push).
class PushScope extends InheritedNotifier<PushController> {
  const PushScope({super.key, required PushController? controller, required super.child}) : super(notifier: controller);

  static PushController? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<PushScope>()?.notifier;
}
