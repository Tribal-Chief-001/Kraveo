import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'push_message.dart';
import 'push_ports.dart';

/// Android small icon (res/drawable/ic_stat_kraveo.xml).
const String kStatusIcon = 'ic_stat_kraveo';

/// Same id for the same order, in every isolate and every run, so a repeat replaces the notification instead of stacking.
int notificationIdFor(String orderId) {
  var hash = 0x811c9dc5;
  for (final unit in orderId.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

/// Real notifications via flutter_local_notifications. Used by the app and by the background handler.
class LocalAlarmNotifications implements AlarmNotifications {
  LocalAlarmNotifications([FlutterLocalNotificationsPlugin? plugin]) : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  final StreamController<PushMessage> _taps = StreamController<PushMessage>.broadcast();
  bool _initialised = false;

  static final AndroidNotificationChannel newOrdersChannel = AndroidNotificationChannel(
    PushChannels.newOrders,
    'New orders',
    description: 'Loud alarm when a customer places an order',
    importance: Importance.high,
    playSound: true,
    sound: const RawResourceAndroidNotificationSound(PushChannels.alarmSoundResource),
    audioAttributesUsage: AudioAttributesUsage.alarm,
    enableVibration: true,
    vibrationPattern: _vibration,
    bypassDnd: true,
    showBadge: true,
  );

  static const AndroidNotificationChannel orderUpdatesChannel = AndroidNotificationChannel(
    PushChannels.orderUpdates,
    'Order updates',
    description: 'Cancellations and other changes to your orders',
    importance: Importance.defaultImportance,
  );

  static final Int64List _vibration = Int64List.fromList([0, 900, 500, 900, 500, 900]);

  @override
  Future<void> initialize() async {
    if (_initialised) return;
    await _plugin.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings(kStatusIcon)),
      onDidReceiveNotificationResponse: (response) => _taps.add(PushMessage.fromPayload(response.payload)),
    );
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(newOrdersChannel);
    await android?.createNotificationChannel(orderUpdatesChannel);
    _initialised = true;
  }

  @override
  Stream<PushMessage> get onTap => _taps.stream;

  @override
  Future<PushMessage?> launchTap() async {
    try {
      final details = await _plugin.getNotificationAppLaunchDetails();
      if (details == null || !details.didNotificationLaunchApp) return null;
      return PushMessage.fromPayload(details.notificationResponse?.payload);
    } catch (e) {
      debugPrint('[push] launch details unavailable: $e');
      return null;
    }
  }

  @override
  Future<void> showNewOrder(String orderId, {String? title, String? body}) async {
    await initialize();
    final payload = PushMessage(event: PushEvent.newOrder, orderId: orderId).toPayload();
    await _plugin.show(
      id: notificationIdFor(orderId),
      title: title ?? 'New order',
      body: body ?? 'Tap to accept.',
      payload: payload,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          PushChannels.newOrders,
          'New orders',
          channelDescription: 'Loud alarm when a customer places an order',
          importance: Importance.high,
          priority: Priority.high,
          icon: kStatusIcon,
          category: AndroidNotificationCategory.alarm,
          visibility: NotificationVisibility.public,
          fullScreenIntent: true,
          playSound: true,
          sound: const RawResourceAndroidNotificationSound(PushChannels.alarmSoundResource),
          audioAttributesUsage: AudioAttributesUsage.alarm,
          enableVibration: true,
          vibrationPattern: _vibration,
          autoCancel: true,
          // FLAG_INSISTENT: the alarm tone repeats until the cook opens or dismisses the notification.
          additionalFlags: Int32List.fromList(const [4]),
          // An order unanswered for 10 minutes is expired by the server anyway.
          timeoutAfter: 10 * 60 * 1000,
        ),
      ),
    );
  }

  @override
  Future<void> showUpdate(String orderId, {required String title, required String body}) async {
    await initialize();
    await _plugin.show(
      id: notificationIdFor(orderId),
      title: title,
      body: body,
      payload: PushMessage(event: PushEvent.orderCancelledVendor, orderId: orderId).toPayload(),
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          PushChannels.orderUpdates,
          'Order updates',
          channelDescription: 'Cancellations and other changes to your orders',
          importance: Importance.defaultImportance,
          priority: Priority.defaultPriority,
          icon: kStatusIcon,
          visibility: NotificationVisibility.public,
        ),
      ),
    );
  }

  @override
  Future<void> cancelOrder(String orderId) async {
    try {
      await _plugin.cancel(id: notificationIdFor(orderId));
    } catch (_) {}
  }
}
