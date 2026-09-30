import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/auth_results.dart';
import '../models/customer_user.dart';
import '../services/customer_api_service.dart';
import '../services/google_auth_service.dart';
import '../widgets/ui/hostel_pill.dart';

/// Where the app is in the account lifecycle. `AuthGate` renders one screen per state.
enum SessionStatus {
  /// Reading the saved token and asking the backend who it belongs to.
  checking,

  /// Saved token exists but the backend could not be reached; the user can retry.
  unreachable,

  /// No valid session: show the Google welcome screen.
  signedOut,

  /// Signed in with Google, but the sign-up profile (name, phone, student?, avatar) is incomplete.
  needsProfile,

  /// Fully set up: show the app.
  signedIn,
}

/// Result of a tap on "Continue with Google", already phrased for the student.
class SignInOutcome {
  const SignInOutcome.ok() : cancelled = false, error = null;
  const SignInOutcome.cancelled() : cancelled = true, error = null;
  const SignInOutcome.failed(String this.error) : cancelled = false;

  /// The student closed the Google picker: show nothing.
  final bool cancelled;

  /// User-facing reason, or null on success / cancel.
  final String? error;

  bool get success => !cancelled && error == null;
}

/// The signed-in student and their drop-off point. Single source of truth for
/// "who am I" so Home, Me and checkout agree.
class SessionProvider with ChangeNotifier {
  SessionProvider({SessionStatus initial = SessionStatus.checking, GoogleAuthService? googleAuth})
      : _status = initial,
        _googleAuth = googleAuth ?? PlatformGoogleAuthService();

  final GoogleAuthService _googleAuth;

  SessionStatus _status;
  CustomerUser? _user;
  bool _savingProfile = false;
  bool _signingIn = false;

  /// Name Google gave us for a brand-new account (pre-fills sign-up step 1).
  String? _googleName;
  bool _newAccount = false;

  /// Drop point picked by a non-student. The server keeps no hostel for them, so it lives only
  /// for this session and is re-asked at checkout after a restart.
  String? _localDropPoint;

  SessionStatus get status => _status;
  CustomerUser? get user => _user;
  bool get isSavingProfile => _savingProfile;
  bool get isSigningIn => _signingIn;

  /// The stored hostel mapped onto [kHostelBlocks] (legacy free-text included), or null if unset.
  String? get hostel => normalizeHostelBlock(_user?.hostelBlock, kHostelBlocks);

  /// Where the next order goes, or null when the student has not chosen yet
  /// (non-students choose at checkout).
  String? get deliveryPoint => hostel ?? _localDropPoint;

  /// Display fallback for places that must always show a block; Block 1 until one is chosen.
  /// Checkout uses [deliveryPoint] and forces an explicit choice instead.
  String get selectedHostel => deliveryPoint ?? kHostelBlocks.first;

  /// Name to pre-fill in sign-up step 1.
  String? get suggestedName => _newAccount ? (_googleName ?? _user?.name) : (_user?.name ?? _googleName);

  /// Called once per new sign-in (after Google sign-in or session restore) with the fresh user.
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

  /// "Continue with Google": account picker -> ID token -> POST /auth/google. On success the
  /// session moves to `needsProfile` or `signedIn`; otherwise the outcome says what to show.
  Future<SignInOutcome> signInWithGoogle() async {
    if (_signingIn) return const SignInOutcome.cancelled();
    _signingIn = true;
    notifyListeners();
    try {
      final google = await _googleAuth.signIn();
      final credential = google.credential;
      if (credential == null) {
        final failure = google.failure ?? GoogleAuthFailure.other;
        final message = googleFailureMessage(failure);
        return message == null ? const SignInOutcome.cancelled() : SignInOutcome.failed(message);
      }
      final result = await CustomerApiService.googleSignIn(credential.idToken);
      final user = result.user;
      if (!result.success || user == null) {
        // Forget the Google account so the next attempt shows the picker (e.g. after a 403).
        unawaited(_googleAuth.signOut());
        return SignInOutcome.failed(_serverFailure(result));
      }
      _googleName = credential.displayName?.trim();
      _newAccount = result.isNewUser;
      _begin(CustomerUser.fromJson(user), needsProfile: result.needsProfile);
      return const SignInOutcome.ok();
    } finally {
      _signingIn = false;
      notifyListeners();
    }
  }

  static String _serverFailure(GoogleLoginResult r) {
    if (r.networkError) return 'We couldn\'t reach Kraveo. Check your connection and try again.';
    if (r.roleNotAllowed) return r.message ?? 'This Google account belongs to a Kraveo partner and can\'t be used in the customer app.';
    if (r.rejected) return r.message ?? 'Google sign-in was rejected. Please try again, or pick a different Google account.';
    if (r.rateLimited) return r.message ?? 'Too many attempts. Please wait a moment and try again.';
    if (r.unavailable || (r.statusCode != null && r.statusCode! >= 500)) return 'Kraveo is unavailable right now. Please try again in a little while.';
    return r.message ?? 'We couldn\'t sign you in. Please try again.';
  }

  /// Test seam: enters a session state without a network round trip.
  @visibleForTesting
  void beginForTest(Map<String, dynamic> userJson, {bool needsProfile = false, String? googleName, bool isNewAccount = false}) {
    _googleName = googleName;
    _newAccount = isNewAccount;
    _begin(CustomerUser.fromJson(userJson), needsProfile: needsProfile);
  }

  void _begin(CustomerUser user, {required bool needsProfile}) {
    _user = user;
    _status = needsProfile ? SessionStatus.needsProfile : SessionStatus.signedIn;
    onUserLoaded?.call(user);
    notifyListeners();
  }

  /// PUT /auth/profile with only the given fields. On success the stored user is replaced by the
  /// server's copy and the status follows `needsProfile` (sign-up completes here).
  Future<ProfileResult> saveProfile({String? name, String? phone, bool? isStudent, String? hostelBlock, int? avatarId}) async {
    _savingProfile = true;
    notifyListeners();
    final result = await CustomerApiService.updateProfile(name: name, phone: phone, isStudent: isStudent, hostelBlock: hostelBlock, avatarId: avatarId);
    _savingProfile = false;
    if (_user != null && result.success && result.user != null) {
      _user = CustomerUser.fromJson(result.user!);
      _status = result.needsProfile ? SessionStatus.needsProfile : SessionStatus.signedIn;
    }
    notifyListeners();
    return result;
  }

  /// Switches the drop-off point. Students save it to their profile (optimistic, reverts on
  /// failure); non-students keep it for this session only because the server stores no hostel
  /// for them.
  Future<ProfileResult> changeHostel(String block) async {
    final current = _user;
    if (current == null) return const ProfileResult(success: false, message: 'Please log in again.');
    if (block == deliveryPoint) return const ProfileResult(success: true);
    if (current.isStudent != true) {
      _localDropPoint = block;
      notifyListeners();
      return const ProfileResult(success: true);
    }
    final previous = current;
    _user = current.copyWith(hostelBlock: block);
    notifyListeners();
    final result = await CustomerApiService.updateProfile(hostelBlock: block);
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
    // Forget the Google account too, so the next sign-in starts from the account picker.
    if (_user != null) unawaited(_googleAuth.signOut());
    _user = null;
    _googleName = null;
    _newAccount = false;
    _localDropPoint = null;
    _savingProfile = false;
    _status = SessionStatus.signedOut;
    if (wasActive) onSignedOut?.call();
    notifyListeners();
  }
}
