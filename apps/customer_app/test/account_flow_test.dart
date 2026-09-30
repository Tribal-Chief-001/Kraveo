import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/models/auth_results.dart';
import 'package:customer_app/models/customer_user.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/auth_screen.dart';
import 'package:customer_app/screens/profile_screen.dart';
import 'package:customer_app/screens/profile_setup_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/widgets/ui/hostel_pill.dart';
import 'package:customer_app/widgets/ui/phone_input.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// In-memory stand-in for the Kraveo backend. Routes are "METHOD /path-after-/api".
class FakeBackend {
  final List<http.Request> requests = [];
  final Map<String, http.Response Function(http.Request)> routes = {};

  void on(String route, http.Response Function(http.Request) handler) => routes[route] = handler;

  MockClient get client => MockClient((req) async {
        requests.add(req);
        final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
        final handler = routes['${req.method} $path'];
        if (handler == null) return http.Response('{"success":false,"message":"no route"}', 404);
        return handler(req);
      });

  Iterable<http.Request> to(String route) => requests.where((r) => '${r.method} ${r.url.path.replaceFirst(RegExp(r'^/api'), '')}' == route);
  Map<String, dynamic> bodyOf(http.Request r) => jsonDecode(r.body) as Map<String, dynamic>;
}

http.Response reply(int status, Map<String, dynamic> body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> userJson({String? name = 'Aarav Sharma', String? hostel = 'Block 2', int coins = 120, String phone = '+919876543210', String role = 'STUDENT'}) =>
    {'id': 'u1', 'phone': phone, 'name': name, 'role': role, 'hostelBlock': hostel, 'kraveoCoins': coins};

Future<void> loadKraveoFonts() async {
  const fonts = {
    'packages/kraveo_ui/Bricolage': 'packages/kraveo_ui/assets/fonts/BricolageGrotesque.ttf',
    'packages/kraveo_ui/Jakarta': 'packages/kraveo_ui/assets/fonts/PlusJakartaSans.ttf',
  };
  for (final entry in fonts.entries) {
    final loader = FontLoader(entry.key)..addFont(rootBundle.load(entry.value));
    await loader.load();
  }
}

/// 360x640 at 1.3x text: any overflow or build error fails the test.
void smallPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

Future<void> pumpWithProviders(
  WidgetTester tester,
  Widget child, {
  SessionProvider? session,
  CartProvider? cart,
  OrderProvider? orders,
}) async {
  smallPhone(tester);
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<SessionProvider>.value(value: session ?? SessionProvider(initial: SessionStatus.signedOut)),
        ChangeNotifierProvider<DhabaProvider>(create: (_) => DhabaProvider()),
        ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
        ChangeNotifierProvider<OrderProvider>.value(value: orders ?? OrderProvider()),
      ],
      child: MaterialApp(theme: KraveoTheme.customer(), home: child),
    ),
  );
  await tester.pump(const Duration(milliseconds: 800));
}

/// Unmounts everything so screen timers (resend countdown) are cancelled before the test ends.
Future<void> unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(seconds: 5));
}

Future<void> settle(WidgetTester tester, [int ms = 600]) async {
  await tester.pump();
  await tester.pump(Duration(milliseconds: ms));
}

void main() {
  setUpAll(loadKraveoFonts);

  late FakeBackend backend;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await CustomerApiService.clearToken();
    backend = FakeBackend();
    CustomerApiService.httpClientOverride = backend.client;
    CustomerApiService.onUnauthorized = null;
  });

  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    CustomerApiService.onUnauthorized = null;
  });

  group('models and helpers', () {
    test('maskedPhone hides the middle digits for any stored format', () {
      for (final raw in ['+919876543210', '919876543210', '9876543210']) {
        expect(CustomerUser(id: '1', phone: raw).maskedPhone, '+91 98••• ••210');
      }
    });

    test('initials and first name', () {
      expect(const CustomerUser(id: '1', phone: '1', name: 'Aarav  Kumar Sharma').initials, 'AS');
      expect(const CustomerUser(id: '1', phone: '1', name: 'meera').initials, 'M');
      expect(const CustomerUser(id: '1', phone: '1', name: 'Aarav Sharma').firstName, 'Aarav');
      expect(const CustomerUser(id: '1', phone: '1').initials, 'K');
    });

    test('legacy hostel names map onto the drop-off list', () {
      expect(normalizeHostelBlock('Boys Hostel Block 3', kHostelBlocks), 'Block 3');
      expect(normalizeHostelBlock('block 6', kHostelBlocks), 'Block 6');
      expect(normalizeHostelBlock('Block 2', kHostelBlocks), 'Block 2');
      expect(normalizeHostelBlock('girls hostel gate 2', kHostelBlocks), 'Girls Gate 2');
      expect(normalizeHostelBlock('VIT Main Gate', kHostelBlocks), 'VIT Main Gate');
      expect(normalizeHostelBlock('Block 42', kHostelBlocks), isNull);
      expect(normalizeHostelBlock('Somewhere else', kHostelBlocks), isNull);
      expect(normalizeHostelBlock(null, kHostelBlocks), isNull);
    });

    test('phone normaliser strips country code and formatting', () {
      expect(normalizeIndianPhone('+91 98765 43210'), '9876543210');
      expect(normalizeIndianPhone('919876543210'), '9876543210');
      expect(normalizeIndianPhone('09876543210'), '9876543210');
      expect(normalizeIndianPhone('98765abc43210999'), '9876543210');
      expect(validateIndianMobile('9876543210'), isNull);
      expect(validateIndianMobile('5876543210'), contains('start with 6, 7, 8 or 9'));
      expect(validateIndianMobile('98765'), contains('10-digit'));
    });

    test('name validation follows the 2-60 character contract', () {
      expect(validateFullName(''), isNotNull);
      expect(validateFullName(' A '), isNotNull);
      expect(validateFullName('12'), isNotNull);
      expect(validateFullName('Al'), isNull);
      expect(validateFullName('Aarav Sharma'), isNull);
      expect(validateFullName('x' * 61), isNotNull);
    });
  });

  group('CustomerApiService', () {
    test('sendOtp parses success, rate limit, outage and network failure', () async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true, 'message': 'sent', 'resendAfterSeconds': 45, 'expiresInSeconds': 120}));
      var r = await CustomerApiService.sendOtp('9876543210');
      expect(r.success, isTrue);
      expect(r.resendAfterSeconds, 45);
      expect(r.expiresInSeconds, 120);
      expect(backend.bodyOf(backend.to('POST /auth/send-otp').single), {'phone': '9876543210'});

      backend.on('POST /auth/send-otp', (_) => reply(429, {'success': false, 'message': 'Slow down', 'retryAfterSeconds': 42}));
      r = await CustomerApiService.sendOtp('9876543210');
      expect(r.success, isFalse);
      expect(r.rateLimited, isTrue);
      expect(r.retryAfterSeconds, 42);
      expect(r.message, 'Slow down');

      backend.on('POST /auth/send-otp', (_) => reply(503, {'success': false, 'message': 'SMS down'}));
      r = await CustomerApiService.sendOtp('9876543210');
      expect(r.unavailable, isTrue);

      backend.on('POST /auth/send-otp', (_) => throw http.ClientException('offline'));
      r = await CustomerApiService.sendOtp('9876543210');
      expect(r.networkError, isTrue);
      expect(r.success, isFalse);
    });

    test('verifyOtp stores the token and returns the typed user', () async {
      backend.on('POST /auth/verify-otp', (_) => reply(200, {'success': true, 'token': 'jwt-1', 'user': userJson(), 'isNewUser': true, 'needsProfile': true}));
      final r = await CustomerApiService.verifyOtp('9876543210', '4821');
      expect(r.success, isTrue);
      expect(r.token, 'jwt-1');
      expect(r.isNewUser, isTrue);
      expect(r.needsProfile, isTrue);
      expect(r.user?['name'], 'Aarav Sharma');
      expect(await CustomerApiService.getSavedToken(), 'jwt-1');
      expect(backend.bodyOf(backend.requests.single), {'phone': '9876543210', 'otp': '4821', 'role': 'STUDENT'});
    });

    test('verifyOtp failures expose attemptsLeft, lockout and role errors without saving a token', () async {
      backend.on('POST /auth/verify-otp', (_) => reply(400, {'success': false, 'message': 'Wrong code', 'attemptsLeft': 3}));
      var r = await CustomerApiService.verifyOtp('9876543210', '0000');
      expect(r.success, isFalse);
      expect(r.attemptsLeft, 3);

      backend.on('POST /auth/verify-otp', (_) => reply(429, {'success': false, 'message': 'Locked', 'retryAfterSeconds': 300}));
      r = await CustomerApiService.verifyOtp('9876543210', '0000');
      expect(r.locked, isTrue);
      expect(r.retryAfterSeconds, 300);

      backend.on('POST /auth/verify-otp', (_) => reply(403, {'success': false, 'message': 'Wrong app'}));
      r = await CustomerApiService.verifyOtp('9876543210', '0000');
      expect(r.roleNotAllowed, isTrue);

      // A vendor account must never be signed in by the customer app, even on a 200.
      backend.on('POST /auth/verify-otp', (_) => reply(200, {'success': true, 'token': 'vendor-jwt', 'user': userJson(role: 'VENDOR')}));
      r = await CustomerApiService.verifyOtp('9876543210', '4821');
      expect(r.success, isFalse);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    test('profile calls send the Bearer token and surface field errors', () async {
      await CustomerApiService.saveToken('jwt-9');
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'Name too short', 'field': 'name'}));
      var r = await CustomerApiService.updateProfile(name: 'A', hostelBlock: 'Block 1');
      expect(r.success, isFalse);
      expect(r.field, 'name');
      expect(r.message, 'Name too short');
      expect(backend.requests.single.headers['Authorization'], 'Bearer jwt-9');
      expect(backend.bodyOf(backend.requests.single), {'name': 'A', 'hostelBlock': 'Block 1'});

      backend.on('PUT /auth/profile', (_) => reply(200, {'success': true, 'user': userJson(hostel: 'Block 1'), 'needsProfile': false}));
      r = await CustomerApiService.updateProfile(name: 'Aarav Sharma', hostelBlock: 'Block 1');
      expect(r.success, isTrue);
      expect(r.user?['hostelBlock'], 'Block 1');
      expect(r.needsProfile, isFalse);
    });

    test('deleteAccount reports the 409 conflict message', () async {
      await CustomerApiService.saveToken('jwt-9');
      backend.on('DELETE /auth/account', (_) => reply(409, {'success': false, 'message': 'Finish your order first'}));
      final r = await CustomerApiService.deleteAccount();
      expect(r.success, isFalse);
      expect(r.conflict, isTrue);
      expect(r.message, 'Finish your order first');
      expect(await CustomerApiService.getSavedToken(), 'jwt-9', reason: 'a refused deletion must not sign the student out');
    });

    test('HTTP 401 on authenticated calls clears the token and fires onUnauthorized', () async {
      var fired = 0;
      CustomerApiService.onUnauthorized = () => fired++;
      backend.on('POST /orders', (_) => reply(401, {'success': false, 'message': 'jwt expired'}));
      backend.on('POST /payments/create-order', (_) => reply(401, {'success': false}));
      backend.on('POST /payments/verify-signature', (_) => reply(401, {'success': false}));
      backend.on('GET /auth/profile', (_) => reply(401, {'success': false}));
      backend.on('PUT /auth/profile', (_) => reply(401, {'success': false}));

      Future<void> expectExpired(Future<Object?> Function() call) async {
        await CustomerApiService.saveToken('jwt-old');
        final before = fired;
        try {
          await call();
        } catch (e) {
          expect(e.toString(), contains(CustomerApiService.sessionExpiredMessage));
        }
        expect(fired, before + 1);
        expect(await CustomerApiService.getSavedToken(), isNull);
      }

      await expectExpired(() => CustomerApiService.createOrder(vendorId: 'v', items: const [], dropoffHostel: 'Block 1', dropoffNotes: ''));
      await expectExpired(() => CustomerApiService.createPaymentOrder('o1'));
      await expectExpired(() => CustomerApiService.verifyPayment(razorpayOrderId: 'a', razorpayPaymentId: 'b', razorpaySignature: 'c'));
      await expectExpired(() async {
        final r = await CustomerApiService.fetchProfile();
        expect(r?.unauthorized, isTrue);
        return r;
      });
      await expectExpired(() async {
        final r = await CustomerApiService.updateProfile(name: 'Aarav', hostelBlock: 'Block 1');
        expect(r.unauthorized, isTrue);
        return r;
      });
    });

    test('fetchProfile keeps the token when the network is down', () async {
      await CustomerApiService.saveToken('jwt-keep');
      backend.on('GET /auth/profile', (_) => throw http.ClientException('offline'));
      final r = await CustomerApiService.fetchProfile();
      expect(r?.networkError, isTrue);
      expect(await CustomerApiService.getSavedToken(), 'jwt-keep');
    });
  });

  group('AuthScreen', () {
    Future<void> enterPhoneAndSend(WidgetTester tester, [String phone = '9876543210']) async {
      await tester.enterText(find.byKey(const ValueKey('phone-field')), phone);
      await tester.tap(find.text('Send code'));
      await settle(tester);
    }

    testWidgets('rejects bad numbers with a clear message and sends nothing', (tester) async {
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await tester.tap(find.text('Send code'));
      await settle(tester);
      expect(find.text('Enter your 10-digit Indian mobile number.'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('phone-field')), '5876543210');
      await tester.pump();
      expect(find.text('Enter your 10-digit Indian mobile number.'), findsNothing, reason: 'typing clears the error');
      await tester.tap(find.text('Send code'));
      await settle(tester);
      expect(find.textContaining('start with 6, 7, 8 or 9'), findsOneWidget);
      expect(backend.requests, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pasting a +91 formatted number keeps the ten digits', (tester) async {
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '+91 98765 43210');
      await tester.pump();
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, '9876543210');
    });

    testWidgets('send -> code entry -> auto-submits on the 4th digit and hands back the typed result', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true, 'message': 'ok', 'resendAfterSeconds': 30, 'expiresInSeconds': 300}));
      backend.on('POST /auth/verify-otp', (_) => reply(200, {'success': true, 'token': 'jwt-1', 'user': userJson(name: null, hostel: null), 'isNewUser': true, 'needsProfile': true}));
      VerifyOtpResult? verified;
      await pumpWithProviders(tester, AuthScreen(onVerified: (r) => verified = r));

      await enterPhoneAndSend(tester);
      expect(find.textContaining('Enter your'), findsOneWidget);
      expect(find.text('Sent to +91 9876543210  '), findsOneWidget);
      expect(find.text('Resend in 0:30'), findsOneWidget);
      expect(find.text('YOUR NAME (OPTIONAL)'), findsNothing, reason: 'name moved to first-time setup');
      expect(find.textContaining('valid for 5 minutes'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '4821');
      await settle(tester);
      expect(verified, isNotNull);
      expect(verified!.needsProfile, isTrue);
      expect(verified!.isNewUser, isTrue);
      expect(backend.bodyOf(backend.to('POST /auth/verify-otp').single), {'phone': '9876543210', 'otp': '4821', 'role': 'STUDENT'});
      expect(await CustomerApiService.getSavedToken(), 'jwt-1');
      await unmount(tester);
    });

    testWidgets('wrong code shows attempts left, clears the boxes and allows another try', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true}));
      backend.on('POST /auth/verify-otp', (_) => reply(400, {'success': false, 'message': 'Invalid code', 'attemptsLeft': 3}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);

      await tester.enterText(find.byType(TextField), '1111');
      await settle(tester);
      expect(find.textContaining('3 attempts left'), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);

      backend.on('POST /auth/verify-otp', (_) => reply(400, {'success': false, 'message': 'Invalid code', 'attemptsLeft': 1}));
      await tester.enterText(find.byType(TextField), '2222');
      await settle(tester);
      expect(find.textContaining('1 attempt left'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await unmount(tester);
    });

    testWidgets('lockout (429) disables entry and counts down using retryAfterSeconds', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true}));
      backend.on('POST /auth/verify-otp', (_) => reply(429, {'success': false, 'message': 'Too many wrong codes', 'retryAfterSeconds': 90}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      await tester.enterText(find.byType(TextField), '1111');
      await settle(tester);

      expect(find.text('Too many wrong codes'), findsOneWidget);
      expect(find.textContaining('Try again in 1:'), findsOneWidget);
      final before = backend.to('POST /auth/verify-otp').length;
      await tester.tap(find.textContaining('Try again in 1:'));
      await settle(tester);
      expect(backend.to('POST /auth/verify-otp').length, before, reason: 'locked: no request');

      await tester.pump(const Duration(seconds: 91));
      expect(find.text('Verify & continue'), findsOneWidget);
      expect(find.text('Too many wrong codes'), findsNothing);
      await unmount(tester);
    });

    testWidgets('resend is disabled for resendAfterSeconds, then sends a new code', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true, 'resendAfterSeconds': 20}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      expect(find.text('Resend in 0:20'), findsOneWidget);
      expect(find.text('Resend code'), findsNothing);

      await tester.pump(const Duration(seconds: 21));
      expect(find.text('Resend code'), findsOneWidget);
      await tester.tap(find.text('Resend code'));
      await settle(tester);
      expect(backend.to('POST /auth/send-otp').length, 2);
      expect(find.textContaining('New code sent to +91 9876543210'), findsOneWidget);
      expect(find.text('Resend in 0:20'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('429 on send shows the cooldown on the button; changing the number lifts it', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(429, {'success': false, 'message': 'Please wait before asking again', 'retryAfterSeconds': 42}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      expect(find.text('Please wait before asking again'), findsOneWidget);
      expect(find.text('Try again in 0:42'), findsOneWidget);

      await tester.tap(find.text('Try again in 0:42'));
      await settle(tester);
      expect(backend.to('POST /auth/send-otp').length, 1);

      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9123456780');
      await tester.pump();
      expect(find.text('Send code'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('SMS outage (503) and offline both get friendly messages', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(503, {'success': false, 'message': 'provider error 5xx'}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      expect(find.textContaining('We couldn\'t send the code right now'), findsOneWidget);
      expect(find.textContaining('provider error'), findsNothing);
      expect(find.text('Send code'), findsOneWidget, reason: 'stays on the phone step');

      backend.on('POST /auth/send-otp', (_) => throw http.ClientException('offline'));
      await tester.tap(find.text('Send code'));
      await settle(tester);
      expect(find.textContaining('couldn\'t reach Kraveo'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('Change number returns to the phone step without another request', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      expect(find.text('Verify & continue'), findsOneWidget);
      await tester.tap(find.text('Change number'));
      await settle(tester);
      expect(find.text('Send code'), findsOneWidget);
      expect(backend.requests.length, 1);
      await unmount(tester);
    });

    testWidgets('code step keeps the boxes usable with the keyboard on the smallest phone', (tester) async {
      backend.on('POST /auth/send-otp', (_) => reply(200, {'success': true}));
      await pumpWithProviders(tester, AuthScreen(onVerified: (_) {}));
      await enterPhoneAndSend(tester);
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await settle(tester);
      expect(tester.takeException(), isNull);
      await unmount(tester);
    });
  });

  group('ProfileSetupScreen', () {
    SessionProvider needsProfileSession() {
      final s = SessionProvider(initial: SessionStatus.checking);
      s.startFromVerify(VerifyOtpResult(success: true, token: 't', user: userJson(name: null, hostel: null), needsProfile: true, isNewUser: true));
      return s;
    }

    testWidgets('cannot continue without a valid name and drop-off point', (tester) async {
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      expect(find.text('Almost there'), findsOneWidget);

      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('Tell us your name'), findsOneWidget);
      expect(find.text('Choose where we should deliver.'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('name-field')), 'A');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('at least 2'), findsOneWidget);
      expect(backend.requests, isEmpty);
      expect(session.status, SessionStatus.needsProfile);
      expect(tester.takeException(), isNull);
    });

    testWidgets('saves name and hostel, then moves the session into the app', (tester) async {
      await CustomerApiService.saveToken('jwt-setup');
      backend.on('PUT /auth/profile', (req) {
        final b = jsonDecode(req.body) as Map;
        return reply(200, {'success': true, 'user': userJson(name: b['name'] as String, hostel: b['hostelBlock'] as String), 'needsProfile': false});
      });
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);

      await tester.enterText(find.byKey(const ValueKey('name-field')), '  Aarav   Sharma ');
      await tester.tap(find.text('Choose your hostel or gate'));
      await settle(tester);
      expect(find.text('Where should we deliver?'), findsOneWidget);
      await tester.tap(find.text('Block 3'));
      await settle(tester);
      expect(find.text('Block 3'), findsOneWidget);

      await tester.ensureVisible(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await settle(tester);

      final put = backend.to('PUT /auth/profile').single;
      expect(backend.bodyOf(put), {'name': 'Aarav Sharma', 'hostelBlock': 'Block 3'});
      expect(put.headers['Authorization'], 'Bearer jwt-setup');
      expect(session.status, SessionStatus.signedIn);
      expect(session.user?.name, 'Aarav Sharma');
      expect(session.selectedHostel, 'Block 3');
    });

    testWidgets('shows the server\'s field error under the right input and keeps the form', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'That name isn\'t allowed', 'field': 'name'}));
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Valid Name');
      await tester.tap(find.text('Choose your hostel or gate'));
      await settle(tester);
      await tester.tap(find.text('Block 1'));
      await settle(tester);
      await tester.ensureVisible(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.text('That name isn\'t allowed'), findsOneWidget);
      expect(session.status, SessionStatus.needsProfile);
    });

    testWidgets('offline save keeps the form and explains why', (tester) async {
      backend.on('PUT /auth/profile', (_) => throw http.ClientException('offline'));
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Valid Name');
      await tester.tap(find.text('Choose your hostel or gate'));
      await settle(tester);
      await tester.tap(find.text('Block 1'));
      await settle(tester);
      await tester.ensureVisible(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('couldn\'t reach Kraveo'), findsOneWidget);
      expect(find.text('Valid Name'), findsOneWidget);
    });

    testWidgets('prefills a legacy account\'s name and mapped hostel', (tester) async {
      final session = SessionProvider(initial: SessionStatus.checking)
        ..startFromVerify(VerifyOtpResult(success: true, user: userJson(name: 'Meera Rao', hostel: 'Boys Hostel Block 3'), needsProfile: true));
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      expect(find.text('Meera Rao'), findsOneWidget);
      expect(find.text('Block 3'), findsOneWidget);
    });
  });

  group('ProfileScreen', () {
    SessionProvider signedIn({String? hostel = 'Block 2'}) {
      final s = SessionProvider(initial: SessionStatus.checking);
      s.startFromVerify(VerifyOtpResult(success: true, token: 't', user: userJson(hostel: hostel)));
      return s;
    }

    Future<void> openDeleteSheet(WidgetTester tester) async {
      await tester.scrollUntilVisible(find.text('Delete account'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Delete account'));
      await settle(tester);
    }

    testWidgets('shows identity, masked phone, coins, drop-off point and version', (tester) async {
      final cart = CartProvider()..setKraveoCoins(120);
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn(), cart: cart);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Me'), findsOneWidget);
      expect(find.text('AS'), findsOneWidget);
      expect(find.text('Aarav Sharma'), findsOneWidget);
      expect(find.text('+91 98••• ••210'), findsOneWidget);
      expect(find.text('9876543210'), findsNothing);
      expect(find.text('120'), findsOneWidget);
      expect(find.text('Block 2'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Kraveo v1.1.0'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Kraveo v1.1.0'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('orders summary counts delivered orders, or explains there are none', (tester) async {
      final orders = OrderProvider()..resetForLogout();
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn(), orders: orders);
      expect(find.textContaining('No delivered orders yet'), findsOneWidget);
    });

    testWidgets('changing the drop-off point saves it through PUT /auth/profile', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      backend.on('PUT /auth/profile', (req) => reply(200, {'success': true, 'user': userJson(hostel: (jsonDecode(req.body) as Map)['hostelBlock'] as String), 'needsProfile': false}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tester.tap(find.text('Block 2'));
      await settle(tester);
      await tester.tap(find.text('Block 5'));
      await settle(tester);

      expect(backend.bodyOf(backend.to('PUT /auth/profile').single), {'name': 'Aarav Sharma', 'hostelBlock': 'Block 5'});
      expect(session.selectedHostel, 'Block 5');
      expect(find.text('Drop-off point set to Block 5'), findsOneWidget);
    });

    testWidgets('a failed save reverts the drop-off point and says so', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'Pick a valid drop-off', 'field': 'hostelBlock'}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tester.tap(find.text('Block 2'));
      await settle(tester);
      await tester.tap(find.text('Block 5'));
      await settle(tester);
      expect(session.selectedHostel, 'Block 2');
      expect(find.text('Pick a valid drop-off'), findsOneWidget);
    });

    testWidgets('log out asks first, notifies the backend and ends the session', (tester) async {
      await CustomerApiService.saveToken('jwt-out');
      backend.on('POST /auth/logout', (_) => reply(200, {'success': true}));
      final session = signedIn();
      var signedOutCalls = 0;
      session.onSignedOut = () => signedOutCalls++;
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tester.scrollUntilVisible(find.text('Log out'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Log out'));
      await settle(tester);
      expect(find.text('Log out of Kraveo?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(session.status, SessionStatus.signedIn);

      await tester.tap(find.text('Log out'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Log out')));
      await settle(tester);

      expect(session.status, SessionStatus.signedOut);
      expect(signedOutCalls, 1);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(backend.to('POST /auth/logout').single.headers['Authorization'], 'Bearer jwt-out');
    });

    testWidgets('log out still works when the backend is unreachable', (tester) async {
      await CustomerApiService.saveToken('jwt-out');
      backend.on('POST /auth/logout', (_) => throw http.ClientException('offline'));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tester.scrollUntilVisible(find.text('Log out'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Log out'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Log out')));
      await settle(tester);
      expect(session.status, SessionStatus.signedOut);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    testWidgets('delete needs an explicit acknowledgement and shows the 409 reason inline', (tester) async {
      await CustomerApiService.saveToken('jwt-del');
      backend.on('DELETE /auth/account', (_) => reply(409, {'success': false, 'message': 'You have an order in progress'}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await openDeleteSheet(tester);

      expect(find.text('Delete your account?'), findsOneWidget);
      expect(find.textContaining('permanent'), findsWidgets);
      await tester.tap(find.text('Delete'));
      await settle(tester);
      expect(backend.to('DELETE /auth/account'), isEmpty, reason: 'disabled until acknowledged');

      await tester.tap(find.text('I understand this is permanent'));
      await settle(tester);
      await tester.tap(find.text('Delete'));
      await settle(tester);
      expect(find.text('You have an order in progress'), findsOneWidget);
      expect(find.text('Delete your account?'), findsOneWidget, reason: 'sheet stays open');
      expect(session.status, SessionStatus.signedIn);
      expect(await CustomerApiService.getSavedToken(), 'jwt-del');
    });

    testWidgets('confirmed deletion signs out and clears the token', (tester) async {
      await CustomerApiService.saveToken('jwt-del');
      backend.on('DELETE /auth/account', (_) => reply(200, {'success': true}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await openDeleteSheet(tester);
      await tester.tap(find.text('I understand this is permanent'));
      await settle(tester);
      await tester.tap(find.text('Delete'));
      await settle(tester);

      expect(backend.to('DELETE /auth/account').single.headers['Authorization'], 'Bearer jwt-del');
      expect(session.status, SessionStatus.signedOut);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(find.text('Delete your account?'), findsNothing);
      expect(find.text('Your account has been deleted.'), findsOneWidget);
    });
  });

  group('AuthGate (whole app)', () {
    void backendProfile({int status = 200, Map<String, dynamic>? user, bool needsProfile = false}) {
      backend.on('GET /auth/profile', (_) => status == 200 ? reply(200, {'success': true, 'user': user ?? userJson(hostel: 'Boys Hostel Block 3'), 'needsProfile': needsProfile}) : reply(status, {'success': false}));
      backend.on('GET /vendors', (_) => reply(500, {'success': false}));
    }

    Future<void> launch(WidgetTester tester) async {
      smallPhone(tester);
      await tester.pumpWidget(const KraveoCustomerApp());
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 1));
    }

    testWidgets('no saved session goes straight to login', (tester) async {
      await launch(tester);
      expect(find.text('Send code'), findsOneWidget);
      expect(backend.requests, isEmpty);
    });

    testWidgets('valid session enters the app with the mapped hostel, greeting, coins and a Me tab; logout resets user state', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      backendProfile();
      backend.on('POST /auth/logout', (_) => reply(200, {'success': true}));
      await launch(tester);
      await tester.pump(const Duration(seconds: 5));

      expect(find.text('DELIVERING TO'), findsOneWidget);
      expect(find.text('Block 3'), findsWidgets, reason: 'legacy "Boys Hostel Block 3" maps to Block 3');
      expect(find.textContaining(', AARAV'), findsOneWidget);
      final ctx = tester.element(find.byType(Scaffold).first);
      expect(ctx.read<CartProvider>().userKraveoCoins, 120, reason: 'seeded from the backend');

      await tester.tap(find.byIcon(LucideIcons.user));
      await settle(tester);
      expect(find.text('Aarav Sharma'), findsOneWidget);

      await tester.scrollUntilVisible(find.text('Log out'), 200, scrollable: find.byType(Scrollable).last);
      await tester.tap(find.text('Log out'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Log out')));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(seconds: 1));

      expect(find.text('Send code'), findsOneWidget);
      final auth = tester.element(find.byType(AuthScreen));
      expect(auth.read<CartProvider>().userKraveoCoins, 0);
      expect(auth.read<OrderProvider>().orderHistory, isEmpty);
      expect(auth.read<OrderProvider>().activeOrder, isNull);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(backend.to('POST /auth/logout'), hasLength(1));
    });

    testWidgets('a session that still needs a profile lands on first-time setup', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      backendProfile(user: userJson(name: null, hostel: null), needsProfile: true);
      await launch(tester);
      expect(find.text('Almost there'), findsOneWidget);
      expect(find.byType(PopScope), findsWidgets);
    });

    testWidgets('an expired saved token returns to login with the session-expired snackbar', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-old'});
      backendProfile(status: 401);
      await launch(tester);
      expect(find.text('Send code'), findsOneWidget);
      expect(find.text('Session expired, please log in again'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    testWidgets('HTTP 401 in the middle of a session closes pushed screens and shows login', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      backendProfile();
      backend.on('POST /orders', (_) => reply(401, {'success': false, 'message': 'jwt expired'}));
      await launch(tester);
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('DELIVERING TO'), findsOneWidget);

      Object? error;
      await tester.runAsync(() async {
        try {
          await CustomerApiService.createOrder(vendorId: 'v1', items: const [], dropoffHostel: 'Block 3', dropoffNotes: '');
        } catch (e) {
          error = e;
        }
      });
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(seconds: 1));

      expect(error.toString(), contains('Session expired, please log in again'));
      expect(find.text('Send code'), findsOneWidget);
      expect(find.text('Session expired, please log in again'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    testWidgets('unreachable backend keeps the session and offers a retry', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      var online = false;
      backend.on('GET /auth/profile', (_) => online ? reply(200, {'success': true, 'user': userJson(), 'needsProfile': false}) : throw http.ClientException('offline'));
      backend.on('GET /vendors', (_) => reply(500, {'success': false}));
      await launch(tester);
      expect(find.text('Can\'t reach Kraveo'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), 'jwt-live');

      online = true;
      await tester.tap(find.text('Try again'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 6));
      expect(find.text('DELIVERING TO'), findsOneWidget);
    });
  });
}
