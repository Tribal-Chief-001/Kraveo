import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../config/app_info.dart';
import 'device_api.dart';
import 'push_messaging.dart';
import 'push_payload.dart';

/// Push notifications for the customer app (Docs/18). Owns the device-token lifecycle
/// (register after login, re-register on refresh, remove on logout), the notification
/// permission state, and the routing of notification taps.
///
/// Push is an addition: every failure here is swallowed (logged without secrets) and nothing
/// in the order or payment flow depends on it.
class PushService extends ChangeNotifier {
  PushService({
    required PushMessaging messaging,
    required LocalNotifier local,
    DeviceApi api = const HttpDeviceApi(),
    SystemSettings? settings,
    String appVersion = kAppVersion,
    this.startTimeout = const Duration(seconds: 10),
  })  : _messaging = messaging,
        _local = local,
        _api = api,
        _settings = settings,
        _appVersion = appVersion;

  final PushMessaging _messaging;
  final LocalNotifier _local;
  final DeviceApi _api;
  final SystemSettings? _settings;
  final String _appVersion;
  final Duration startTimeout;

  static const String _kRationaleShown = 'push_rationale_shown_v1';
  static const String _kSystemAsked = 'push_system_permission_asked_v1';

  // ---- state ---------------------------------------------------------------------------------

  Future<void>? _startFuture;
  bool _available = false;
  PushPermission? _permission;
  String? _userId;

  /// What the backend has been told: this user owns this token.
  String? _registeredUser;
  String? _registeredToken;

  /// Latest token delivered by `onTokenRefresh` (preferred over asking again).
  String? _refreshedToken;

  Future<void>? _syncing;
  bool _resync = false;

  PushPayload? _pendingTap;
  final List<String> _seenMessageIds = [];
  final List<StreamSubscription<Object?>> _subs = [];

  /// Set by the app shell: bring the order up to date (the existing OrderProvider path).
  void Function(PushPayload payload)? onOrderEvent;

  /// Set by the app shell: whether a tracking screen is already showing this order.
  bool Function(String orderId)? isOrderVisible;

  /// Firebase started; false when it is missing/broken (the app then works with sockets only).
  bool get available => _available;

  /// Null until the first check completes.
  PushPermission? get permission => _permission;

  /// Signed in on a phone that can do push, but the student has notifications switched off.
  bool get blocked => _available && _userId != null && _permission == PushPermission.denied;

  /// A tapped notification waiting for the app shell to route it.
  PushPayload? get pendingTap => _pendingTap;

  @visibleForTesting
  String? get registeredToken => _registeredToken;

  // ---- start ---------------------------------------------------------------------------------

  /// Starts Firebase and the message listeners. Safe to call repeatedly and never throws.
  Future<void> start() => _startFuture ??= _start();

  Future<void> _start() async {
    try {
      final ok = await _messaging.initialize().timeout(startTimeout, onTimeout: () => false);
      if (!ok) {
        debugPrint('[Push] not available on this device; continuing without push');
        return;
      }
      await _local.initialize();
      _available = true;
      try {
        _permission = await _messaging.permission();
      } catch (_) {
        _permission = PushPermission.denied;
      }
      _subs
        ..add(_messaging.tokenRefreshes.listen(_onTokenRefresh, onError: (_) {}))
        ..add(_messaging.foregroundMessages.listen(_onForeground, onError: (_) {}))
        ..add(_messaging.openedMessages.listen(_handleOpened, onError: (_) {}))
        ..add(_local.taps.listen(_handleLocalTap, onError: (_) {}));
      notifyListeners();
      // Cold start: the notification (or banner) that launched the app.
      final initial = await _messaging.initialMessage();
      if (initial != null) _handleOpened(initial);
      _handleLocalTap(await _local.launchPayload());
    } catch (e) {
      debugPrint('[Push] start failed, push disabled: ${e.runtimeType}');
    }
  }

  // ---- session -------------------------------------------------------------------------------

  /// A student is signed in: register this phone with the backend (once permission allows).
  Future<void> onSessionStarted(String userId) {
    _userId = userId;
    notifyListeners();
    return syncRegistration();
  }

  /// Sign-out is about to clear the session: tell the backend to forget this phone while the
  /// token is still valid, then drop the FCM token. Best effort, never throws.
  Future<void> onSessionEnding() async {
    final userId = _userId;
    _userId = null;
    _pendingTap = null;
    try {
      String? token = _registeredUser == userId ? _registeredToken : null;
      if (token == null && userId != null && _available && _permission == PushPermission.granted) {
        token = _refreshedToken ?? await _messaging.token().timeout(const Duration(seconds: 3));
      }
      if (token != null && token.isNotEmpty) await _api.unregister(token);
    } catch (e) {
      debugPrint('[Push] could not remove the device token (ignored): ${e.runtimeType}');
    }
    await _dropLocalToken();
    notifyListeners();
  }

  /// The session ended (logout, deletion or expiry). If [onSessionEnding] did not already clean
  /// up (expiry / deleted account), forget the token locally; the backend drops dead tokens itself.
  void onSignedOut() {
    _userId = null;
    _pendingTap = null;
    if (_registeredToken != null) unawaited(_dropLocalToken());
    notifyListeners();
  }

  Future<void> _dropLocalToken() async {
    _registeredUser = null;
    _registeredToken = null;
    _refreshedToken = null;
    if (!_available) return;
    try {
      await _messaging.deleteToken();
    } catch (_) {}
  }

  /// The app came back to the foreground: the student may have changed the setting, or an
  /// earlier registration may have failed.
  Future<void> onAppResumed() async {
    await start();
    if (!_available) return;
    try {
      final p = await _messaging.permission();
      if (p != _permission) {
        _permission = p;
        notifyListeners();
      }
    } catch (_) {}
    await syncRegistration();
  }

  // ---- registration --------------------------------------------------------------------------

  /// Registers the current token for the signed-in user if that has not happened yet.
  /// Concurrent calls collapse into one run (plus one re-check), so a token is never posted twice.
  Future<void> syncRegistration() {
    final running = _syncing;
    if (running != null) {
      _resync = true;
      return running;
    }
    return _syncing = _runSync().whenComplete(() {
      _syncing = null;
    });
  }

  Future<void> _runSync() async {
    do {
      _resync = false;
      try {
        await _syncOnce();
      } catch (e) {
        debugPrint('[Push] registration failed (will retry later): ${e.runtimeType}');
      }
    } while (_resync);
  }

  Future<void> _syncOnce() async {
    await start();
    final userId = _userId;
    if (!_available || userId == null || _permission != PushPermission.granted) return;
    final token = _refreshedToken ?? await _messaging.token();
    if (token == null || token.isEmpty || userId != _userId) return;
    if (_registeredUser == userId && _registeredToken == token) return;
    final result = await _api.register(token: token, appVersion: _appVersion);
    // unauthorized: the existing session handling takes over. failed: retried on resume / refresh.
    if (result == DeviceCallResult.ok && userId == _userId) {
      _registeredUser = userId;
      _registeredToken = token;
    }
  }

  void _onTokenRefresh(String token) {
    if (token.isEmpty) return;
    _refreshedToken = token;
    unawaited(syncRegistration());
  }

  // ---- permission ----------------------------------------------------------------------------

  /// Whether to show our one-line explanation before the system dialog: only on phones that can
  /// do push, while notifications are off, and only once.
  Future<bool> shouldShowRationale() async {
    await start();
    if (!_available || _permission != PushPermission.denied) return false;
    return !await _readFlag(_kRationaleShown);
  }

  Future<void> markRationaleShown() => _writeFlag(_kRationaleShown);

  /// Shows the system permission dialog (Android 13+) and registers the phone if granted.
  Future<PushPermission> requestPermission() async {
    await start();
    if (!_available) return PushPermission.denied;
    await _writeFlag(_kSystemAsked);
    try {
      _permission = await _messaging.requestPermission();
    } catch (_) {
      _permission = PushPermission.denied;
    }
    notifyListeners();
    await syncRegistration();
    return _permission!;
  }

  /// The "turn on notifications" button: the system dialog the first time, the system settings
  /// page afterwards (Android no longer shows the dialog once it was refused).
  Future<void> enableNotifications() async {
    if (!await _readFlag(_kSystemAsked)) {
      await requestPermission();
      return;
    }
    await _settings?.openNotificationSettings();
  }

  Future<bool> _readFlag(String key) async {
    try {
      return (await SharedPreferences.getInstance()).getBool(key) ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> _writeFlag(String key) async {
    try {
      await (await SharedPreferences.getInstance()).setBool(key, true);
    } catch (_) {}
  }

  // ---- messages ------------------------------------------------------------------------------

  void _onForeground(PushMessage m) {
    final payload = PushPayload.tryParse(m.data);
    if (payload == null || _userId == null) return;
    // FCM shows nothing while the app is open: bring the order up to date once.
    try {
      onOrderEvent?.call(payload);
    } catch (_) {}
    // Only things the student must not miss, and only if they are not already looking at that
    // order (the tracking screen updates itself).
    if (payload.event.needsAttention && !(isOrderVisible?.call(payload.orderId) ?? false)) {
      unawaited(_showBanner(payload, m));
    }
  }

  Future<void> _showBanner(PushPayload payload, PushMessage m) async {
    try {
      final title = (m.title ?? '').trim();
      final body = (m.body ?? '').trim();
      await _local.show(
        id: payload.orderId.hashCode & 0x7fffffff,
        title: title.isEmpty ? payload.event.fallbackTitle : title,
        body: body.isEmpty ? payload.event.fallbackBody : body,
        channelId: payload.event.channelId,
        payload: payload.encode(),
      );
    } catch (e) {
      debugPrint('[Push] could not show a banner (ignored): ${e.runtimeType}');
    }
  }

  void _handleOpened(PushMessage m) {
    final id = m.messageId;
    if (id != null) {
      if (_seenMessageIds.contains(id)) return;
      _seenMessageIds.add(id);
      if (_seenMessageIds.length > 30) _seenMessageIds.removeAt(0);
    }
    _setPending(PushPayload.tryParse(m.data));
  }

  void _handleLocalTap(String? raw) => _setPending(PushPayload.tryDecode(raw));

  void _setPending(PushPayload? payload) {
    if (payload == null) return; // malformed or unknown: just stay on the app's home
    _pendingTap = payload;
    notifyListeners();
  }

  /// The app shell routes the tap and clears it. Returns null when nothing is waiting.
  PushPayload? takePendingTap() {
    final t = _pendingTap;
    _pendingTap = null;
    return t;
  }

  /// Drops a waiting tap (signed out: the normal login is shown instead).
  void clearPendingTap() => _pendingTap = null;

  Future<void> openSystemSettings() async {
    await _settings?.openNotificationSettings();
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    super.dispose();
  }
}
