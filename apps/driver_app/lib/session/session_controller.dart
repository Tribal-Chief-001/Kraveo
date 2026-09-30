import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/partner_session.dart';
import '../services/partner_auth_service.dart';
import '../services/driver_api_service.dart';

enum SessionStatus {
  /// Validating a stored token.
  checking,
  signedOut,

  /// A token is stored but Kraveo could not be reached to validate it.
  unreachable,
  signedIn,
}

/// Owns the partner's login lifecycle. The JWT itself is stored by [DriverApiService] (which
/// injects it into every request); this keeps the who-am-I basics next to it. A password is
/// only ever passed straight through to the server and is never stored.
class SessionController extends ChangeNotifier {
  SessionController({PartnerAuthService? auth}) : auth = auth ?? ApiPartnerAuthService();

  static const String sessionPrefKey = 'kraveo_driver_session';

  final PartnerAuthService auth;

  SessionStatus _status = SessionStatus.checking;
  PartnerSession? _session;
  bool _expiring = false;

  SessionStatus get status => _status;
  PartnerSession? get session => _session;

  void _set(SessionStatus status, [PartnerSession? session]) {
    _status = status;
    _session = session;
    notifyListeners();
  }

  Future<PartnerSession?> _loadStored() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(sessionPrefKey);
      if (raw == null) return null;
      return PartnerSession.fromStoredJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  Future<void> _persist(PartnerSession session) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(sessionPrefKey, jsonEncode(session.toJson()));
    } catch (_) {}
  }

  Future<void> _clearAll() async {
    await DriverApiService.clearToken();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(sessionPrefKey);
    } catch (_) {}
  }

  /// App start: validate the stored token, or fall through to the login screen.
  Future<void> restore() async {
    final token = await DriverApiService.getSavedToken();
    if (token == null || token.isEmpty) {
      _set(SessionStatus.signedOut);
      return;
    }
    final stored = await _loadStored();
    final result = await auth.fetchProfile(token);
    switch (result.outcome) {
      case ProfileOutcome.valid:
        final fresh = result.session!;
        final merged = stored == null ? fresh : stored.withUserFrom(fresh);
        await _persist(merged);
        _set(SessionStatus.signedIn, merged);
      case ProfileOutcome.unauthorized:
        await _clearAll();
        _set(SessionStatus.signedOut);
      case ProfileOutcome.unreachable:
        // Keep the token: a dropped network must not log a rider off mid-shift.
        _set(SessionStatus.unreachable, stored);
    }
  }

  Future<void> retryRestore() {
    _set(SessionStatus.checking, _session);
    return restore();
  }

  /// Signs in with phone + password. On success the token and basics are saved and the
  /// status flips to signed-in; on failure the result tells the screen what to show.
  Future<LoginResult> login(String phone, String password) async {
    final result = await auth.login(phone: phone, password: password);
    if (result.ok) {
      await DriverApiService.saveToken(result.token!);
      await _persist(result.session!);
      _set(SessionStatus.signedIn, result.session);
    }
    return result;
  }

  /// A 401 came back from an authenticated call: drop the token, show login.
  Future<void> expire() async {
    if (_status == SessionStatus.signedOut || _expiring) return;
    _expiring = true;
    try {
      await _clearAll();
      _set(SessionStatus.signedOut);
    } finally {
      _expiring = false;
    }
  }

  /// Signs out. The server call is best effort and bounded, so a dead network cannot trap
  /// the partner in the app; local data is always cleared.
  Future<void> logout({Future<void> Function()? beforeClear}) async {
    final token = await DriverApiService.getSavedToken();
    try {
      await Future.wait<void>([
        if (beforeClear != null) beforeClear(),
        if (token != null && token.isNotEmpty) auth.logout(token),
      ]).timeout(const Duration(seconds: 5));
    } catch (_) {}
    await _clearAll();
    _set(SessionStatus.signedOut);
  }
}

/// Makes the [SessionController] reachable from any screen, including pushed routes.
class SessionScope extends InheritedNotifier<SessionController> {
  const SessionScope({super.key, required SessionController controller, required super.child}) : super(notifier: controller);

  /// The controller, or null when there is no scope (screens pumped alone in tests).
  static SessionController? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SessionScope>()?.notifier;
}
