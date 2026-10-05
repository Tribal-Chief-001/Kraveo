import 'dart:async';

import 'package:customer_app/services/push/push_messaging.dart';
import 'package:customer_app/services/push/push_payload.dart';
import 'package:customer_app/services/push/push_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/push_fakes.dart';

void main() {
  late PushLog log;
  late FakePushMessaging fcm;
  late FakeLocalNotifier local;
  late FakeDeviceApi api;
  late FakeSystemSettings settings;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    log = PushLog();
    fcm = FakePushMessaging(log: log);
    local = FakeLocalNotifier();
    api = FakeDeviceApi(log: log);
    settings = FakeSystemSettings();
  });

  PushService make({String appVersion = '9.9.9'}) => PushService(messaging: fcm, local: local, api: api, settings: settings, appVersion: appVersion);

  group('payload parsing', () {
    test('every customer event parses and maps to the contract channel', () {
      const expected = {
        'ORDER_ACCEPTED': PushChannels.orderUpdates,
        'ORDER_READY': PushChannels.orderUpdates,
        'ORDER_PICKED_UP': PushChannels.orderAttention,
        'RIDER_AT_GATE': PushChannels.orderAttention,
        'ORDER_DELIVERED': PushChannels.orderUpdates,
        'ORDER_CANCELLED': PushChannels.orderAttention,
        'REFUND_PROCESSED': PushChannels.orderUpdates,
      };
      for (final e in expected.entries) {
        final p = PushPayload.tryParse(pushData(e.key, orderId: 'abc-123'));
        expect(p, isNotNull, reason: e.key);
        expect(p!.event.key, e.key);
        expect(p.orderId, 'abc-123');
        expect(p.event.channelId, e.value, reason: e.key);
      }
      expect(PushPayload.tryParse(pushData('RIDER_AT_GATE'))!.event.needsAttention, isTrue);
    });

    test('malformed or foreign payloads are rejected, never thrown on', () {
      final bad = <Object?>[
        null,
        'string',
        42,
        <String, dynamic>{},
        {'event': 'RIDER_AT_GATE'},
        {'orderId': 'order-1', 'v': '1'},
        pushData('NEW_ORDER'), // vendor event
        pushData('rider_at_gate'),
        pushData('ORDER_READY', orderId: ''),
        pushData('ORDER_READY', orderId: 'a b'),
        pushData('ORDER_READY', orderId: '../../etc'),
        pushData('ORDER_READY', orderId: 'x' * 65),
        pushData('ORDER_READY', v: '2'),
        {'event': 'ORDER_READY', 'orderId': 'order-1'},
        {'event': 5, 'orderId': 'order-1', 'v': '1'},
        {'event': 'ORDER_READY', 'orderId': 7, 'v': '1'},
        {'event': 'ORDER_READY', 'orderId': 'order-1', 'v': 1},
      ];
      for (final b in bad) {
        expect(PushPayload.tryParse(b), isNull, reason: '$b');
      }
      for (final raw in <String?>[null, '', 'not json', '[]', '{"event":"X"}', 'x' * 600]) {
        expect(PushPayload.tryDecode(raw), isNull, reason: '$raw');
      }
    });

    test('a local banner payload round-trips and never carries more than event/order/version', () {
      final p = PushPayload.tryParse(pushData('RIDER_AT_GATE', orderId: 'o-9'))!;
      final back = PushPayload.tryDecode(p.encode())!;
      expect(back.event, PushEvent.riderAtGate);
      expect(back.orderId, 'o-9');
      for (final e in PushEvent.values) {
        expect('${e.fallbackTitle} ${e.fallbackBody}', isNot(matches(RegExp(r'\d{4}'))), reason: 'no code/number in fallback copy for ${e.key}');
      }
    });
  });

  group('token registration', () {
    test('registers the token with app, platform and version once a student is signed in', () async {
      final push = make();
      await push.onSessionStarted('u1');
      expect(api.registered, [(token: 'tok-aaaaaaaaaaaaaaaaaaaaaaaa', appVersion: '9.9.9')]);
      expect(push.registeredToken, 'tok-aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(local.initCalls, 1);
    });

    test('does not register before there is a session', () async {
      final push = make();
      await push.start();
      expect(api.registered, isEmpty);
    });

    test('no duplicate registration: repeated session start, resume and concurrent calls post once', () async {
      final push = make();
      api.registerGate = Completer<void>();
      final first = push.onSessionStarted('u1');
      final again = push.syncRegistration();
      final resumed = push.onAppResumed();
      await Future<void>.delayed(Duration.zero);
      api.registerGate!.complete();
      await Future.wait([first, again, resumed]);
      await push.onSessionStarted('u1');
      await push.onAppResumed();
      expect(api.registered, hasLength(1));
    });

    test('a token refresh registers the new token; a repeated refresh does not post again', () async {
      final push = make();
      await push.onSessionStarted('u1');
      fcm.refreshes.add('tok-new-bbbbbbbbbbbbbbbbbbbb');
      await pumpEventQueue();
      fcm.refreshes.add('tok-new-bbbbbbbbbbbbbbbbbbbb');
      await pumpEventQueue();
      expect(api.registered.map((r) => r.token), ['tok-aaaaaaaaaaaaaaaaaaaaaaaa', 'tok-new-bbbbbbbbbbbbbbbbbbbb']);
    });

    test('a refresh while signed out registers nothing', () async {
      final push = make();
      await push.start();
      fcm.refreshes.add('tok-new-bbbbbbbbbbbbbbbbbbbb');
      await pumpEventQueue();
      expect(api.registered, isEmpty);
    });

    test('a failed registration is retried on the next resume, then not repeated', () async {
      final push = make();
      api.registerResult = DeviceCallResult.failed;
      await push.onSessionStarted('u1');
      expect(push.registeredToken, isNull);
      api.registerResult = DeviceCallResult.ok;
      await push.onAppResumed();
      await push.onAppResumed();
      expect(api.registered, hasLength(2));
      expect(push.registeredToken, isNotNull);
    });

    test('an unauthorized answer is ignored (session handling already exists)', () async {
      final push = make();
      api.registerResult = DeviceCallResult.unauthorized;
      await push.onSessionStarted('u1');
      expect(push.registeredToken, isNull);
    });

    test('a different student on the same phone registers the same token again', () async {
      final push = make();
      await push.onSessionStarted('u1');
      push.onSignedOut();
      await pumpEventQueue();
      fcm.tokenValue = 'tok-aaaaaaaaaaaaaaaaaaaaaaaa';
      await push.onSessionStarted('u2');
      expect(api.registered, hasLength(2));
    });
  });

  group('logout', () {
    test('tells the server first, then deletes the local token', () async {
      final push = make();
      await push.onSessionStarted('u1');
      log.entries.clear();
      await push.onSessionEnding();
      expect(log.entries, ['unregister:tok-aaaaaaaaaaaaaaaaaaaaaaaa', 'deleteToken']);
      expect(push.registeredToken, isNull);
    });

    test('a failing DELETE never blocks the local clean-up or throws', () async {
      final push = make();
      await push.onSessionStarted('u1');
      api.unregisterThrows = true;
      await push.onSessionEnding();
      expect(log.entries.last, 'deleteToken');
    });

    test('with nothing registered (notifications off) there is nothing to delete on the server', () async {
      fcm.permissionValue = PushPermission.denied;
      final push = make();
      await push.onSessionStarted('u1');
      await push.onSessionEnding();
      expect(api.unregistered, isEmpty);
    });

    test('an expired session just forgets the token locally', () async {
      final push = make();
      await push.onSessionStarted('u1');
      log.entries.clear();
      push.onSignedOut();
      await pumpEventQueue();
      expect(api.unregistered, isEmpty);
      expect(log.entries, ['deleteToken']);
    });

    test('a waiting notification tap does not survive sign-out', () async {
      final push = make();
      await push.onSessionStarted('u1');
      fcm.opened.add(PushMessage(data: pushData('ORDER_READY')));
      expect(push.pendingTap, isNotNull);
      push.onSignedOut();
      expect(push.pendingTap, isNull);
    });
  });

  group('permission', () {
    test('denied: nothing is registered, the hint state is on, and granting later registers', () async {
      fcm.permissionValue = PushPermission.denied;
      fcm.requestResult = PushPermission.granted;
      final push = make();
      await push.onSessionStarted('u1');
      expect(api.registered, isEmpty);
      expect(push.blocked, isTrue);
      expect(await push.requestPermission(), PushPermission.granted);
      expect(push.blocked, isFalse);
      expect(api.registered, hasLength(1));
    });

    test('denied again after the system dialog stays blocked and registers nothing', () async {
      fcm.permissionValue = PushPermission.denied;
      fcm.requestResult = PushPermission.denied;
      final push = make();
      await push.onSessionStarted('u1');
      await push.requestPermission();
      expect(push.blocked, isTrue);
      expect(api.registered, isEmpty);
    });

    test('changing the setting outside the app is picked up on resume', () async {
      fcm.permissionValue = PushPermission.denied;
      final push = make();
      await push.onSessionStarted('u1');
      expect(push.blocked, isTrue);
      fcm.permissionValue = PushPermission.granted;
      await push.onAppResumed();
      expect(push.blocked, isFalse);
      expect(api.registered, hasLength(1));
    });

    test('the explanation is offered once, only while notifications are off', () async {
      fcm.permissionValue = PushPermission.denied;
      final push = make();
      expect(await push.shouldShowRationale(), isTrue);
      await push.markRationaleShown();
      expect(await push.shouldShowRationale(), isFalse);

      fcm.permissionValue = PushPermission.granted;
      SharedPreferences.setMockInitialValues({});
      final granted = make();
      expect(await granted.shouldShowRationale(), isFalse);
    });

    test('Android 7-12 (no permission dialog, notifications off): the first Turn on press opens the notification settings', () async {
      fcm.permissionValue = PushPermission.denied; // what the plugin reports below Android 13 when notifications are off
      fcm.requestResult = PushPermission.denied;
      settings.dialogAvailable = false;
      final push = make();
      await push.onSessionStarted('u1');
      await push.enableNotifications();
      expect(fcm.requestCalls, 1);
      expect(settings.opened, 1, reason: 'a dead button is the bug: nothing visible happened before');
    });

    test('the Turn on button asks the system first and opens settings afterwards', () async {
      fcm.permissionValue = PushPermission.denied; // Android 13+: the dialog is shown and the customer says "Don't allow"

      final push = make();
      await push.onSessionStarted('u1');
      await push.enableNotifications();
      expect(fcm.requestCalls, 1);
      expect(settings.opened, 0);
      await push.enableNotifications();
      expect(fcm.requestCalls, 1);
      expect(settings.opened, 1);
    });
  });

  group('Firebase unavailable', () {
    test('init returning false leaves a working service with no push', () async {
      fcm.initOk = false;
      final push = make();
      await push.onSessionStarted('u1');
      await push.requestPermission();
      await push.onAppResumed();
      await push.onSessionEnding();
      expect(push.available, isFalse);
      expect(push.blocked, isFalse);
      expect(api.registered, isEmpty);
      expect(api.unregistered, isEmpty);
      expect(local.initCalls, 0);
      expect(await push.shouldShowRationale(), isFalse);
    });

    test('init throwing is swallowed', () async {
      fcm.throwOnInit = true;
      final push = make();
      await expectLater(push.start(), completes);
      await expectLater(push.onSessionStarted('u1'), completes);
      expect(push.available, isFalse);
      expect(api.registered, isEmpty);
    });

    test('init hanging is given up on after the timeout', () async {
      fcm.initGate = Completer<bool>();
      final push = PushService(messaging: fcm, local: local, api: api, startTimeout: const Duration(milliseconds: 20));
      await push.start();
      expect(push.available, isFalse);
    });
  });

  group('notification taps', () {
    test('a tap from the background routes each customer event to its order', () async {
      final push = make();
      await push.onSessionStarted('u1');
      for (final e in PushEvent.values) {
        fcm.opened.add(PushMessage(messageId: 'm-${e.key}', data: pushData(e.key, orderId: 'ord-${e.key}')));
        final tap = push.takePendingTap();
        expect(tap, isNotNull, reason: e.key);
        expect(tap!.event, e);
        expect(tap.orderId, 'ord-${e.key}');
      }
      expect(push.takePendingTap(), isNull);
    });

    test('the tap that launched the app from a terminated state is picked up', () async {
      fcm.initial = PushMessage(messageId: 'm1', data: pushData('RIDER_AT_GATE', orderId: 'ord-gate'));
      final push = make();
      await push.start();
      expect(push.pendingTap!.orderId, 'ord-gate');
      expect(push.pendingTap!.event, PushEvent.riderAtGate);
    });

    test('a tapped local banner (running or launching the app) is routed', () async {
      final push = make();
      await push.start();
      local.tapController.add(PushPayload.tryParse(pushData('ORDER_CANCELLED', orderId: 'ord-c'))!.encode());
      expect(push.takePendingTap()!.orderId, 'ord-c');

      local.launch = PushPayload.tryParse(pushData('ORDER_PICKED_UP', orderId: 'ord-p'))!.encode();
      final cold = make();
      await cold.start();
      expect(cold.pendingTap!.event, PushEvent.orderPickedUp);
    });

    test('the same message delivered twice routes once', () async {
      final push = make();
      await push.start();
      fcm.opened.add(PushMessage(messageId: 'same', data: pushData('ORDER_READY')));
      expect(push.takePendingTap(), isNotNull);
      fcm.opened.add(PushMessage(messageId: 'same', data: pushData('ORDER_READY')));
      expect(push.takePendingTap(), isNull);
    });

    test('malformed taps leave nothing to route', () async {
      fcm.initial = const PushMessage(data: {'event': 'ORDER_READY'});
      local.launch = 'garbage';
      final push = make();
      await push.start();
      fcm.opened.add(const PushMessage(data: {}));
      fcm.opened.add(PushMessage(data: pushData('NEW_ORDER')));
      fcm.opened.add(PushMessage(data: pushData('ORDER_READY', orderId: '<script>')));
      local.tapController.add(null);
      local.tapController.add('{"event":');
      expect(push.pendingTap, isNull);
    });
  });

  group('foreground messages', () {
    test('refresh the order once and show no banner for ordinary updates', () async {
      final push = make();
      final seen = <PushPayload>[];
      push.onOrderEvent = seen.add;
      await push.onSessionStarted('u1');
      fcm.foreground.add(PushMessage(data: pushData('ORDER_ACCEPTED', orderId: 'o-1'), title: 'Order accepted', body: 'x'));
      expect(seen.map((p) => p.orderId), ['o-1']);
      expect(local.shown, isEmpty);
    });

    test('an attention event shows one banner unless that order is already on screen', () async {
      final push = make();
      var visible = false;
      push.isOrderVisible = (_) => visible;
      push.onOrderEvent = (_) {};
      await push.onSessionStarted('u1');

      fcm.foreground.add(PushMessage(data: pushData('RIDER_AT_GATE', orderId: 'o-1'), title: 'Your rider is at the gate', body: 'Open Kraveo to see your code.'));
      await pumpEventQueue();
      expect(local.shown, hasLength(1));
      expect(local.shown.single.channelId, PushChannels.orderAttention);
      expect(local.shown.single.title, 'Your rider is at the gate');
      expect(PushPayload.tryDecode(local.shown.single.payload)!.orderId, 'o-1');

      visible = true;
      fcm.foreground.add(PushMessage(data: pushData('RIDER_AT_GATE', orderId: 'o-1')));
      await pumpEventQueue();
      expect(local.shown, hasLength(1));
    });

    test('a banner falls back to built-in copy when the message has no notification block', () async {
      final push = make();
      await push.onSessionStarted('u1');
      fcm.foreground.add(PushMessage(data: pushData('ORDER_CANCELLED')));
      await pumpEventQueue();
      expect(local.shown.single.title, 'Order cancelled');
    });

    test('malformed, foreign or signed-out messages are ignored', () async {
      final push = make();
      var calls = 0;
      push.onOrderEvent = (_) => calls++;
      await push.start();
      fcm.foreground.add(PushMessage(data: pushData('ORDER_READY'))); // no session yet
      await push.onSessionStarted('u1');
      fcm.foreground.add(const PushMessage(data: {}));
      fcm.foreground.add(PushMessage(data: pushData('NEW_DELIVERY')));
      fcm.foreground.add(PushMessage(data: pushData('ORDER_READY', v: '9')));
      await pumpEventQueue();
      expect(calls, 0);
      expect(local.shown, isEmpty);
    });

    test('a failing banner never throws', () async {
      final push = make();
      local.failShow = true;
      await push.onSessionStarted('u1');
      fcm.foreground.add(PushMessage(data: pushData('RIDER_AT_GATE')));
      await pumpEventQueue();
      expect(push.registeredToken, isNotNull);
    });
  });
}
