import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/screens/application_status_screen.dart';
import 'package:driver_app/screens/driver_home.dart';
import 'package:driver_app/screens/login_screen.dart';
import 'package:driver_app/screens/runner_id_card_screen.dart';
import 'package:driver_app/screens/signup_screen.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/partner_auth_service.dart';
import 'package:driver_app/session/session_controller.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'support/fake_rider.dart';

/// Session, sign-up and API-shape tests for the pre-demo bug-hunt fixes of the rider app
/// (DR-02, DR-07, DR-09, DR-10, DR-15).

PartnerSession _rider(PartnerApproval a, {String? reason, String? duty, bool details = true}) => PartnerSession(
      userId: 'u9',
      name: 'Sunil Verma',
      phone: '+91 9811100003',
      driverId: 'd9',
      runnerCode: 'RUN-4821',
      approval: a,
      rejectionReason: reason,
      vehicleType: details ? 'Cycle' : null,
      vehicleRegNo: details ? null : null,
      emergencyPhone: details ? '+91 9811100099' : null,
      upiId: details ? 'sunil@okaxis' : null,
      dutyStatus: duty,
    );

class FakeAuth implements PartnerAuthService {
  ProfileResult profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending));
  SignupResult Function(PartnerSignupForm f) onResubmit = (_) => SignupResult.success(session: _rider(PartnerApproval.pending));
  LoginResult loginResult = const LoginResult.failure(LoginFailure.server);
  final resubmits = <PartnerSignupForm>[];
  int profileCalls = 0;

  @override
  Future<LoginResult> login({required String phone, required String password}) async => loginResult;

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    profileCalls++;
    return profile;
  }

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async => const SignupResult.failure(SignupFailure.server);

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async {
    resubmits.add(form);
    return onResubmit(form);
  }

  @override
  Future<void> logout(String token) async {}
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 900));
}

Future<void> _pumpApp(WidgetTester tester, FakeAuth auth, {FakeRider? rider}) async {
  await tester.pumpWidget(KraveoDriverApp(auth: auth, riderServices: rider == null ? null : () => rider.services));
  await _settle(tester);
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.pump(const Duration(seconds: 2));
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(seconds: 2));
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

Future<void> _storedSession(PartnerSession s, {bool dutyPref = false}) async {
  SharedPreferences.setMockInitialValues({
    'kraveo_driver_jwt_token': 'stored-jwt',
    SessionController.sessionPrefKey: jsonEncode(s.toJson()),
    if (dutyPref) RiderController.dutyPrefKey: true,
  });
  await DriverApiService.saveToken('stored-jwt');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await DriverApiService.clearToken();
    DriverApiService.onUnauthorized = null;
    DriverApiService.onSuspended = null;
    DriverApiService.onNotApproved = null;
  });

  group('re-sending an application (DR-02)', () {
    Future<SignupResult> resubmitWith(http.Response Function(http.Request) h, {PartnerSignupForm? form}) => http.runWithClient(
          () => ApiPartnerAuthService().resubmit('jwt', form ?? const PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234')),
          () => MockClient((r) async => h(r)),
        );

    test('the real PUT /partner/application body WITHOUT a user is still a success', () async {
      final r = await resubmitWith((_) => http.Response(
          jsonEncode({
            'success': true,
            'approvalStatus': 'PENDING',
            'rejectionReason': null,
            'driver': {'id': 'd1', 'runnerCode': 'RUN-1', 'approvalStatus': 'PENDING'},
          }),
          200));
      expect(r.ok, isTrue);
      expect(r.failure, isNull);
      expect(r.session, isNull);
    });

    test('a body WITH the user (new backend) is parsed as a pending session', () async {
      late http.Request seen;
      final r = await resubmitWith((req) {
        seen = req;
        return http.Response(
            jsonEncode({
              'success': true,
              'user': {'id': 'u1', 'name': 'S', 'phone': '+91 9811100003', 'role': 'DRIVER', 'avatarId': null},
              'approvalStatus': 'PENDING',
              'rejectionReason': null,
              'driver': {'id': 'd1', 'runnerCode': 'RUN-1', 'vehicleType': 'Cycle', 'vehicleRegNo': null, 'emergencyPhone': null, 'upiId': 'a@b', 'dutyStatus': 'OFFLINE'},
            }),
            200);
      });
      expect(seen.method, 'PUT');
      expect(seen.url.path, endsWith('/partner/application'));
      expect(r.ok, isTrue);
      expect(r.session!.approval, PartnerApproval.pending);
      expect(r.session!.vehicleType, 'Cycle');
      expect(r.session!.dutyStatus, 'OFFLINE');
    });

    test('401, 400 and a dead network are still failures', () async {
      expect((await resubmitWith((_) => http.Response('{}', 401))).failure, SignupFailure.unauthorized);
      expect((await resubmitWith((_) => http.Response(jsonEncode({'field': 'vehicleRegNo', 'message': 'x'}), 400))).failure, SignupFailure.invalid);
      expect((await resubmitWith((_) => http.Response('oops', 502))).failure, SignupFailure.server);
    });

    test('only the edited fields are sent (null = all)', () {
      const all = PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: 'Bike', vehicleRegNo: 'MP04', emergencyPhone: '', upiId: '');
      expect(all.toUpdateJson().keys, {'name', 'vehicleType', 'vehicleRegNo', 'emergencyPhone', 'upiId'});
      const some = PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: 'Bike', vehicleRegNo: 'MP04', updateFields: {'vehicleRegNo'});
      expect(some.toUpdateJson(), {'vehicleRegNo': 'MP04'});
      const none = PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: '', updateFields: {});
      expect(none.toUpdateJson(), isEmpty);
    });

    test('SessionController: a 200 without a user re-reads the profile and the application shows as pending', () async {
      await _storedSession(_rider(PartnerApproval.rejected, reason: 'Phone not reachable'));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.rejected, reason: 'Phone not reachable'));
      final c = SessionController(auth: auth);
      await c.restore();
      expect(c.session!.approval, PartnerApproval.rejected);
      auth.onResubmit = (_) => const SignupResult.success();
      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending));
      final before = auth.profileCalls;
      final r = await c.resubmit(const PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: 'Cycle'));
      expect(r.ok, isTrue);
      expect(auth.profileCalls, before + 1);
      expect(c.session!.approval, PartnerApproval.pending);
      c.dispose();
    });

    test('SessionController: an answer that lacks the rider profile keeps the stored details', () async {
      await _storedSession(_rider(PartnerApproval.rejected, reason: 'x'));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.rejected, reason: 'x'));
      final c = SessionController(auth: auth);
      await c.restore();
      auth.onResubmit = (_) => const SignupResult.success(
          session: PartnerSession(userId: 'u9', name: 'Sunil Verma', phone: '+91 9811100003', approval: PartnerApproval.pending));
      await c.resubmit(const PartnerSignupForm(name: 'S', phone: '', password: '', vehicleType: 'Cycle'));
      expect(c.session!.approval, PartnerApproval.pending);
      expect(c.session!.vehicleType, 'Cycle');
      expect(c.session!.upiId, 'sunil@okaxis');
      expect(c.session!.runnerCode, 'RUN-4821');
      c.dispose();
    });

    testWidgets('"Update details and apply again" on a 200 without a user: no "having trouble", the form closes, status is pending', (tester) async {
      await _storedSession(_rider(PartnerApproval.rejected, reason: 'Phone not reachable'));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.rejected, reason: 'Phone not reachable'));
      await _pumpApp(tester, auth);
      expect(find.text('We could not approve this yet'), findsOneWidget);
      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 1500));
      expect(find.text('Update your details'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Sunil K Verma');
      auth.onResubmit = (_) => const SignupResult.success();
      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending));
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      await _settle(tester);

      expect(find.textContaining('having trouble'), findsNothing);
      expect(find.byType(SignupScreen), findsNothing);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      expect(auth.resubmits.single.updateFields, {'name'});
      await _unmount(tester);
    });
  });

  group('details after a fresh login (DR-09)', () {
    testWidgets('login with the rider\'s own details: status shows them and "Change my details" is prefilled; nothing untouched is sent', (tester) async {
      final auth = FakeAuth()
        ..loginResult = LoginResult.success(token: 'jwt', session: _rider(PartnerApproval.pending))
        ..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending));
      await tester.pumpWidget(KraveoDriverApp(auth: auth, riderServices: () => FakeRider().services));
      await _settle(tester);
      expect(find.byType(LoginScreen), findsOneWidget);
      final c = tester.widget<LoginScreen>(find.byType(LoginScreen));
      await c.onSubmit('9811100003', 'Passw0rd!x');
      await _settle(tester);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(find.text('Cycle'), findsOneWidget);

      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 1500));
      expect(tester.widget<TextField>(find.byKey(const ValueKey('name-field'))).controller!.text, 'Sunil Verma');
      expect(find.byKey(const ValueKey('plate-field')), findsNothing, reason: 'a Cycle rider is not asked for a plate');
      expect(tester.widget<TextField>(find.byKey(const ValueKey('emergency-field'))).controller!.text, '9811100099');
      expect(tester.widget<TextField>(find.byKey(const ValueKey('upi-field'))).controller!.text, 'sunil@okaxis');

      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(auth.resubmits.single.updateFields, isEmpty, reason: 'nothing was edited, so nothing is overwritten');
      expect(auth.resubmits.single.toUpdateJson(), isEmpty);
      await _unmount(tester);
    });

    testWidgets('an older server that sends no details: the form does not turn the rider into a Bike or wipe anything', (tester) async {
      final bare = _rider(PartnerApproval.pending, details: false);
      final auth = FakeAuth()
        ..loginResult = LoginResult.success(token: 'jwt', session: bare)
        ..profile = ProfileResult(ProfileOutcome.valid, bare);
      await tester.pumpWidget(KraveoDriverApp(auth: auth, riderServices: () => FakeRider().services));
      await _settle(tester);
      await tester.widget<LoginScreen>(find.byType(LoginScreen)).onSubmit('9811100003', 'Passw0rd!x');
      await _settle(tester);

      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 1500));
      expect(find.byKey(const ValueKey('plate-field')), findsNothing, reason: 'no vehicle chosen yet, so no plate question');
      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Sunil K Verma');
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      final sent = auth.resubmits.single;
      expect(sent.updateFields, {'name'});
      expect(sent.toUpdateJson(), {'name': 'Sunil K Verma'});
      await _unmount(tester);
    });

    testWidgets('choosing a vehicle and a plate sends exactly those two fields', (tester) async {
      final bare = _rider(PartnerApproval.rejected, reason: 'Plate unreadable', details: false);
      await _storedSession(bare);
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, bare);
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 1500));
      await _tapKey(tester, 'vehicle-Scooter');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.ensureVisible(find.byKey(const ValueKey('plate-field')));
      await tester.enterText(find.byKey(const ValueKey('plate-field')), 'mp04 cd 9999');
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(auth.resubmits.single.updateFields, {'vehicleType', 'vehicleRegNo'});
      expect(auth.resubmits.single.toUpdateJson(), {'vehicleType': 'Scooter', 'vehicleRegNo': 'MP04 CD 9999'});
      await _unmount(tester);
    });

    test('a profile check that completes the details tells the screens (the form must not open stale)', () async {
      await _storedSession(_rider(PartnerApproval.pending, details: false));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending, details: false));
      final c = SessionController(auth: auth);
      await c.restore();
      var heard = 0;
      c.addListener(() => heard++);
      expect(await c.refreshApproval(), isFalse);
      expect(heard, 0, reason: 'nothing changed');
      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.pending));
      expect(await c.refreshApproval(), isFalse, reason: 'approval itself did not change');
      expect(heard, 1);
      expect(c.session!.vehicleType, 'Cycle');
      c.dispose();
    });
  });

  group('a paused account (DR-10)', () {
    test('a 401 body with reason ACCOUNT_SUSPENDED goes to onSuspended; any other 401 to onUnauthorized', () {
      var suspended = 0, expired = 0;
      DriverApiService.onUnauthorized = () => expired++;
      DriverApiService.onSuspended = () => suspended++;
      DriverApiService.checkAuthResponse(http.Response(jsonEncode({'code': 'TOKEN_REVOKED', 'reason': 'ACCOUNT_SUSPENDED'}), 401));
      expect((suspended, expired), (1, 0));
      DriverApiService.checkAuthResponse(http.Response(jsonEncode({'code': 'TOKEN_REVOKED'}), 401));
      DriverApiService.checkAuthResponse(http.Response('not json ACCOUNT_SUSPENDED', 401));
      expect((suspended, expired), (1, 2));
      DriverApiService.onSuspended = null;
      DriverApiService.checkAuthResponse(http.Response(jsonEncode({'reason': 'ACCOUNT_SUSPENDED'}), 401));
      expect(expired, 3, reason: 'without a suspended hook the old behaviour stays');
    });

    test('the profile call reports the suspension too', () async {
      Future<ProfileResult> profileWith(http.Response r) =>
          http.runWithClient(() => ApiPartnerAuthService().fetchProfile('jwt'), () => MockClient((_) async => r));
      final paused = await profileWith(http.Response(jsonEncode({'code': 'TOKEN_REVOKED', 'reason': 'ACCOUNT_SUSPENDED'}), 401));
      expect(paused.outcome, ProfileOutcome.unauthorized);
      expect(paused.suspended, isTrue);
      final plain = await profileWith(http.Response(jsonEncode({'code': 'TOKEN_REVOKED'}), 401));
      expect(plain.outcome, ProfileOutcome.unauthorized);
      expect(plain.suspended, isFalse);
    });

    testWidgets('401 ACCOUNT_SUSPENDED mid-shift: login screen says the account is paused (not "Session expired"); the pass screen closes', (tester) async {
      await _storedSession(_rider(PartnerApproval.approved), dutyPref: true);
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved));
      await _pumpApp(tester, auth, rider: FakeRider());
      expect(find.byType(DriverHomeScreen), findsOneWidget);
      await tester.tap(find.byIcon(LucideIcons.badgeCheck).first);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(RunnerIdCardScreen), findsOneWidget);

      DriverApiService.checkAuthResponse(http.Response(jsonEncode({'code': 'TOKEN_REVOKED', 'reason': 'ACCOUNT_SUSPENDED'}), 401));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(RunnerIdCardScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('Your Kraveo account is paused. Please contact Kraveo support.'), findsOneWidget);
      expect(find.textContaining('Session expired'), findsNothing);
      expect((await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey), isNull, reason: 'DR-15: the next login does not go on duty by itself');
      await _unmount(tester);
    });

    testWidgets('a profile check on resume that finds the account paused: same message', (tester) async {
      await _storedSession(_rider(PartnerApproval.approved));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved));
      await _pumpApp(tester, auth, rider: FakeRider());
      expect(find.byType(DriverHomeScreen), findsOneWidget);
      auth.profile = const ProfileResult(ProfileOutcome.unauthorized, null, true);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('Your Kraveo account is paused. Please contact Kraveo support.'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a plain expired session keeps the old text', (tester) async {
      await _storedSession(_rider(PartnerApproval.approved));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved));
      await _pumpApp(tester, auth, rider: FakeRider());
      DriverApiService.checkAuthResponse(http.Response(jsonEncode({'code': 'TOKEN_EXPIRED'}), 401));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('Session expired. Please log in again.'), findsOneWidget);
      expect(find.textContaining('account is paused'), findsNothing);
      await _unmount(tester);
    });
  });

  group('"on duty" belongs to the rider, not the phone (DR-15)', () {
    Future<SessionController> signedIn() async {
      await _storedSession(_rider(PartnerApproval.approved), dutyPref: true);
      final c = SessionController(auth: FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved)));
      await c.restore();
      return c;
    }

    Future<bool?> pref() async => (await SharedPreferences.getInstance()).getBool(RiderController.dutyPrefKey);

    test('session expiry clears the saved duty', () async {
      final c = await signedIn();
      expect(await pref(), isTrue);
      await c.expire();
      expect(await pref(), isNull);
      expect(c.takeSignOutNotice(), isNull);
      c.dispose();
    });

    test('expiry because of a suspension clears it and leaves a one-off notice', () async {
      final c = await signedIn();
      await c.expire(suspended: true);
      expect(await pref(), isNull);
      expect(c.takeSignOutNotice(), DriverApiService.accountPausedMessage);
      expect(c.takeSignOutNotice(), isNull, reason: 'read once');
      c.dispose();
    });

    test('logout clears it', () async {
      final c = await signedIn();
      await c.logout();
      expect(await pref(), isNull);
      c.dispose();
    });

    test('a profile check that finds the rider suspended (status screen) clears it', () async {
      final c = await signedIn();
      final auth = c.auth as FakeAuth;
      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.suspended, reason: 'No-shows'));
      await c.refreshApproval();
      expect(c.session!.approval, PartnerApproval.suspended);
      expect(await pref(), isNull);
      c.dispose();
    });

    test('a healthy refresh leaves it alone', () async {
      final c = await signedIn();
      await c.refreshApproval();
      expect(await pref(), isTrue);
      c.dispose();
    });
  });

  group('duty read from Kraveo (DR-07)', () {
    test('login and profile answers carry driver.dutyStatus; an older server without it gives null', () {
      final s = PartnerSession.fromLoginJson({
        'user': {'id': 'u', 'name': 'N'},
        'driver': {'id': 'd', 'runnerCode': 'RUN-1', 'dutyStatus': 'ONLINE'},
      })!;
      expect(s.dutyStatus, 'ONLINE');
      expect(PartnerSession.fromLoginJson({'user': {'id': 'u', 'name': 'N'}, 'driver': {'id': 'd'}})!.dutyStatus, isNull);
      expect(PartnerSession.fromStoredJson(jsonDecode(jsonEncode(s.toJson())))!.dutyStatus, isNull, reason: 'never stored: it is stale by the next start');
    });

    test('every successful profile read publishes a DutyReading', () async {
      await _storedSession(_rider(PartnerApproval.approved, duty: 'ONLINE'));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved, duty: 'ONLINE'));
      final c = SessionController(auth: auth);
      expect(c.dutyReading.value, isNull);
      await c.restore();
      expect(c.dutyReading.value!.status, 'ONLINE');
      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved, duty: 'OFFLINE'));
      await c.refreshApproval();
      expect(c.dutyReading.value!.status, 'OFFLINE');
      c.dispose();
    });

    testWidgets('the phone shows ON when Kraveo says ONLINE, and OFF again when another phone logs out', (tester) async {
      await _storedSession(_rider(PartnerApproval.approved, duty: 'ONLINE'));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved, duty: 'ONLINE'));
      final f = FakeRider();
      await _pumpApp(tester, auth, rider: f);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('ON DUTY'), findsOneWidget);
      expect(f.api.calls, isNot(contains('duty:true')), reason: 'mirrored, not re-sent');

      auth.profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved, duty: 'OFFLINE'));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(find.textContaining('Kraveo has you off duty'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('an older server (no dutyStatus) leaves the phone as it is', (tester) async {
      await _storedSession(_rider(PartnerApproval.approved));
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _rider(PartnerApproval.approved));
      await _pumpApp(tester, auth, rider: FakeRider());
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('OFF DUTY'), findsOneWidget);
      await _unmount(tester);
    });
  });
}
