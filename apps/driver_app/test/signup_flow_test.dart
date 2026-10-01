import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/screens/application_status_screen.dart';
import 'package:driver_app/screens/driver_home_screen.dart';
import 'package:driver_app/screens/login_screen.dart';
import 'package:driver_app/screens/signup_screen.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/partner_auth_service.dart';
import 'package:driver_app/session/session_controller.dart';

PartnerSession _with(PartnerApproval a, {String? reason}) => PartnerSession(
      userId: 'u9',
      name: 'Sunil Verma',
      phone: '+91 9811100003',
      driverId: 'd9',
      runnerCode: 'RUN-4821',
      approval: a,
      rejectionReason: reason,
      vehicleType: 'Bike',
      vehicleRegNo: 'MP04 AB 1234',
      emergencyPhone: '+91 9811100099',
      upiId: 'sunil@okaxis',
    );

final _pending = _with(PartnerApproval.pending);

class FakeAuth implements PartnerAuthService {
  SignupResult Function(PartnerSignupForm f) onSignUp = (_) => SignupResult.success(token: 'jwt-new', session: _pending);
  SignupResult Function(PartnerSignupForm f) onResubmit = (_) => SignupResult.success(session: _pending);
  ProfileResult profile = ProfileResult(ProfileOutcome.valid, _pending);
  final signUps = <PartnerSignupForm>[];
  final resubmits = <PartnerSignupForm>[];
  int profileCalls = 0;
  final loggedOut = <String>[];

  @override
  Future<LoginResult> login({required String phone, required String password}) async => const LoginResult.failure(LoginFailure.server);

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    profileCalls++;
    return profile;
  }

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async {
    signUps.add(form);
    return onSignUp(form);
  }

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async {
    resubmits.add(form);
    return onResubmit(form);
  }

  @override
  Future<void> logout(String token) async => loggedOut.add(token);
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 900));
}

Future<void> _pumpApp(WidgetTester tester, FakeAuth auth) async {
  await tester.pumpWidget(KraveoDriverApp(auth: auth));
  await _settle(tester);
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

/// Scrolls the control into view and taps it once its staggered fade-in has finished.
Future<void> _tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.pump(const Duration(seconds: 2)); // staggered fade-ins start one frame after the route is built
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(seconds: 2));
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

Future<void> _openForm(WidgetTester tester) async {
  await _tapKey(tester, 'create-account-button');
  await tester.pump(const Duration(milliseconds: 1500));
  await tester.pump(const Duration(milliseconds: 1500));
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final f = find.byKey(ValueKey(key));
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.enterText(f, text);
  await tester.pump();
}

Future<void> _fill(WidgetTester tester, {String phone = '9811100003', String password = 'Passw0rd!x', String plate = 'mp04 ab 1234'}) async {
  await _type(tester, 'name-field', 'Sunil Verma');
  await _type(tester, 'phone-field', phone);
  await _type(tester, 'password-field', password);
  if (plate.isNotEmpty) await _type(tester, 'plate-field', plate);
}

void _smallPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await DriverApiService.clearToken();
    DriverApiService.onUnauthorized = null;
  });

  group('Create account', () {
    testWidgets('login screen offers "Create account" and it opens the sign-up form', (tester) async {
      await _pumpApp(tester, FakeAuth());
      expect(find.byType(LoginScreen), findsOneWidget);
      await _openForm(tester);
      expect(find.byType(SignupScreen), findsOneWidget);
      expect(find.text('Become a delivery partner'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('empty form shows every missing field and sends nothing', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _openForm(tester);
      await _tapKey(tester, 'signup-button');
      expect(auth.signUps, isEmpty);
      expect(find.text('Enter your full name'), findsOneWidget);
      expect(find.text('Enter your 10-digit mobile number'), findsOneWidget);
      expect(find.text('Use at least 8 characters'), findsOneWidget);
      expect(find.text('Enter the number plate of your vehicle'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a cycle or walking rider is not asked for a number plate', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _openForm(tester);
      expect(find.byKey(const ValueKey('plate-field')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('vehicle-Cycle')));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('vehicle-Cycle')));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const ValueKey('plate-field')), findsNothing);

      await _fill(tester, plate: '');
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(auth.signUps, hasLength(1));
      expect(auth.signUps.single.vehicleType, 'Cycle');
      expect(auth.signUps.single.vehicleRegNo, '');
      await _unmount(tester);
    });

    testWidgets('a valid form creates the account and lands on "checking your details"', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _openForm(tester);
      await _fill(tester);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);

      expect(auth.signUps, hasLength(1));
      final f = auth.signUps.single;
      expect(f.name, 'Sunil Verma');
      expect(f.phone, '9811100003');
      expect(f.vehicleType, 'Bike');
      expect(f.vehicleRegNo, 'MP04 AB 1234'); // upper-cased
      expect(f.toSignupJson()['role'], 'DRIVER');

      expect(find.byType(SignupScreen), findsNothing);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      expect(find.text('RUN-4821'), findsOneWidget);
      expect(await DriverApiService.getSavedToken(), 'jwt-new');
      await _unmount(tester);
    });

    testWidgets('a bad emergency number or UPI id opens the optional section and explains', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _openForm(tester);
      await _fill(tester);
      await tester.ensureVisible(find.textContaining('Add emergency contact'));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.textContaining('Add emergency contact'));
      await tester.pump(const Duration(milliseconds: 400));
      await _type(tester, 'emergency-field', '12345');
      await _type(tester, 'upi-field', 'not-a-upi');
      await _tapKey(tester, 'signup-button');
      expect(auth.signUps, isEmpty);
      expect(find.textContaining('valid 10-digit number'), findsOneWidget);
      expect(find.textContaining('UPI id does not look right'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('number already registered -> the message sits under the phone field', (tester) async {
      final auth = FakeAuth()..onSignUp = (_) => const SignupResult.failure(SignupFailure.phoneTaken, field: 'phone');
      await _pumpApp(tester, auth);
      await _openForm(tester);
      await _fill(tester);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.byType(SignupScreen), findsOneWidget);
      expect(find.textContaining('already has an account'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('offline and rate-limit problems are explained and the typed answers stay', (tester) async {
      final auth = FakeAuth()..onSignUp = (_) => const SignupResult.failure(SignupFailure.offline);
      await _pumpApp(tester, auth);
      await _openForm(tester);
      await _fill(tester);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.byKey(const ValueKey('signup-problem')), findsOneWidget);
      expect(find.textContaining("Can't reach Kraveo"), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('name-field'))).controller!.text, 'Sunil Verma'); // still there

      auth.onSignUp = (_) => const SignupResult.failure(SignupFailure.rateLimited);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.textContaining('Too many tries'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('the form does not overflow on a small phone at 1.3x text', (tester) async {
      _smallPhone(tester);
      await _pumpApp(tester, FakeAuth());
      await _openForm(tester);
      expect(tester.takeException(), isNull);
      await _tapKey(tester, 'signup-button');
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });
  });

  group('Waiting for approval', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({
        'kraveo_driver_jwt_token': 'stored-jwt',
        SessionController.sessionPrefKey: jsonEncode(_pending.toJson()),
      });
    });

    testWidgets('a pending rider never sees the delivery screens', (tester) async {
      await _pumpApp(tester, FakeAuth());
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(find.byType(DriverHomeScreen), findsNothing);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      expect(find.byKey(const ValueKey('check-button')), findsOneWidget);
      expect(find.byKey(const ValueKey('edit-button')), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('"Check status" asks Kraveo and, when still pending, says it will update by itself', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      final before = auth.profileCalls;
      await _tapKey(tester, 'check-button');
      await _settle(tester);
      expect(auth.profileCalls, before + 1);
      expect(find.byKey(const ValueKey('still-waiting')), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('it re-checks every 20 seconds and opens the app as soon as the admin approves', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      auth.profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.approved));
      await tester.pump(const Duration(seconds: 21));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.byType(ApplicationStatusScreen), findsNothing);
      expect(find.byType(DriverHomeScreen), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a rejected application shows the reason and an Update button that re-sends the details', (tester) async {
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.rejected, reason: 'Phone not reachable'));
      await _pumpApp(tester, auth);
      expect(find.text('We could not approve this yet'), findsOneWidget);
      expect(find.text('Phone not reachable'), findsOneWidget);
      expect(find.byKey(const ValueKey('check-button')), findsNothing);

      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump(const Duration(milliseconds: 1500));
      expect(find.text('Update your details'), findsOneWidget);
      expect(find.byKey(const ValueKey('phone-field')), findsNothing);
      expect(find.byKey(const ValueKey('password-field')), findsNothing);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('name-field'))).controller!.text, 'Sunil Verma');
      expect(tester.widget<TextField>(find.byKey(const ValueKey('plate-field'))).controller!.text, 'MP04 AB 1234');

      await tester.enterText(find.byKey(const ValueKey('plate-field')), 'MP04 CD 9999');
      auth.onResubmit = (_) => SignupResult.success(session: _with(PartnerApproval.pending));
      await _tapKey(tester, 'signup-button');
      await _settle(tester);

      expect(auth.resubmits, hasLength(1));
      expect(auth.resubmits.single.vehicleRegNo, 'MP04 CD 9999');
      expect(auth.resubmits.single.upiId, 'sunil@okaxis');
      expect(find.byType(SignupScreen), findsNothing);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a suspended rider is told why and can only log out', (tester) async {
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.suspended, reason: 'No-shows on orders'));
      await _pumpApp(tester, auth);
      expect(find.text('Your account is paused'), findsOneWidget);
      expect(find.text('No-shows on orders'), findsOneWidget);
      expect(find.byKey(const ValueKey('edit-button')), findsNothing);
      await _tapKey(tester, 'logout-button');
      await _settle(tester);
      expect(auth.loggedOut, ['stored-jwt']);
      expect(find.byType(LoginScreen), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('the status screens fit a small phone at 1.3x text', (tester) async {
      _smallPhone(tester);
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.rejected, reason: 'Phone not reachable on any of the numbers given'));
      await _pumpApp(tester, auth);
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });
  });

  group('API layer', () {
    Future<SignupResult> signUpWith(http.Response Function(http.Request) h, {Object? throws}) => http.runWithClient(
          () => ApiPartnerAuthService().signUp(const PartnerSignupForm(name: 'S', phone: '9811100003', password: 'Passw0rd!x', vehicleType: 'Bike', vehicleRegNo: 'MP04 AB 1234')),
          () => MockClient((r) async {
            if (throws != null) throw throws;
            return h(r);
          }),
        );

    test('sign-up posts the role and details, and parses a pending rider', () async {
      late http.Request seen;
      final r = await signUpWith((req) {
        seen = req;
        return http.Response(
          jsonEncode({
            'success': true,
            'token': 'jwt',
            'approvalStatus': 'PENDING',
            'user': {'id': 'u1', 'name': 'S', 'phone': '+91 9811100003', 'role': 'DRIVER'},
            'driver': {'id': 'd1', 'runnerCode': 'RUN-1234', 'vehicleType': 'Bike', 'vehicleRegNo': 'MP04 AB 1234', 'approvalStatus': 'PENDING'},
          }),
          201,
        );
      });
      expect(seen.url.toString(), endsWith('/auth/partner-signup'));
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(body['role'], 'DRIVER');
      expect(body['vehicleType'], 'Bike');
      expect(r.ok, isTrue);
      expect(r.token, 'jwt');
      expect(r.session!.approval, PartnerApproval.pending);
      expect(r.session!.runnerCode, 'RUN-1234');
      expect(r.session!.vehicleRegNo, 'MP04 AB 1234');
    });

    test('maps 400 (with the field), 409, 429, 5xx and a dead network', () async {
      final bad = await signUpWith((_) => http.Response(jsonEncode({'success': false, 'field': 'vehicleRegNo', 'message': 'Enter the vehicle number plate.'}), 400));
      expect(bad.failure, SignupFailure.invalid);
      expect(bad.field, 'vehicleRegNo');
      expect((await signUpWith((_) => http.Response(jsonEncode({'field': 'phone', 'message': 'taken'}), 409))).failure, SignupFailure.phoneTaken);
      expect((await signUpWith((_) => http.Response('{}', 429))).failure, SignupFailure.rateLimited);
      expect((await signUpWith((_) => http.Response('oops', 502))).failure, SignupFailure.server);
      expect((await signUpWith((_) => http.Response('{}', 201))).failure, SignupFailure.server);
      expect((await signUpWith((_) => http.Response('', 200), throws: http.ClientException('x'))).failure, SignupFailure.offline);
    });

    test('login carries the approval state and the reason; old accounts default to approved', () {
      final s = PartnerSession.fromLoginJson({
        'user': {'id': 'u', 'name': 'N', 'role': 'DRIVER'},
        'approvalStatus': 'SUSPENDED',
        'rejectionReason': 'Late',
        'driver': {'id': 'd', 'runnerCode': 'RUN-1'},
      })!;
      expect(s.approval, PartnerApproval.suspended);
      expect(s.rejectionReason, 'Late');
      expect(PartnerSession.fromLoginJson({'user': {'id': 'u', 'name': 'N'}})!.approval, PartnerApproval.approved);
    });

    test('the stored session keeps the approval state and vehicle across restarts', () {
      final restored = PartnerSession.fromStoredJson(jsonDecode(jsonEncode(_with(PartnerApproval.rejected, reason: 'Late').toJson())));
      expect(restored!.approval, PartnerApproval.rejected);
      expect(restored.vehicleRegNo, 'MP04 AB 1234');
      expect(restored.upiId, 'sunil@okaxis');
    });

    test('vehicleNeedsPlate: bikes and scooters do, cycles and walking do not', () {
      expect(vehicleNeedsPlate('Bike'), isTrue);
      expect(vehicleNeedsPlate('Scooter'), isTrue);
      expect(vehicleNeedsPlate('Cycle'), isFalse);
      expect(vehicleNeedsPlate('On foot'), isFalse);
    });
  });

  test('refreshApproval updates the session when the admin decides, and ignores a dead network', () async {
    SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'stored-jwt'});
    final auth = FakeAuth();
    final controller = SessionController(auth: auth);
    await controller.restore();
    expect(controller.session!.approval, PartnerApproval.pending);

    auth.profile = const ProfileResult(ProfileOutcome.unreachable);
    expect(await controller.refreshApproval(), isFalse);
    expect(controller.session!.approval, PartnerApproval.pending);

    auth.profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.approved));
    expect(await controller.refreshApproval(), isTrue);
    expect(controller.session!.approval, PartnerApproval.approved);
    expect(await controller.refreshApproval(), isFalse);

    auth.profile = const ProfileResult(ProfileOutcome.unauthorized);
    expect(await controller.refreshApproval(), isTrue);
    expect(controller.status, SessionStatus.signedOut);
    controller.dispose();
  });
}
