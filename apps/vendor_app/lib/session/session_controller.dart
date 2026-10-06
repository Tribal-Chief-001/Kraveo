import 'dart:async';
import 'dart:convert';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/partner_session.dart';
import '../services/location/location_capture.dart';
import '../services/location/vendor_location_api.dart';
import '../services/partner_auth_service.dart';
import '../services/vendor_backend.dart';
import '../services/vendor_api_service.dart';

enum SessionStatus {
  /// Validating a stored token.
  checking,
  signedOut,

  /// A token is stored but Kraveo could not be reached to validate it.
  unreachable,
  signedIn,
}

/// Owns the partner's login lifecycle. The JWT itself is stored by [VendorApiService] (which
/// injects it into every request); this keeps the who-am-I basics next to it. A password is
/// only ever passed straight through to the server and is never stored.
class SessionController extends ChangeNotifier {
  SessionController({PartnerAuthService? auth, VendorLocationApi? locationApi})
      : auth = auth ?? ApiPartnerAuthService(),
        locationApi = locationApi ?? HttpVendorLocationApi();

  static const String sessionPrefKey = 'kraveo_vendor_session';

  final PartnerAuthService auth;

  /// `PUT /partner/vendor/location` (tests pass a fake).
  final VendorLocationApi locationApi;

  /// The "Set your restaurant location" sheet is offered ONCE per app start / login. Set when it was shown (or when
  /// the owner just created the account and had the chance to detect it there); cleared on login and logout.
  bool locationPromptShown = false;

  /// Runs at the start of [logout], before the token is cleared, with the server call (best effort and bounded).
  /// The push layer uses it to `DELETE /devices` while the JWT is still valid.
  Future<void> Function()? beforeLogout;

  /// Called after the session was ended by the server (a 401), not by the owner's own log out. The gate uses it to
  /// explain why the login screen appeared.
  VoidCallback? onExpired;

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
    await VendorApiService.clearToken();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(sessionPrefKey);
    } catch (_) {}
  }

  /// `GET /partner/me` carries the account, the restaurant and the approval state. If a response ever lacks the
  /// restaurant, keep the details we already stored and take only the fresh account + approval fields.
  static PartnerSession _mergeFresh(PartnerSession? stored, PartnerSession fresh) {
    if (stored == null || fresh.vendorId != null) return fresh;
    return stored.withUserFrom(fresh).copyWith(
          approval: fresh.approval,
          rejectionReason: fresh.rejectionReason,
          clearReason: fresh.rejectionReason == null,
        );
  }

  /// App start: validate the stored token, or fall through to the login screen.
  Future<void> restore() async {
    final token = await VendorApiService.getSavedToken();
    if (token == null || token.isEmpty) {
      _set(SessionStatus.signedOut);
      return;
    }
    final stored = await _loadStored();
    final result = await auth.fetchProfile(token);
    switch (result.outcome) {
      case ProfileOutcome.valid:
        final merged = _mergeFresh(stored, result.session!);
        await _persist(merged);
        _set(SessionStatus.signedIn, merged);
      case ProfileOutcome.unauthorized:
        await _clearAll();
        _set(SessionStatus.signedOut);
      case ProfileOutcome.unreachable:
        // Keep the token: a dropped network must not log a cook out mid-shift.
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
      await VendorApiService.saveToken(result.token!);
      await _persist(result.session!);
      locationPromptShown = false; // a new login asks again (once)
      _set(SessionStatus.signedIn, result.session);
    }
    return result;
  }

  /// Creates a restaurant account. On success the new owner is signed in straight away and the gate
  /// shows the "waiting for approval" screen.
  Future<SignupResult> signUp(PartnerSignupForm form) async {
    final result = await auth.signUp(form);
    if (result.ok && result.token != null) {
      await VendorApiService.saveToken(result.token!);
      await _persist(result.session!);
      // The form just offered "Use my current location"; do not pop a sheet over the status screen right away. The
      // banner stays and the next login / app start asks again.
      locationPromptShown = true;
      _set(SessionStatus.signedIn, result.session);
    }
    return result;
  }

  /// Fixes and re-sends an application that is pending or was rejected.
  Future<SignupResult> resubmit(PartnerSignupForm form) async {
    final token = await VendorApiService.getSavedToken();
    if (token == null || token.isEmpty) return const SignupResult.failure(SignupFailure.unauthorized);
    final result = await auth.resubmit(token, form);
    if (result.ok) {
      final answered = result.session;
      final now = _session;
      // The server accepted it and reset the application to pending. If its answer has no readable account, keep what
      // we know and mark it pending, then re-read the real profile from /partner/me.
      final next = answered != null ? _mergeFresh(now, answered) : now?.copyWith(approval: PartnerApproval.pending, clearReason: true);
      if (next != null) {
        await _persist(next);
        _set(SessionStatus.signedIn, next);
      }
      if (answered == null) {
        try {
          await refreshApproval();
        } catch (_) {}
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
    final token = await VendorApiService.getSavedToken();
    if (token == null || token.isEmpty) return false;
    final result = await auth.fetchProfile(token);
    switch (result.outcome) {
      case ProfileOutcome.valid:
        final before = _session;
        final fresh = _mergeFresh(before, result.session!);
        final changed = before == null ||
            before.approval != fresh.approval ||
            before.rejectionReason != fresh.rejectionReason ||
            before.name != fresh.name ||
            before.vendorName != fresh.vendorName ||
            before.address != fresh.address ||
            before.category != fresh.category ||
            before.fssaiNumber != fresh.fssaiNumber ||
            before.hasLocation != fresh.hasLocation ||
            before.lat != fresh.lat ||
            before.lng != fresh.lng;
        await _persist(fresh);
        _session = fresh;
        if (changed) notifyListeners();
        return changed;
      case ProfileOutcome.unauthorized:
        await expire();
        return true;
      case ProfileOutcome.unreachable:
        return false;
    }
  }

  /// Saves the restaurant's own pin (`PUT /partner/vendor/location`). On success the local profile shows the pin at
  /// once and the profile is re-read from Kraveo; on failure nothing local changes (the banner stays) and the result
  /// carries the server's message.
  Future<ApiResult<SavedLocation>> saveRestaurantLocation(LocationFix fix) async {
    final result = await locationApi.save(lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM);
    final saved = result.data;
    if (!result.ok || saved == null) {
      return result.ok ? const ApiResult.failure(ApiFailure.server) : result;
    }
    final now = _session;
    if (_status == SessionStatus.signedIn && now != null) {
      final updated = now.withLocation(lat: saved.lat, lng: saved.lng, source: saved.source, setAt: saved.setAt, accuracyM: saved.accuracyM);
      await _persist(updated);
      _session = updated;
      notifyListeners();
    }
    // Ask Kraveo what it now holds; a network problem here keeps the local state.
    try {
      await refreshApproval();
    } catch (_) {}
    return result;
  }

  /// A 401 came back from an authenticated call: drop the token, show login.
  Future<void> expire() async {
    if (_status == SessionStatus.signedOut || _expiring) return;
    _expiring = true;
    try {
      await _clearAll();
      _set(SessionStatus.signedOut);
      onExpired?.call();
    } finally {
      _expiring = false;
    }
  }

  /// Signs out. The server call is best effort and bounded, so a dead network cannot trap
  /// the partner in the app; local data is always cleared.
  Future<void> logout({Future<void> Function()? beforeClear}) async {
    final token = await VendorApiService.getSavedToken();
    try {
      await Future.wait<void>([
        if (beforeClear != null) beforeClear(),
        if (beforeLogout != null) beforeLogout!(),
        if (token != null && token.isNotEmpty) auth.logout(token),
      ]).timeout(const Duration(seconds: 5));
    } catch (_) {}
    await _clearAll();
    locationPromptShown = false;
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
