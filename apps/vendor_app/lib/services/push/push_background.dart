import 'dart:ui' show DartPluginRegistrant;
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'local_alarm_notifications.dart';
import 'push_message.dart';
import 'push_ports.dart';

/// The pure part of the background handler (so tests can run it with a fake notifier).
///
/// A push that carries a `notification` block is shown by Android itself on its own channel, so nothing is added
/// here (that is what prevents a double alarm). A data-only push is turned into a notification by the app:
/// NEW_ORDER becomes the loud full-screen alarm, ORDER_CANCELLED_VENDOR a quiet update. Anything else is ignored.
Future<void> showBackgroundPush(PushMessage message, AlarmNotifications notifications) async {
  if (message.hasNotificationBlock || !message.isActionable) return;
  final orderId = message.orderId!;
  switch (message.event) {
    case PushEvent.newOrder:
      await notifications.showNewOrder(orderId, title: message.title, body: message.body);
    case PushEvent.orderCancelledVendor:
      await notifications.showUpdate(orderId, title: message.title ?? 'Order cancelled', body: message.body ?? 'An order was cancelled.');
    case PushEvent.groupReadyToCook:
      await notifications.showUpdate(orderId, title: message.title ?? 'Start cooking', body: message.body ?? 'All restaurants accepted - you can start cooking.');
    case PushEvent.unknown:
      break;
  }
}

/// Runs in its own isolate when a push arrives while the app is not in the foreground. It must not touch UI or
/// app state (and needs no Firebase of its own: it only builds a local notification). Never throws: a failure here must not crash the process.
@pragma('vm:entry-point')
Future<void> kraveoVendorBackgroundHandler(RemoteMessage remote) async {
  try {
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final message = PushMessage.fromData(
      remote.data,
      hasNotificationBlock: remote.notification != null,
      title: remote.notification?.title,
      body: remote.notification?.body,
    );
    if (message.hasNotificationBlock || !message.isActionable) return; // Android shows it, or nothing to do
    final notifications = LocalAlarmNotifications();
    await notifications.initialize();
    await showBackgroundPush(message, notifications);
  } catch (e) {
    debugPrint('[push] background handler failed: ${e.runtimeType}');
  }
}
