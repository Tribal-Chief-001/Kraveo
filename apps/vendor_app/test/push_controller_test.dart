import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/services/push/push_controller.dart';
import 'package:vendor_app/services/push/push_message.dart';
import 'package:vendor_app/services/push/push_ports.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/session/session_controller.dart';
import 'support/push_fakes.dart';
import 'support/signed_in.dart';

PushMessage msg(String event, [String? orderId = 'ord-1', bool block = false]) =>
    PushMessage.fromData({'event': event, if (orderId != null) 'orderId': orderId, 'v': '1'}, hasNotificationBlock: block);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PushLog log;
  late FakePushMessaging messaging;
  late FakeNotifications notifications;
  late FakePermissions permissions;
  late FakeRegistry registry;
  late PushController push;

  PushController build() => PushController(
        messaging: messaging,
        notifications: notifications,
        permissions: permissions,
        registry: registry,
        appVersion: () async => '1.5.0+9',
        retryDelays: const [], // no timers in unit tests
      );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    log = PushLog();
    messaging = FakePushMessaging(log: log);
    notifications = FakeNotifications();
    permissions = FakePermissions();
    registry = FakeRegistry(log: log);
    push = build();
  });

  tearDown(() => push.dispose());

  group('token lifecycle', () {
    test('registers the FCM token once after sign-in, with the app version', () async {
      await push.onSignedIn('u1');
      expect(registry.registered, hasLength(1));
      expect(registry.registered.single.token, 'fcm-token-1');
      expect(registry.registered.single.appVersion, '1.5.0+9');
      expect(push.registeredToken, 'fcm-token-1');
      expect(notifications.initCalls, 1); // channels are created at start-up
    });

    test('signing in again (session listener fires repeatedly) never registers twice', () async {
      await Future.wait([push.onSignedIn('u1'), push.onSignedIn('u1')]);
      await push.onSignedIn('u1');
      await push.onResumed();
      expect(registry.registered, hasLength(1));
    });

    test('a refreshed token is registered; the same token again is not', () async {
      await push.onSignedIn('u1');
      messaging.refresh.add('fcm-token-2');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      messaging.refresh.add('fcm-token-2');
      await Future<void>.delayed(Duration.zero);
      expect(registry.registered.map((r) => r.token), ['fcm-token-1', 'fcm-token-2']);
    });

    test('a refresh before anyone is signed in registers nothing', () async {
      await push.init();
      messaging.refresh.add('fcm-token-9');
      await Future<void>.delayed(Duration.zero);
      expect(registry.registered, isEmpty);
    });

    test('a failed registration (network) is retried when the app is resumed', () async {
      registry.answers.add(RegisterOutcome.failed);
      await push.onSignedIn('u1');
      expect(push.registeredToken, isNull);
      await push.onResumed();
      expect(registry.registered, hasLength(2));
      expect(push.registeredToken, 'fcm-token-1');
    });

    test('a 401 or a refusal is not asked again on resume, but a new login tries again', () async {
      registry.answers.addAll([RegisterOutcome.unauthorized, RegisterOutcome.rejected]);
      await push.onSignedIn('u1');
      await push.onResumed();
      await push.onResumed();
      expect(registry.registered, hasLength(1));
      expect(push.registeredToken, isNull);

      push.onSignedOut();
      await push.onSignedIn('u1');
      expect(registry.registered, hasLength(2)); // rejected this time
      await push.onResumed();
      expect(registry.registered, hasLength(2));

      messaging.refresh.add('fcm-token-5'); // a different token is worth another try
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(registry.registered, hasLength(3));
      expect(push.registeredToken, 'fcm-token-5');
    });

    test('a token that is not there yet (null) does not crash and registers nothing', () async {
      messaging.token = null;
      await push.onSignedIn('u1');
      expect(registry.registered, isEmpty);
    });

    test('logout: DELETE /devices happens while the JWT is still saved, then deleteToken, then the session is cleared', () async {
      SharedPreferences.setMockInitialValues({});
      await VendorApiService.saveToken('jwt-live');
      final session = SessionController(auth: SignedInAuth());
      session.beforeLogout = push.unregisterForLogout;
      await push.onSignedIn('u1');
      log.events.clear();

      await session.logout();

      expect(registry.unregistered, ['fcm-token-1']);
      expect(registry.tokenDuringUnregister, ['jwt-live'], reason: 'the device must be removed before the session is cleared');
      expect(log.events, ['unregister:fcm-token-1', 'deleteToken']);
      expect(await VendorApiService.getSavedToken(), isNull);
      expect(session.status, SessionStatus.signedOut);
      push.onSignedOut();
      expect(messaging.deleteCalls, 1, reason: 'signing out afterwards must not delete the token a second time');
      session.dispose();
    });

    test('logout is never blocked by a failing DELETE /devices', () async {
      await VendorApiService.saveToken('jwt-live');
      registry.unregisterThrows = true;
      final session = SessionController(auth: SignedInAuth());
      session.beforeLogout = push.unregisterForLogout;
      await push.onSignedIn('u1');
      await session.logout();
      expect(session.status, SessionStatus.signedOut);
      expect(await VendorApiService.getSavedToken(), isNull);
      expect(messaging.deleteCalls, 1);
      session.dispose();
    });

    test('after logout a token refresh does not register the old login again', () async {
      await VendorApiService.saveToken('jwt-live');
      await push.onSignedIn('u1');
      await push.unregisterForLogout();
      messaging.refresh.add('fcm-token-3');
      await Future<void>.delayed(Duration.zero);
      expect(registry.registered, hasLength(1));
    });

    test('session expiry (no logout call) forgets the token on this phone', () async {
      await push.onSignedIn('u1');
      push.onSignedOut();
      await Future<void>.delayed(Duration.zero);
      expect(messaging.deleteCalls, 1);
      expect(registry.unregistered, isEmpty); // the JWT is dead; the server cleans up dead tokens itself
    });

    test('another partner signing in on the same phone registers the token again for that user', () async {
      await push.onSignedIn('u1');
      await push.unregisterForLogout();
      push.onSignedOut();
      await push.onSignedIn('u2');
      expect(registry.registered, hasLength(2));
    });
  });

  group('permission state', () {
    test('granted: no banner, no explainer', () async {
      await push.onSignedIn('u1');
      expect(push.banner, PushBanner.none);
      expect(push.shouldExplain, isFalse);
    });

    test('never asked: explain first; after "Not now" the banner offers Allow', () async {
      permissions.access = NotificationAccess.denied;
      await push.onSignedIn('u1');
      expect(push.shouldExplain, isTrue);
      expect(push.banner, PushBanner.ask);
      push.markExplained();
      expect(push.shouldExplain, isFalse);
      expect(push.banner, PushBanner.ask);
      expect(permissions.requests, 0, reason: 'nothing is asked without the partner agreeing');
    });

    test('asked and still denied: persistent blocked banner whose action opens settings', () async {
      permissions.access = NotificationAccess.denied;
      permissions.afterRequest = NotificationAccess.denied;
      await push.onSignedIn('u1');
      await push.requestNotifications();
      expect(permissions.requests, 1);
      expect(push.banner, PushBanner.blocked);
      await push.openNotificationSettings();
      expect(permissions.settingsOpened, 1);
    });

    test('permanently denied: blocked banner straight away', () async {
      permissions.access = NotificationAccess.blocked;
      await push.onSignedIn('u1');
      expect(push.banner, PushBanner.blocked);
      expect(push.shouldExplain, isFalse);
    });

    test('allowed in settings, then back to the app: banner disappears', () async {
      permissions.access = NotificationAccess.blocked;
      await push.onSignedIn('u1');
      permissions.access = NotificationAccess.granted;
      await push.onResumed();
      expect(push.banner, PushBanner.none);
    });

    test('the token is registered even while notifications are blocked (turning them on later just works)', () async {
      permissions.access = NotificationAccess.blocked;
      await push.onSignedIn('u1');
      expect(registry.registered, hasLength(1));
    });

    test('a permission answer is remembered: a new controller does not explain again', () async {
      permissions.access = NotificationAccess.denied;
      permissions.afterRequest = NotificationAccess.denied;
      await push.onSignedIn('u1');
      await push.requestNotifications();
      final again = build();
      await again.onSignedIn('u1');
      expect(again.shouldExplain, isFalse);
      expect(again.banner, PushBanner.blocked);
      again.dispose();
    });

    test('battery hint: once, only after notifications are on, never again after any answer', () async {
      permissions.access = NotificationAccess.denied;
      await push.onSignedIn('u1');
      expect(push.showBatteryCard, isFalse);

      permissions.afterRequest = NotificationAccess.granted;
      await push.requestNotifications();
      expect(push.showBatteryCard, isTrue);

      await push.requestBatteryUnrestricted();
      expect(permissions.batteryRequests, 1);
      expect(push.showBatteryCard, isFalse);

      final again = build();
      await again.onSignedIn('u1');
      expect(again.showBatteryCard, isFalse);
      again.dispose();
    });

    test('battery hint is not shown when the phone is already unrestricted, and "Not now" dismisses it for good', () async {
      permissions.battery = true;
      await push.onSignedIn('u1');
      expect(push.showBatteryCard, isFalse);

      permissions.battery = false;
      final other = build();
      await other.onSignedIn('u1');
      expect(other.showBatteryCard, isTrue);
      other.dismissBatteryCard();
      expect(other.showBatteryCard, isFalse);
      expect(permissions.batteryRequests, 0);
      other.dispose();
    });
  });

  group('routing', () {
    late List<PushAction> seen;

    setUp(() async {
      seen = [];
      await push.onSignedIn('u1');
      push.attachHome(seen.add);
    });

    test('foreground NEW_ORDER only reloads the queue: no notification, so no second alarm', () async {
      messaging.foreground.add(msg('NEW_ORDER'));
      await Future<void>.delayed(Duration.zero);
      expect(seen.map((a) => a.kind), [PushActionKind.refreshOrders]);
      expect(notifications.shown, isEmpty);
    });

    test('foreground ORDER_CANCELLED_VENDOR reloads the queue', () async {
      messaging.foreground.add(msg('ORDER_CANCELLED_VENDOR'));
      await Future<void>.delayed(Duration.zero);
      expect(seen.single.kind, PushActionKind.refreshOrders);
    });

    test('tap on NEW_ORDER (background) opens the queue and the order', () async {
      messaging.opened.add(msg('NEW_ORDER', 'ord-7'));
      await Future<void>.delayed(Duration.zero);
      expect(seen.single.kind, PushActionKind.showQueue);
      expect(seen.single.orderId, 'ord-7');
    });

    test('tap on ORDER_CANCELLED_VENDOR opens the queue only', () async {
      messaging.opened.add(msg('ORDER_CANCELLED_VENDOR', 'ord-7'));
      await Future<void>.delayed(Duration.zero);
      expect(seen.single.kind, PushActionKind.showQueue);
      expect(seen.single.orderId, isNull);
    });

    test('tap on a notification the app built itself (foreground local notification) is routed the same way', () async {
      notifications.taps.add(PushMessage.fromPayload(msg('NEW_ORDER', 'ord-8').toPayload()));
      await Future<void>.delayed(Duration.zero);
      expect(seen.single.orderId, 'ord-8');
    });

    test('unknown event, missing order id and junk are ignored', () async {
      messaging.opened.add(msg('NEW_DELIVERY'));
      messaging.opened.add(msg('NEW_ORDER', null));
      messaging.foreground.add(msg('SOMETHING_ELSE'));
      notifications.taps.add(PushMessage.fromPayload('not json'));
      notifications.taps.add(PushMessage.fromPayload(null));
      await Future<void>.delayed(Duration.zero);
      expect(seen, isEmpty);
    });

    test('a push that arrives while signed out does nothing', () async {
      push.onSignedOut();
      messaging.foreground.add(msg('NEW_ORDER'));
      messaging.opened.add(msg('NEW_ORDER'));
      await Future<void>.delayed(Duration.zero);
      expect(seen, isEmpty);
    });
  });

  group('cold start', () {
    test('the tap that started the app is held until the home screen exists, then delivered once', () async {
      messaging.initial = msg('NEW_ORDER', 'ord-cold');
      final seen = <PushAction>[];
      await push.init(); // app start: the session is still being checked
      expect(seen, isEmpty);
      await push.onSignedIn('u1');
      push.attachHome(seen.add);
      await Future<void>.delayed(Duration.zero);
      expect(seen.map((a) => a.orderId), ['ord-cold']);

      push.attachHome(seen.add); // a rebuilt home screen must not replay it
      await Future<void>.delayed(Duration.zero);
      expect(seen, hasLength(1));
    });

    test('a launch from the app\'s own notification is routed too', () async {
      notifications.launch = msg('NEW_ORDER', 'ord-local');
      final seen = <PushAction>[];
      await push.onSignedIn('u1');
      push.attachHome(seen.add);
      await Future<void>.delayed(Duration.zero);
      expect(seen.single.orderId, 'ord-local');
    });

    test('cold-start tap but the saved login turned out to be gone: dropped, login is shown, nothing replays after login', () async {
      messaging.initial = msg('NEW_ORDER', 'ord-cold');
      await push.init();
      push.onSignedOut(); // session check finished: logged out
      final seen = <PushAction>[];
      await push.onSignedIn('u2');
      push.attachHome(seen.add);
      await Future<void>.delayed(Duration.zero);
      expect(seen, isEmpty);
    });
  });

  group('Firebase failure', () {
    test('initialize() returning false: no token work, no crash, permission handling still works', () async {
      messaging.initOk = false;
      permissions.access = NotificationAccess.denied;
      await push.onSignedIn('u1');
      expect(push.firebaseReady, isFalse);
      expect(registry.registered, isEmpty);
      expect(messaging.tokenCalls, 0);
      expect(push.banner, PushBanner.ask);
      await push.unregisterForLogout(); // must not throw either
    });

    test('initialize() throwing is contained', () async {
      messaging.initThrows = true;
      await push.onSignedIn('u1');
      expect(push.firebaseReady, isFalse);
      expect(registry.registered, isEmpty);
    });

    test('channel creation failing does not stop registration', () async {
      notifications.initThrows = true;
      await push.onSignedIn('u1');
      expect(registry.registered, hasLength(1));
    });
  });
}
