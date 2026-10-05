import 'dart:async';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/push/push_controller.dart';
import 'package:driver_app/services/push/push_device_api.dart';
import 'package:driver_app/services/push/push_messaging.dart';
import 'package:driver_app/session/session_controller.dart';
import 'package:driver_app/services/partner_auth_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support_log.dart';

/// Shared, ordered record of what happened (device API calls, token deletion, session clearing).
class FakePushMessaging implements PushMessaging {
  FakePushMessaging({this.initOk = true, this.token = 'fcm-token-1', this.perm = PushPermission.granted, EventLog? log}) : log = log ?? EventLog();

  final EventLog log;
  bool initOk;
  String? token;
  PushPermission perm;

  /// What the system prompt answers when the rider is asked.
  PushPermission promptAnswer = PushPermission.granted;
  int initializeCalls = 0;
  int channelCalls = 0;
  int promptCalls = 0;
  int settingsOpened = 0;
  PushIncoming? initial;

  final refresh = StreamController<String>.broadcast();
  final foreground = StreamController<PushIncoming>.broadcast();
  final taps = StreamController<PushIncoming>.broadcast();

  @override
  Future<bool> initialize() async {
    initializeCalls++;
    return initOk;
  }

  @override
  Future<void> createChannels() async => channelCalls++;

  @override
  Future<PushPermission> permission() async => perm;

  @override
  Future<PushPermission> requestPermission() async {
    promptCalls++;
    perm = promptAnswer;
    return perm;
  }

  @override
  Future<void> openSettings() async => settingsOpened++;

  @override
  Future<String?> getToken() async => token;

  @override
  Stream<String> get onTokenRefresh => refresh.stream;

  @override
  Future<void> deleteToken() async {
    log.add('deleteToken');
    token = 'fcm-token-rotated';
  }

  @override
  Stream<PushIncoming> get onForegroundMessage => foreground.stream;

  @override
  Stream<PushIncoming> get onNotificationTap => taps.stream;

  @override
  Future<PushIncoming?> getInitialMessage() async {
    final m = initial;
    initial = null;
    return m;
  }
}

class FakeDeviceApi implements PushDeviceApi {
  FakeDeviceApi(this.log);

  final EventLog log;
  DeviceCallResult registerResult = DeviceCallResult.ok;
  DeviceCallResult unregisterResult = DeviceCallResult.ok;
  bool throwOnUnregister = false;
  final registered = <String>[];
  final versions = <String?>[];

  /// Whether the login token still existed when DELETE /devices ran.
  bool? jwtPresentOnUnregister;

  @override
  Future<DeviceCallResult> register({required String token, String? appVersion}) async {
    log.add('register:$token');
    registered.add(token);
    versions.add(appVersion);
    return registerResult;
  }

  @override
  Future<DeviceCallResult> unregister(String token) async {
    jwtPresentOnUnregister = (await DriverApiService.getSavedToken()) != null;
    log.add('unregister:$token');
    if (throwOnUnregister) throw Exception('network down');
    return unregisterResult;
  }
}

/// Signed-in auth with a choosable approval state.
class ApprovalAuth implements PartnerAuthService {
  ApprovalAuth([this.approval = PartnerApproval.approved]);

  PartnerApproval approval;

  @override
  Future<LoginResult> login({required String phone, required String password}) async => LoginResult.success(token: 'jwt-new', session: _me);

  PartnerSession get _me => PartnerSession(userId: 'u1', name: 'Test Rider', runnerCode: 'RUN-1', approval: approval);

  @override
  Future<ProfileResult> fetchProfile(String token) async => ProfileResult(ProfileOutcome.valid, _me);

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async => const SignupResult.failure(SignupFailure.server);

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async => const SignupResult.failure(SignupFailure.server);

  @override
  Future<void> logout(String token) async {}
}

/// A restored, signed-in session over a stored token. Call after resetting prefs.
Future<SessionController> restoredSession([PartnerApproval approval = PartnerApproval.approved]) async {
  await DriverApiService.clearToken();
  SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt', PushController.explainedPrefKey: true});
  final s = SessionController(auth: ApprovalAuth(approval));
  await s.restore();
  return s;
}
