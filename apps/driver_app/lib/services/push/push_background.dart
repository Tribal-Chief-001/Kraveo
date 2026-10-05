import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

/// Runs in a background isolate when a push arrives while the app is closed or in the background. The system shows
/// the notification itself (the message carries a `notification` block), so there is nothing to do here and, by
/// design, no UI or app state is touched. It only makes sure Firebase is usable in this isolate.
@pragma('vm:entry-point')
Future<void> kraveoDriverBackgroundMessageHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {}
}
