import 'dart:async';

/// The notification permission as the rider sees it.
enum PushPermission {
  /// Not asked yet / not known.
  unknown,
  granted,

  /// Never asked: the system prompt can still be shown.
  notDetermined,

  /// Said no, but the system prompt can be shown again.
  denied,

  /// Said no and the system will not ask again: only the phone settings can fix it.
  deniedPermanently;

  bool get isGranted => this == granted;

  /// Known and not allowed: the persistent warning banner is shown.
  bool get isBlocked => this == notDetermined || this == denied || this == deniedPermanently;
}

/// One push as the app sees it (the transport's message type never leaks past the real implementation).
class PushIncoming {
  const PushIncoming({this.messageId, this.data = const {}});

  final String? messageId;
  final Map<String, dynamic> data;
}

/// Everything the push layer needs from the phone: Firebase, the permission prompt, the channels. The real
/// implementation (`FirebasePushMessaging`) is built only in `main`; tests pass a fake, so no test ever touches Firebase.
abstract class PushMessaging {
  /// Starts Firebase defensively. Never throws; false means push is unavailable on this phone (bad config, no
  /// Play Services) and the app carries on with sockets and polling.
  Future<bool> initialize();

  /// Creates the Android channels (`new_deliveries`, `order_updates`). Never throws.
  Future<void> createChannels();

  Future<PushPermission> permission();

  /// Shows the system prompt where there is one, then returns the new state.
  Future<PushPermission> requestPermission();

  /// Opens this app's page in the phone settings.
  Future<void> openSettings();

  Future<String?> getToken();
  Stream<String> get onTokenRefresh;
  Future<void> deleteToken();

  /// A push that arrived while the app is open.
  Stream<PushIncoming> get onForegroundMessage;

  /// The rider tapped a notification while the app was in the background.
  Stream<PushIncoming> get onNotificationTap;

  /// The notification that launched the app from a killed state, once.
  Future<PushIncoming?> getInitialMessage();
}
