import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/screens/login_screen.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/services/push/push_controller.dart';
import 'package:vendor_app/services/push/push_message.dart';
import 'package:vendor_app/services/push/push_ports.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/push_status_cards.dart';
import 'support/fakes.dart';
import 'support/push_fakes.dart';
import 'support/signed_in.dart';

/// The whole restaurant app with push wired to fakes (no Firebase, no Android).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  var customSize = false;
  late FakeBackend backend;
  late FakeAlarm alarm;
  late PushLog log;
  late FakePushMessaging messaging;
  late FakeNotifications notifications;
  late FakePermissions permissions;
  late FakeRegistry registry;
  late PushController push;
  late List<FakeSocket> sockets;

  setUp(() {
    customSize = false;
    mockSignedInPrefs();
    OrderQueueService.clearQueue();
    backend = FakeBackend();
    alarm = FakeAlarm();
    sockets = [];
    log = PushLog();
    messaging = FakePushMessaging(log: log);
    notifications = FakeNotifications();
    permissions = FakePermissions();
    registry = FakeRegistry(log: log);
    push = PushController(
      messaging: messaging,
      notifications: notifications,
      permissions: permissions,
      registry: registry,
      appVersion: () async => '1.5.0+9',
      retryDelays: const [],
    );
  });

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> launch(WidgetTester tester, {PushController? withPush}) async {
    if (!customSize) {
      tester.view.physicalSize = const Size(412, 915); // a normal phone; the default 800x600 test window is not one
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
    }
    await tester.pumpWidget(KraveoVendorApp(
      auth: SignedInAuth(),
      backend: backend,
      push: withPush ?? push,
      socketFactory: () {
        final s = FakeSocket();
        sockets.add(s);
        return s;
      },
      alarm: alarm,
    ));
    await settle(tester);
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
    push.dispose();
  }

  Future<void> tapButton(WidgetTester tester, String label) async {
    final f = find.widgetWithText(KButton, label);
    await tester.ensureVisible(f);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('signed-in start registers the device once and shows no notice when everything is allowed', (tester) async {
    permissions.battery = true;
    await launch(tester);
    expect(registry.registered.map((r) => r.token), ['fcm-token-1']);
    expect(find.byKey(kNotificationBannerKey), findsNothing);
    expect(find.byKey(kBatteryCardKey), findsNothing);
    expect(notifications.initCalls, 1, reason: 'channels are created at start');
    await unmount(tester);
  });

  testWidgets('never asked: the explanation comes first, "Allow" then shows the system dialog', (tester) async {
    permissions.access = NotificationAccess.denied;
    permissions.afterRequest = NotificationAccess.granted;
    await launch(tester);
    expect(find.text('Hear every new order'), findsOneWidget);
    expect(permissions.requests, 0, reason: 'the system dialog must wait for the partner');
    await tapButton(tester, 'Allow notifications');
    await settle(tester);
    expect(permissions.requests, 1);
    expect(find.text('Hear every new order'), findsNothing);
    expect(find.byKey(kNotificationBannerKey), findsNothing);
    expect(find.byKey(kBatteryCardKey), findsOneWidget); // next: the one-time battery hint
    await unmount(tester);
  });

  testWidgets('"Not now" on the explanation leaves a persistent banner with an Allow button', (tester) async {
    permissions.access = NotificationAccess.denied;
    await launch(tester);
    await tapButton(tester, 'Not now');
    await settle(tester);
    expect(permissions.requests, 0);
    expect(find.byKey(kNotificationBannerKey), findsOneWidget);
    expect(find.text('Allow notifications to hear new orders'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('blocked notifications: persistent banner with a button that opens settings; hides again once allowed', (tester) async {
    permissions.access = NotificationAccess.blocked;
    await launch(tester);
    expect(find.text('Turn on notifications or you will miss orders'), findsOneWidget);
    expect(find.text('Hear every new order'), findsNothing); // no pop-up, the banner is enough
    await tapButton(tester, 'Open settings');
    expect(permissions.settingsOpened, 1);

    permissions.access = NotificationAccess.granted;
    await push.onResumed();
    await settle(tester);
    expect(find.byKey(kNotificationBannerKey), findsNothing);
    await unmount(tester);
  });

  testWidgets('battery hint: shown once, "Allow" asks the system, and it never comes back', (tester) async {
    await launch(tester);
    expect(find.text('Allow unrestricted battery so orders are never missed'), findsOneWidget);
    await tapButton(tester, 'Allow');
    await settle(tester);
    expect(permissions.batteryRequests, 1);
    expect(find.byKey(kBatteryCardKey), findsNothing);
    await unmount(tester);
  });

  testWidgets('banner and battery card do not overflow on a small phone with large text', (tester) async {
    customSize = true;
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    permissions.access = NotificationAccess.blocked;
    await launch(tester);
    expect(find.byKey(kNotificationBannerKey), findsOneWidget);
    expect(tester.takeException(), isNull);
    permissions.access = NotificationAccess.granted;
    await push.onResumed();
    await settle(tester);
    expect(find.byKey(kBatteryCardKey), findsOneWidget);
    expect(tester.takeException(), isNull);
    await unmount(tester);
  });

  testWidgets('tapping a NEW_ORDER push opens the Orders tab and the takeover for an order that is still PLACED', (tester) async {
    await launch(tester);
    await tester.tap(find.text('Menu'));
    await settle(tester);

    backend.put(order(id: 'ord-push')); // exists on the server; the socket never told the app
    messaging.opened.add(PushMessage.fromData({'event': 'NEW_ORDER', 'orderId': 'ord-push', 'v': '1'}));
    await settle(tester);

    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(OrderQueueService.showingOrderId, 'ord-push');
    expect(backend.calls.where((c) => c == 'list:active').length, greaterThanOrEqualTo(2));
    await unmount(tester);
  });

  testWidgets('a NEW_ORDER tap that started the app from closed is held through login check, then opens the takeover', (tester) async {
    backend.put(order(id: 'ord-cold'));
    messaging.initial = PushMessage.fromData({'event': 'NEW_ORDER', 'orderId': 'ord-cold', 'v': '1'});
    await launch(tester);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(alarm.ringing, isTrue);
    expect(alarm.starts, 1, reason: 'one alarm, not one from push and one from the order list');
    await unmount(tester);
  });

  testWidgets('foreground NEW_ORDER: the queue is reloaded once, the in-app alarm rings once, no notification is built', (tester) async {
    await launch(tester);
    final listsBefore = backend.calls.where((c) => c == 'list:active').length;
    backend.put(order(id: 'ord-fg'));
    messaging.foreground.add(PushMessage.fromData({'event': 'NEW_ORDER', 'orderId': 'ord-fg', 'v': '1'}));
    await settle(tester);

    expect(backend.calls.where((c) => c == 'list:active').length, listsBefore + 1);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(alarm.starts, 1);
    expect(notifications.shown, isEmpty);
    await unmount(tester);
  });

  testWidgets('a cancelled order push refreshes the queue and the open takeover explains it', (tester) async {
    backend.put(order(id: 'ord-x'));
    await launch(tester);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    backend.serverChange('ord-x', OrderStatus.cancelled, by: CancelledBy.customer);
    messaging.foreground.add(PushMessage.fromData({'event': 'ORDER_CANCELLED_VENDOR', 'orderId': 'ord-x', 'v': '1'}));
    await settle(tester);
    expect(find.text('The customer cancelled this order.'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('malformed pushes (foreground and tapped) change nothing and do not crash', (tester) async {
    await launch(tester);
    final listsBefore = backend.calls.where((c) => c == 'list:active').length;
    for (final junk in <Object?>[
      null,
      'x',
      5,
      <String, Object?>{},
      {'event': 'NEW_ORDER'},
      {'event': 'NEW_ORDER', 'orderId': 9},
      {'event': 'BOOM', 'orderId': 'a'}
    ]) {
      messaging.foreground.add(PushMessage.fromData(junk));
      messaging.opened.add(PushMessage.fromData(junk));
    }
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(backend.calls.where((c) => c == 'list:active').length, listsBefore);
    expect(find.byType(IncomingOrderDialog), findsNothing);
    await unmount(tester);
  });

  testWidgets('Firebase cannot start: the app still loads orders and rings through sockets and polling', (tester) async {
    messaging.initThrows = true;
    backend.put(order(id: 'ord-1'));
    await launch(tester);
    expect(push.firebaseReady, isFalse);
    expect(registry.registered, isEmpty);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(alarm.ringing, isTrue);

    // A later order over the socket still works.
    await tapButton(tester, 'Accept');
    await settle(tester);
    backend.put(order(id: 'ord-2'));
    sockets.single.emit('new_order_alert', orderJson(id: 'ord-2'));
    await settle(tester);
    expect(find.byType(IncomingOrderDialog), findsOneWidget);
    expect(tester.takeException(), isNull);
    await unmount(tester);
  });

  testWidgets('logging out from the app: DELETE /devices while the JWT is still saved, then the login screen', (tester) async {
    await launch(tester);
    log.events.clear();

    await tester.tap(find.byIcon(LucideIcons.headset).first);
    await settle(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('logout-button')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('logout-button')));
    await settle(tester);
    await tester.tap(find.text('Yes, log out'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await settle(tester);

    expect(find.byType(LoginScreen), findsOneWidget);
    expect(log.events, ['unregister:fcm-token-1', 'deleteToken']);
    expect(registry.tokenDuringUnregister, ['test-jwt']);
    expect(await VendorApiService.getSavedToken(), isNull);
    expect(push.isActive, isFalse);
    await unmount(tester);
  });

  testWidgets('the app without a push controller (as in every older test) shows no push UI', (tester) async {
    await tester.pumpWidget(KraveoVendorApp(auth: SignedInAuth(), backend: backend, socketFactory: FakeSocket.new, alarm: alarm));
    await settle(tester);
    expect(find.byKey(kNotificationBannerKey), findsNothing);
    expect(find.text('No orders right now'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
    push.dispose();
  });
}
