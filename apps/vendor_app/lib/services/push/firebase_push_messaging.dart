import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'push_background.dart';
import 'push_message.dart';
import 'push_ports.dart';

/// The real FCM connection. Only constructed in `main()`; tests use a fake [PushMessaging].
class FirebasePushMessaging implements PushMessaging {
  FirebaseMessaging? _fcm;
  bool _failedLogged = false;

  PushMessage _convert(RemoteMessage m) => PushMessage.fromData(
        m.data,
        hasNotificationBlock: m.notification != null,
        title: m.notification?.title,
        body: m.notification?.body,
      );

  /// FirebaseMessaging's static streams throw if Firebase never started; hand back an empty stream instead.
  Stream<RemoteMessage> _stream(Stream<RemoteMessage> source) => _fcm == null ? const Stream<RemoteMessage>.empty() : source;

  @override
  Future<bool> initialize() async {
    if (_fcm != null) return true;
    try {
      // Android reads the config the google-services plugin generated from google-services.json.
      await Firebase.initializeApp().timeout(const Duration(seconds: 15));
      FirebaseMessaging.onBackgroundMessage(kraveoVendorBackgroundHandler);
      _fcm = FirebaseMessaging.instance;
      return true;
    } catch (e) {
      if (!_failedLogged) {
        _failedLogged = true;
        debugPrint('[push] Firebase unavailable (${e.runtimeType}); orders still arrive by live connection and polling');
      }
      return false;
    }
  }

  @override
  Future<String?> getToken() async {
    try {
      return await _fcm?.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh => _fcm?.onTokenRefresh ?? const Stream<String>.empty();

  @override
  Future<void> deleteToken() async {
    try {
      await _fcm?.deleteToken();
    } catch (_) {}
  }

  @override
  Stream<PushMessage> get onForegroundMessage => _stream(FirebaseMessaging.onMessage).map(_convert);

  @override
  Stream<PushMessage> get onOpenedFromBackground => _stream(FirebaseMessaging.onMessageOpenedApp).map(_convert);

  @override
  Future<PushMessage?> getInitialMessage() async {
    try {
      final m = await _fcm?.getInitialMessage();
      return m == null ? null : _convert(m);
    } catch (_) {
      return null;
    }
  }
}
