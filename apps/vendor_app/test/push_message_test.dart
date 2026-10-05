import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/services/push/local_alarm_notifications.dart';
import 'package:vendor_app/services/push/push_background.dart';
import 'package:vendor_app/services/push/push_message.dart';
import 'package:vendor_app/services/push/push_ports.dart';
import 'support/push_fakes.dart';

void main() {
  group('payload parsing never throws', () {
    test('a well-formed NEW_ORDER and ORDER_CANCELLED_VENDOR', () {
      final a = PushMessage.fromData({'event': 'NEW_ORDER', 'orderId': 'ord-1', 'v': '1'});
      expect(a.event, PushEvent.newOrder);
      expect(a.orderId, 'ord-1');
      expect(a.isActionable, isTrue);
      expect(PushMessage.fromData({'event': 'ORDER_CANCELLED_VENDOR', 'orderId': 'ord-2'}).event, PushEvent.orderCancelledVendor);
    });

    test('junk in any shape becomes an unknown, non-actionable message', () {
      final inputs = <Object?>[
        null,
        'a string',
        42,
        <Object?>[],
        <String, Object?>{},
        {'event': null, 'orderId': null},
        {'event': 42, 'orderId': 7},
        {'event': 'NEW_ORDER'},
        {'event': 'NEW_ORDER', 'orderId': ''},
        {'event': 'NEW_ORDER', 'orderId': '   '},
        {'event': 'NEW_ORDER', 'orderId': 123},
        {'event': 'NEW_ORDER', 'orderId': 'x' * 500},
        {'event': 'new_order', 'orderId': 'ord-1'},
        {'event': 'NEW_DELIVERY', 'orderId': 'ord-1'},
        {'orderId': 'ord-1'},
      ];
      for (final input in inputs) {
        final m = PushMessage.fromData(input);
        expect(m.isActionable, isFalse, reason: 'input: $input');
      }
    });

    test('local-notification payloads: bad JSON, wrong type, empty, huge', () {
      for (final p in <String?>[null, '', 'not json', '[1,2]', '"x"', '{"event":', '{"event":"NEW_ORDER"}', 'a' * 5000]) {
        expect(PushMessage.fromPayload(p).isActionable, isFalse, reason: 'payload: $p');
      }
    });

    test('a payload round-trips and carries no personal data', () {
      const m = PushMessage(event: PushEvent.newOrder, orderId: 'ord-1', title: 'Priya 9876543210', body: 'Hostel 4');
      final payload = m.toPayload();
      expect(payload, isNot(contains('Priya')));
      expect(payload, isNot(contains('9876543210')));
      expect(payload, isNot(contains('Hostel')));
      final back = PushMessage.fromPayload(payload);
      expect(back.event, PushEvent.newOrder);
      expect(back.orderId, 'ord-1');
    });
  });

  group('background handler body', () {
    PushMessage data(String event, {String? orderId = 'ord-1', bool block = false}) =>
        PushMessage.fromData({'event': event, if (orderId != null) 'orderId': orderId},
            hasNotificationBlock: block, title: 'New order', body: '2 items - Rs 245. Tap to accept.');

    test('data-only NEW_ORDER shows exactly one alarm notification', () async {
      final n = FakeNotifications();
      await showBackgroundPush(data('NEW_ORDER'), n);
      expect(n.shown, ['newOrder:ord-1']);
    });

    test('NEW_ORDER that already has a notification block is left to Android: no second alarm', () async {
      final n = FakeNotifications();
      await showBackgroundPush(data('NEW_ORDER', block: true), n);
      expect(n.shown, isEmpty);
    });

    test('data-only ORDER_CANCELLED_VENDOR shows a quiet update, not the alarm', () async {
      final n = FakeNotifications();
      await showBackgroundPush(data('ORDER_CANCELLED_VENDOR'), n);
      expect(n.shown, ['update:ord-1']);
    });

    test('unknown event, no order id: nothing shown', () async {
      final n = FakeNotifications();
      await showBackgroundPush(data('NEW_DELIVERY'), n);
      await showBackgroundPush(data('NEW_ORDER', orderId: null), n);
      await showBackgroundPush(PushMessage.fromData(null), n);
      expect(n.shown, isEmpty);
    });

    test('the same order always maps to the same notification id (a repeat replaces, never stacks)', () {
      expect(notificationIdFor('ord-1'), notificationIdFor('ord-1'));
      expect(notificationIdFor('ord-1'), isNot(notificationIdFor('ord-2')));
      expect(notificationIdFor('3f2a9c1e-0000-4000-8000-00000000a1b2'), isNonNegative);
    });
  });

  group('contract constants and Android resources', () {
    test('channel ids are the contract ids', () {
      expect(PushChannels.newOrders, 'new_orders');
      expect(PushChannels.orderUpdates, 'order_updates');
    });

    test('the alarm channel is high importance, alarm usage, bundled sound', () {
      final c = LocalAlarmNotifications.newOrdersChannel;
      expect(c.id, 'new_orders');
      expect(c.importance.value, 4); // IMPORTANCE_HIGH
      expect(c.audioAttributesUsage.name, 'alarm');
      expect(c.enableVibration, isTrue);
      expect(c.playSound, isTrue);
      expect(c.sound, isNotNull);
      expect(LocalAlarmNotifications.orderUpdatesChannel.id, 'order_updates');
    });

    test('the native sound, the small icon and the manifest entries exist', () {
      final raw = File('android/app/src/main/res/raw/new_order_alarm.ogg');
      expect(raw.existsSync(), isTrue);
      expect(raw.lengthSync(), lessThan(700 * 1024));
      expect(File('android/app/src/main/res/drawable/ic_stat_kraveo.xml').existsSync(), isTrue);
      final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      for (final needle in [
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.USE_FULL_SCREEN_INTENT',
        'default_notification_channel_id',
        '@drawable/ic_stat_kraveo',
      ]) {
        expect(manifest, contains(needle));
      }
      // A locked kitchen phone must not show the dashboard over the keyguard.
      expect(manifest, isNot(contains('showWhenLocked')));
      expect(manifest, isNot(contains('turnScreenOn')));
    });
  });
}
