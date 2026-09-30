import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/services/partner_auth_service.dart';

/// Backend stand-in for tests that need the app already past the login gate.
class SignedInAuth implements PartnerAuthService {
  @override
  Future<LoginResult> login({required String phone, required String password}) async =>
      const LoginResult.failure(LoginFailure.server);

  @override
  Future<ProfileResult> fetchProfile(String token) async =>
      const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u1', name: 'Test Rider', runnerCode: 'RUN-1'));

  @override
  Future<void> logout(String token) async {}
}

/// Stored token so the session gate validates it and opens the home screen.
void mockSignedInPrefs() => SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt'});
