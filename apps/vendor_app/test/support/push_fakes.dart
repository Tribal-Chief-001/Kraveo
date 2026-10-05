import 'dart:async';
import 'package:vendor_app/services/push/push_message.dart';
import 'package:vendor_app/services/push/push_ports.dart';
import 'package:vendor_app/services/vendor_api_service.dart';

/// Everything that happened, in order, across the fakes (for order-of-calls assertions).
class PushLog {
  final List<String> events = [];
  void add(String e) => events.add(e);
}

class FakePushMessaging implements PushMessaging {
  FakePushMessaging({this.log});

  final PushLog? log;
  bool initOk = true;
  bool initThrows = false;
  String? token = 'fcm-token-1';
  PushMessage? initial;
  int initCalls = 0;
  int tokenCalls = 0;
  int deleteCalls = 0;

  final StreamController<String> refresh = StreamController<String>.broadcast();
  final StreamController<PushMessage> foreground = StreamController<PushMessage>.broadcast();
  final StreamController<PushMessage> opened = StreamController<PushMessage>.broadcast();

  @override
  Future<bool> initialize() async {
    initCalls++;
    if (initThrows) throw StateError('no Play Services');
    return initOk;
  }

  @override
  Future<String?> getToken() async {
    tokenCalls++;
    return token;
  }

  @override
  Stream<String> get onTokenRefresh => refresh.stream;

  @override
  Future<void> deleteToken() async {
    deleteCalls++;
    log?.add('deleteToken');
  }

  @override
  Stream<PushMessage> get onForegroundMessage => foreground.stream;

  @override
  Stream<PushMessage> get onOpenedFromBackground => opened.stream;

  @override
  Future<PushMessage?> getInitialMessage() async => initial;
}

class FakeNotifications implements AlarmNotifications {
  final List<String> shown = [];
  final StreamController<PushMessage> taps = StreamController<PushMessage>.broadcast();
  PushMessage? launch;
  int initCalls = 0;
  bool initThrows = false;

  @override
  Future<void> initialize() async {
    initCalls++;
    if (initThrows) throw StateError('channels failed');
  }

  @override
  Stream<PushMessage> get onTap => taps.stream;

  @override
  Future<PushMessage?> launchTap() async => launch;

  @override
  Future<void> showNewOrder(String orderId, {String? title, String? body}) async => shown.add('newOrder:$orderId');

  @override
  Future<void> showUpdate(String orderId, {required String title, required String body}) async => shown.add('update:$orderId');

  @override
  Future<void> cancelOrder(String orderId) async => shown.add('cancel:$orderId');
}

class FakePermissions implements PushPermissions {
  NotificationAccess access = NotificationAccess.granted;
  NotificationAccess afterRequest = NotificationAccess.granted;
  bool battery = false;
  bool batteryAfterRequest = true;
  int requests = 0;
  int settingsOpened = 0;
  int batteryRequests = 0;

  @override
  Future<NotificationAccess> notificationAccess() async => access;

  @override
  Future<NotificationAccess> requestNotifications() async {
    requests++;
    access = afterRequest;
    return access;
  }

  @override
  Future<void> openSettings() async => settingsOpened++;

  @override
  Future<bool> batteryUnrestricted() async => battery;

  @override
  Future<bool> requestBatteryUnrestricted() async {
    batteryRequests++;
    battery = batteryAfterRequest;
    return battery;
  }
}

class FakeRegistry implements DeviceRegistry {
  FakeRegistry({this.log});

  final PushLog? log;
  final List<({String token, String appVersion})> registered = [];
  final List<String> unregistered = [];

  /// Answers handed out first-in first-out; then [defaultOutcome].
  final List<RegisterOutcome> answers = [];
  RegisterOutcome defaultOutcome = RegisterOutcome.ok;
  bool unregisterThrows = false;

  /// What the saved JWT looked like at the moment of `DELETE /devices` (it must still be there).
  final List<String?> tokenDuringUnregister = [];

  @override
  Future<RegisterOutcome> register({required String token, required String appVersion}) async {
    registered.add((token: token, appVersion: appVersion));
    log?.add('register:$token');
    return answers.isNotEmpty ? answers.removeAt(0) : defaultOutcome;
  }

  @override
  Future<void> unregister(String token) async {
    tokenDuringUnregister.add(await VendorApiService.getSavedToken());
    unregistered.add(token);
    log?.add('unregister:$token');
    if (unregisterThrows) throw StateError('network down');
  }
}
