import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:geolocator/geolocator.dart';
import 'push_background.dart';
import 'push_messaging.dart';

/// Android channel ids. They are part of the contract (Docs/18, section 5) and must never change after release:
/// a channel's sound is fixed once created.
const String kNewDeliveriesChannelId = 'new_deliveries';
const String kOrderUpdatesChannelId = 'order_updates';

/// The real thing: Firebase Cloud Messaging + flutter_local_notifications (used only to create the channels).
/// Built in `main` only; tests use a fake [PushMessaging].
class FirebasePushMessaging implements PushMessaging {
  bool _ready = false;

  @override
  Future<bool> initialize() async {
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp().timeout(const Duration(seconds: 15));
      }
      FirebaseMessaging.onBackgroundMessage(kraveoDriverBackgroundMessageHandler);
      _ready = true;
    } catch (e) {
      _ready = false;
      debugPrint('Push is off: Firebase could not start (${e.runtimeType}). The app keeps working without it.');
    }
    return _ready;
  }

  @override
  Future<void> createChannels() async {
    try {
      final android = FlutterLocalNotificationsPlugin().resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android == null) return;
      await android.createNotificationChannel(AndroidNotificationChannel(
        kNewDeliveriesChannelId,
        'New deliveries',
        description: 'Alerts when a new delivery is waiting for you.',
        importance: Importance.high,
        playSound: true,
        sound: const RawResourceAndroidNotificationSound('new_delivery'),
        enableVibration: true,
        vibrationPattern: Int64List.fromList([0, 500, 250, 500, 250, 500]),
      ));
      await android.createNotificationChannel(const AndroidNotificationChannel(
        kOrderUpdatesChannelId,
        'Delivery updates',
        description: 'Changes to a delivery you are carrying.',
        importance: Importance.defaultImportance,
      ));
    } catch (e) {
      debugPrint('Push channels could not be created (${e.runtimeType}).');
    }
  }

  static PushPermission _map(AuthorizationStatus s) => switch (s) {
        AuthorizationStatus.authorized || AuthorizationStatus.provisional => PushPermission.granted,
        AuthorizationStatus.notDetermined => PushPermission.notDetermined,
        AuthorizationStatus.denied => PushPermission.denied,
        AuthorizationStatus.deniedPermanently => PushPermission.deniedPermanently,
      };

  @override
  Future<PushPermission> permission() async {
    if (!_ready) return PushPermission.unknown;
    try {
      return _map((await FirebaseMessaging.instance.getNotificationSettings()).authorizationStatus);
    } catch (_) {
      return PushPermission.unknown;
    }
  }

  @override
  Future<PushPermission> requestPermission() async {
    if (!_ready) return PushPermission.unknown;
    try {
      return _map((await FirebaseMessaging.instance.requestPermission()).authorizationStatus);
    } catch (_) {
      return permission();
    }
  }

  @override
  Future<void> openSettings() async {
    try {
      await Geolocator.openAppSettings();
    } catch (_) {}
  }

  @override
  Future<String?> getToken() async {
    if (!_ready) return null;
    try {
      return await FirebaseMessaging.instance.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh => _ready ? FirebaseMessaging.instance.onTokenRefresh : const Stream<String>.empty();

  @override
  Future<void> deleteToken() async {
    if (!_ready) return;
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }

  static PushIncoming _incoming(RemoteMessage m) => PushIncoming(messageId: m.messageId, data: Map<String, dynamic>.from(m.data));

  @override
  Stream<PushIncoming> get onForegroundMessage => _ready ? FirebaseMessaging.onMessage.map(_incoming) : const Stream<PushIncoming>.empty();

  @override
  Stream<PushIncoming> get onNotificationTap => _ready ? FirebaseMessaging.onMessageOpenedApp.map(_incoming) : const Stream<PushIncoming>.empty();

  @override
  Future<PushIncoming?> getInitialMessage() async {
    if (!_ready) return null;
    try {
      final m = await FirebaseMessaging.instance.getInitialMessage();
      return m == null ? null : _incoming(m);
    } catch (_) {
      return null;
    }
  }
}
