import 'package:permission_handler/permission_handler.dart';
import 'push_ports.dart';

/// Android runtime permissions through permission_handler. Nothing here asks by itself: the controller decides
/// when, after explaining why.
class SystemPushPermissions implements PushPermissions {
  const SystemPushPermissions();

  static NotificationAccess _map(PermissionStatus s) {
    switch (s) {
      case PermissionStatus.granted:
      case PermissionStatus.limited:
      case PermissionStatus.provisional:
        return NotificationAccess.granted;
      case PermissionStatus.permanentlyDenied:
      case PermissionStatus.restricted:
        return NotificationAccess.blocked;
      case PermissionStatus.denied:
        return NotificationAccess.denied;
    }
  }

  @override
  Future<NotificationAccess> notificationAccess() async {
    try {
      return _map(await Permission.notification.status);
    } catch (_) {
      return NotificationAccess.denied;
    }
  }

  @override
  Future<NotificationAccess> requestNotifications() async {
    try {
      return _map(await Permission.notification.request());
    } catch (_) {
      return NotificationAccess.denied;
    }
  }

  @override
  Future<void> openSettings() async {
    try {
      await openAppSettings();
    } catch (_) {}
  }

  @override
  Future<bool> batteryUnrestricted() async {
    try {
      return await Permission.ignoreBatteryOptimizations.isGranted;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> requestBatteryUnrestricted() async {
    try {
      return (await Permission.ignoreBatteryOptimizations.request()).isGranted;
    } catch (_) {
      return false;
    }
  }
}
