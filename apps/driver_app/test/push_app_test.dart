import 'package:driver_app/main.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/push/push_controller.dart';
import 'package:driver_app/services/push/push_messaging.dart';
import 'package:driver_app/session/session_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_push.dart';
import 'support/fake_rider.dart';
import 'support/support_log.dart';

class _Rig {
  _Rig(this.msg, this.api, this.push, this.rider);
  final FakePushMessaging msg;
  final FakeDeviceApi api;
  final PushController push;
  final FakeRider rider;
}

Map<String, dynamic> _data(String event, [String orderId = 'ord-1']) => {'event': event, 'orderId': orderId, 'v': '1'};

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Future<_Rig> _pump(
  WidgetTester tester, {
  PushPermission permission = PushPermission.granted,
  bool explained = true,
  bool initOk = true,
  PushIncoming? launchedBy,
  void Function(FakeRider f)? setup,
}) async {
  tester.view.physicalSize = const Size(400, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.runAsync(DriverApiService.clearToken); // real async: prefs I/O does not complete in fake time
  SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt', if (explained) PushController.explainedPrefKey: true});
  final log = EventLog();
  final msg = FakePushMessaging(perm: permission, initOk: initOk, log: log)..initial = launchedBy;
  final api = FakeDeviceApi(log);
  final push = PushController(messaging: msg, api: api, retryDelays: const []);
  final rider = FakeRider();
  setup?.call(rider);
  await tester.pumpWidget(KraveoDriverApp(auth: ApprovalAuth(), riderServices: () => rider.services, push: push));
  await _settle(tester);
  return _Rig(msg, api, push, rider);
}

int _tab(WidgetTester tester) => tester.widget<IndexedStack>(find.byType(IndexedStack)).index ?? -1;

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
}

OrderView _mine() => OrderView.tryParse(orderJson(id: 'ord-1', status: 'ACCEPTED', driverId: 'u1'))!;

void main() {
  testWidgets('signed in: the device registers and no banner shows when notifications are on', (tester) async {
    final r = await _pump(tester);
    expect(find.text('OFF DUTY'), findsOneWidget);
    expect(r.api.registered, ['fcm-token-1']);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsNothing);
    await _unmount(tester);
  });

  testWidgets('blocked notifications: banner above the duty switch; Turn on asks, settings when the system will not ask', (tester) async {
    final r = await _pump(tester, permission: PushPermission.denied);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsOneWidget);
    expect(find.text('Turn on notifications or you will miss deliveries'), findsOneWidget);
    expect(find.text('Turn on'), findsOneWidget);
    // The banner sits directly above the duty switch.
    expect(tester.getTopLeft(find.byKey(const ValueKey('push-blocked-banner'))).dy, lessThan(tester.getTopLeft(find.text('OFF DUTY')).dy));

    r.msg.promptAnswer = PushPermission.deniedPermanently;
    await tester.tap(find.byKey(const ValueKey('push-fix-button')));
    await _settle(tester);
    expect(r.msg.promptCalls, 1);
    expect(find.text('Open settings'), findsOneWidget);
    expect(r.msg.settingsOpened, 1);

    await tester.tap(find.byKey(const ValueKey('push-fix-button')));
    await _settle(tester);
    expect(r.msg.settingsOpened, 2);

    r.msg.perm = PushPermission.granted;
    await r.push.onAppResumed();
    await _settle(tester);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsNothing);
    await _unmount(tester);
  });

  testWidgets('on duty with notifications blocked: the duty switch says alerts are off', (tester) async {
    await _pump(tester, permission: PushPermission.deniedPermanently);
    await tester.tap(find.text('OFF DUTY'));
    await _settle(tester);
    expect(find.text('ON DUTY'), findsOneWidget);
    expect(find.text('Alerts are off - you may miss orders'), findsOneWidget);
    await _unmount(tester);
  });

  testWidgets('explain-then-ask: a sheet explains first, then the system prompt; asked only once', (tester) async {
    final r = await _pump(tester, permission: PushPermission.notDetermined, explained: false);
    expect(find.text('Get new-delivery alerts'), findsOneWidget);
    expect(r.msg.promptCalls, 0); // nothing is asked before the rider agrees
    await tester.tap(find.byKey(const ValueKey('push-explain-allow')));
    await _settle(tester);
    expect(r.msg.promptCalls, 1);
    expect(find.text('Get new-delivery alerts'), findsNothing);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsNothing);
    await _unmount(tester);

    // "Not now": no prompt, the banner takes over, and the sheet never comes back.
    final r2 = await _pump(tester, permission: PushPermission.notDetermined, explained: false);
    await tester.tap(find.byKey(const ValueKey('push-explain-skip')));
    await _settle(tester);
    expect(r2.msg.promptCalls, 0);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsOneWidget);
    expect(r2.push.needsExplanation, isFalse);
    await _unmount(tester);
  });

  testWidgets('foreground NEW_DELIVERY while on duty: one pool refresh, no extra banner; off duty: nothing', (tester) async {
    final r = await _pump(tester);
    await tester.tap(find.text('OFF DUTY'));
    await _settle(tester);
    r.rider.api.calls.clear();
    r.msg.foreground.add(PushIncoming(messageId: 'm1', data: _data('NEW_DELIVERY')));
    r.msg.foreground.add(PushIncoming(messageId: 'm1', data: _data('NEW_DELIVERY'))); // duplicate delivery
    await _settle(tester);
    expect(r.rider.api.calls.where((c) => c == 'available').length, 1);
    expect(find.byType(SnackBar), findsNothing);
    await _unmount(tester);

    final r2 = await _pump(tester);
    r2.rider.api.calls.clear();
    r2.msg.foreground.add(PushIncoming(messageId: 'm2', data: _data('NEW_DELIVERY')));
    await _settle(tester);
    expect(r2.rider.api.calls, isEmpty); // off duty: ignored
    await _unmount(tester);
  });

  testWidgets('tap NEW_DELIVERY opens the pool (home); tap DELIVERY_CANCELLED refreshes home', (tester) async {
    final r = await _pump(tester, setup: (f) => f.api.available = ApiResult.ok([offer()]));
    await tester.tap(find.text('OFF DUTY'));
    await _settle(tester);
    // Go somewhere else first.
    await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(LucideIcons.wallet)));
    await _settle(tester);
    expect(_tab(tester), 2);
    r.rider.api.calls.clear();
    r.msg.taps.add(PushIncoming(messageId: 't1', data: _data('NEW_DELIVERY')));
    await _settle(tester);
    expect(_tab(tester), 0);
    expect(r.rider.api.calls, contains('available'));

    await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(LucideIcons.history)));
    await _settle(tester);
    r.rider.api.calls.clear();
    r.msg.taps.add(PushIncoming(messageId: 't2', data: _data('DELIVERY_CANCELLED')));
    await _settle(tester);
    expect(_tab(tester), 0);
    expect(r.rider.api.calls, contains('active'));
    await _unmount(tester);
  });

  testWidgets('tap DELIVERY_ASSIGNED opens the active delivery once the assignment is confirmed', (tester) async {
    final r = await _pump(tester);
    expect(_tab(tester), 0);
    r.rider.api.active = ApiResult.ok([_mine()]);
    r.msg.taps.add(PushIncoming(messageId: 't1', data: _data('DELIVERY_ASSIGNED')));
    await _settle(tester);
    expect(_tab(tester), 1);
    await _unmount(tester);
  });

  testWidgets('tap DELIVERY_ASSIGNED that the server does not confirm stays on home', (tester) async {
    final r = await _pump(tester);
    r.msg.taps.add(PushIncoming(messageId: 't1', data: _data('DELIVERY_ASSIGNED')));
    await _settle(tester);
    expect(_tab(tester), 0);
    await _unmount(tester);
  });

  testWidgets('cold start from a notification: the active delivery opens after login restore', (tester) async {
    final r = await _pump(
      tester,
      launchedBy: PushIncoming(messageId: 'cold', data: _data('DELIVERY_ASSIGNED')),
      setup: (f) => f.api.active = ApiResult.ok([_mine()]),
    );
    expect(_tab(tester), 1);
    expect(r.api.registered, isNotEmpty);
    await _unmount(tester);
  });

  testWidgets('malformed payloads in the foreground and on tap leave the app untouched', (tester) async {
    final r = await _pump(tester);
    r.rider.api.calls.clear();
    for (final d in <Map<String, dynamic>>[{}, {'event': 'NEW_ORDER', 'orderId': 'x'}, {'event': 'NEW_DELIVERY'}, {'x': 1}]) {
      r.msg.foreground.add(PushIncoming(messageId: 'f${d.length}${d.hashCode}', data: d));
      r.msg.taps.add(PushIncoming(messageId: 't${d.length}${d.hashCode}', data: d));
    }
    await _settle(tester);
    expect(_tab(tester), 0);
    expect(r.rider.api.calls, isEmpty);
    expect(tester.takeException(), isNull);
    await _unmount(tester);
  });

  testWidgets('Firebase cannot start: the home screen works, no banner, no device calls', (tester) async {
    final r = await _pump(tester, initOk: false, permission: PushPermission.denied);
    expect(find.text('OFF DUTY'), findsOneWidget);
    expect(find.byKey(const ValueKey('push-blocked-banner')), findsNothing);
    expect(r.api.registered, isEmpty);
    await tester.tap(find.text('OFF DUTY'));
    await _settle(tester);
    expect(find.text('ON DUTY'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await _unmount(tester);
  });

  testWidgets('logging out from the app removes the device before the session is cleared', (tester) async {
    final r = await _pump(tester);
    r.api.log.clear();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.ensureVisible(find.byKey(const ValueKey('logout-card')));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byKey(const ValueKey('logout-card')));
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('confirm-logout-button')));
    await _settle(tester);
    expect(r.api.log.events, ['unregister:fcm-token-1', 'deleteToken']);
    expect(r.api.jwtPresentOnUnregister, isTrue);
    expect(find.byKey(const ValueKey('login-button')), findsOneWidget);
    expect(await DriverApiService.getSavedToken(), isNull);
    await _unmount(tester);
  });

  test('SessionController without a push hook logs out exactly as before', () async {
    await DriverApiService.clearToken();
    SharedPreferences.setMockInitialValues({'kraveo_driver_jwt_token': 'test-jwt'});
    final s = SessionController(auth: ApprovalAuth());
    await s.restore();
    expect(s.beforeSignOut, isNull);
    await s.logout();
    expect(s.status, SessionStatus.signedOut);
  });
}
