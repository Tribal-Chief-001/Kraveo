import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/push/push_controller.dart';
import 'package:driver_app/services/push/push_device_api.dart';
import 'package:driver_app/services/push/push_messaging.dart';
import 'package:driver_app/services/push/push_payload.dart';
import 'package:driver_app/session/session_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_push.dart';
import 'support/support_log.dart';

class _Ui implements PushUiHandler {
  final foreground = <PushPayload>[];
  final taps = <PushPayload>[];

  @override
  void onPushForeground(PushPayload payload) => foreground.add(payload);

  @override
  void onPushTap(PushPayload payload) => taps.add(payload);
}

Map<String, dynamic> _data(String event, [String orderId = 'ord1']) => {'event': event, 'orderId': orderId, 'v': '1'};

class _Rig {
  _Rig(this.msg, this.api, this.session, this.push);
  final FakePushMessaging msg;
  final FakeDeviceApi api;
  final SessionController session;
  final PushController push;
}

Future<_Rig> _rig({
  PartnerApproval approval = PartnerApproval.approved,
  PushPermission permission = PushPermission.granted,
  bool initOk = true,
  List<Duration> retry = const [],
  bool attach = true,
}) async {
  final log = EventLog();
  final msg = FakePushMessaging(perm: permission, initOk: initOk, log: log);
  final api = FakeDeviceApi(log);
  final session = await restoredSession(approval);
  final push = PushController(messaging: msg, api: api, appVersion: () async => '1.5.0+9', retryDelays: retry);
  if (attach) push.attach(session);
  await pumpEventQueue();
  return _Rig(msg, api, session, push);
}

void main() {
  tearDown(() async => DriverApiService.clearToken());

  group('token lifecycle', () {
    test('registers once after an approved rider is signed in, with the app version', () async {
      final r = await _rig();
      expect(r.api.registered, ['fcm-token-1']);
      expect(r.api.versions, ['1.5.0+9']);
      expect(r.push.registered, isTrue);
      expect(r.msg.channelCalls, 1);
      r.push.dispose();
    });

    test('no duplicate registration: resume, repeated sync and re-delivery of the same token do nothing', () async {
      final r = await _rig();
      await r.push.syncToken();
      await r.push.onAppResumed();
      r.msg.refresh.add('fcm-token-1');
      await pumpEventQueue();
      await Future.wait([r.push.syncToken(), r.push.syncToken()]);
      expect(r.api.registered, ['fcm-token-1']);
      r.push.dispose();
    });

    test('concurrent syncs while a register is in flight make a single call', () async {
      final r = await _rig(attach: false);
      r.push.attach(r.session);
      await Future.wait([r.push.syncToken(), r.push.syncToken(), r.push.syncToken()]);
      await pumpEventQueue();
      expect(r.api.registered, ['fcm-token-1']);
      r.push.dispose();
    });

    test('a refreshed token is registered again', () async {
      final r = await _rig();
      r.msg.refresh.add('fcm-token-2');
      await pumpEventQueue();
      expect(r.api.registered, ['fcm-token-1', 'fcm-token-2']);
      r.push.dispose();
    });

    test('a rider who is not approved yet is not registered; approval triggers it', () async {
      final r = await _rig(approval: PartnerApproval.pending);
      expect(r.api.registered, isEmpty);
      (r.session.auth as ApprovalAuth).approval = PartnerApproval.approved;
      await r.session.refreshApproval();
      await pumpEventQueue();
      expect(r.api.registered, ['fcm-token-1']);
      r.push.dispose();
    });

    test('logout: DELETE /devices runs BEFORE the login token is cleared, then the FCM token is deleted', () async {
      final r = await _rig();
      r.api.log.clear();
      await r.session.logout();
      expect(r.api.log.events, ['unregister:fcm-token-1', 'deleteToken']);
      expect(r.api.jwtPresentOnUnregister, isTrue);
      expect(r.session.status, SessionStatus.signedOut);
      expect(await DriverApiService.getSavedToken(), isNull);
      r.push.dispose();
    });

    test('logout never waits on or fails because of a dead network', () async {
      final r = await _rig();
      r.api.throwOnUnregister = true;
      await r.session.logout();
      expect(r.session.status, SessionStatus.signedOut);
      expect(await DriverApiService.getSavedToken(), isNull);
      r.push.dispose();
    });

    test('a different rider logging in afterwards registers the rotated token', () async {
      final r = await _rig();
      await r.session.logout();
      await pumpEventQueue();
      await r.session.login('9000000000', 'secret');
      await pumpEventQueue();
      expect(r.api.registered, ['fcm-token-1', 'fcm-token-rotated']);
      r.push.dispose();
    });

    test('a 401 session expiry rotates the local token without calling DELETE', () async {
      final r = await _rig();
      r.api.log.clear();
      await r.session.expire();
      await pumpEventQueue();
      expect(r.api.log.events, ['deleteToken']);
      r.push.dispose();
    });

    test('network failure retries with backoff; a 4xx stops quietly', () async {
      final r = await _rig(retry: const [Duration(milliseconds: 20)], attach: false);
      r.api.registerResult = DeviceCallResult.retry;
      r.push.attach(r.session);
      await pumpEventQueue();
      expect(r.push.registered, isFalse);
      r.api.registerResult = DeviceCallResult.ok;
      await Future<void>.delayed(const Duration(milliseconds: 80));
      await pumpEventQueue();
      expect(r.api.registered.length, 2);
      expect(r.push.registered, isTrue);
      r.push.dispose();

      final r2 = await _rig(retry: const [Duration(milliseconds: 10)], attach: false);
      r2.api.registerResult = DeviceCallResult.rejected;
      r2.push.attach(r2.session);
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(r2.api.registered.length, 1);
      r2.push.dispose();
    });

    test('Firebase init failure: no calls, no throw, the session still works', () async {
      final r = await _rig(initOk: false);
      expect(r.push.available, isFalse);
      expect(r.api.registered, isEmpty);
      expect(r.push.showBlockedBanner, isFalse);
      expect(r.session.status, SessionStatus.signedIn);
      await r.push.fixPermission();
      await r.push.onAppResumed();
      await r.session.logout();
      expect(r.session.status, SessionStatus.signedOut);
      expect(r.api.log.events, isEmpty);
      r.push.dispose();
    });
  });

  group('permission', () {
    test('denied: banner is up and the button asks again; permanent denial opens settings', () async {
      final r = await _rig(permission: PushPermission.denied);
      expect(r.push.showBlockedBanner, isTrue);
      expect(r.push.mustOpenSettings, isFalse);
      r.msg.promptAnswer = PushPermission.deniedPermanently;
      await r.push.fixPermission();
      expect(r.msg.promptCalls, 1);
      expect(r.msg.settingsOpened, 1); // the system would not ask again
      expect(r.push.mustOpenSettings, isTrue);
      await r.push.fixPermission();
      expect(r.msg.promptCalls, 1); // no prompt any more, straight to settings
      expect(r.msg.settingsOpened, 2);
      r.push.dispose();
    });

    test('Android 7-12: no dialog exists, so the banner button opens the notification settings at once', () async {
      final r = await _rig(permission: PushPermission.denied);
      r.msg.promptAnswer = PushPermission.denied; // the plugin just answers "denied" without showing anything
      await r.push.fixPermission();
      expect(r.msg.settingsOpened, 1);
      r.push.dispose();
    });

    test('Android 13+: a refusal of the dialog that was just shown does not open settings right away', () async {
      final r = await _rig(permission: PushPermission.notDetermined);
      r.msg.promptAnswer = PushPermission.denied;
      await r.push.fixPermission();
      expect(r.msg.promptCalls, 1);
      expect(r.msg.settingsOpened, 0);
      r.push.dispose();
    });

    test('granting from the banner clears it; coming back from settings clears it too', () async {
      final r = await _rig(permission: PushPermission.denied);
      r.msg.promptAnswer = PushPermission.granted;
      await r.push.fixPermission();
      expect(r.push.showBlockedBanner, isFalse);
      r.push.dispose();

      final r2 = await _rig(permission: PushPermission.deniedPermanently);
      expect(r2.push.showBlockedBanner, isTrue);
      r2.msg.perm = PushPermission.granted; // rider enabled it in the phone settings
      await r2.push.onAppResumed();
      expect(r2.push.showBlockedBanner, isFalse);
      r2.push.dispose();
    });

    test('blocked notifications do not stop the device from registering', () async {
      final r = await _rig(permission: PushPermission.denied);
      expect(r.api.registered, ['fcm-token-1']);
      r.push.dispose();
    });

    test('explain-then-ask is needed until answered, only for an approved rider who was never asked', () async {
      final log = EventLog();
      await DriverApiService.clearToken();
      SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt'});
      final msg = FakePushMessaging(perm: PushPermission.notDetermined, log: log);
      final session = SessionController(auth: ApprovalAuth());
      await session.restore();
      final push = PushController(messaging: msg, api: FakeDeviceApi(log));
      push.attach(session);
      await pumpEventQueue();
      expect(push.needsExplanation, isTrue);
      await push.markExplained();
      expect(push.needsExplanation, isFalse);
      expect((await SharedPreferences.getInstance()).getBool(PushController.explainedPrefKey), isTrue);
      push.dispose();

      // A pending rider is never asked.
      final pending = await _rig(permission: PushPermission.notDetermined, approval: PartnerApproval.pending);
      expect(pending.push.needsExplanation, isFalse);
      expect(pending.push.showBlockedBanner, isFalse);
      pending.push.dispose();
    });
  });

  group('incoming pushes', () {
    test('foreground: each rider event reaches the screen exactly once, duplicates are dropped', () async {
      final r = await _rig();
      final ui = _Ui();
      r.push.attachUi(ui);
      for (final e in ['NEW_DELIVERY', 'DELIVERY_ASSIGNED', 'DELIVERY_CANCELLED']) {
        r.msg.foreground.add(PushIncoming(messageId: 'm-$e', data: _data(e)));
      }
      r.msg.foreground.add(PushIncoming(messageId: 'm-NEW_DELIVERY', data: _data('NEW_DELIVERY'))); // same message again
      await pumpEventQueue();
      expect(ui.foreground.map((p) => p.event), [PushEvent.newDelivery, PushEvent.deliveryAssigned, PushEvent.deliveryCancelled]);
      r.push.dispose();
    });

    test('foreground: malformed, foreign and unknown payloads are ignored safely', () async {
      final r = await _rig();
      final ui = _Ui();
      r.push.attachUi(ui);
      for (final d in <Map<String, dynamic>>[
        {},
        {'event': 'NEW_ORDER', 'orderId': 'x'},
        {'event': 'NEW_DELIVERY'},
        {'event': 5, 'orderId': 6},
        {'foo': 'bar'},
      ]) {
        r.msg.foreground.add(PushIncoming(messageId: 'm${d.hashCode}', data: d));
      }
      await pumpEventQueue();
      expect(ui.foreground, isEmpty);
      expect(ui.taps, isEmpty);
      r.push.dispose();
    });

    test('taps from the background route per event; the same tap twice routes once', () async {
      final r = await _rig();
      final ui = _Ui();
      r.push.attachUi(ui);
      r.msg.taps.add(PushIncoming(messageId: 't1', data: _data('NEW_DELIVERY', 'o1')));
      r.msg.taps.add(PushIncoming(messageId: 't2', data: _data('DELIVERY_ASSIGNED', 'o2')));
      r.msg.taps.add(PushIncoming(messageId: 't3', data: _data('DELIVERY_CANCELLED', 'o3')));
      r.msg.taps.add(PushIncoming(messageId: 't3', data: _data('DELIVERY_CANCELLED', 'o3')));
      await pumpEventQueue();
      expect(ui.taps, [
        const PushPayload(event: PushEvent.newDelivery, orderId: 'o1'),
        const PushPayload(event: PushEvent.deliveryAssigned, orderId: 'o2'),
        const PushPayload(event: PushEvent.deliveryCancelled, orderId: 'o3'),
      ]);
      r.push.dispose();
    });

    test('cold start: the launching notification is held until the screen is up, then delivered once', () async {
      final log = EventLog();
      final msg = FakePushMessaging(log: log)..initial = PushIncoming(messageId: 'cold', data: _data('NEW_DELIVERY', 'o9'));
      final session = await restoredSession();
      final push = PushController(messaging: msg, api: FakeDeviceApi(log));
      push.attach(session);
      await pumpEventQueue();
      final ui = _Ui();
      push.attachUi(ui);
      expect(ui.taps, [const PushPayload(event: PushEvent.newDelivery, orderId: 'o9')]);
      push.detachUi(ui);
      final ui2 = _Ui();
      push.attachUi(ui2);
      expect(ui2.taps, isEmpty);
      push.dispose();
    });

    test('logged out: pushes and taps are ignored and the app just opens', () async {
      final log = EventLog();
      final msg = FakePushMessaging(log: log)..initial = PushIncoming(messageId: 'cold', data: _data('NEW_DELIVERY'));
      await DriverApiService.clearToken();
      SharedPreferences.setMockInitialValues({});
      final session = SessionController(auth: ApprovalAuth());
      await session.restore(); // no token -> signed out
      final push = PushController(messaging: msg, api: FakeDeviceApi(log));
      push.attach(session);
      await pumpEventQueue();
      final ui = _Ui();
      push.attachUi(ui);
      msg.foreground.add(PushIncoming(messageId: 'f', data: _data('NEW_DELIVERY')));
      msg.taps.add(PushIncoming(messageId: 't', data: _data('DELIVERY_ASSIGNED')));
      await pumpEventQueue();
      expect(ui.foreground, isEmpty);
      expect(ui.taps, isEmpty);
      expect(log.events, isEmpty);
      push.dispose();
    });

    test('a tap that arrives before the screen exists is dropped when the rider ends up signed out', () async {
      final r = await _rig();
      r.msg.taps.add(PushIncoming(messageId: 't', data: _data('NEW_DELIVERY')));
      await pumpEventQueue();
      await r.session.logout();
      final ui = _Ui();
      r.push.attachUi(ui);
      expect(ui.taps, isEmpty);
      r.push.dispose();
    });
  });
}
