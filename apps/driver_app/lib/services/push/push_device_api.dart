import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../driver_api_service.dart';

/// Outcome of a `/devices` call.
enum DeviceCallResult {
  ok,

  /// Network trouble or a server error: worth trying again later.
  retry,

  /// The server said no (4xx): trying again would not help.
  rejected,

  /// 401: the session handling in [DriverApiService] already took over; nothing to do here.
  unauthorized,
}

/// `POST /devices` and `DELETE /devices` (Docs/18, section 3).
abstract class PushDeviceApi {
  Future<DeviceCallResult> register({required String token, String? appVersion});
  Future<DeviceCallResult> unregister(String token);
}

class HttpPushDeviceApi implements PushDeviceApi {
  HttpPushDeviceApi({http.Client? client, this.timeout = const Duration(seconds: 8)}) : _client = client ?? http.Client();

  final http.Client _client;
  final Duration timeout;

  Uri get _url => Uri.parse('${ApiConfig.baseUrl}/devices');

  @override
  Future<DeviceCallResult> register({required String token, String? appVersion}) {
    return _send(() async => _client.post(
          _url,
          headers: await DriverApiService.getAuthHeaders(),
          body: jsonEncode({
            'token': token,
            'app': 'DRIVER',
            'platform': 'android',
            if (appVersion != null && appVersion.isNotEmpty) 'appVersion': appVersion.length > 32 ? appVersion.substring(0, 32) : appVersion,
          }),
        ));
  }

  @override
  Future<DeviceCallResult> unregister(String token) {
    return _send(() async => _client.delete(
          _url,
          headers: await DriverApiService.getAuthHeaders(),
          body: jsonEncode({'token': token}),
        ));
  }

  Future<DeviceCallResult> _send(Future<http.Response> Function() call) async {
    try {
      final response = await call().timeout(timeout);
      DriverApiService.checkAuthResponse(response);
      final code = response.statusCode;
      if (code >= 200 && code < 300) return DeviceCallResult.ok;
      if (code == 401) return DeviceCallResult.unauthorized;
      if (code == 408 || code == 429 || code >= 500) return DeviceCallResult.retry;
      return DeviceCallResult.rejected;
    } catch (_) {
      return DeviceCallResult.retry;
    }
  }
}
