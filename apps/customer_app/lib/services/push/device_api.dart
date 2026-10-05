import 'package:flutter/foundation.dart';

import '../customer_api_service.dart';
import 'push_messaging.dart';

/// Real [DeviceApi]: the authenticated client every other customer call uses.
class HttpDeviceApi implements DeviceApi {
  const HttpDeviceApi();

  @override
  Future<DeviceCallResult> register({required String token, required String appVersion}) async {
    try {
      final r = await CustomerApiService.authorizedRequest(
        'POST',
        '/devices',
        body: {'token': token, 'app': 'CUSTOMER', 'platform': 'android', 'appVersion': appVersion},
      );
      if (r.statusCode == 401) return DeviceCallResult.unauthorized;
      return r.statusCode >= 200 && r.statusCode < 300 ? DeviceCallResult.ok : DeviceCallResult.failed;
    } catch (e) {
      debugPrint('[Push] device registration failed (will retry later): ${e.runtimeType}');
      return DeviceCallResult.failed;
    }
  }

  @override
  Future<DeviceCallResult> unregister(String token) async {
    try {
      final r = await CustomerApiService.authorizedRequest(
        'DELETE',
        '/devices',
        body: {'token': token},
        timeout: const Duration(seconds: 4),
        handleUnauthorized: false,
      );
      if (r.statusCode == 401) return DeviceCallResult.unauthorized;
      return r.statusCode >= 200 && r.statusCode < 300 ? DeviceCallResult.ok : DeviceCallResult.failed;
    } catch (e) {
      debugPrint('[Push] device removal failed (ignored): ${e.runtimeType}');
      return DeviceCallResult.failed;
    }
  }
}
