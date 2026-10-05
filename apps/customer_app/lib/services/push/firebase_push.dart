import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'push_messaging.dart';
import 'push_payload.dart';

/// Runs in a background isolate when a data message arrives while the app is not running.
/// Notification messages are shown by Android itself, so there is nothing to do here and it
/// must never touch UI or app state (Docs/18 section 6).
@pragma('vm:entry-point')
Future<void> kraveoFirebaseBackgroundHandler(RemoteMessage message) async {
  try {
    if (Firebase.apps.isEmpty) await Firebase.initializeApp();
  } catch (_) {}
}

PushMessage _toPushMessage(RemoteMessage m) => PushMessage(
      messageId: m.messageId,
      data: {for (final e in m.data.entries) e.key: e.value},
      title: m.notification?.title,
      body: m.notification?.body,
    );

/// Real FCM layer. Only `main.dart` constructs it; tests use fakes.
class FirebasePushMessaging implements PushMessaging {
  bool _ready = false;

  FirebaseMessaging get _fm => FirebaseMessaging.instance;

  @override
  Future<bool> initialize() async {
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(kraveoFirebaseBackgroundHandler);
      _ready = true;
    } catch (e) {
      _ready = false;
      debugPrint('[Push] Firebase unavailable, push disabled: ${e.runtimeType}');
    }
    return _ready;
  }

  PushPermission _map(AuthorizationStatus s) =>
      s == AuthorizationStatus.authorized || s == AuthorizationStatus.provisional ? PushPermission.granted : PushPermission.denied;

  @override
  Future<PushPermission> permission() async => _map((await _fm.getNotificationSettings()).authorizationStatus);

  @override
  Future<PushPermission> requestPermission() async => _map((await _fm.requestPermission()).authorizationStatus);

  @override
  Future<String?> token() => _fm.getToken();

  @override
  Stream<String> get tokenRefreshes => _ready ? _fm.onTokenRefresh : const Stream.empty();

  @override
  Future<void> deleteToken() => _fm.deleteToken();

  @override
  Stream<PushMessage> get foregroundMessages => _ready ? FirebaseMessaging.onMessage.map(_toPushMessage) : const Stream.empty();

  @override
  Stream<PushMessage> get openedMessages => _ready ? FirebaseMessaging.onMessageOpenedApp.map(_toPushMessage) : const Stream.empty();

  @override
  Future<PushMessage?> initialMessage() async {
    final m = await _fm.getInitialMessage();
    return m == null ? null : _toPushMessage(m);
  }
}

/// Real local-notification layer (channels + banners shown by the app itself).
class PlatformLocalNotifier implements LocalNotifier {
  static const String _icon = 'ic_stat_kraveo';

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  final StreamController<String?> _taps = StreamController<String?>.broadcast();
  bool _ready = false;

  @override
  Stream<String?> get taps => _taps.stream;

  @override
  Future<void> initialize() async {
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(android: AndroidInitializationSettings(_icon)),
        onDidReceiveNotificationResponse: (r) => _taps.add(r.payload),
      );
      final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      await android?.createNotificationChannel(const AndroidNotificationChannel(
        PushChannels.orderUpdates,
        'Order updates',
        description: 'Accepted, ready and delivered updates for your orders.',
        importance: Importance.defaultImportance,
      ));
      await android?.createNotificationChannel(const AndroidNotificationChannel(
        PushChannels.orderAttention,
        'Rider and order alerts',
        description: 'Your rider is on the way or at the gate, and cancelled orders.',
        importance: Importance.high,
      ));
      _ready = true;
    } catch (e) {
      _ready = false;
      debugPrint('[Push] local notifications unavailable: ${e.runtimeType}');
    }
  }

  @override
  Future<String?> launchPayload() async {
    if (!_ready) return null;
    try {
      final d = await _plugin.getNotificationAppLaunchDetails();
      return d != null && d.didNotificationLaunchApp ? d.notificationResponse?.payload : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> show({required int id, required String title, required String body, required String channelId, required String payload}) async {
    if (!_ready) return;
    final attention = channelId == PushChannels.orderAttention;
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          channelId,
          attention ? 'Rider and order alerts' : 'Order updates',
          importance: attention ? Importance.high : Importance.defaultImportance,
          priority: attention ? Priority.high : Priority.defaultPriority,
          icon: _icon,
        ),
      ),
      payload: payload,
    );
  }
}

/// Real [SystemSettings] backed by `MainActivity.kt`.
class MethodChannelSystemSettings implements SystemSettings {
  static const MethodChannel _channel = MethodChannel('site.kraveo.customer/system');

  @override
  Future<bool> openNotificationSettings() async {
    try {
      return await _channel.invokeMethod<bool>('openNotificationSettings') ?? false;
    } catch (_) {
      return false;
    }
  }
}
