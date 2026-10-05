import 'dart:async';

/// Notification permission as the app needs it (Android 13+ `POST_NOTIFICATIONS`; older
/// versions are always granted unless the student switched notifications off in settings).
enum PushPermission { granted, denied }

/// One incoming FCM message, reduced to what the app uses.
class PushMessage {
  const PushMessage({this.messageId, this.data = const {}, this.title, this.body});

  final String? messageId;
  final Map<String, dynamic> data;
  final String? title;
  final String? body;
}

/// Thin seam over Firebase Cloud Messaging so the push logic can be tested without Firebase.
/// The real implementation is `FirebasePushMessaging`; tests inject a fake.
abstract class PushMessaging {
  /// Starts Firebase. Returns false (never throws) when it is unavailable.
  Future<bool> initialize();

  Future<PushPermission> permission();
  Future<PushPermission> requestPermission();

  Future<String?> token();
  Stream<String> get tokenRefreshes;
  Future<void> deleteToken();

  /// Messages that arrive while the app is in the foreground (FCM shows no banner then).
  Stream<PushMessage> get foregroundMessages;

  /// The student tapped a system notification while the app was in the background.
  Stream<PushMessage> get openedMessages;

  /// The notification whose tap launched the app from a terminated state, if any.
  Future<PushMessage?> initialMessage();
}

/// Thin seam over `flutter_local_notifications`: channels, banners shown by the app itself,
/// and taps on them.
abstract class LocalNotifier {
  /// Creates the Android channels and initialises the plugin. Must not throw.
  Future<void> initialize();

  /// Payload of the local notification the student tapped while the app was running.
  Stream<String?> get taps;

  /// Payload of the local notification whose tap launched the app, if any.
  Future<String?> launchPayload();

  Future<void> show({required int id, required String title, required String body, required String channelId, required String payload});
}

/// Opens this app's notification settings in Android (used when notifications are blocked).
abstract class SystemSettings {
  Future<bool> openNotificationSettings();
}

/// Result of a call to `/devices`.
enum DeviceCallResult { ok, unauthorized, failed }

/// `POST /devices` and `DELETE /devices` (Docs/18 section 3).
abstract class DeviceApi {
  Future<DeviceCallResult> register({required String token, required String appVersion});
  Future<DeviceCallResult> unregister(String token);
}
