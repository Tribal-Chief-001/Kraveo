import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/screens/login_screen.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/partner_auth_service.dart';
import 'package:driver_app/session/session_controller.dart';

const _secret = 'Sup3r-Secret-pw';
const _phone = '9876543210';

const _sessionFromLogin = PartnerSession(
  userId: 'u9',
  name: 'Vikram Singh',
  phone: '+91 9876543210',
  avatarId: 4,
  driverId: 'drv-7',
  runnerCode: 'RUN-7731',
);

/// A scriptable stand-in for the backend.
class FakeAuth implements PartnerAuthService {
  LoginResult Function(String phone, String password) onLogin =
      (_, __) => const LoginResult.success(token: 'jwt-123', session: _sessionFromLogin);
  ProfileResult profile = const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u9', name: 'Vikram Singh', phone: '+91 9876543210', avatarId: 4));
  Completer<void>? loginGate;
  SignupResult Function(PartnerSignupForm form) onSignUp = (_) => const SignupResult.failure(SignupFailure.server);
  SignupResult Function(PartnerSignupForm form) onResubmit = (_) => const SignupResult.failure(SignupFailure.server);

  final loginCalls = <(String, String)>[];
  final profileTokens = <String>[];
  final loggedOutTokens = <String>[];

  @override
  Future<LoginResult> login({required String phone, required String password}) async {
    loginCalls.add((phone, password));
    if (loginGate != null) await loginGate!.future;
    return onLogin(phone, password);
  }

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    profileTokens.add(token);
    return profile;
  }

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async => onSignUp(form);

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async => onResubmit(form);

  @override
  Future<void> logout(String token) async => loggedOutTokens.add(token);
}

void _smallPhone(WidgetTester tester, {double textScale = 1.3}) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 900));
}

Future<void> _pumpApp(WidgetTester tester, FakeAuth auth) async {
  await tester.pumpWidget(KraveoDriverApp(auth: auth));
  await _settle(tester);
}

Future<void> _type(WidgetTester tester, {String phone = _phone, String password = _secret}) async {
  await tester.enterText(find.byKey(const ValueKey('phone-field')), phone);
  await tester.enterText(find.byKey(const ValueKey('password-field')), password);
  await tester.pump();
}

Future<void> _tapLogin(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const ValueKey('login-button')));
  await tester.tap(find.byKey(const ValueKey('login-button')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

/// Unmounts the app so the home screen's timers are disposed.
Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await DriverApiService.clearToken();
    DriverApiService.onUnauthorized = null;
  });

  group('Driver login', () {
    testWidgets('no stored token -> login screen, no network call for the session check', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('Delivery partner login'), findsOneWidget);
      expect(find.textContaining('Forgot password? Ask Kraveo support'), findsOneWidget);
      expect(auth.profileTokens, isEmpty);
      // Nothing is pre-filled: the app never holds or shows a default password.
      final password = tester.widget<TextField>(find.byKey(const ValueKey('password-field')));
      expect(password.controller!.text, isEmpty);
      expect(password.obscureText, isTrue);
      await _unmount(tester);
    });

    testWidgets('validation: bad phone and empty password never reach the server', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);

      await _tapLogin(tester);
      expect(find.text('Enter your 10-digit mobile number'), findsOneWidget);
      expect(find.text('Enter your password'), findsOneWidget);

      await _type(tester, phone: '12345', password: 'x');
      await _tapLogin(tester);
      expect(find.text('Enter your 10-digit mobile number'), findsOneWidget);
      expect(auth.loginCalls, isEmpty);
      await _unmount(tester);
    });

    testWidgets('phone field keeps 10 digits from a pasted +91 number; password can be shown', (tester) async {
      await _pumpApp(tester, FakeAuth());
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '+91 98765 43210');
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, _phone);

      await tester.enterText(find.byKey(const ValueKey('password-field')), _secret);
      await tester.tap(find.bySemanticsLabel('Show password'));
      await tester.pump();
      expect(tester.widget<TextField>(find.byKey(const ValueKey('password-field'))).obscureText, isFalse);
      expect(find.bySemanticsLabel('Hide password'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('success: sends phone + password, saves token and basics, greets the rider', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await _settle(tester);

      expect(auth.loginCalls.single, (_phone, _secret));
      expect(find.byType(LoginScreen), findsNothing);
      expect(find.text('Hi, Vikram'), findsOneWidget);
      expect(find.text('RUN-7731'), findsOneWidget);
      expect(await DriverApiService.getSavedToken(), 'jwt-123');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('kraveo_driver_jwt_token'), 'jwt-123');
      final stored = prefs.getString(SessionController.sessionPrefKey)!;
      expect(jsonDecode(stored)['runnerCode'], 'RUN-7731');
      // The password is never persisted anywhere.
      for (final key in prefs.getKeys()) {
        expect(prefs.get(key).toString().contains(_secret), isFalse, reason: 'password found in "$key"');
      }
      await _unmount(tester);
    });

    testWidgets('busy state: button shows progress and a second tap is ignored', (tester) async {
      final auth = FakeAuth()..loginGate = Completer<void>();
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('login-button')), warnIfMissed: false);
      await tester.pump();
      expect(auth.loginCalls.length, 1);
      auth.loginGate!.complete();
      await _settle(tester);
      await _unmount(tester);
    });

    testWidgets('401: wrong phone or password, password cleared, phone kept', (tester) async {
      final auth = FakeAuth()..onLogin = (_, __) => const LoginResult.failure(LoginFailure.invalidCredentials, message: 'Wrong phone or password.');
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await _settle(tester);

      expect(find.text('Wrong phone or password.'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('password-field'))).controller!.text, isEmpty);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, _phone);
      expect(await DriverApiService.getSavedToken(), isNull);

      // Typing again clears the error.
      await tester.enterText(find.byKey(const ValueKey('password-field')), 'a');
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Wrong phone or password.'), findsNothing);
      await _unmount(tester);
    });

    testWidgets('429: live countdown disables the button, then re-enables', (tester) async {
      final auth = FakeAuth()
        ..onLogin = (_, __) => const LoginResult.failure(LoginFailure.locked, message: 'Locked', retryAfterSeconds: 90);
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.text('Too many wrong tries.'), findsOneWidget);
      expect(find.text('Try again in 1:30'), findsNWidgets(2)); // banner + button
      expect(tester.widget<Opacity>(find.descendant(of: find.byKey(const ValueKey('login-button')), matching: find.byType(Opacity)).first).opacity, lessThan(1));

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Try again in 1:29'), findsNWidgets(2));

      // A tap while locked does nothing.
      await tester.tap(find.byKey(const ValueKey('login-button')), warnIfMissed: false);
      await tester.pump();
      expect(auth.loginCalls.length, 1);

      await tester.pump(const Duration(seconds: 89));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('Try again in'), findsNothing);
      expect(find.text('Too many wrong tries.'), findsNothing);
      expect(find.text('Log in'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('429: editing to a different number lifts the lock display', (tester) async {
      final auth = FakeAuth()
        ..onLogin = (_, __) => const LoginResult.failure(LoginFailure.locked, retryAfterSeconds: 600);
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Try again in 10:00'), findsNWidgets(2));

      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9123456789');
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('Try again in'), findsNothing);
      expect(find.text('Log in'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('403 wrong app, offline and server error each get a clear message', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _type(tester);

      auth.onLogin = (_, __) => const LoginResult.failure(LoginFailure.wrongRole, message: 'This number belongs to a restaurant partner.');
      await _tapLogin(tester);
      await _settle(tester);
      expect(find.text('This number belongs to a restaurant partner.'), findsOneWidget);

      auth.onLogin = (_, __) => const LoginResult.failure(LoginFailure.offline);
      await _tapLogin(tester);
      await _settle(tester);
      expect(find.textContaining('Can\'t reach Kraveo'), findsOneWidget);
      expect(find.text('This number belongs to a restaurant partner.'), findsNothing);

      auth.onLogin = (_, __) => const LoginResult.failure(LoginFailure.server);
      await _tapLogin(tester);
      await _settle(tester);
      expect(find.textContaining('Kraveo is having trouble'), findsOneWidget);
      expect(find.byType(LoginScreen), findsOneWidget);
      await _unmount(tester);
    });
  });

  group('Driver session gate', () {
    testWidgets('valid stored token -> splash, then home with the saved rider name', (tester) async {
      SharedPreferences.setMockInitialValues({
        'kraveo_driver_jwt_token': 'stored-jwt',
        SessionController.sessionPrefKey: jsonEncode(_sessionFromLogin.toJson()),
      });
      final auth = FakeAuth();
      await tester.pumpWidget(KraveoDriverApp(auth: auth));
      expect(find.byType(CircularProgressIndicator), findsOneWidget); // splash while validating
      await _settle(tester);

      expect(auth.profileTokens, ['stored-jwt']);
      expect(find.byType(LoginScreen), findsNothing);
      expect(find.text('Hi, Vikram'), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('401 on the session check clears the token and shows login', (tester) async {
      SharedPreferences.setMockInitialValues({
        'kraveo_driver_jwt_token': 'dead-jwt',
        SessionController.sessionPrefKey: jsonEncode(_sessionFromLogin.toJson()),
      });
      final auth = FakeAuth()..profile = const ProfileResult(ProfileOutcome.unauthorized);
      await _pumpApp(tester, auth);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(await DriverApiService.getSavedToken(), isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('kraveo_driver_jwt_token'), isNull);
      expect(prefs.getString(SessionController.sessionPrefKey), isNull);
      await _unmount(tester);
    });

    testWidgets('offline session check keeps the token and offers Retry', (tester) async {
      SharedPreferences.setMockInitialValues({
        'kraveo_driver_jwt_token': 'stored-jwt',
        SessionController.sessionPrefKey: jsonEncode(_sessionFromLogin.toJson()),
      });
      final auth = FakeAuth()..profile = const ProfileResult(ProfileOutcome.unreachable);
      await _pumpApp(tester, auth);

      expect(find.text('Can\'t reach Kraveo'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byType(LoginScreen), findsNothing);
      expect(await DriverApiService.getSavedToken(), 'stored-jwt');

      auth.profile = const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u9', name: 'Vikram Singh'));
      await tester.tap(find.text('Retry'));
      await _settle(tester);
      expect(auth.profileTokens.length, 2);
      expect(find.text('Can\'t reach Kraveo'), findsNothing);
      expect(find.text('RUN-7731'), findsOneWidget); // runner code survives from the stored login
      await _unmount(tester);
    });

    testWidgets('a token that belongs to another role does not open the app', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'other-role-jwt'});
      final auth = FakeAuth()..profile = const ProfileResult(ProfileOutcome.unauthorized);
      await _pumpApp(tester, auth);
      expect(find.byType(LoginScreen), findsOneWidget);
      await _unmount(tester);
    });

    testWidgets('401 from any authenticated call -> login with a Session expired snackbar', (tester) async {
      final auth = FakeAuth();
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await _settle(tester);
      expect(find.text('Hi, Vikram'), findsOneWidget);

      // What DriverApiService does when the server answers 401.
      DriverApiService.onUnauthorized!.call();
      DriverApiService.onUnauthorized!.call(); // a burst of 401s is harmless
      await _settle(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.textContaining('Session expired'), findsOneWidget);
      expect(await DriverApiService.getSavedToken(), isNull);
      await tester.pump(const Duration(seconds: 6));
      await _unmount(tester);
    });
  });

  group('Driver logout', () {
    Future<void> signIn(WidgetTester tester, FakeAuth auth) async {
      await _pumpApp(tester, auth);
      await _type(tester);
      await _tapLogin(tester);
      await _settle(tester);
    }

    testWidgets('log out card -> confirm: goes off duty, clears everything, returns to login', (tester) async {
      final auth = FakeAuth();
      final dutyCalls = <Object?>[];
      await http.runWithClient(() async {
        await signIn(tester, auth);
        await tester.scrollUntilVisible(find.byKey(const ValueKey('logout-card')), 300, scrollable: find.byType(Scrollable).first);
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('logout-card')));
        await _settle(tester);

        expect(find.text('Log out?'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('confirm-logout-button')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        await _settle(tester);
      }, () => MockClient((request) async {
            if (request.url.path.endsWith('/drivers/duty-status')) dutyCalls.add(jsonDecode(request.body)['isOnline']);
            return http.Response('{}', 200);
          }));

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(auth.loggedOutTokens, ['jwt-123']);
      expect(dutyCalls.last, false);
      expect(await DriverApiService.getSavedToken(), isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('kraveo_driver_jwt_token'), isNull);
      expect(prefs.getString(SessionController.sessionPrefKey), isNull);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, isEmpty);
      await tester.pump(const Duration(seconds: 7));
      await _unmount(tester);
    });

    testWidgets('greeting opens the account sheet with name, runner code and Log out; "Stay logged in" keeps the session', (tester) async {
      final auth = FakeAuth();
      await signIn(tester, auth);
      await tester.tap(find.text('Hi, Vikram'));
      await _settle(tester);

      expect(find.text('Vikram Singh'), findsOneWidget);
      expect(find.text('RUN-7731'), findsNWidgets(2)); // greeting + sheet
      expect(find.byKey(const ValueKey('account-logout-button')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('account-logout-button')));
      await _settle(tester);
      expect(find.text('Log out?'), findsOneWidget);

      await tester.tap(find.text('Stay logged in'));
      await _settle(tester);
      expect(find.byType(LoginScreen), findsNothing);
      expect(auth.loggedOutTokens, isEmpty);
      expect(await DriverApiService.getSavedToken(), 'jwt-123');
      await _unmount(tester);
    });

    testWidgets('the real runner pass shows the logged-in rider, not placeholder details', (tester) async {
      await signIn(tester, FakeAuth());
      await tester.tap(find.byIcon(LucideIcons.badgeCheck).first);
      await _settle(tester);
      expect(find.text('Vikram Singh'), findsOneWidget);
      expect(find.text('RUN-7731'), findsOneWidget);
      expect(find.text('TVS Jupiter · MP 04 AB 1234'), findsNothing);
      await _unmount(tester);
    });
  });

  group('DriverApiService 401 handling', () {
    test('a 401 from an authenticated call fires onUnauthorized; a 200 does not', () async {
      var fired = 0;
      DriverApiService.onUnauthorized = () => fired++;
      await DriverApiService.saveToken('jwt-abc');
      String? sentAuth;
      var status = 200;
      await http.runWithClient(() async {
        await DriverApiService.toggleDutyStatus(true);
        expect(fired, 0);
        status = 401;
        final ok = await DriverApiService.acceptJob('ord-1');
        expect(ok, isFalse);
      }, () => MockClient((request) async {
            sentAuth = request.headers['Authorization'];
            return http.Response('{}', status);
          }));
      expect(fired, 1);
      expect(sentAuth, 'Bearer jwt-abc');
    });
  });

  group('ApiPartnerAuthService', () {
    Future<LoginResult> loginWith(http.Response Function(http.Request) handler, {Object? throws}) {
      return http.runWithClient(
        () => ApiPartnerAuthService().login(phone: _phone, password: _secret),
        () => MockClient((request) async {
          if (throws != null) throw throws;
          return handler(request);
        }),
      );
    }

    test('sends phone, password and role DRIVER to /auth/partner-login and parses success', () async {
      late http.Request seen;
      final result = await loginWith((request) {
        seen = request;
        return http.Response(
          jsonEncode({
            'success': true,
            'token': 'jwt',
            'user': {'id': 7, 'name': 'Vikram', 'phone': '+91 9876543210', 'role': 'DRIVER', 'avatarId': null},
            'driver': {'id': 'd1', 'runnerCode': 'RUN-1234'},
          }),
          200,
        );
      });
      expect(seen.url.toString(), endsWith('/auth/partner-login'));
      expect(jsonDecode(seen.body), {'phone': _phone, 'password': _secret, 'role': 'DRIVER'});
      expect(result.ok, isTrue);
      expect(result.token, 'jwt');
      expect(result.session!.userId, '7');
      expect(result.session!.runnerCode, 'RUN-1234');
    });

    test('maps 401 / 403 / 429 / 500 / network errors', () async {
      final r401 = await loginWith((_) => http.Response(jsonEncode({'success': false, 'message': 'Wrong phone or password.'}), 401));
      expect(r401.failure, LoginFailure.invalidCredentials);
      expect(r401.message, 'Wrong phone or password.');

      final r403 = await loginWith((_) => http.Response(jsonEncode({'success': false, 'message': 'Vendor account'}), 403));
      expect(r403.failure, LoginFailure.wrongRole);
      expect(r403.message, 'Vendor account');

      final r429 = await loginWith((_) => http.Response(jsonEncode({'success': false, 'message': 'Locked', 'retryAfterSeconds': 840}), 429));
      expect(r429.failure, LoginFailure.locked);
      expect(r429.retryAfterSeconds, 840);

      final r500 = await loginWith((_) => http.Response('<html>oops</html>', 502));
      expect(r500.failure, LoginFailure.server);

      final rBad = await loginWith((_) => http.Response('{}', 200));
      expect(rBad.failure, LoginFailure.server);

      final offline = await loginWith((_) => http.Response('', 200), throws: http.ClientException('no route'));
      expect(offline.failure, LoginFailure.offline);
    });

    test('profile: 200 valid, 401 unauthorized, other role unauthorized, 5xx/network unreachable', () async {
      Future<ProfileResult> profileWith(http.Response Function(http.Request) h, {Object? throws}) => http.runWithClient(
            () => ApiPartnerAuthService().fetchProfile('tok'),
            () => MockClient((r) async {
              if (throws != null) throw throws;
              expect(r.headers['Authorization'], 'Bearer tok');
              return h(r);
            }),
          );
      String body(String role) => jsonEncode({'success': true, 'user': {'id': 'u', 'name': 'N', 'role': role}});
      expect((await profileWith((_) => http.Response(body('DRIVER'), 200))).outcome, ProfileOutcome.valid);
      expect((await profileWith((_) => http.Response(body('VENDOR'), 200))).outcome, ProfileOutcome.unauthorized);
      expect((await profileWith((_) => http.Response('{}', 401))).outcome, ProfileOutcome.unauthorized);
      expect((await profileWith((_) => http.Response('{}', 503))).outcome, ProfileOutcome.unreachable);
      expect((await profileWith((_) => http.Response('', 200), throws: http.ClientException('x'))).outcome, ProfileOutcome.unreachable);
    });
  });

  group('Driver auth layout (360x640 @ 1.3x)', () {
    testWidgets('login with a lock banner and validation errors does not overflow', (tester) async {
      _smallPhone(tester);
      final auth = FakeAuth()..onLogin = (_, __) => const LoginResult.failure(LoginFailure.locked, retryAfterSeconds: 900);
      await _pumpApp(tester, auth);
      await _tapLogin(tester); // both validation errors
      expect(tester.takeException(), isNull);
      await _type(tester);
      await _tapLogin(tester);
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Too many wrong tries.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });

    testWidgets('offline retry screen, greeting, account sheet and logout card do not overflow', (tester) async {
      _smallPhone(tester);
      SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 't'});
      final auth = FakeAuth()..profile = const ProfileResult(ProfileOutcome.unreachable);
      await _pumpApp(tester, auth);
      expect(find.text('Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
      // The retry button must be on screen without scrolling.
      expect(tester.getBottomLeft(find.byType(KButton)).dy, lessThanOrEqualTo(640));

      auth.profile = const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u1', name: 'A Very Long Rider Name Kumar Srivastava', runnerCode: 'RUN-9999'));
      await tester.tap(find.text('Retry'));
      await _settle(tester);
      expect(tester.takeException(), isNull);
      await tester.tap(find.textContaining('Hi, A'));
      await _settle(tester);
      expect(find.byKey(const ValueKey('account-logout-button')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('account-logout-button')));
      await _settle(tester);
      expect(find.text('Log out?'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _unmount(tester);
    });
  });
}
