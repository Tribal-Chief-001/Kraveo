import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/auth_results.dart';
import '../models/customer_user.dart';
import '../services/customer_api_service.dart';
import '../widgets/ui/hostel_pill.dart';

/// Where the app is in the account lifecycle. `AuthGate` renders one screen per state.
enum SessionStatus {
  /// Reading the saved token and asking the backend who it belongs to.
  checking,

  /// Saved token exists but the backend could not be reached; the user can retry.
  unreachable,

  /// No valid session: show phone login.
  signedOut,

  /// Signed in, but name / drop-off point are missing: show first-time setup.
  needsProfile,

  /// Fully set up: show the app.
  signedIn,
}

/// The signed-in student and their drop-off point. Single source of truth for
/// "who am I" so Home, Me and checkout agree.
class SessionProvider with ChangeNotifier {
  SessionProvider({SessionStatus initial = SessionStatus.checking}) : _status = initial;

  SessionStatus _status;
  CustomerUser? _user;
  bool _savingProfile = false;

  SessionStatus get status => _status;
  CustomerUser? get user => _user;
  bool get isSavingProfile => _savingProfile;

  /// The stored hostel mapped onto [kHostelBlocks] (legacy free-text included), or null if unset.
  String? get hostel => normalizeHostelBlock(_user?.hostelBlock, kHostelBlocks);

  /// Drop-off used across the app; Block 1 until the student picks one.
  String get selectedHostel => hostel ?? kHostelBlocks.first;

  /// Called once per new sign-in (after OTP or session restore) with the fresh user.
  /// Lets the app shell seed provider state such as the coin balance.
  void Function(CustomerUser user)? onUserLoaded;

  /// Called when the session ends for any reason (logout, deletion, expiry).
  VoidCallback? onSignedOut;

  /// Validates the saved token at app start.
  Future<void> restore() async {
    if (_status != SessionStatus.checking) {
      // A retry from the "can't reach Kraveo" screen. (The first call starts as `checking`,
      // and notifying from initState would rebuild the tree mid-build.)
      _status = SessionStatus.checking;
      notifyListeners();
    }
    final result = await CustomerApiService.fetchProfile();
    if (result == null) return _endSession();
    if (result.networkError) {
      _status = SessionStatus.unreachable;
      notifyListeners();
      return;
    }
    if (!result.success || result.user == null) {
      // 401 or an unusable answer: the saved token is no good.
      await CustomerApiService.clearToken();
      return _endSession();
    }
    final user = CustomerUser.fromJson(result.user!);
    if (user.role != 'STUDENT') {
      await CustomerApiService.clearToken();
      return _endSession();
    }
    _begin(user, needsProfile: result.needsProfile);
  }

  /// Called by the login screen after a successful OTP check (token already saved).
  void startFromVerify(VerifyOtpResult result) {
    final map = result.user;
    if (map == null) return;
    _begin(CustomerUser.fromJson(map), needsProfile: result.needsProfile);
  }

  void _begin(CustomerUser user, {required bool needsProfile}) {
    _user = user;
    _status = needsProfile ? SessionStatus.needsProfile : SessionStatus.signedIn;
    onUserLoaded?.call(user);
    notifyListeners();
  }

  /// Saves name + drop-off point. On success the session moves to `signedIn`.
  Future<ProfileResult> saveProfile({required String name, required String hostelBlock}) async {
    _savingProfile = true;
    notifyListeners();
    final result = await CustomerApiService.updateProfile(name: name, hostelBlock: hostelBlock);
    _savingProfile = false;
    if (result.success && result.user != null) {
      final saved = CustomerUser.fromJson(result.user!);
      _user = saved;
      _status = result.needsProfile ? SessionStatus.needsProfile : SessionStatus.signedIn;
    }
    notifyListeners();
    return result;
  }

  /// Optimistically switches the drop-off point, then persists it. Reverts on failure.
  Future<ProfileResult> changeHostel(String block) async {
    final current = _user;
    if (current == null) return const ProfileResult(success: false, message: 'Please log in again.');
    if (block == hostel) return const ProfileResult(success: true);
    final previous = current;
    _user = current.copyWith(hostelBlock: block);
    notifyListeners();
    final result = await CustomerApiService.updateProfile(name: current.name ?? '', hostelBlock: block);
    if (_user == null) return result; // signed out meanwhile
    if (result.success && result.user != null) {
      _user = CustomerUser.fromJson(result.user!);
    } else {
      _user = previous;
    }
    notifyListeners();
    return result;
  }

  /// Ends the session now and tells the backend in the background.
  Future<void> logout() async {
    final token = await CustomerApiService.getSavedToken();
    unawaited(CustomerApiService.logout(token: token));
    await CustomerApiService.clearToken();
    _endSession();
  }

  /// DELETE /auth/account. On success the session ends; otherwise the result explains why not.
  Future<ActionResult> deleteAccount() async {
    final result = await CustomerApiService.deleteAccount();
    if (result.success) {
      await CustomerApiService.clearToken();
      _endSession();
    }
    return result;
  }

  /// A 401 came back from an authenticated call (token already cleared by the service).
  void expire() => _endSession();

  /// Retry after `unreachable`.
  Future<void> retryRestore() => restore();

  void _endSession() {
    final wasActive = _user != null || _status != SessionStatus.signedOut;
    _user = null;
    _savingProfile = false;
    _status = SessionStatus.signedOut;
    if (wasActive) onSignedOut?.call();
    notifyListeners();
  }
}
