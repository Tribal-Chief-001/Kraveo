import 'dart:async';

import 'package:customer_app/services/push/push_messaging.dart';

/// Shared, ordered record of what the push layer did, so tests can assert sequences
/// (e.g. the server is told before the local token is deleted).
class PushLog {
  final List<String> entries = [];
  void add(String e) => entries.add(e);
  int count(String prefix) => entries.where((e) => e.startsWith(prefix)).length;
}

class FakePushMessaging implements PushMessaging {
  FakePushMessaging({PushLog? log, this.initOk = true, this.tokenValue = 'tok-aaaaaaaaaaaaaaaaaaaaaaaa', this.permissionValue = PushPermission.granted, this.requestResult = PushPermission.granted})
      : log = log ?? PushLog();

  final PushLog log;
  bool initOk;
  bool throwOnInit = false;
  Completer<bool>? initGate;
  String? tokenValue;
  PushPermission permissionValue;
  PushPermission requestResult;
  PushMessage? initial;

  final StreamController<String> refreshes = StreamController<String>.broadcast(sync: true);
  final StreamController<PushMessage> foreground = StreamController<PushMessage>.broadcast(sync: true);
  final StreamController<PushMessage> opened = StreamController<PushMessage>.broadcast(sync: true);

  int initCalls = 0;
  int requestCalls = 0;

  @override
  Future<bool> initialize() async {
    initCalls++;
    log.add('init');
    if (throwOnInit) throw StateError('no play services');
    if (initGate != null) return initGate!.future;
    return initOk;
  }

  @override
  Future<PushPermission> permission() async => permissionValue;

  @override
  Future<PushPermission> requestPermission() async {
    requestCalls++;
    log.add('requestPermission');
    permissionValue = requestResult;
    return requestResult;
  }

  @override
  Future<String?> token() async => tokenValue;

  @override
  Stream<String> get tokenRefreshes => refreshes.stream;

  @override
  Future<void> deleteToken() async {
    log.add('deleteToken');
  }

  @override
  Stream<PushMessage> get foregroundMessages => foreground.stream;

  @override
  Stream<PushMessage> get openedMessages => opened.stream;

  @override
  Future<PushMessage?> initialMessage() async => initial;
}

class FakeLocalNotifier implements LocalNotifier {
  int initCalls = 0;
  String? launch;
  bool failShow = false;
  final List<({int id, String title, String body, String channelId, String payload})> shown = [];
  final StreamController<String?> tapController = StreamController<String?>.broadcast(sync: true);

  @override
  Future<void> initialize() async => initCalls++;

  @override
  Stream<String?> get taps => tapController.stream;

  @override
  Future<String?> launchPayload() async => launch;

  @override
  Future<void> show({required int id, required String title, required String body, required String channelId, required String payload}) async {
    if (failShow) throw StateError('show failed');
    shown.add((id: id, title: title, body: body, channelId: channelId, payload: payload));
  }
}

class FakeDeviceApi implements DeviceApi {
  FakeDeviceApi({PushLog? log}) : log = log ?? PushLog();

  final PushLog log;
  DeviceCallResult registerResult = DeviceCallResult.ok;
  DeviceCallResult unregisterResult = DeviceCallResult.ok;
  bool unregisterThrows = false;
  Completer<void>? registerGate;
  final List<({String token, String appVersion})> registered = [];
  final List<String> unregistered = [];

  @override
  Future<DeviceCallResult> register({required String token, required String appVersion}) async {
    log.add('register:$token');
    registered.add((token: token, appVersion: appVersion));
    if (registerGate != null) await registerGate!.future;
    return registerResult;
  }

  @override
  Future<DeviceCallResult> unregister(String token) async {
    log.add('unregister:$token');
    unregistered.add(token);
    if (unregisterThrows) throw StateError('network down');
    return unregisterResult;
  }
}

class FakeSystemSettings implements SystemSettings {
  /// False models Android 7-12 (no permission dialog exists).
  bool dialogAvailable = true;

  @override
  Future<bool> hasPermissionDialog() async => dialogAvailable;

  int opened = 0;
  @override
  Future<bool> openNotificationSettings() async {
    opened++;
    return true;
  }
}

/// The FCM `data` block for a customer event.
Map<String, dynamic> pushData(String event, {String orderId = 'order-1', String v = '1'}) => {'event': event, 'orderId': orderId, 'v': v};
