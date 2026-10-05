import 'dart:async';
import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/push/push_messaging.dart';
import 'package:customer_app/services/push/push_service.dart';
import 'package:customer_app/widgets/push_permission.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';
import 'support/push_fakes.dart';

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

const _user = {
  'id': 'u1',
  'name': 'Aarav Sharma',
  'email': 'a@x.com',
  'phone': '+91 9876543210',
  'role': 'STUDENT',
  'isStudent': true,
  'hostelBlock': 'Block 2',
  'avatarId': 3,
  'kraveoCoins': 120,
};

http.Response _json(int status, Map<String, dynamic> body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  late PushLog log;
  late FakePushMessaging fcm;
  late FakeLocalNotifier local;
  late FakeSystemSettings settings;
  late FakeOrderApi orderApi;
  late List<http.Request> deviceRequests;
  late int deleteStatus;
  late List<String> authHeaderSeenOnDelete;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await CustomerApiService.clearToken();
    log = PushLog();
    fcm = FakePushMessaging(log: log);
    local = FakeLocalNotifier();
    settings = FakeSystemSettings();
    orderApi = FakeOrderApi();
    deviceRequests = [];
    deleteStatus = 200;
    authHeaderSeenOnDelete = [];
    CustomerApiService.onUnauthorized = null;
    CustomerApiService.httpClientOverride = MockClient((req) async {
      final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
      log.add('${req.method} $path');
      switch ('${req.method} $path') {
        case 'GET /auth/profile':
          return _json(200, {'success': true, 'user': _user, 'needsProfile': false});
        case 'POST /devices':
          deviceRequests.add(req);
          return _json(200, {'success': true});
        case 'DELETE /devices':
          deviceRequests.add(req);
          authHeaderSeenOnDelete.add(req.headers['Authorization'] ?? '');
          return _json(deleteStatus, {'success': deleteStatus == 200});
        case 'POST /auth/logout':
          return _json(200, {'success': true});
        default:
          return _json(500, {'success': false});
      }
    });
    orderApi.server['order-gate'] = orderModel(id: 'order-gate', status: 'ARRIVED_AT_GATE', paymentStatus: 'PAID', otpCode: '4821');
    orderApi.server['order-ready'] = orderModel(id: 'order-ready', status: 'READY_FOR_PICKUP', paymentStatus: 'PAID');
  });

  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    CustomerApiService.onUnauthorized = null;
  });

  PushService makePush() => PushService(messaging: fcm, local: local, settings: settings, appVersion: '1.2.3');

  Future<void> launch(WidgetTester tester, {PushService? push, bool signedIn = true}) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    if (signedIn) await CustomerApiService.saveToken('jwt-1');
    await tester.pumpWidget(KraveoCustomerApp(googleAuth: _NoGoogle(), createOrders: () => fakeOrders(orderApi), push: push));
    await _settle(tester);
  }

  SessionProvider sessionOf(WidgetTester tester) => Provider.of<SessionProvider>(tester.element(find.byType(AuthGate)), listen: false);

  Future<void> disposeApp(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    // Run out the catalog skeleton grace period and any hung fake call.
    await tester.pump(const Duration(minutes: 6));
  }

  testWidgets('app without push behaves as before (no device calls)', (tester) async {
    await launch(tester);
    expect(find.text('DELIVERING TO'), findsOneWidget);
    expect(deviceRequests, isEmpty);
    await disposeApp(tester);
  });

  testWidgets('a signed-in student registers the phone with app, platform and version', (tester) async {
    await launch(tester, push: makePush());
    expect(find.text('DELIVERING TO'), findsOneWidget);
    expect(deviceRequests, hasLength(1));
    final r = deviceRequests.single;
    expect(r.method, 'POST');
    expect(r.headers['Authorization'], 'Bearer jwt-1');
    expect(jsonDecode(r.body), {'token': 'tok-aaaaaaaaaaaaaaaaaaaaaaaa', 'app': 'CUSTOMER', 'platform': 'android', 'appVersion': '1.2.3'});
    await disposeApp(tester);
  });

  testWidgets('logout removes the device on the server BEFORE the session is cleared, then deletes the local token', (tester) async {
    await launch(tester, push: makePush());
    log.entries.clear();
    final session = sessionOf(tester);
    await tester.runAsync(() => session.logout());
    await _settle(tester);
    expect(log.entries, ['DELETE /devices', 'deleteToken', 'POST /auth/logout']);
    expect(jsonDecode(deviceRequests.last.body), {'token': 'tok-aaaaaaaaaaaaaaaaaaaaaaaa'});
    expect(authHeaderSeenOnDelete.single, 'Bearer jwt-1', reason: 'the session was still valid when the device was removed');
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(await CustomerApiService.getSavedToken(), isNull);
    await disposeApp(tester);
  });

  testWidgets('a failing DELETE /devices never blocks logout', (tester) async {
    await launch(tester, push: makePush());
    deleteStatus = 500;
    final session = sessionOf(tester);
    await tester.runAsync(() => session.logout());
    await _settle(tester);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(log.entries, contains('POST /auth/logout'));
    expect(await CustomerApiService.getSavedToken(), isNull);
    await disposeApp(tester);
  });

  testWidgets('a hung DELETE /devices is given up on so logout still completes', (tester) async {
    await launch(tester, push: PushService(messaging: fcm, local: local, api: _HangingUnregister(), appVersion: '1'));
    final session = sessionOf(tester);
    final done = session.logout();
    await tester.pump(SessionProvider.beforeSignOutTimeout + const Duration(seconds: 1));
    await done;
    await _settle(tester);
    expect(find.text('Continue with Google'), findsOneWidget);
    await disposeApp(tester);
  });

  testWidgets('cold start from a RIDER_AT_GATE push opens tracking where the OTP is shown', (tester) async {
    fcm.initial = PushMessage(messageId: 'm1', data: pushData('RIDER_AT_GATE', orderId: 'order-gate'));
    await launch(tester, push: makePush());
    expect(find.byType(LiveTrackingScreen), findsOneWidget);
    expect(find.text('Your gate OTP'), findsOneWidget);
    expect(find.byType(KOtpDisplay), findsOneWidget);
    expect(find.text('4'), findsWidgets);
    await disposeApp(tester);
  });

  testWidgets('a tap that arrives signed out lands on the normal login and is dropped', (tester) async {
    fcm.initial = PushMessage(messageId: 'm1', data: pushData('ORDER_READY', orderId: 'order-ready'));
    final push = makePush();
    await launch(tester, push: push, signedIn: false);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.byType(LiveTrackingScreen), findsNothing);
    expect(push.pendingTap, isNull);
    expect(deviceRequests, isEmpty);
    await disposeApp(tester);
  });

  testWidgets('a background tap opens the order once; a second tap on the same order does not stack screens', (tester) async {
    await launch(tester, push: makePush());
    expect(find.byType(LiveTrackingScreen), findsNothing);
    // Home keeps its own Track tab mounted (offstage); count on top of that.
    final tabCopies = find.byType(LiveTrackingScreen, skipOffstage: false).evaluate().length;
    fcm.opened.add(PushMessage(messageId: 'a', data: pushData('ORDER_READY', orderId: 'order-ready')));
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen), findsOneWidget);
    fcm.opened.add(PushMessage(messageId: 'b', data: pushData('ORDER_READY', orderId: 'order-ready')));
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen, skipOffstage: false).evaluate().length, tabCopies + 1, reason: 'one tracking route, not stacked');
    await disposeApp(tester);
  });

  testWidgets('tapping a local banner opens that order', (tester) async {
    await launch(tester, push: makePush());
    local.tapController.add('{"event":"ORDER_CANCELLED","orderId":"order-ready","v":"1"}');
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen), findsOneWidget);
    await disposeApp(tester);
  });

  testWidgets('malformed tap payloads do nothing and do not crash', (tester) async {
    fcm.initial = const PushMessage(data: {'event': 'RIDER_AT_GATE'});
    await launch(tester, push: makePush());
    fcm.opened.add(const PushMessage(data: {'junk': 'x'}));
    local.tapController.add('not json');
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen), findsNothing);
    expect(find.text('DELIVERING TO'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await disposeApp(tester);
  });

  testWidgets('a foreground message refreshes that order once and does not navigate', (tester) async {
    await launch(tester, push: makePush());
    orderApi.fetchedIds.clear();
    fcm.foreground.add(PushMessage(data: pushData('ORDER_READY', orderId: 'order-ready')));
    await _settle(tester);
    expect(orderApi.fetchedIds, ['order-ready']);
    expect(find.byType(LiveTrackingScreen), findsNothing);
    expect(local.shown, isEmpty);
    await disposeApp(tester);
  });

  testWidgets('Firebase failing to start leaves the app fully working', (tester) async {
    fcm.initOk = false;
    await launch(tester, push: makePush());
    expect(find.text('DELIVERING TO'), findsOneWidget);
    expect(deviceRequests, isEmpty);
    await tester.runAsync(() => sessionOf(tester).logout());
    await _settle(tester);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(log.entries, isNot(contains('deleteToken')));
    await disposeApp(tester);
  });

  testWidgets('notifications off: the tracking screen shows a hint with a button that asks, then opens settings', (tester) async {
    fcm.permissionValue = PushPermission.denied;
    fcm.requestResult = PushPermission.denied;
    fcm.initial = PushMessage(messageId: 'm1', data: pushData('ORDER_READY', orderId: 'order-ready'));
    await launch(tester, push: makePush());
    expect(find.byType(LiveTrackingScreen), findsOneWidget);
    expect(deviceRequests, isEmpty, reason: 'nothing is registered while notifications are off');
    expect(find.textContaining('Notifications are off'), findsOneWidget);

    await tester.tap(find.text('Turn on'));
    await _settle(tester);
    expect(fcm.requestCalls, 1);
    expect(find.textContaining('Notifications are off'), findsOneWidget);

    await tester.tap(find.text('Turn on'));
    await _settle(tester);
    expect(settings.opened, 1);

    fcm.permissionValue = PushPermission.granted;
    // (Same zone as the service's earlier futures; mixing runAsync here would deadlock the test.)
    final push = Provider.of<PushService>(tester.element(find.byType(LiveTrackingScreen)), listen: false);
    unawaited(push.onAppResumed());
    await _settle(tester);
    expect(find.textContaining('Notifications are off'), findsNothing);
    expect(deviceRequests, hasLength(1));
    await disposeApp(tester);
  });

  group('permission explanation', () {
    Future<void> pumpAsker(WidgetTester tester, PushService? push) async {
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.customer(),
        home: ChangeNotifierProvider<PushService?>.value(
          value: push,
          child: Builder(builder: (context) => Scaffold(body: TextButton(onPressed: () => askForNotificationsOnce(context), child: const Text('open checkout')))),
        ),
      ));
    }

    testWidgets('asks once with a reason; Turn on shows the system dialog', (tester) async {
      fcm.permissionValue = PushPermission.denied;
      fcm.requestResult = PushPermission.granted;
      final push = makePush();
      await tester.runAsync(push.start);
      await pumpAsker(tester, push);
      expect(find.text('Get order updates?'), findsNothing, reason: 'never on first frame');

      await tester.tap(find.text('open checkout'));
      await _settle(tester);
      expect(find.text('Get order updates?'), findsOneWidget);
      await tester.tap(find.text('Turn on'));
      await _settle(tester);
      expect(fcm.requestCalls, 1);

      fcm.permissionValue = PushPermission.denied;
      await tester.runAsync(push.onAppResumed);
      await tester.tap(find.text('open checkout'));
      await _settle(tester);
      expect(find.text('Get order updates?'), findsNothing, reason: 'only once');
    });

    testWidgets('Not now asks nothing of the system', (tester) async {
      fcm.permissionValue = PushPermission.denied;
      final push = makePush();
      await tester.runAsync(push.start);
      await pumpAsker(tester, push);
      await tester.tap(find.text('open checkout'));
      await _settle(tester);
      await tester.tap(find.text('Not now'));
      await _settle(tester);
      expect(fcm.requestCalls, 0);
    });

    testWidgets('does nothing without push support or when already allowed', (tester) async {
      await pumpAsker(tester, null);
      await tester.tap(find.text('open checkout'));
      await _settle(tester);
      expect(find.text('Get order updates?'), findsNothing);

      final push = makePush(); // permission already granted
      await tester.runAsync(push.start);
      await pumpAsker(tester, push);
      await tester.tap(find.text('open checkout'));
      await _settle(tester);
      expect(find.text('Get order updates?'), findsNothing);
    });
  });
}

class _HangingUnregister implements DeviceApi {
  @override
  Future<DeviceCallResult> register({required String token, required String appVersion}) async => DeviceCallResult.ok;
  @override
  Future<DeviceCallResult> unregister(String token) => Future<DeviceCallResult>.delayed(const Duration(minutes: 5), () => DeviceCallResult.ok);
}

/// Lets futures and timers run: HTTP mocks and prefs need real async turns inside testWidgets.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump(const Duration(milliseconds: 150));
  }
}
