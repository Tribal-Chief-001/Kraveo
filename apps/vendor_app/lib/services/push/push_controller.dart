import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'push_message.dart';
import 'push_ports.dart';

/// What the order screens should do because of a push.
enum PushActionKind {
  /// A push arrived while the app is open: reload the orders once.
  refreshOrders,

  /// A push was tapped: show the kitchen queue (and the incoming-order pop-up if [PushAction.orderId] is still waiting).
  showQueue,
}

class PushAction {
  const PushAction(this.kind, [this.orderId]);
  final PushActionKind kind;
  final String? orderId;

  @override
  String toString() => 'PushAction($kind, ${orderId ?? '-'})';
}

enum PushBanner {
  none,

  /// Notifications are off but the system can still ask: explain and offer "Allow".
  ask,

  /// Notifications are off for good: send the partner to the system settings.
  blocked,
}

Future<String> _packageVersion() async {
  try {
    final info = await PackageInfo.fromPlatform();
    return info.buildNumber.isEmpty ? info.version : '${info.version}+${info.buildNumber}';
  } catch (_) {
    return 'unknown';
  }
}

/// The brain of vendor push: Firebase start-up, device-token lifecycle, notification permission, the one-time
/// battery hint and routing of pushes to the order screens.
///
/// Push is an addition. Nothing here may stop the app from working on sockets and polling: every outside call is
/// wrapped, Firebase failing just leaves [firebaseReady] false, and nothing is awaited by the order screens.
class PushController extends ChangeNotifier {
  PushController({
    required this.messaging,
    required this.notifications,
    required this.permissions,
    required this.registry,
    Future<String> Function()? appVersion,
    this.retryDelays = const [Duration(seconds: 30), Duration(minutes: 2), Duration(minutes: 10)],
  }) : _appVersion = appVersion ?? _packageVersion;

  static const String explainedPrefKey = 'kraveo_vendor_push_explained';
  static const String askedPrefKey = 'kraveo_vendor_push_asked';
  static const String batteryDonePrefKey = 'kraveo_vendor_battery_card_done';

  final PushMessaging messaging;
  final AlarmNotifications notifications;
  final PushPermissions permissions;
  final DeviceRegistry registry;
  final Future<String> Function() _appVersion;

  /// Waits before each retry of a failed `POST /devices` (also retried when the app comes back to the foreground).
  final List<Duration> retryDelays;

  Future<void>? _initFuture;
  final List<StreamSubscription<Object?>> _subs = [];
  bool _disposed = false;

  bool _firebaseReady = false;
  bool _active = false;
  bool _signedOutKnown = false;
  bool _loggingOut = false;
  String? _userId;

  NotificationAccess? _access;
  bool _explained = false;
  bool _asked = false;
  bool _batteryDone = false;
  bool _batteryUnrestricted = false;

  String? _lastToken;
  String? _registeredToken;
  String? _registeredUser;
  String? _inFlightToken;

  /// A token the server refused (or answered 401 for): not offered again until the login or the token changes.
  String? _refusedToken;
  Future<void>? _registering;
  Timer? _retryTimer;
  int _retryAttempt = 0;

  void Function(PushAction)? _home;
  PushAction? _pendingTap;

  // ------------------------------------------------------------------ state for the UI

  /// False when Firebase could not start; the app then relies on the live connection and polling alone.
  bool get firebaseReady => _firebaseReady;
  bool get isActive => _active;
  NotificationAccess? get notificationAccess => _access;

  /// The FCM token currently registered with Kraveo for this login (null until the server accepted it).
  String? get registeredToken => _registeredToken;

  PushBanner get banner {
    if (!_active || _access == null || _access == NotificationAccess.granted) return PushBanner.none;
    if (_access == NotificationAccess.blocked || _asked) return PushBanner.blocked;
    return PushBanner.ask;
  }

  /// True once, right after an approved login, while the system has never been asked: the home screen explains
  /// why before the system dialog appears.
  bool get shouldExplain => _active && _access == NotificationAccess.denied && !_explained && !_asked;

  /// One-time hint: allow unrestricted battery so orders are never delayed.
  bool get showBatteryCard => _active && _access == NotificationAccess.granted && !_batteryDone && !_batteryUnrestricted;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  // ------------------------------------------------------------------ start-up

  /// Starts Firebase, creates the notification channels and listens for pushes and taps. Safe to call many times.
  Future<void> init() => _initFuture ??= _doInit().catchError((Object e) {
        debugPrint('[push] start-up failed: ${e.runtimeType}');
      });

  Future<void> _doInit() async {
    await _loadFlags();
    try {
      await notifications.initialize();
    } catch (e) {
      debugPrint('[push] notification channels unavailable: ${e.runtimeType}');
    }
    try {
      _firebaseReady = await messaging.initialize();
    } catch (e) {
      _firebaseReady = false;
      debugPrint('[push] Firebase failed to start: ${e.runtimeType}');
    }
    if (_disposed) return;
    _listen<String>(messaging.onTokenRefresh, _onTokenRefresh);
    _listen<PushMessage>(messaging.onForegroundMessage, _onForeground);
    _listen<PushMessage>(messaging.onOpenedFromBackground, _onTap);
    _listen<PushMessage>(notifications.onTap, _onTap);
    // The tap that started the app from closed.
    for (final read in [messaging.getInitialMessage, notifications.launchTap]) {
      try {
        final first = await read();
        if (first != null) _onTap(first);
      } catch (_) {}
    }
    _changed();
  }

  void _listen<T>(Stream<T> stream, void Function(T) onData) {
    try {
      _subs.add(stream.listen(onData, onError: (Object _) {}));
    } catch (_) {}
  }

  Future<void> _loadFlags() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _explained = prefs.getBool(explainedPrefKey) ?? false;
      _asked = prefs.getBool(askedPrefKey) ?? false;
      _batteryDone = prefs.getBool(batteryDonePrefKey) ?? false;
    } catch (_) {}
  }

  Future<void> _saveFlag(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(key, true);
    } catch (_) {}
  }

  // ------------------------------------------------------------------ session

  /// An approved partner is signed in (login, or the app started with a saved session). Idempotent.
  Future<void> onSignedIn(String userId) async {
    _signedOutKnown = false;
    final same = _active && _userId == userId;
    if (!same) _refusedToken = null;
    _active = true;
    _loggingOut = false;
    _userId = userId;
    await init();
    if (!_active || _disposed) return;
    if (!same) await refreshPermission();
    _changed();
    await _ensureRegistered();
  }

  /// Signed in, but the account is not (or no longer) approved: no pushes are needed until it is.
  void onNotApproved() {
    _active = false;
    _retryTimer?.cancel();
    _changed();
  }

  /// Logged out (or the session expired). A logout that went through [unregisterForLogout] has nothing left to do.
  void onSignedOut() {
    final hadToken = _registeredToken != null;
    _active = false;
    _signedOutKnown = true;
    _userId = null;
    _pendingTap = null;
    _retryTimer?.cancel();
    _retryAttempt = 0;
    _registeredToken = null;
    _registeredUser = null;
    _lastToken = null;
    _refusedToken = null;
    // Session expired: the server cannot be asked any more, but this phone should stop being this login's device.
    if (hadToken && !_loggingOut) unawaited(_deleteLocalToken());
    _changed();
  }

  Future<void> _deleteLocalToken() async {
    try {
      await messaging.deleteToken().timeout(const Duration(seconds: 3));
    } catch (_) {}
  }

  /// Logout step 1 (before the session is cleared): `DELETE /devices`, then forget the FCM token. Best effort and
  /// bounded; never throws, never blocks logout for long.
  Future<void> unregisterForLogout() async {
    if (!_active) return;
    _loggingOut = true;
    _retryTimer?.cancel();
    try {
      final token = _lastToken ?? await messaging.getToken().timeout(const Duration(seconds: 1));
      if (token != null && token.isNotEmpty) await registry.unregister(token).timeout(const Duration(seconds: 3));
    } catch (_) {}
    try {
      await messaging.deleteToken().timeout(const Duration(seconds: 1));
    } catch (_) {}
    _registeredToken = null;
    _registeredUser = null;
    _lastToken = null;
  }

  /// The app came back to the foreground: permission may have been changed in settings; retry a failed registration.
  Future<void> onResumed() async {
    if (!_active) return;
    await refreshPermission();
    if (_registeredToken == null) {
      _retryAttempt = 0;
      await _ensureRegistered();
    }
  }

  // ------------------------------------------------------------------ token

  Future<void> _ensureRegistered() => _registering ??= _register().whenComplete(() => _registering = null);

  Future<void> _register() async {
    await init();
    if (!_active || _loggingOut || !_firebaseReady) return;
    String? token;
    try {
      token = await messaging.getToken();
    } catch (_) {}
    if (token == null || token.isEmpty) {
      _scheduleRetry();
      return;
    }
    await _registerToken(token);
  }

  Future<void> _registerToken(String token) async {
    if (!_active || _loggingOut) return;
    _lastToken = token;
    if (_registeredToken == token && _registeredUser == _userId) return; // already registered: never twice
    if (_inFlightToken == token || _refusedToken == token) return;
    _inFlightToken = token;
    final user = _userId;
    RegisterOutcome outcome;
    try {
      outcome = await registry.register(token: token, appVersion: await _appVersion());
    } catch (_) {
      outcome = RegisterOutcome.failed;
    } finally {
      _inFlightToken = null;
    }
    if (!_active || _loggingOut || _userId != user) return;
    switch (outcome) {
      case RegisterOutcome.ok:
        _registeredToken = token;
        _registeredUser = user;
        _retryAttempt = 0;
        _retryTimer?.cancel();
        _changed();
      case RegisterOutcome.failed:
        _scheduleRetry();
      case RegisterOutcome.unauthorized:
      case RegisterOutcome.rejected:
        _refusedToken = token; // the session gate handles a dead session; a refusal will not change by asking again
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    if (!_active || _retryAttempt >= retryDelays.length) return;
    _retryTimer = Timer(retryDelays[_retryAttempt++], () {
      if (_active && !_disposed) unawaited(_ensureRegistered());
    });
  }

  void _onTokenRefresh(String token) {
    if (token.isEmpty) return;
    _lastToken = token;
    if (_active) unawaited(_registerToken(token));
  }

  // ------------------------------------------------------------------ permission + battery

  Future<void> refreshPermission() async {
    NotificationAccess access;
    try {
      access = await permissions.notificationAccess();
    } catch (_) {
      access = NotificationAccess.denied;
    }
    _access = access;
    if (access == NotificationAccess.granted && !_batteryDone) {
      try {
        _batteryUnrestricted = await permissions.batteryUnrestricted();
      } catch (_) {}
    }
    _changed();
  }

  /// The explainer was shown (whatever the answer): do not show it again.
  void markExplained() {
    if (_explained) return;
    _explained = true;
    unawaited(_saveFlag(explainedPrefKey));
    _changed();
  }

  /// Shows the system dialog. Call after the partner agreed to the explanation.
  Future<void> requestNotifications() async {
    _explained = true;
    _asked = true;
    unawaited(_saveFlag(explainedPrefKey));
    unawaited(_saveFlag(askedPrefKey));
    try {
      _access = await permissions.requestNotifications();
    } catch (_) {
      _access = NotificationAccess.denied;
    }
    if (_access == NotificationAccess.granted && !_batteryDone) {
      try {
        _batteryUnrestricted = await permissions.batteryUnrestricted();
      } catch (_) {}
    }
    _changed();
    if (_active) unawaited(_ensureRegistered());
  }

  Future<void> openNotificationSettings() async {
    try {
      await permissions.openSettings();
    } catch (_) {}
  }

  /// "Allow unrestricted battery" pressed: system dialog, then never ask again.
  Future<void> requestBatteryUnrestricted() async {
    _batteryDone = true;
    unawaited(_saveFlag(batteryDonePrefKey));
    try {
      _batteryUnrestricted = await permissions.requestBatteryUnrestricted();
    } catch (_) {}
    _changed();
  }

  void dismissBatteryCard() {
    if (_batteryDone) return;
    _batteryDone = true;
    unawaited(_saveFlag(batteryDonePrefKey));
    _changed();
  }

  // ------------------------------------------------------------------ messages and taps

  /// A push while the app is open. The existing live connection already updates the screen and rings the in-app
  /// alarm, so no banner is shown (no double alarm); the queue is just reloaded once.
  void _onForeground(PushMessage m) {
    if (!_active || !m.isActionable) return;
    _home?.call(const PushAction(PushActionKind.refreshOrders));
  }

  void _onTap(PushMessage m) {
    // Unknown or malformed: the app is simply open on its home screen.
    if (!m.isActionable) return;
    if (_signedOutKnown) return; // logged out: the login screen is shown instead
    final action = PushAction(PushActionKind.showQueue, m.event == PushEvent.newOrder ? m.orderId : null);
    final home = _home;
    if (home != null && _active) {
      home(action);
    } else {
      _pendingTap = action; // cold start: the session is still being checked, or the home screen is not up yet
    }
  }

  /// The home screen starts listening. A tap that arrived before it existed is delivered now. Returns the detach function.
  VoidCallback attachHome(void Function(PushAction) handler) {
    _home = handler;
    final pending = _pendingTap;
    if (pending != null && _active) {
      _pendingTap = null;
      scheduleMicrotask(() {
        if (identical(_home, handler)) handler(pending);
      });
    }
    return () {
      if (identical(_home, handler)) _home = null;
    };
  }

  @override
  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}

/// Makes the [PushController] reachable from the order screens.
class PushScope extends InheritedNotifier<PushController> {
  const PushScope({super.key, required PushController controller, required super.child}) : super(notifier: controller);

  /// The controller, or null when the app runs without push (tests, or Firebase turned off).
  static PushController? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<PushScope>()?.notifier;
}
