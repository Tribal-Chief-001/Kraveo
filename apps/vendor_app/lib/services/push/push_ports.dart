import 'push_message.dart';

/// Android notification channel ids. Part of the contract (Docs/18 section 5): never rename after release.
class PushChannels {
  /// IMPORTANCE_HIGH, bundled alarm sound, alarm audio usage, vibration, lock-screen public. NEW_ORDER goes here.
  static const String newOrders = 'new_orders';

  /// Default importance. Cancellations and other updates.
  static const String orderUpdates = 'order_updates';

  /// `res/raw/new_order_alarm` (no extension).
  static const String alarmSoundResource = 'new_order_alarm';
}

/// Firebase Cloud Messaging, as the app sees it. The real one wraps Firebase; tests use a fake so nothing
/// ever touches Firebase.
abstract class PushMessaging {
  /// Starts Firebase and registers the background handler. Returns false (never throws) when Firebase is
  /// unavailable (bad config, no Play Services): the app then works on sockets and polling only.
  Future<bool> initialize();

  /// The device's FCM token, or null when there is none.
  Future<String?> getToken();

  Stream<String> get onTokenRefresh;

  /// Forgets this device's token (on logout), so the next login gets a fresh one.
  Future<void> deleteToken();

  /// A push that arrived while the app is in the foreground.
  Stream<PushMessage> get onForegroundMessage;

  /// The user tapped a push notification while the app was in the background.
  Stream<PushMessage> get onOpenedFromBackground;

  /// The push notification whose tap started the app from closed (once), if any.
  Future<PushMessage?> getInitialMessage();
}

/// Notifications the app builds itself (alarm for a data-only push, taps on them).
abstract class AlarmNotifications {
  /// Creates the channels. Safe to call again.
  Future<void> initialize();

  /// Payloads of taps on notifications this app built, while it is running.
  Stream<PushMessage> get onTap;

  /// The tap that started the app from closed, if the app was started by one of its own notifications.
  Future<PushMessage?> launchTap();

  /// The loud full-screen "new order" notification on [PushChannels.newOrders]. One per order (a repeat replaces it).
  Future<void> showNewOrder(String orderId, {String? title, String? body});

  /// A quiet update on [PushChannels.orderUpdates] (an order was cancelled).
  Future<void> showUpdate(String orderId, {required String title, required String body});

  Future<void> cancelOrder(String orderId);
}

enum NotificationAccess {
  granted,

  /// Not allowed yet, but the system can still ask.
  denied,

  /// Switched off for good: only the system settings can turn it on.
  blocked,
}

abstract class PushPermissions {
  Future<NotificationAccess> notificationAccess();

  /// Shows the system dialog. Returns the access after the answer.
  Future<NotificationAccess> requestNotifications();

  /// Opens this app's system settings page.
  Future<void> openSettings();

  /// True when Android does not restrict this app's battery use.
  Future<bool> batteryUnrestricted();

  /// Asks Android (system dialog) to stop restricting battery use. Returns whether it is allowed now.
  Future<bool> requestBatteryUnrestricted();
}

enum RegisterOutcome {
  ok,

  /// 401: the session is gone. The session gate handles it; nothing to retry.
  unauthorized,

  /// The server said no (4xx other than 401). Retrying will not help.
  rejected,

  /// Network, timeout or 5xx: try again later.
  failed,
}

/// `POST /devices` and `DELETE /devices` (Docs/18 section 3).
abstract class DeviceRegistry {
  Future<RegisterOutcome> register({required String token, required String appVersion});

  /// Best effort. Never throws.
  Future<void> unregister(String token);
}
