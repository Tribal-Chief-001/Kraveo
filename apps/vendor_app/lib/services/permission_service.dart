import 'package:permission_handler/permission_handler.dart';

class PermissionService {
  /// Prompts dhaba cook for Notification, Alarm, Audio, and Background permissions on app start.
  static Future<void> requestVendorPermissions() async {
    print('🔑 [Permission Engine] Requesting runtime Android system permissions for Vendor App...');

    try {
      // 1. Notification Permission (Android 13+)
      final notificationStatus = await Permission.notification.request();
      print('🔔 Notification Permission Status: $notificationStatus');

      // 2. Exact Alarm Permission (Android 12+)
      if (await Permission.scheduleExactAlarm.isDenied) {
        await Permission.scheduleExactAlarm.request();
      }

      // 3. System Alert Window (Overlays on lock screen)
      if (await Permission.systemAlertWindow.isDenied) {
        await Permission.systemAlertWindow.request();
      }

      // 4. Ignore Battery Optimizations (Prevents OS from killing audio alarm in background)
      if (await Permission.ignoreBatteryOptimizations.isDenied) {
        await Permission.ignoreBatteryOptimizations.request();
      }
    } catch (e) {
      print('⚠️ Permission Handler Notice: $e');
    }
  }
}
