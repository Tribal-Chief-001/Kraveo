import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/partner_session.dart';
import 'package:vendor_app/screens/application_status_screen.dart';
import 'package:vendor_app/screens/login_screen.dart';
import 'package:vendor_app/screens/signup_screen.dart';
import 'package:vendor_app/screens/vendor_home_screen.dart';
import 'package:vendor_app/services/partner_auth_service.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/session/session_controller.dart';

const _pending = PartnerSession(
  userId: 'u9',
  name: 'Ramesh Kumar',
  phone: '+91 9811100001',
  vendorId: 'v9',
  vendorName: 'Shiv Shakti Dhaba',
  isAcceptingOrders: false,
  approval: PartnerApproval.pending,
  category: 'North Indian',
  address: 'Ashta road, near Gate 2',
);

PartnerSession _with(PartnerApproval a, {String? reason}) => PartnerSession(
      userId: 'u9',
      name: 'Ramesh Kumar',
      phone: '+91 9811100001',
      vendorId: 'v9',
      vendorName: 'Shiv Shakti Dhaba',
      isAcceptingOrders: false,
      approval: a,
      rejectionReason: reason,
      category: 'North Indian',
      address: 'Ashta road, near Gate 2',
    );

class FakeAuth implements PartnerAuthService {
  SignupResult Function(PartnerSignupForm f) onSignUp = (_) => const SignupResult.success(token: 'jwt-new', session: _pending);
  SignupResult Function(PartnerSignupForm f) onResubmit = (_) => const SignupResult.success(session: _pending);
  ProfileResult profile = const ProfileResult(ProfileOutcome.valid, _pending);
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
  await tester.pumpWidget(KraveoVendorApp(auth: auth));
  await _settle(tester);
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

Future<void> _fillSignup(WidgetTester tester, {String restaurant = 'Shiv Shakti Dhaba', String phone = '9811100001', String password = 'Passw0rd!x'}) async {
  Future<void> type(String key, String text) async {
    final f = find.byKey(ValueKey(key));
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.enterText(f, text);
    await tester.pump();
  }

  await type('restaurant-field', restaurant);
  await type('address-field', 'Ashta road, near Gate 2');
  await type('owner-field', 'Ramesh Kumar');
  await type('phone-field', phone);
  await type('password-field', password);
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

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await VendorApiService.clearToken();
    VendorApiService.onUnauthorized = null;
  });

  group('Create account', () {
    testWidgets('login screen offers "Create account" and it opens the sign-up form', (tester) async {
      await _pumpApp(tester, FakeAuth());
      expect(find.byType(LoginScreen), findsOneWidget);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(SignupScreen), findsOneWidget);
      expect(find.text('Create your restaurant account'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('empty form shows every missing field and sends nothing', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      await _tapKey(tester, 'signup-button');
      expect(auth.signUps, isEmpty);
      expect(find.textContaining('Enter the restaurant name'), findsOneWidget);
      expect(find.textContaining('Tell us where the kitchen is'), findsOneWidget);
      expect(find.textContaining('Enter your name'), findsOneWidget);
      expect(find.textContaining('10-digit mobile number'), findsOneWidget);
      expect(find.textContaining('at least 8 characters'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a bad FSSAI number and a short password are caught on the phone', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      await _fillSignup(tester, password: 'short');
      await tester.ensureVisible(find.textContaining('Have an FSSAI licence'));
      await tester.tap(find.textContaining('Have an FSSAI licence'));
      await tester.pump();
      await tester.enterText(find.byKey(const ValueKey('fssai-field')), '123');
      await _tapKey(tester, 'signup-button');
      expect(auth.signUps, isEmpty);
      expect(find.textContaining('FSSAI number has 14 digits'), findsOneWidget);
      expect(find.textContaining('Use at least 8 characters'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a valid form creates the account and lands on "checking your details"', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      await _fillSignup(tester);
      await tester.ensureVisible(find.byKey(const ValueKey('category-Rolls & Wraps')));
      await tester.tap(find.byKey(const ValueKey('category-Rolls & Wraps')));
      await tester.pump();
      await _tapKey(tester, 'signup-button');
      await _settle(tester);

      expect(auth.signUps, hasLength(1));
      final f = auth.signUps.single;
      expect(f.restaurantName, 'Shiv Shakti Dhaba');
      expect(f.phone, '9811100001');
      expect(f.category, 'Rolls & Wraps');
      expect(f.toSignupJson()['role'], 'VENDOR');

      expect(find.byType(SignupScreen), findsNothing);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      expect(find.text('Shiv Shakti Dhaba'), findsOneWidget);
      expect(await VendorApiService.getSavedToken(), 'jwt-new');
      await _unmount(tester);
    });

    testWidgets('server says the number is taken -> the message sits under the phone field', (tester) async {
      final auth = FakeAuth()..onSignUp = (_) => const SignupResult.failure(SignupFailure.phoneTaken, field: 'phone');
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      await _fillSignup(tester);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.byType(SignupScreen), findsOneWidget);
      expect(find.textContaining('already registered in another Kraveo app'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('offline and rate-limit problems are explained, and the form keeps what was typed', (tester) async {
      final auth = FakeAuth()..onSignUp = (_) => const SignupResult.failure(SignupFailure.offline);
      await _pumpApp(tester, auth);
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      await _fillSignup(tester);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.byKey(const ValueKey('signup-problem')), findsOneWidget);
      expect(find.textContaining("Can't reach Kraveo"), findsOneWidget);
      expect(find.text('Shiv Shakti Dhaba'), findsOneWidget);

      auth.onSignUp = (_) => const SignupResult.failure(SignupFailure.rateLimited);
      await _tapKey(tester, 'signup-button');
      await _settle(tester);
      expect(find.textContaining('Too many tries'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('the form does not overflow on a small phone at 1.3x text', (tester) async {
      _smallPhone(tester);
      await _pumpApp(tester, FakeAuth());
      await _tapKey(tester, 'create-account-button');
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);
      await _tapKey(tester, 'signup-button');
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });
  });

  group('Waiting for approval', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({
        'kraveo_vendor_jwt_token': 'stored-jwt',
        SessionController.sessionPrefKey: jsonEncode(_pending.toJson()),
      });
    });

    testWidgets('a pending restaurant never sees the order screens', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(find.byType(VendorHomeScreen), findsNothing);
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

    testWidgets('it re-checks by itself every 20 seconds and opens the app as soon as the admin approves', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);

      auth.profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.approved));
      await tester.pump(const Duration(seconds: 21));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.byType(ApplicationStatusScreen), findsNothing);
      expect(find.byType(VendorHomeScreen), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a rejected application shows the reason and an Update button that re-sends the details', (tester) async {
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.rejected, reason: 'FSSAI number does not match'));
      await _pumpApp(tester, auth);
      expect(find.text('We could not approve this yet'), findsOneWidget);
      expect(find.text('FSSAI number does not match'), findsOneWidget);
      expect(find.byKey(const ValueKey('check-button')), findsNothing);

      await _tapKey(tester, 'edit-button');
      await tester.pump(const Duration(milliseconds: 1500)); // route transition
      await tester.pump(const Duration(milliseconds: 1500)); // the form's staggered fade-in (starts one frame later)
      expect(find.text('Update your details'), findsOneWidget);
      // Phone and password are not asked again, and the old answers are prefilled.
      expect(find.byKey(const ValueKey('phone-field')), findsNothing);
      expect(find.byKey(const ValueKey('password-field')), findsNothing);
      expect(find.text('Shiv Shakti Dhaba'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('address-field')), 'Gate 2 food court');
      auth.onResubmit = (_) => SignupResult.success(session: _with(PartnerApproval.pending));
      await tester.pump(const Duration(seconds: 3)); // let the form's staggered fade-in finish
      await tester.pump(const Duration(seconds: 3));
      await tester.ensureVisible(find.byKey(const ValueKey('signup-button')));
      await tester.pump(const Duration(seconds: 2));
      await tester.tap(find.byKey(const ValueKey('signup-button')));
      await tester.pump();
      await _settle(tester);

      expect(auth.resubmits, hasLength(1));
      expect(auth.resubmits.single.address, 'Gate 2 food court');
      expect(find.byType(SignupScreen), findsNothing);
      expect(find.text('Thanks! We are checking your details'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('a suspended restaurant is told why and can only log out', (tester) async {
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.suspended, reason: 'Customer complaints'));
      await _pumpApp(tester, auth);
      expect(find.text('Your account is paused'), findsOneWidget);
      expect(find.text('Customer complaints'), findsOneWidget);
      expect(find.byKey(const ValueKey('edit-button')), findsNothing);
      await _tapKey(tester, 'logout-button');
      await _settle(tester);
      expect(auth.loggedOut, ['stored-jwt']);
      expect(find.byType(LoginScreen), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('the status screens fit a small phone at 1.3x text', (tester) async {
      _smallPhone(tester);
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.rejected, reason: 'FSSAI number does not match the licence on file'));
      await _pumpApp(tester, auth);
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });
  });

  group('Suspended while the app is open', () {
    test('a 403 PARTNER_NOT_APPROVED fires onNotApproved; a plain 403 or a 200 does not', () async {
      var fired = 0;
      VendorApiService.onNotApproved = () => fired++;
      await VendorApiService.saveToken('jwt-abc');
      var status = 200;
      var body = '{}';
      await http.runWithClient(() async {
        await VendorApiService.updateOrderStatus('ord-1', 'PREPARING');
        expect(fired, 0);
        status = 403;
        body = jsonEncode({'success': false, 'message': 'Forbidden. You do not own this vendor.'});
        await VendorApiService.toggleStoreStatus('ven-1', false);
        expect(fired, 0);
        body = jsonEncode({'success': false, 'code': 'PARTNER_NOT_APPROVED', 'approvalStatus': 'SUSPENDED'});
        final ok = await VendorApiService.toggleStoreStatus('ven-1', false);
        expect(ok, isFalse);
      }, () => MockClient((request) async => http.Response(body, status)));
      expect(fired, 1);
      VendorApiService.onNotApproved = null;
    });

    testWidgets('an approved restaurant that gets suspended moves to the status screen, and again on app resume', (tester) async {
      SharedPreferences.setMockInitialValues({
        'kraveo_vendor_jwt_token': 'stored-jwt',
        SessionController.sessionPrefKey: jsonEncode(_with(PartnerApproval.approved).toJson()),
      });
      final auth = FakeAuth()..profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.approved));
      await _pumpApp(tester, auth);
      expect(find.byType(VendorHomeScreen), findsOneWidget);

      // The admin suspends the account; the next field action is refused with PARTNER_NOT_APPROVED.
      auth.profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.suspended, reason: 'Hygiene complaint'));
      VendorApiService.onNotApproved!.call();
      await _settle(tester);
      expect(find.byType(VendorHomeScreen), findsNothing);
      expect(find.text('Your account is paused'), findsOneWidget);
      expect(find.text('Hygiene complaint'), findsOneWidget);

      // Reactivated while the phone was in the pocket: coming back to the app re-checks and reopens it.
      auth.profile = ProfileResult(ProfileOutcome.valid, _with(PartnerApproval.approved));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _settle(tester);
      expect(find.byType(VendorHomeScreen), findsOneWidget);
      await _unmount(tester);
    });
  });

  group('API layer', () {
    Future<SignupResult> signUpWith(http.Response Function(http.Request) h, {Object? throws}) => http.runWithClient(
          () => ApiPartnerAuthService().signUp(const PartnerSignupForm(ownerName: 'R', phone: '9811100001', password: 'Passw0rd!x', restaurantName: 'Shiv', address: 'Gate 2', category: 'Biryani')),
          () => MockClient((r) async {
            if (throws != null) throw throws;
            return h(r);
          }),
        );

    test('sign-up posts the role and details, and parses a pending account', () async {
      late http.Request seen;
      final r = await signUpWith((req) {
        seen = req;
        return http.Response(
          jsonEncode({
            'success': true,
            'token': 'jwt',
            'approvalStatus': 'PENDING',
            'user': {'id': 'u1', 'name': 'R', 'phone': '+91 9811100001', 'role': 'VENDOR'},
            'vendor': {'id': 'v1', 'name': 'Shiv', 'category': 'Biryani', 'address': 'Gate 2', 'fssaiNumber': null, 'isAcceptingOrders': false, 'approvalStatus': 'PENDING'},
          }),
          201,
        );
      });
      expect(seen.url.toString(), endsWith('/auth/partner-signup'));
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(body['role'], 'VENDOR');
      expect(body['restaurantName'], 'Shiv');
      expect(body['category'], 'Biryani');
      expect(r.ok, isTrue);
      expect(r.token, 'jwt');
      expect(r.session!.approval, PartnerApproval.pending);
      expect(r.session!.vendorName, 'Shiv');
      expect(r.session!.address, 'Gate 2');
    });

    test('maps 400 (with the field), 409, 429, 5xx and a dead network', () async {
      final bad = await signUpWith((_) => http.Response(jsonEncode({'success': false, 'field': 'fssaiNumber', 'message': 'FSSAI number has 14 digits.'}), 400));
      expect(bad.failure, SignupFailure.invalid);
      expect(bad.field, 'fssaiNumber');
      expect(bad.message, 'FSSAI number has 14 digits.');
      expect((await signUpWith((_) => http.Response(jsonEncode({'field': 'phone', 'message': 'taken'}), 409))).failure, SignupFailure.phoneTaken);
      expect((await signUpWith((_) => http.Response('{}', 429))).failure, SignupFailure.rateLimited);
      expect((await signUpWith((_) => http.Response('oops', 502))).failure, SignupFailure.server);
      expect((await signUpWith((_) => http.Response('{}', 201))).failure, SignupFailure.server); // no token
      expect((await signUpWith((_) => http.Response('', 200), throws: http.ClientException('x'))).failure, SignupFailure.offline);
    });

    test('login now carries the approval state and the reason', () {
      final s = PartnerSession.fromLoginJson({
        'user': {'id': 'u', 'name': 'N', 'role': 'VENDOR'},
        'approvalStatus': 'REJECTED',
        'rejectionReason': 'Details incomplete',
        'vendor': {'id': 'v', 'name': 'X', 'isAcceptingOrders': false},
      })!;
      expect(s.approval, PartnerApproval.rejected);
      expect(s.rejectionReason, 'Details incomplete');
      expect(s.isApproved, isFalse);
      // Accounts from before approvals existed have no field and keep working.
      expect(PartnerSession.fromLoginJson({'user': {'id': 'u', 'name': 'N'}})!.approval, PartnerApproval.approved);
    });

    test('the stored session keeps the approval state across restarts', () {
      final restored = PartnerSession.fromStoredJson(jsonDecode(jsonEncode(_with(PartnerApproval.suspended, reason: 'Late').toJson())));
      expect(restored!.approval, PartnerApproval.suspended);
      expect(restored.rejectionReason, 'Late');
      expect(restored.address, 'Ashta road, near Gate 2');
    });
  });

  test('refreshApproval updates the session when the admin decides, and ignores a dead network', () async {
    SharedPreferences.setMockInitialValues({'kraveo_vendor_jwt_token': 'stored-jwt'});
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
    expect(await controller.refreshApproval(), isFalse); // nothing new

    auth.profile = const ProfileResult(ProfileOutcome.unauthorized);
    expect(await controller.refreshApproval(), isTrue);
    expect(controller.status, SessionStatus.signedOut);
    controller.dispose();
  });
}
