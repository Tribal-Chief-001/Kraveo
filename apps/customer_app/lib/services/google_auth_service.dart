import 'dart:async';
import 'dart:io' show SocketException;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:google_sign_in/google_sign_in.dart';
import '../config/api_config.dart';
import 'external_links.dart';

/// What the Google account picker handed back: enough to call POST /auth/google and to
/// pre-fill the sign-up form.
class GoogleCredential {
  const GoogleCredential({required this.idToken, this.email, this.displayName});

  final String idToken;
  final String? email;
  final String? displayName;
}

enum GoogleAuthFailure {
  /// The student closed the account picker. Never shown as an error.
  cancelled,

  /// The device is offline or the request to Google was interrupted.
  noNetwork,

  /// Google Play services is missing, disabled or out of date.
  playServices,

  /// The app's Google client is not configured (SHA-1 / web client id / google-services.json).
  notConfigured,

  /// Anything else (no ID token returned, unknown plugin error).
  other,
}

class GoogleAuthResult {
  const GoogleAuthResult.success(GoogleCredential this.credential)
      : failure = null,
        detail = null;
  const GoogleAuthResult.failed(GoogleAuthFailure this.failure, {this.detail}) : credential = null;

  final GoogleCredential? credential;
  final GoogleAuthFailure? failure;

  /// Technical detail for logs only; never shown to the student.
  final String? detail;

  bool get ok => credential != null;
  bool get cancelled => failure == GoogleAuthFailure.cancelled;
}

/// User-facing sentence for a failed Google step. `null` for [GoogleAuthFailure.cancelled].
String? googleFailureMessage(GoogleAuthFailure failure) {
  switch (failure) {
    case GoogleAuthFailure.cancelled:
      return null;
    case GoogleAuthFailure.noNetwork:
      return 'We couldn\'t reach Google. Check your connection and try again.';
    case GoogleAuthFailure.playServices:
      return 'Google Play services is missing or needs an update on this phone. Update it from the Play Store and try again.';
    case GoogleAuthFailure.notConfigured:
      return 'Google sign-in isn\'t set up correctly in this build. Please update the app or contact Kraveo support at $kSupportEmail.';
    case GoogleAuthFailure.other:
      return 'Google sign-in didn\'t work. Please try again.';
  }
}

/// The Google sign-in layer behind an interface so the rest of the app (and widget tests) never
/// touch the platform plugin.
abstract class GoogleAuthService {
  /// Opens the account picker and returns the Google ID token. Never throws.
  Future<GoogleAuthResult> signIn();

  /// Forgets the chosen Google account so the next sign-in shows the picker. Never throws.
  Future<void> signOut();
}

/// Real implementation on top of `google_sign_in` 7.x (Credential Manager on Android).
///
/// On Android the Web client id is read from the google-services plugin's
/// `default_web_client_id`; `--dart-define=GOOGLE_SERVER_CLIENT_ID=...` is passed as
/// `serverClientId` when provided (needed only if google-services.json has no web client).
class PlatformGoogleAuthService implements GoogleAuthService {
  Future<void>? _initialising;

  Future<void> _ensureInitialised() {
    return _initialising ??= GoogleSignIn.instance
        .initialize(serverClientId: ApiConfig.googleServerClientId.isEmpty ? null : ApiConfig.googleServerClientId)
        .catchError((Object e) {
      _initialising = null; // allow a retry on the next tap
      throw e;
    });
  }

  @override
  Future<GoogleAuthResult> signIn() async {
    try {
      await _ensureInitialised();
      if (!GoogleSignIn.instance.supportsAuthenticate()) {
        return const GoogleAuthResult.failed(GoogleAuthFailure.other, detail: 'authenticate() unsupported on this platform');
      }
      final account = await GoogleSignIn.instance.authenticate();
      final idToken = account.authentication.idToken;
      if (idToken == null || idToken.isEmpty) {
        return const GoogleAuthResult.failed(GoogleAuthFailure.notConfigured, detail: 'Google returned no ID token (web client id missing?)');
      }
      return GoogleAuthResult.success(GoogleCredential(idToken: idToken, email: account.email, displayName: account.displayName));
    } on GoogleSignInException catch (e) {
      debugPrint('[Google] sign-in failed: ${e.code} ${e.description}');
      switch (e.code) {
        case GoogleSignInExceptionCode.canceled:
          return const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
        case GoogleSignInExceptionCode.interrupted:
          return GoogleAuthResult.failed(GoogleAuthFailure.noNetwork, detail: e.description);
        case GoogleSignInExceptionCode.providerConfigurationError:
          return GoogleAuthResult.failed(GoogleAuthFailure.playServices, detail: e.description);
        case GoogleSignInExceptionCode.clientConfigurationError:
          return GoogleAuthResult.failed(GoogleAuthFailure.notConfigured, detail: e.description);
        case GoogleSignInExceptionCode.uiUnavailable:
        case GoogleSignInExceptionCode.userMismatch:
        case GoogleSignInExceptionCode.unknownError:
          return GoogleAuthResult.failed(GoogleAuthFailure.other, detail: e.description);
      }
    } on SocketException catch (e) {
      return GoogleAuthResult.failed(GoogleAuthFailure.noNetwork, detail: '$e');
    } on PlatformException catch (e) {
      debugPrint('[Google] platform error: ${e.code} ${e.message}');
      final text = '${e.code} ${e.message}'.toLowerCase();
      if (text.contains('network')) return GoogleAuthResult.failed(GoogleAuthFailure.noNetwork, detail: text);
      if (text.contains('play') && text.contains('service')) return GoogleAuthResult.failed(GoogleAuthFailure.playServices, detail: text);
      return GoogleAuthResult.failed(GoogleAuthFailure.other, detail: text);
    } on UnimplementedError catch (e) {
      return GoogleAuthResult.failed(GoogleAuthFailure.other, detail: '$e');
    } catch (e) {
      debugPrint('[Google] unexpected error: $e');
      return GoogleAuthResult.failed(GoogleAuthFailure.other, detail: '$e');
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _ensureInitialised();
      await GoogleSignIn.instance.signOut();
    } catch (e) {
      debugPrint('[Google] sign-out failed (ignored): $e');
    }
  }
}
