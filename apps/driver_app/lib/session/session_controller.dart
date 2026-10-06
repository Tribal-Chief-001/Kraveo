import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/partner_session.dart';
import '../services/partner_auth_service.dart';
import '../services/driver_api_service.dart';
import '../state/rider_controller.dart' show RiderController;

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

  /// Set by the push layer. Runs at the start of [logout], while the login token still exists, so this phone can be
  /// removed from the rider's account on the server. Best effort and time-boxed; it never blocks the logout.
  Future<void> Function()? beforeSignOut;

  SessionStatus _status = SessionStatus.checking;
  PartnerSession? _session;
  bool _expiring = false;
  String? _signOutNotice;

  /// The duty Kraveo reported at the last successful login / profile read, and when that request was sent.
  /// A separate notifier so the work screen can mirror it without rebuilding the whole app on every poll.
  final ValueNotifier<DutyReading?> dutyReading = ValueNotifier<DutyReading?>(null);

  SessionStatus get status => _status;
  PartnerSession? get session => _session;

  /// A one-off explanation for the login screen after the session was ended for a reason the rider should
  /// know (the account was paused). Reading it clears it.
  String? takeSignOutNotice() {
    final n = _signOutNotice;
    _signOutNotice = null;
    return n;
  }

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
      // "On duty" belongs to the rider who chose it, not to the phone: the next login starts from what Kraveo says.
      await prefs.remove(RiderController.dutyPrefKey);
    } catch (_) {}
  }

  Future<void> _forgetDuty() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(RiderController.dutyPrefKey);
    } catch (_) {}
  }

  /// `GET /partner/me` carries the account, the rider profile and the approval state. If a response ever lacks
  /// the rider profile, keep the details we already stored and take only the fresh account + approval fields.
  static PartnerSession _mergeFresh(PartnerSession? stored, PartnerSession fresh) {
    if (stored == null || fresh.driverId != null) return fresh;
    return stored.withUserFrom(fresh).copyWith(
          approval: fresh.approval,
          rejectionReason: fresh.rejectionReason,
          clearReason: fresh.rejectionReason == null,
        );
  }

  /// App start: validate the stored token, or fall through to the login screen.
  Future<void> restore() async {
    final token = await DriverApiService.getSavedToken();
    if (token == null || token.isEmpty) {
      _set(SessionStatus.signedOut);
      return;
    }
    final stored = await _loadStored();
    final askedAt = DateTime.now();
    final result = await auth.fetchProfile(token);
    switch (result.outcome) {
      case ProfileOutcome.valid:
        final merged = _mergeFresh(stored, result.session!);
        await _persist(merged);
        if (merged.approval != PartnerApproval.approved) await _forgetDuty();
        dutyReading.value = DutyReading(merged.dutyStatus, askedAt);
        _set(SessionStatus.signedIn, merged);
      case ProfileOutcome.unauthorized:
        await _clearAll();
        if (result.suspended) _signOutNotice = DriverApiService.accountPausedMessage;
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
    final askedAt = DateTime.now();
    final result = await auth.login(phone: phone, password: password);
    if (result.ok) {
      await DriverApiService.saveToken(result.token!);
      await _persist(result.session!);
      dutyReading.value = DutyReading(result.session!.dutyStatus, askedAt);
      _set(SessionStatus.signedIn, result.session);
    }
    return result;
  }

  /// Creates a rider account. On success the new rider is signed in straight away and the gate
  /// shows the "waiting for approval" screen.
  Future<SignupResult> signUp(PartnerSignupForm form) async {
    final result = await auth.signUp(form);
    if (result.ok && result.token != null) {
      await DriverApiService.saveToken(result.token!);
      await _persist(result.session!);
      _set(SessionStatus.signedIn, result.session);
    }
    return result;
  }

  /// Fixes and re-sends an application that is pending or was rejected.
  Future<SignupResult> resubmit(PartnerSignupForm form) async {
    final token = await DriverApiService.getSavedToken();
    if (token == null || token.isEmpty) return const SignupResult.failure(SignupFailure.unauthorized);
    final result = await auth.resubmit(token, form);
    if (result.ok) {
      final answered = result.session;
      if (answered != null) {
        final merged = _mergeFresh(_session, answered);
        await _persist(merged);
        _set(SessionStatus.signedIn, merged);
      } else {
        // Kraveo accepted it (200) without sending the account back: read the new state ourselves.
        await refreshApproval();
      }
    } else if (result.failure == SignupFailure.unauthorized) {
      await expire();
    }
    return result;
  }

  /// Asks Kraveo where the application stands. Returns true when something changed. Safe to call
  /// from a timer: a network problem keeps the current state.
  Future<bool> refreshApproval() async {
    if (_status != SessionStatus.signedIn) return false;
    final token = await DriverApiService.getSavedToken();
    if (token == null || token.isEmpty) return false;
    final askedAt = DateTime.now();
    final result = await auth.fetchProfile(token);
    switch (result.outcome) {
      case ProfileOutcome.valid:
        final before = _session;
        final fresh = _mergeFresh(before, result.session!);
        final changed = before == null || before.approval != fresh.approval || before.rejectionReason != fresh.rejectionReason;
        // Details (vehicle, plate, UPI...) that changed also need the screens to hear about it (the "update details"
        // form must not open with stale values), but they are not an "approval changed" answer for the caller.
        final detailsChanged = before == null || !before.sameDetailsAs(fresh);
        await _persist(fresh);
        if (fresh.approval != PartnerApproval.approved) await _forgetDuty();
        _session = fresh;
        dutyReading.value = DutyReading(fresh.dutyStatus, askedAt);
        if (changed || detailsChanged) notifyListeners();
        return changed;
      case ProfileOutcome.unauthorized:
        await expire(suspended: result.suspended);
        return true;
      case ProfileOutcome.unreachable:
        return false;
    }
  }

  @override
  void dispose() {
    dutyReading.dispose();
    super.dispose();
  }

  /// A 401 came back from an authenticated call: drop the token, show login.
  Future<void> expire({bool suspended = false}) async {
    if (_status == SessionStatus.signedOut || _expiring) return;
    _expiring = true;
    try {
      await _clearAll();
      if (suspended) _signOutNotice = DriverApiService.accountPausedMessage;
      _set(SessionStatus.signedOut);
    } finally {
      _expiring = false;
    }
  }

  /// Signs out. The server call is best effort and bounded, so a dead network cannot trap
  /// the partner in the app; local data is always cleared.
  Future<void> logout({Future<void> Function()? beforeClear}) async {
    final token = await DriverApiService.getSavedToken();
    final hook = beforeSignOut;
    if (hook != null) {
      try {
        await hook().timeout(const Duration(seconds: 5));
      } catch (_) {}
    }
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

/// What Kraveo said about the rider's duty ([status]: `ONLINE`, `IN_TRANSIT`, `OFFLINE` or null when it did not
/// say) in an answer to a request sent at [asOf].
class DutyReading {
  const DutyReading(this.status, this.asOf);
  final String? status;
  final DateTime asOf;
}

/// Makes the [SessionController] reachable from any screen, including pushed routes.
class SessionScope extends InheritedNotifier<SessionController> {
  const SessionScope({super.key, required SessionController controller, required super.child}) : super(notifier: controller);

  /// The controller, or null when there is no scope (screens pumped alone in tests).
  static SessionController? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SessionScope>()?.notifier;
}
