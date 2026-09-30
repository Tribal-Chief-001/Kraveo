import 'dart:async';
import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/models/customer_user.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/auth_screen.dart';
import 'package:customer_app/screens/profile_screen.dart';
import 'package:customer_app/screens/profile_setup_screen.dart';
import 'package:customer_app/screens/checkout_screen.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/widgets/ui/google_button.dart';
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


Map<String, dynamic> userJson({
  String? name = 'Aarav Sharma',
  String? hostel = 'Block 2',
  int coins = 120,
  String? phone = '+91 9876543210',
  String? email = 'aarav@example.com',
  bool? isStudent = true,
  int? avatarId = 3,
  String role = 'STUDENT',
}) =>
    {
      'id': 'u1',
      'name': name,
      'email': email,
      'phone': phone,
      'role': role,
      'isStudent': isStudent,
      'hostelBlock': hostel,
      'avatarId': avatarId,
      'kraveoCoins': coins,
    };

/// A brand-new Google account: nothing but e-mail filled in.
Map<String, dynamic> blankUserJson() => userJson(name: null, phone: null, hostel: null, isStudent: null, avatarId: null);

/// Scriptable stand-in for the Google sign-in layer (the only thing the app mocks natively).
class FakeGoogleAuth implements GoogleAuthService {
  GoogleAuthResult next = const GoogleAuthResult.success(GoogleCredential(idToken: 'google-id-token', email: 'aarav@example.com', displayName: 'Aarav Sharma'));
  int signInCalls = 0;
  int signOutCalls = 0;

  /// When set, signIn() waits for it (to observe the in-flight state).
  Completer<void>? gate;

  @override
  Future<GoogleAuthResult> signIn() async {
    signInCalls++;
    if (gate != null) await gate!.future;
    return next;
  }

  @override
  Future<void> signOut() async => signOutCalls++;
}

/// Implements the Auth v2 contract for the parts the app touches, so whole-flow tests exercise
/// the real needsProfile rules instead of hand-written answers.
class FakeServer {
  FakeServer(this.backend, {Map<String, dynamic>? seed, this.isNewUser = true}) : user = {...(seed ?? blankUserJson())} {
    backend.on('POST /auth/google', (_) => reply(200, {'success': true, 'token': 'jwt-google', 'user': user, 'isNewUser': isNewUser, 'needsProfile': needsProfile}));
    backend.on('GET /auth/profile', (_) => reply(200, {'success': true, 'user': user, 'needsProfile': needsProfile}));
    backend.on('PUT /auth/profile', (req) {
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      putBodies.add(b);
      if (b.containsKey('name')) user['name'] = b['name'];
      if (b.containsKey('phone')) user['phone'] = '+91 ${normalizeIndianPhone(b['phone'] as String)}';
      if (b.containsKey('avatarId')) user['avatarId'] = b['avatarId'];
      if (b.containsKey('isStudent')) user['isStudent'] = b['isStudent'];
      if (user['isStudent'] == false) {
        user['hostelBlock'] = null;
      } else if (user['isStudent'] == true && b.containsKey('hostelBlock')) {
        user['hostelBlock'] = b['hostelBlock'];
      }
      return reply(200, {'success': true, 'user': user, 'needsProfile': needsProfile});
    });
    backend.on('GET /vendors', (_) => reply(500, {'success': false}));
    backend.on('POST /auth/logout', (_) => reply(200, {'success': true}));
  }

  final FakeBackend backend;
  final Map<String, dynamic> user;
  final bool isNewUser;
  final List<Map<String, dynamic>> putBodies = [];

  bool get needsProfile =>
      user['role'] == 'STUDENT' &&
      (user['name'] == null || user['phone'] == null || user['avatarId'] == null || user['isStudent'] == null || (user['isStudent'] == true && user['hostelBlock'] == null));
}

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

SessionProvider newSession({FakeGoogleAuth? google}) => SessionProvider(initial: SessionStatus.signedOut, googleAuth: google ?? FakeGoogleAuth());

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
        ChangeNotifierProvider<SessionProvider>.value(value: session ?? newSession()),
        ChangeNotifierProvider<DhabaProvider>(create: (_) => DhabaProvider()),
        ChangeNotifierProvider<CartProvider>.value(value: cart ?? CartProvider()),
        ChangeNotifierProvider<OrderProvider>.value(value: orders ?? OrderProvider()),
      ],
      child: MaterialApp(theme: KraveoTheme.customer(), home: child),
    ),
  );
  await tester.pump(const Duration(milliseconds: 800));
}

Future<void> settle(WidgetTester tester, [int ms = 600]) async {
  await tester.pump();
  await tester.pump(Duration(milliseconds: ms));
}

Finder kAvatarWithId(int? id) => find.byWidgetPredicate((w) => w is KAvatar && w.id == id);

/// Scrolls the page's main list until [finder] is built and on screen, then taps it.
Future<void> tapScrolled(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 150, scrollable: find.byType(Scrollable).first);
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await settle(tester);
}

bool isDisabled(WidgetTester tester, String label) => tester.widget<KButton>(find.widgetWithText(KButton, label)).onPressed == null;

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
      for (final raw in ['+919876543210', '+91 9876543210', '919876543210', '9876543210']) {
        expect(CustomerUser(id: '1', phone: raw).maskedPhone, '+91 98••• ••210');
      }
      expect(const CustomerUser(id: '1').maskedPhone, '');
    });

    test('initials and first name', () {
      expect(const CustomerUser(id: '1', name: 'Aarav  Kumar Sharma').initials, 'AS');
      expect(const CustomerUser(id: '1', name: 'meera').initials, 'M');
      expect(const CustomerUser(id: '1', name: 'Aarav Sharma').firstName, 'Aarav');
      expect(const CustomerUser(id: '1').initials, 'K');
    });

    test('fromJson parses the v2 user object, including nulls', () {
      final full = CustomerUser.fromJson(userJson());
      expect(full.email, 'aarav@example.com');
      expect(full.phone, '+91 9876543210');
      expect(full.isStudent, isTrue);
      expect(full.avatarId, 3);
      expect(full.hostelBlock, 'Block 2');
      expect(full.kraveoCoins, 120);

      final blank = CustomerUser.fromJson(blankUserJson());
      expect(blank.name, isNull);
      expect(blank.phone, isNull);
      expect(blank.isStudent, isNull);
      expect(blank.avatarId, isNull);
      expect(blank.hostelBlock, isNull);

      expect(CustomerUser.fromJson(userJson(isStudent: false, hostel: null)).isStudent, isFalse);
      expect(CustomerUser.fromJson({...userJson(), 'avatarId': 99}).avatarId, isNull, reason: 'out of range is ignored');
      expect(CustomerUser.fromJson({...userJson(), 'avatarId': '7'}).avatarId, 7);
      expect(CustomerUser.fromJson({...userJson(), 'phone': '  ', 'email': ''}).phone, isNull);
    });

    test('copyWith can clear the hostel', () {
      final u = CustomerUser.fromJson(userJson());
      expect(u.copyWith(avatarId: 9).avatarId, 9);
      expect(u.copyWith(clearHostelBlock: true, isStudent: false).hostelBlock, isNull);
      expect(u.copyWith(name: 'Z').hostelBlock, 'Block 2');
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
      expect(normalizeIndianPhone('+91 9876543210'), '9876543210');
      expect(normalizeIndianPhone('919876543210'), '9876543210');
      expect(normalizeIndianPhone('09876543210'), '9876543210');
      expect(normalizeIndianPhone('98765abc43210999'), '9876543210');
      expect(validateIndianMobile('9876543210'), isNull);
      expect(validateIndianMobile('5876543210'), contains('start with 6, 7, 8 or 9'));
      expect(validateIndianMobile('98765'), contains('10-digit'));
    });

    test('name validation follows the 2-60 letters contract', () {
      expect(validateFullName(''), isNotNull);
      expect(validateFullName(' A '), isNotNull);
      expect(validateFullName('12'), isNotNull);
      expect(validateFullName('Al'), isNull);
      expect(validateFullName('Aarav Sharma'), isNull);
      expect(validateFullName("Mary-Jane O'Neil Jr."), isNull);
      expect(validateFullName('Aarav 2'), contains('letters only'));
      expect(validateFullName('Aarav<script>'), contains('letters only'));
      expect(validateFullName('x' * 61), isNotNull);
    });

    test('Google failures map to plain sentences and a cancel stays silent', () {
      expect(googleFailureMessage(GoogleAuthFailure.cancelled), isNull);
      expect(googleFailureMessage(GoogleAuthFailure.noNetwork), contains('connection'));
      expect(googleFailureMessage(GoogleAuthFailure.playServices), contains('Google Play services'));
      expect(googleFailureMessage(GoogleAuthFailure.notConfigured), contains('set up correctly'));
      expect(googleFailureMessage(GoogleAuthFailure.other), isNotNull);
    });
  });

  group('CustomerApiService', () {
    test('googleSignIn posts the ID token, stores the JWT and returns the typed user', () async {
      backend.on('POST /auth/google', (_) => reply(200, {'success': true, 'token': 'jwt-1', 'user': blankUserJson(), 'isNewUser': true, 'needsProfile': true}));
      final r = await CustomerApiService.googleSignIn('google-id-token');
      expect(r.success, isTrue);
      expect(r.isNewUser, isTrue);
      expect(r.needsProfile, isTrue);
      expect(r.user?['email'], 'aarav@example.com');
      expect(backend.bodyOf(backend.requests.single), {'idToken': 'google-id-token'});
      expect(backend.requests.single.headers.containsKey('Authorization'), isFalse);
      expect(await CustomerApiService.getSavedToken(), 'jwt-1');
    });

    test('googleSignIn failures carry the server message and never save a token', () async {
      backend.on('POST /auth/google', (_) => reply(401, {'success': false, 'message': 'Email not verified'}));
      var r = await CustomerApiService.googleSignIn('x');
      expect(r.success, isFalse);
      expect(r.rejected, isTrue);
      expect(r.message, 'Email not verified');

      backend.on('POST /auth/google', (_) => reply(403, {'success': false, 'message': 'This is a partner account'}));
      r = await CustomerApiService.googleSignIn('x');
      expect(r.roleNotAllowed, isTrue);
      expect(r.message, 'This is a partner account');

      backend.on('POST /auth/google', (_) => reply(200, {'success': true, 'token': 't', 'user': userJson(role: 'VENDOR')}));
      r = await CustomerApiService.googleSignIn('x');
      expect(r.success, isFalse, reason: 'a non-student role is refused even on a 200');
      expect(r.roleNotAllowed, isTrue);

      backend.on('POST /auth/google', (_) => reply(503, {'success': false}));
      r = await CustomerApiService.googleSignIn('x');
      expect(r.unavailable, isTrue);

      backend.on('POST /auth/google', (_) => throw http.ClientException('offline'));
      r = await CustomerApiService.googleSignIn('x');
      expect(r.networkError, isTrue);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    test('updateProfile sends only the fields given, with the Bearer token', () async {
      await CustomerApiService.saveToken('jwt-9');
      backend.on('PUT /auth/profile', (_) => reply(200, {'success': true, 'user': userJson(), 'needsProfile': false}));
      await CustomerApiService.updateProfile(avatarId: 7);
      expect(backend.bodyOf(backend.requests.last), {'avatarId': 7});
      expect(backend.requests.last.headers['Authorization'], 'Bearer jwt-9');

      await CustomerApiService.updateProfile(name: 'Aarav Sharma', phone: '9876543210', isStudent: true, hostelBlock: 'Block 3', avatarId: 4);
      expect(backend.bodyOf(backend.requests.last), {'name': 'Aarav Sharma', 'phone': '9876543210', 'isStudent': true, 'hostelBlock': 'Block 3', 'avatarId': 4});

      await CustomerApiService.updateProfile(isStudent: false);
      expect(backend.bodyOf(backend.requests.last), {'isStudent': false});
    });

    test('profile errors surface the field so the form can point at the input', () async {
      await CustomerApiService.saveToken('jwt-9');
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'Enter a valid mobile number', 'field': 'phone'}));
      final r = await CustomerApiService.updateProfile(phone: '123');
      expect(r.success, isFalse);
      expect(r.field, 'phone');
      expect(r.message, 'Enter a valid mobile number');
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
      backend.on('DELETE /auth/account', (_) => reply(401, {'success': false}));

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
        final r = await CustomerApiService.updateProfile(name: 'Aarav');
        expect(r.unauthorized, isTrue);
        return r;
      });
      await expectExpired(() async {
        final r = await CustomerApiService.deleteAccount();
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

  group('SessionProvider Google sign-in', () {
    test('new account: token saved, status needsProfile, Google name suggested', () async {
      final server = FakeServer(backend);
      final google = FakeGoogleAuth();
      final s = newSession(google: google);
      final outcome = await s.signInWithGoogle();
      expect(outcome.success, isTrue);
      expect(s.status, SessionStatus.needsProfile);
      expect(s.user?.email, 'aarav@example.com');
      expect(s.suggestedName, 'Aarav Sharma');
      expect(await CustomerApiService.getSavedToken(), 'jwt-google');
      expect(server.putBodies, isEmpty);
      expect(backend.bodyOf(backend.to('POST /auth/google').single), {'idToken': 'google-id-token'});
    });

    test('returning student goes straight to signedIn and seeds onUserLoaded', () async {
      FakeServer(backend, seed: userJson(), isNewUser: false);
      final s = newSession();
      CustomerUser? loaded;
      s.onUserLoaded = (u) => loaded = u;
      await s.signInWithGoogle();
      expect(s.status, SessionStatus.signedIn);
      expect(loaded?.kraveoCoins, 120);
      expect(s.suggestedName, 'Aarav Sharma');
    });

    test('cancelling the Google picker is silent and sends nothing', () async {
      final google = FakeGoogleAuth()..next = const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
      final s = newSession(google: google);
      final outcome = await s.signInWithGoogle();
      expect(outcome.cancelled, isTrue);
      expect(outcome.error, isNull);
      expect(s.status, SessionStatus.signedOut);
      expect(backend.requests, isEmpty);
      expect(s.isSigningIn, isFalse);
    });

    test('Play services / offline / misconfiguration produce messages and no request', () async {
      for (final (failure, expected) in [
        (GoogleAuthFailure.playServices, 'Google Play services'),
        (GoogleAuthFailure.noNetwork, 'connection'),
        (GoogleAuthFailure.notConfigured, 'set up correctly'),
        (GoogleAuthFailure.other, 'try again'),
      ]) {
        final google = FakeGoogleAuth()..next = GoogleAuthResult.failed(failure);
        final s = newSession(google: google);
        final outcome = await s.signInWithGoogle();
        expect(outcome.error, contains(expected), reason: '$failure');
        expect(s.status, SessionStatus.signedOut);
      }
      expect(backend.requests, isEmpty);
    });

    test('server 401 / 403 / offline / outage show the right text, leave no session, and sign Google out', () async {
      Future<SignInOutcome> attempt(http.Response Function(http.Request) handler, FakeGoogleAuth google) async {
        backend.on('POST /auth/google', handler);
        final s = newSession(google: google);
        final outcome = await s.signInWithGoogle();
        expect(s.status, SessionStatus.signedOut);
        expect(await CustomerApiService.getSavedToken(), isNull);
        return outcome;
      }

      var g = FakeGoogleAuth();
      var o = await attempt((_) => reply(401, {'success': false, 'message': 'Google email is not verified'}), g);
      expect(o.error, 'Google email is not verified');
      expect(g.signOutCalls, 1, reason: 'so the next tap shows the account picker');

      g = FakeGoogleAuth();
      o = await attempt((_) => reply(403, {'success': false, 'message': 'This email belongs to a partner account'}), g);
      expect(o.error, 'This email belongs to a partner account');
      expect(g.signOutCalls, 1);

      g = FakeGoogleAuth();
      o = await attempt((_) => reply(401, {'success': false}), g);
      expect(o.error, contains('rejected'));

      g = FakeGoogleAuth();
      o = await attempt((_) => reply(403, {'success': false}), g);
      expect(o.error, contains('partner'));

      g = FakeGoogleAuth();
      o = await attempt((_) => throw http.ClientException('offline'), g);
      expect(o.error, contains('couldn\'t reach Kraveo'));

      g = FakeGoogleAuth();
      o = await attempt((_) => reply(502, {'success': false}), g);
      expect(o.error, contains('unavailable'));
    });

    test('a second tap while signing in is ignored', () async {
      FakeServer(backend);
      final google = FakeGoogleAuth()..gate = Completer<void>();
      final s = newSession(google: google);
      final first = s.signInWithGoogle();
      expect(s.isSigningIn, isTrue);
      final second = await s.signInWithGoogle();
      expect(second.cancelled, isTrue);
      expect(google.signInCalls, 1);
      google.gate!.complete();
      expect((await first).success, isTrue);
      expect(s.isSigningIn, isFalse);
    });

    test('logout, account deletion and session expiry all sign the Google account out', () async {
      FakeServer(backend, seed: userJson(), isNewUser: false);
      backend.on('DELETE /auth/account', (_) => reply(200, {'success': true}));

      var google = FakeGoogleAuth();
      var s = newSession(google: google);
      await s.signInWithGoogle();
      await s.logout();
      await pumpEventQueue();
      expect(s.status, SessionStatus.signedOut);
      expect(google.signOutCalls, 1);
      expect(backend.to('POST /auth/logout'), hasLength(1));

      google = FakeGoogleAuth();
      s = newSession(google: google);
      await s.signInWithGoogle();
      final del = await s.deleteAccount();
      expect(del.success, isTrue);
      expect(google.signOutCalls, 1);

      google = FakeGoogleAuth();
      s = newSession(google: google);
      await s.signInWithGoogle();
      s.expire();
      expect(google.signOutCalls, 1);
      expect(s.status, SessionStatus.signedOut);
    });

    test('a refused deletion keeps the Google account signed in', () async {
      FakeServer(backend, seed: userJson(), isNewUser: false);
      backend.on('DELETE /auth/account', (_) => reply(409, {'success': false, 'message': 'Order in progress'}));
      final google = FakeGoogleAuth();
      final s = newSession(google: google);
      await s.signInWithGoogle();
      final del = await s.deleteAccount();
      expect(del.conflict, isTrue);
      expect(google.signOutCalls, 0);
      expect(s.status, SessionStatus.signedIn);
    });

    test('non-students keep their drop point in memory only; students persist it', () async {
      FakeServer(backend, seed: userJson(isStudent: false, hostel: null), isNewUser: false);
      final s = newSession();
      await s.signInWithGoogle();
      expect(s.deliveryPoint, isNull);
      final r = await s.changeHostel('Block 5');
      expect(r.success, isTrue);
      expect(s.deliveryPoint, 'Block 5');
      expect(backend.to('PUT /auth/profile'), isEmpty, reason: 'the server keeps no hostel for non-students');
      await s.logout();
      expect(s.deliveryPoint, isNull, reason: 'cleared with the session');

      final student = newSession()..beginForTest(userJson());
      expect(student.deliveryPoint, 'Block 2');
    });
  });

  group('AuthScreen', () {
    testWidgets('shows the welcome, one Google button and the privacy line without overflow', (tester) async {
      await pumpWithProviders(tester, const AuthScreen());
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.byType(GoogleGMark), findsOneWidget);
      expect(find.textContaining('cravings'), findsOneWidget);
      expect(find.textContaining('Google name and email'), findsOneWidget);
      expect(find.textContaining('SMS'), findsNothing);
      expect(find.textContaining('password'), findsOneWidget, reason: 'the privacy line says there is no password');
      expect(tester.takeException(), isNull);
    });

    testWidgets('tap signs in through the Google layer and POSTs the ID token', (tester) async {
      FakeServer(backend);
      final google = FakeGoogleAuth();
      final session = newSession(google: google);
      await pumpWithProviders(tester, const AuthScreen(), session: session);
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(google.signInCalls, 1);
      expect(backend.bodyOf(backend.to('POST /auth/google').single), {'idToken': 'google-id-token'});
      expect(session.status, SessionStatus.needsProfile);
    });

    testWidgets('cancel shows nothing; real failures show a message under the button', (tester) async {
      final google = FakeGoogleAuth()..next = const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
      await pumpWithProviders(tester, const AuthScreen(), session: newSession(google: google));
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.byIcon(LucideIcons.circleAlert), findsNothing);
      expect(backend.requests, isEmpty);

      google.next = const GoogleAuthResult.failed(GoogleAuthFailure.playServices);
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.textContaining('Google Play services'), findsOneWidget);

      backend.on('POST /auth/google', (_) => reply(403, {'success': false, 'message': 'This is a partner account'}));
      google.next = const GoogleAuthResult.success(GoogleCredential(idToken: 't'));
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.text('This is a partner account'), findsOneWidget);
      expect(find.textContaining('Google Play services'), findsNothing, reason: 'the old error is replaced');
      expect(tester.takeException(), isNull);
    });

    testWidgets('offline after picking an account explains the network problem', (tester) async {
      backend.on('POST /auth/google', (_) => throw http.ClientException('offline'));
      await pumpWithProviders(tester, const AuthScreen());
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.textContaining('couldn\'t reach Kraveo'), findsOneWidget);
    });

    testWidgets('shows progress while signing in and ignores repeat taps', (tester) async {
      FakeServer(backend);
      final google = FakeGoogleAuth()..gate = Completer<void>();
      await pumpWithProviders(tester, const AuthScreen(), session: newSession(google: google));
      await tester.tap(find.text('Continue with Google'));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Continue with Google'), findsNothing);
      await tester.tap(find.byType(CircularProgressIndicator), warnIfMissed: false);
      await tester.pump();
      expect(google.signInCalls, 1);
      google.gate!.complete();
      await settle(tester);
    });
  });

  group('ProfileSetupScreen', () {
    SessionProvider needsProfileSession({String? googleName = 'Aarav Sharma', Map<String, dynamic>? user}) {
      final s = SessionProvider(initial: SessionStatus.checking, googleAuth: FakeGoogleAuth());
      s.beginForTest(user ?? blankUserJson(), needsProfile: true, googleName: googleName, isNewAccount: true);
      return s;
    }

    Future<void> fillStep1(WidgetTester tester, {String name = 'Aarav Sharma', String phone = '9876543210'}) async {
      await tester.enterText(find.byKey(const ValueKey('name-field')), name);
      await tester.enterText(find.byKey(const ValueKey('phone-field')), phone);
      await tester.pump();
      await tester.tap(find.text('Continue'));
      await settle(tester);
    }

    Future<void> chooseHostel(WidgetTester tester, String block) async {
      await tester.ensureVisible(find.byKey(const ValueKey('hostel-field')));
      await tester.tap(find.byKey(const ValueKey('hostel-field')));
      await settle(tester);
      expect(find.text('Where should we deliver?'), findsOneWidget);
      await tester.tap(find.text(block));
      await settle(tester);
    }

    Future<void> pickAvatar(WidgetTester tester, int id) async {
      await tester.ensureVisible(kAvatarWithId(id));
      await tester.tap(kAvatarWithId(id));
      await tester.pump();
    }

    testWidgets('step 1 is prefilled from Google and shows the +91 prefix and progress', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession(googleName: 'Meera Rao'));
      expect(find.text('Meera Rao'), findsOneWidget);
      expect(find.text('+91'), findsOneWidget);
      expect(find.text('aarav@example.com'), findsOneWidget);
      expect(find.bySemanticsLabel('Step 1 of 3'), findsOneWidget);
      expect(find.byIcon(LucideIcons.arrowLeft), findsNothing, reason: 'no back on the first step');
      expect(tester.takeException(), isNull);
    });

    testWidgets('step 1 blocks empty, too-short, non-letter and non-Indian numbers with clear text', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession(googleName: null));
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('Tell us your name'), findsOneWidget);
      expect(find.text('Enter your 10-digit Indian mobile number.'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('name-field')), 'A');
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '5876543210');
      await tester.pump();
      expect(find.textContaining('Tell us your name'), findsNothing, reason: 'typing clears the error');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('at least 2'), findsOneWidget);
      expect(find.textContaining('start with 6, 7, 8 or 9'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Aarav 2');
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '98765');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.textContaining('letters only'), findsOneWidget);
      expect(find.text('Enter your 10-digit Indian mobile number.'), findsOneWidget);

      expect(find.text('Are you a\nstudent?'), findsNothing, reason: 'still on step 1');
      expect(backend.requests, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pasting +91 98765 43210 keeps the ten digits', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession());
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '+91 98765 43210');
      await tester.pump();
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, '9876543210');
    });

    testWidgets('step 2: Continue stays disabled until Yes (+ hostel) or No is chosen', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession());
      await fillStep1(tester);
      expect(find.textContaining('student?'), findsOneWidget);
      expect(isDisabled(tester, 'Continue'), isTrue);
      expect(find.text('Choose your hostel block'), findsNothing, reason: 'hostel only after Yes');

      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      expect(find.text('Choose your hostel block'), findsOneWidget);
      expect(find.text('Pick your block to continue.'), findsOneWidget);
      expect(isDisabled(tester, 'Continue'), isTrue, reason: 'Yes needs a hostel block');

      await chooseHostel(tester, 'Block 3');
      expect(find.text('Block 3'), findsOneWidget);
      expect(isDisabled(tester, 'Continue'), isFalse);

      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      expect(find.text('Block 3'), findsNothing, reason: 'hostel field hides for No');
      expect(isDisabled(tester, 'Continue'), isFalse, reason: 'No skips the hostel');

      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      expect(find.text('Block 3'), findsOneWidget, reason: 'the earlier hostel pick is remembered');
      expect(tester.takeException(), isNull);
    });

    testWidgets('step 3: Finish needs an avatar; none is pre-selected', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession());
      await fillStep1(tester);
      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);

      expect(find.text('Pick your\navatar'), findsOneWidget);
      expect(find.byType(KAvatarPicker), findsOneWidget);
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, isNull);
      expect(isDisabled(tester, 'Finish'), isTrue);
      expect(find.text('Choose one to finish.'), findsOneWidget);

      await pickAvatar(tester, 6);
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, 6);
      expect(isDisabled(tester, 'Finish'), isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets('going back never loses what was typed or picked', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession());
      await fillStep1(tester, name: 'Riya Kapoor', phone: '9123456780');
      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      await chooseHostel(tester, 'Girls Gate 2');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await pickAvatar(tester, 11);

      // Step 3 -> 2 (button) -> 1 (system back).
      await tester.tap(find.byIcon(LucideIcons.arrowLeft));
      await settle(tester);
      expect(find.text('Girls Gate 2'), findsOneWidget);
      expect(tester.widget<KButton>(find.widgetWithText(KButton, 'Continue')).onPressed, isNotNull);
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(find.text('Riya Kapoor'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, '9123456780');
      expect(find.byIcon(LucideIcons.arrowLeft), findsNothing);

      // Forward again: everything is still selected.
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.text('Girls Gate 2'), findsOneWidget);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, 11);

      // System back on the first step does nothing (no exit, no sign-out).
      await tester.binding.handlePopRoute();
      await tester.binding.handlePopRoute();
      await settle(tester);
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(find.text('Riya Kapoor'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('student path: one PUT with everything, then the session enters the app', (tester) async {
      await CustomerApiService.saveToken('jwt-setup');
      final server = FakeServer(backend);
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);

      await fillStep1(tester, name: '  Aarav   Sharma ', phone: '+91 98765 43210');
      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      await chooseHostel(tester, 'Block 3');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(backend.to('PUT /auth/profile'), isEmpty, reason: 'nothing is saved until Finish');
      await pickAvatar(tester, 9);
      await tester.tap(find.text('Finish'));
      await settle(tester);

      final put = backend.to('PUT /auth/profile').single;
      expect(backend.bodyOf(put), {'name': 'Aarav Sharma', 'phone': '9876543210', 'isStudent': true, 'hostelBlock': 'Block 3', 'avatarId': 9});
      expect(put.headers['Authorization'], 'Bearer jwt-setup');
      expect(server.putBodies, hasLength(1));
      expect(session.status, SessionStatus.signedIn);
      expect(session.user?.avatarId, 9);
      expect(session.user?.isStudent, isTrue);
      expect(session.deliveryPoint, 'Block 3');
    });

    testWidgets('non-student path: hostel is skipped and not sent', (tester) async {
      await CustomerApiService.saveToken('jwt-setup');
      FakeServer(backend);
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);

      await fillStep1(tester);
      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      await chooseHostel(tester, 'Block 1'); // picked, then changed their mind
      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await pickAvatar(tester, 2);
      await tester.tap(find.text('Finish'));
      await settle(tester);

      expect(backend.bodyOf(backend.to('PUT /auth/profile').single), {'name': 'Aarav Sharma', 'phone': '9876543210', 'isStudent': false, 'avatarId': 2});
      expect(session.status, SessionStatus.signedIn);
      expect(session.user?.isStudent, isFalse);
      expect(session.user?.hostelBlock, isNull);
      expect(session.deliveryPoint, isNull, reason: 'a non-student chooses at checkout');
    });

    testWidgets('a server field error jumps back to the right step and keeps all answers', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'That number is already in use', 'field': 'phone'}));
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      await fillStep1(tester);
      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await pickAvatar(tester, 4);
      await tester.tap(find.text('Finish'));
      await settle(tester);
      await settle(tester); // the page animates back to step 1

      expect(find.text('That number is already in use'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, '9876543210');
      expect(find.text('Aarav Sharma'), findsOneWidget);
      expect(session.status, SessionStatus.needsProfile);

      // Fix it and go through again: answers on steps 2 and 3 survived.
      backend.on('PUT /auth/profile', (_) => reply(200, {'success': true, 'user': userJson(), 'needsProfile': false}));
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9123456780');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, 4);
      await tester.tap(find.text('Finish'));
      await settle(tester);
      expect(session.status, SessionStatus.signedIn);
    });

    testWidgets('offline on Finish explains why and stays on the avatar step, ready to retry', (tester) async {
      backend.on('PUT /auth/profile', (_) => throw http.ClientException('offline'));
      final session = needsProfileSession();
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      await fillStep1(tester);
      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await pickAvatar(tester, 4);
      await tester.tap(find.text('Finish'));
      await settle(tester);

      expect(find.textContaining('couldn\'t reach Kraveo'), findsOneWidget);
      expect(find.text('Pick your\navatar'), findsOneWidget);
      expect(isDisabled(tester, 'Finish'), isFalse);
      expect(session.status, SessionStatus.needsProfile);
    });

    testWidgets('an account that was left half set-up resumes with what the server already has', (tester) async {
      final session = needsProfileSession(
        user: userJson(name: 'Meera Rao', phone: '+91 9123456780', hostel: 'Block 4', isStudent: true, avatarId: null),
        googleName: null,
      );
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      expect(find.text('Meera Rao'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('phone-field'))).controller!.text, '9123456780');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(find.text('Block 4'), findsOneWidget);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, isNull);
    });

    testWidgets('Switch account signs the Google account out', (tester) async {
      final google = FakeGoogleAuth();
      final session = SessionProvider(initial: SessionStatus.checking, googleAuth: google)..beginForTest(blankUserJson(), needsProfile: true);
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: session);
      await tester.ensureVisible(find.text('Switch'));
      await tester.tap(find.text('Switch'));
      await settle(tester);
      expect(session.status, SessionStatus.signedOut);
      expect(google.signOutCalls, 1);
    });

    testWidgets('every step fits 360x640 at 1.3x text, also with the keyboard up', (tester) async {
      await pumpWithProviders(tester, const ProfileSetupScreen(), session: needsProfileSession());
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await settle(tester);
      expect(tester.takeException(), isNull);
      tester.view.resetViewInsets();
      await fillStep1(tester);
      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      expect(tester.takeException(), isNull);
      await chooseHostel(tester, 'VIT Main Gate');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      expect(tester.takeException(), isNull);
    });
  });

  group('ProfileScreen', () {
    SessionProvider signedIn({Map<String, dynamic>? user, FakeGoogleAuth? google}) {
      final s = SessionProvider(initial: SessionStatus.checking, googleAuth: google ?? FakeGoogleAuth());
      s.beginForTest(user ?? userJson());
      return s;
    }

    Future<void> openDeleteSheet(WidgetTester tester) async {
      await tapScrolled(tester, find.text('Delete account'));
    }

    testWidgets('shows avatar, name, e-mail, masked phone, student status, hostel, coins and version', (tester) async {
      final cart = CartProvider()..setKraveoCoins(120);
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn(), cart: cart);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Me'), findsOneWidget);
      expect(kAvatarWithId(3), findsOneWidget);
      expect(find.text('Aarav Sharma'), findsWidgets);
      expect(find.text('aarav@example.com'), findsWidgets);
      expect(find.text('+91 98••• ••210'), findsOneWidget);
      expect(find.text('9876543210'), findsNothing);
      expect(find.text('120'), findsOneWidget);
      expect(find.text('I\'m a student'), findsOneWidget);
      expect(find.text('Block 2'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Kraveo v1.1.0'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.text('Kraveo v1.1.0'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a non-student sees "chosen at checkout" instead of a hostel row; a missing phone invites adding one', (tester) async {
      final session = signedIn(user: userJson(isStudent: false, hostel: null, phone: null));
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Chosen at checkout for each order'), findsOneWidget);
      expect(find.text('Hostel block'), findsNothing);
      expect(find.text('Add your number'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('orders summary counts delivered orders, or explains there are none', (tester) async {
      final orders = OrderProvider()..resetForLogout();
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn(), orders: orders);
      await tester.scrollUntilVisible(find.textContaining('No delivered orders yet'), 150, scrollable: find.byType(Scrollable).first);
      expect(find.textContaining('No delivered orders yet'), findsOneWidget);
    });

    testWidgets('changing the avatar: Save is off until a different one is picked, then PUTs avatarId', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      final server = FakeServer(backend, seed: userJson());
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tester.tap(find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Change avatar'));
      await settle(tester);
      expect(find.text('Choose your avatar'), findsOneWidget);
      expect(isDisabled(tester, 'Save'), isTrue, reason: 'unchanged');
      expect(tester.widget<KAvatarPicker>(find.byType(KAvatarPicker)).selectedId, 3);

      await tester.ensureVisible(kAvatarWithId(12).last);
      await tester.tap(kAvatarWithId(12).last);
      await tester.pump();
      expect(isDisabled(tester, 'Save'), isFalse);
      await tester.tap(find.text('Save'));
      await settle(tester);

      expect(server.putBodies.single, {'avatarId': 12});
      expect(find.text('Choose your avatar'), findsNothing);
      expect(session.user?.avatarId, 12);
      expect(kAvatarWithId(12), findsWidgets);
    });

    testWidgets('a failed avatar save keeps the sheet open with the reason', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'Pick an avatar from the list', 'field': 'avatarId'}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tester.tap(find.byWidgetPredicate((w) => w is KPressable && w.semanticLabel == 'Change avatar'));
      await settle(tester);
      await tester.ensureVisible(kAvatarWithId(5).last);
      await tester.tap(kAvatarWithId(5).last);
      await tester.pump();
      await tester.tap(find.text('Save'));
      await settle(tester);
      expect(find.text('Pick an avatar from the list'), findsOneWidget);
      expect(find.text('Choose your avatar'), findsOneWidget);
      expect(session.user?.avatarId, 3);
    });

    testWidgets('editing the mobile number validates, then sends only the phone', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      final server = FakeServer(backend, seed: userJson());
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tapScrolled(tester, find.text('+91 98••• ••210'));
      expect(find.text('Your details'), findsOneWidget);
      expect(isDisabled(tester, 'Save'), isTrue);

      await tester.enterText(find.byKey(const ValueKey('edit-phone-field')), '5876543210');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await settle(tester);
      expect(find.textContaining('start with 6, 7, 8 or 9'), findsOneWidget);
      expect(server.putBodies, isEmpty);

      await tester.enterText(find.byKey(const ValueKey('edit-phone-field')), '9123456780');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await settle(tester);
      expect(server.putBodies.single, {'phone': '9123456780'});
      expect(find.text('Your details'), findsNothing);
      expect(session.user?.phone, '+91 9123456780');
      expect(find.text('+91 91••• ••780'), findsOneWidget);
    });

    testWidgets('editing the name shows the server\'s field error under the name', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'That name isn\'t allowed', 'field': 'name'}));
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn());
      await tapScrolled(tester, find.text('Name'));
      await tester.enterText(find.byKey(const ValueKey('edit-name-field')), 'Aarav K');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await settle(tester);
      expect(find.text('That name isn\'t allowed'), findsOneWidget);
      expect(find.text('Your details'), findsOneWidget);
    });

    testWidgets('turning the student switch off saves isStudent=false and hides the hostel row', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      final server = FakeServer(backend, seed: userJson());
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tapScrolled(tester, find.text('I\'m a student'));
      expect(server.putBodies.single, {'isStudent': false});
      expect(session.user?.isStudent, isFalse);
      expect(session.deliveryPoint, isNull);
      expect(find.text('Chosen at checkout for each order'), findsOneWidget);
      expect(find.textContaining('choose your drop-off point at checkout'), findsWidgets);
    });

    testWidgets('turning it on asks for a hostel block first and saves both together', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      final server = FakeServer(backend, seed: userJson(isStudent: false, hostel: null));
      final session = signedIn(user: userJson(isStudent: false, hostel: null));
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tapScrolled(tester, find.text('I\'m a student'));
      expect(find.text('Where should we deliver?'), findsOneWidget);
      await tester.tap(find.text('Block 4'));
      await settle(tester);
      expect(server.putBodies.single, {'isStudent': true, 'hostelBlock': 'Block 4'});
      expect(session.user?.isStudent, isTrue);
      expect(session.hostel, 'Block 4');
      expect(find.text('Hostel block'), findsOneWidget);
    });

    testWidgets('dismissing the hostel picker leaves the switch off and sends nothing', (tester) async {
      final session = signedIn(user: userJson(isStudent: false, hostel: null));
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tapScrolled(tester, find.text('I\'m a student'));
      await tester.tap(find.byIcon(LucideIcons.x));
      await settle(tester);
      expect(backend.requests, isEmpty);
      expect(session.user?.isStudent, isFalse);
    });

    testWidgets('changing the hostel saves it through PUT /auth/profile (hostel only)', (tester) async {
      await CustomerApiService.saveToken('jwt-me');
      final server = FakeServer(backend, seed: userJson());
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tapScrolled(tester, find.text('Block 2'));
      await tester.tap(find.text('Block 5'));
      await settle(tester);

      expect(server.putBodies.single, {'hostelBlock': 'Block 5'});
      expect(session.selectedHostel, 'Block 5');
      expect(find.text('Drop-off point set to Block 5'), findsOneWidget);
    });

    testWidgets('a failed save reverts the hostel and says so', (tester) async {
      backend.on('PUT /auth/profile', (_) => reply(400, {'success': false, 'message': 'Pick a valid drop-off', 'field': 'hostelBlock'}));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tapScrolled(tester, find.text('Block 2'));
      await tester.tap(find.text('Block 5'));
      await settle(tester);
      expect(session.selectedHostel, 'Block 2');
      expect(find.text('Pick a valid drop-off'), findsOneWidget);
    });

    testWidgets('a 401 while saving fires the session-expired flow', (tester) async {
      var expired = 0;
      CustomerApiService.onUnauthorized = () => expired++;
      await CustomerApiService.saveToken('jwt-old');
      backend.on('PUT /auth/profile', (_) => reply(401, {'success': false}));
      await pumpWithProviders(tester, const ProfileScreen(), session: signedIn());
      await tapScrolled(tester, find.text('I\'m a student'));
      expect(expired, 1);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    testWidgets('log out asks first, notifies the backend, ends the session and signs Google out', (tester) async {
      await CustomerApiService.saveToken('jwt-out');
      backend.on('POST /auth/logout', (_) => reply(200, {'success': true}));
      final google = FakeGoogleAuth();
      final session = signedIn(google: google);
      var signedOutCalls = 0;
      session.onSignedOut = () => signedOutCalls++;
      await pumpWithProviders(tester, const ProfileScreen(), session: session);

      await tapScrolled(tester, find.text('Log out'));
      expect(find.text('Log out of Kraveo?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(session.status, SessionStatus.signedIn);
      expect(google.signOutCalls, 0);

      await tester.tap(find.text('Log out'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Log out')));
      await settle(tester);

      expect(session.status, SessionStatus.signedOut);
      expect(signedOutCalls, 1);
      expect(google.signOutCalls, 1);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(backend.to('POST /auth/logout').single.headers['Authorization'], 'Bearer jwt-out');
    });

    testWidgets('log out still works when the backend is unreachable', (tester) async {
      await CustomerApiService.saveToken('jwt-out');
      backend.on('POST /auth/logout', (_) => throw http.ClientException('offline'));
      final session = signedIn();
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await tapScrolled(tester, find.text('Log out'));
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

    testWidgets('confirmed deletion signs out, clears the token and signs Google out', (tester) async {
      await CustomerApiService.saveToken('jwt-del');
      backend.on('DELETE /auth/account', (_) => reply(200, {'success': true}));
      final google = FakeGoogleAuth();
      final session = signedIn(google: google);
      await pumpWithProviders(tester, const ProfileScreen(), session: session);
      await openDeleteSheet(tester);
      await tester.tap(find.text('I understand this is permanent'));
      await settle(tester);
      await tester.tap(find.text('Delete'));
      await settle(tester);

      expect(backend.to('DELETE /auth/account').single.headers['Authorization'], 'Bearer jwt-del');
      expect(session.status, SessionStatus.signedOut);
      expect(google.signOutCalls, 1);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(find.text('Delete your account?'), findsNothing);
      expect(find.text('Your account has been deleted.'), findsOneWidget);
    });
  });

  group('Checkout drop-off', () {
    setUp(() {
      // Razorpay() talks to a native plugin as soon as it is created.
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('razorpay_flutter'), (call) async => null);
    });
    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('razorpay_flutter'), null);
    });

    CartProvider cartWithItem() {
      final cart = CartProvider();
      cart.addItem(
        item: const MenuItemModel(id: 'a', vendorId: 'ven-1', name: 'Test dish', price: 120, category: 'Thalis', description: 'd', imageUrl: '', isAvailable: true),
        dhabaId: 'ven-1',
        dhabaName: 'Sharma Highway Dhaba',
      );
      return cart;
    }

    testWidgets('no saved hostel: a prominent required chooser replaces the pill and payment cannot start', (tester) async {
      final session = SessionProvider(initial: SessionStatus.checking, googleAuth: FakeGoogleAuth())..beginForTest(userJson(isStudent: false, hostel: null));
      await pumpWithProviders(tester, const CheckoutScreen(selectedHostel: null), session: session, cart: cartWithItem());
      expect(find.text('Choose drop-off point'), findsOneWidget);
      expect(find.text('Required before you can pay'), findsOneWidget);
      expect(find.text('Choose drop-off'), findsOneWidget);
      expect(find.textContaining('Pay ₹'), findsNothing);

      // Tapping the pay button opens the picker instead of creating an order.
      await tester.tap(find.text('Choose drop-off'));
      await settle(tester);
      expect(find.text('Where should we deliver?'), findsOneWidget);
      expect(backend.requests, isEmpty);

      await tester.tap(find.text('Block 6'));
      await settle(tester);
      expect(find.text('Choose drop-off point'), findsNothing);
      expect(find.text('Block 6'), findsOneWidget);
      expect(find.textContaining('Pay ₹'), findsOneWidget);
      expect(session.deliveryPoint, 'Block 6', reason: 'remembered for the next checkout this session');
      expect(backend.requests, isEmpty, reason: 'a non-student\'s choice is never sent to the server');
      expect(tester.takeException(), isNull);
    });

    testWidgets('a student with a saved hostel sees it pre-selected and a normal Pay button', (tester) async {
      final session = SessionProvider(initial: SessionStatus.checking, googleAuth: FakeGoogleAuth())..beginForTest(userJson());
      await pumpWithProviders(tester, const CheckoutScreen(selectedHostel: 'Block 2'), session: session, cart: cartWithItem());
      expect(find.text('Choose drop-off point'), findsNothing);
      expect(find.text('Block 2'), findsOneWidget);
      expect(find.textContaining('Pay ₹'), findsOneWidget);
    });
  });

  group('AuthGate (whole app)', () {
    Future<void> launch(WidgetTester tester, {FakeGoogleAuth? google}) async {
      smallPhone(tester);
      await tester.pumpWidget(KraveoCustomerApp(googleAuth: google ?? FakeGoogleAuth()));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 1));
    }

    testWidgets('no saved session goes straight to the Google welcome', (tester) async {
      await launch(tester);
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(backend.requests, isEmpty);
    });

    testWidgets('brand-new student: Google -> 3 sign-up steps -> Home with avatar, hostel and coins', (tester) async {
      final server = FakeServer(backend);
      final google = FakeGoogleAuth();
      await launch(tester, google: google);

      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.text('Aarav Sharma'), findsOneWidget, reason: 'name pre-filled from Google');

      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9876543210');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('student-yes')));
      await settle(tester);
      await tester.ensureVisible(find.text('Choose your hostel block'));
      await tester.pump();
      await tester.tap(find.text('Choose your hostel block'));
      await settle(tester);
      await tester.tap(find.text('Block 3'));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await tester.ensureVisible(kAvatarWithId(5));
      await tester.tap(kAvatarWithId(5));
      await tester.pump();
      await tester.tap(find.text('Finish'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 5));

      expect(server.putBodies, hasLength(1));
      expect(find.text('DELIVERING TO'), findsOneWidget);
      expect(find.text('Block 3'), findsWidgets);
      expect(kAvatarWithId(5), findsWidgets, reason: 'greeting shows the chosen avatar');
      expect(google.signInCalls, 1);
    });

    testWidgets('returning student skips sign-up; logout resets user state and signs Google out', (tester) async {
      FakeServer(backend, seed: userJson(hostel: 'Block 3'), isNewUser: false);
      final google = FakeGoogleAuth();
      await launch(tester, google: google);
      await tester.tap(find.text('Continue with Google'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 5));

      expect(find.text('DELIVERING TO'), findsOneWidget);
      expect(find.text('Block 3'), findsWidgets);
      expect(find.textContaining(', AARAV'), findsOneWidget);
      final ctx = tester.element(find.byType(Scaffold).first);
      expect(ctx.read<CartProvider>().userKraveoCoins, 120, reason: 'seeded from the backend');

      await tester.tap(find.byIcon(LucideIcons.user).last);
      await settle(tester);
      expect(find.text('aarav@example.com'), findsWidgets);

      await tester.scrollUntilVisible(find.text('Log out'), 150, scrollable: find.byType(Scrollable).last);
      await tester.ensureVisible(find.text('Log out'));
      await tester.pump();
      await tester.tap(find.text('Log out'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(KButton), matching: find.text('Log out')));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(seconds: 1));

      expect(find.text('Continue with Google'), findsOneWidget);
      final auth = tester.element(find.byType(AuthScreen));
      expect(auth.read<CartProvider>().userKraveoCoins, 0);
      expect(auth.read<OrderProvider>().orderHistory, isEmpty);
      expect(auth.read<OrderProvider>().activeOrder, isNull);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(backend.to('POST /auth/logout'), hasLength(1));
      expect(google.signOutCalls, 1);
    });

    testWidgets('a non-student sees "Delivery point" on Home until they choose one at checkout', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      FakeServer(backend, seed: userJson(isStudent: false, hostel: null), isNewUser: false);
      await launch(tester);
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('DELIVERY POINT'), findsOneWidget);
      expect(find.text('Choose drop point'), findsOneWidget);
      expect(find.text('DELIVERING TO'), findsNothing);
    });

    testWidgets('a session that still needs a profile lands on sign-up step 1', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      FakeServer(backend, seed: userJson(name: 'Aarav Sharma', phone: null, hostel: null, isStudent: null, avatarId: null));
      await launch(tester);
      expect(find.text('Welcome to\nKraveo'), findsOneWidget);
      expect(find.text('Aarav Sharma'), findsOneWidget);
    });

    testWidgets('an expired saved token returns to the welcome with the session-expired snackbar', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-old'});
      backend.on('GET /auth/profile', (_) => reply(401, {'success': false}));
      await launch(tester);
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Session expired, please log in again'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), isNull);
    });

    testWidgets('HTTP 401 in the middle of a session closes pushed screens and shows the welcome', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      FakeServer(backend, seed: userJson(hostel: 'Block 3'), isNewUser: false);
      backend.on('POST /orders', (_) => reply(401, {'success': false, 'message': 'jwt expired'}));
      final google = FakeGoogleAuth();
      await launch(tester, google: google);
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
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Session expired, please log in again'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), isNull);
      expect(google.signOutCalls, 1);
    });

    testWidgets('a 401 during the last sign-up save returns to the welcome', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      FakeServer(backend);
      backend.on('PUT /auth/profile', (_) => reply(401, {'success': false}));
      await launch(tester);
      await tester.enterText(find.byKey(const ValueKey('name-field')), 'Aarav Sharma');
      await tester.enterText(find.byKey(const ValueKey('phone-field')), '9876543210');
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('student-no')));
      await settle(tester);
      await tester.tap(find.text('Continue'));
      await settle(tester);
      await tester.ensureVisible(kAvatarWithId(1));
      await tester.tap(kAvatarWithId(1));
      await tester.pump();
      await tester.tap(find.text('Finish'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Session expired, please log in again'), findsOneWidget);
    });

    testWidgets('unreachable backend keeps the session and offers a retry or another account', (tester) async {
      SharedPreferences.setMockInitialValues({'kraveo_customer_jwt_token': 'jwt-live'});
      var online = false;
      backend.on('GET /auth/profile', (_) => online ? reply(200, {'success': true, 'user': userJson(), 'needsProfile': false}) : throw http.ClientException('offline'));
      backend.on('GET /vendors', (_) => reply(500, {'success': false}));
      await launch(tester);
      expect(find.text('Can\'t reach Kraveo'), findsOneWidget);
      expect(find.text('Use a different account'), findsOneWidget);
      expect(await CustomerApiService.getSavedToken(), 'jwt-live');

      online = true;
      await tester.tap(find.text('Try again'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(seconds: 6));
      expect(find.text('DELIVERING TO'), findsOneWidget);
    });
  });
}
