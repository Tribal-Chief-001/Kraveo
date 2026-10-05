import 'dart:async';
import 'package:vendor_app/models/partner_session.dart';
import 'package:vendor_app/services/location/location_capture.dart';
import 'package:vendor_app/services/location/location_scope.dart';
import 'package:vendor_app/services/location/vendor_location_api.dart';
import 'package:vendor_app/services/partner_auth_service.dart';
import 'package:vendor_app/services/vendor_backend.dart';

/// Real campus-area coordinates (BH1 is at 23.074861, 76.859889).
const kKitchenLat = 23.0741;
const kKitchenLng = 76.8567;

/// Scripted [LocationCapture]: each `detect()` hands out the next result (the last one repeats).
class FakeCapture implements LocationCapture {
  FakeCapture(this.script);

  FakeCapture.fix({double accuracy = 12, double lat = kKitchenLat, double lng = kKitchenLng})
      : script = [CaptureResult.fix(LocationFix(lat, lng, accuracy), weak: accuracy > 40)];

  final List<CaptureResult> script;
  int detects = 0;
  int cancels = 0;
  final List<LocationProblem> settingsOpened = [];

  /// Holds `detect()` open until completed (to test the "looking for GPS" state).
  Completer<void>? gate;

  /// Progress to report before the result (accuracy values).
  List<double> progress = const [];

  @override
  Future<CaptureResult> detect({void Function(LocationFix best, Duration elapsed)? onProgress}) async {
    detects++;
    for (final p in progress) {
      onProgress?.call(LocationFix(kKitchenLat, kKitchenLng, p), const Duration(seconds: 2));
    }
    if (gate != null) await gate!.future;
    final i = detects - 1;
    return script[i < script.length ? i : script.length - 1];
  }

  @override
  void cancel() => cancels++;

  @override
  Future<void> openSettingsFor(LocationProblem problem) async => settingsOpened.add(problem);
}

LocationServices fakeServices(FakeCapture capture, {List<Uri>? opened, bool opens = true}) =>
    LocationServices(capture: capture, openUrl: (uri) async {
      opened?.add(uri);
      return opens;
    });

/// Scripted `PUT /partner/vendor/location`.
class FakeLocationApi implements VendorLocationApi {
  final List<({double lat, double lng, double? accuracyM})> calls = [];

  /// Answers handed out first-in first-out; then success.
  final List<ApiResult<SavedLocation>> answers = [];
  Completer<void>? gate;

  @override
  Future<ApiResult<SavedLocation>> save({required double lat, required double lng, double? accuracyM}) async {
    calls.add((lat: lat, lng: lng, accuracyM: accuracyM));
    if (gate != null) await gate!.future;
    if (answers.isNotEmpty) return answers.removeAt(0);
    return ApiResult.success(SavedLocation(lat: lat, lng: lng, source: 'DEVICE', setAt: DateTime.utc(2026, 10, 5), accuracyM: accuracyM));
  }
}

PartnerSession restaurant({
  PartnerApproval approval = PartnerApproval.approved,
  bool? hasLocation,
  double? lat,
  double? lng,
}) =>
    PartnerSession(
      userId: 'u1',
      name: 'Test Owner',
      phone: '+91 9811100001',
      vendorId: 'v1',
      vendorName: 'Test Dhaba',
      isAcceptingOrders: true,
      approval: approval,
      address: 'Near Gate 2',
      hasLocation: hasLocation,
      lat: lat,
      lng: lng,
    );

/// Backend stand-in whose `GET /partner/me` answer is scripted and counted.
class LocationAuth implements PartnerAuthService {
  LocationAuth(this.profile);

  PartnerSession profile;
  int profileCalls = 0;

  /// `GET /partner/me` cannot be reached (the saved state is kept).
  bool unreachable = false;
  final List<PartnerSignupForm> signUps = [];

  @override
  Future<LoginResult> login({required String phone, required String password}) async => LoginResult.success(token: 'jwt-login', session: profile);

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    profileCalls++;
    if (unreachable) return const ProfileResult(ProfileOutcome.unreachable);
    return ProfileResult(ProfileOutcome.valid, profile);
  }

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async {
    signUps.add(form);
    return SignupResult.success(token: 'jwt-new', session: restaurant(approval: PartnerApproval.pending, hasLocation: form.hasLocation));
  }

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async => SignupResult.success(session: profile);

  @override
  Future<void> logout(String token) async {}
}

/// A sensor whose positions the test pushes in.
class FakeSensor implements LocationSensor {
  bool service = true;
  SensorPermission permissionNow = SensorPermission.granted;
  SensorPermission afterRequest = SensorPermission.granted;
  int requests = 0;
  int locationSettings = 0;
  int appSettings = 0;
  bool throwOnService = false;
  final StreamController<LocationFix> controller = StreamController<LocationFix>.broadcast();

  void emit(double accuracy, {double lat = kKitchenLat, double lng = kKitchenLng}) => controller.add(LocationFix(lat, lng, accuracy));

  @override
  Future<bool> serviceEnabled() async {
    if (throwOnService) throw StateError('plugin missing');
    return service;
  }

  @override
  Future<SensorPermission> permission() async => permissionNow;

  @override
  Future<SensorPermission> requestPermission() async {
    requests++;
    permissionNow = afterRequest;
    return permissionNow;
  }

  @override
  Stream<LocationFix> fixes() => controller.stream;

  @override
  Future<void> openLocationSettings() async => locationSettings++;

  @override
  Future<void> openAppSettings() async => appSettings++;
}
