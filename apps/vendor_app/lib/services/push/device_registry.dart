import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../vendor_api_service.dart';
import 'push_ports.dart';

/// Talks to the Kraveo API with the partner's JWT, like the rest of the app.
class HttpDeviceRegistry implements DeviceRegistry {
  const HttpDeviceRegistry({this.timeout = const Duration(seconds: 10)});

  final Duration timeout;

  @override
  Future<RegisterOutcome> register({required String token, required String appVersion}) async {
    final headers = await VendorApiService.getAuthHeaders();
    if (!headers.containsKey('Authorization')) return RegisterOutcome.unauthorized;
    final http.Response response;
    try {
      response = await http
          .post(
            Uri.parse('${ApiConfig.baseUrl}/devices'),
            headers: headers,
            body: jsonEncode({'token': token, 'app': 'VENDOR', 'platform': 'android', 'appVersion': appVersion}),
          )
          .timeout(timeout);
    } catch (_) {
      return RegisterOutcome.failed;
    }
    // Same session handling as every other authenticated call (401 -> login, 403 PARTNER_NOT_APPROVED -> status screen).
    VendorApiService.checkResponse(response);
    final status = response.statusCode;
    if (status >= 200 && status < 300) return RegisterOutcome.ok;
    if (status == 401) return RegisterOutcome.unauthorized;
    if (status == 408 || status == 429 || status >= 500) return RegisterOutcome.failed;
    return RegisterOutcome.rejected;
  }

  @override
  Future<void> unregister(String token) async {
    try {
      final headers = await VendorApiService.getAuthHeaders();
      if (!headers.containsKey('Authorization')) return;
      // Deliberately not passed through checkResponse: logging out must never trigger session-expiry handling.
      await http.delete(Uri.parse('${ApiConfig.baseUrl}/devices'), headers: headers, body: jsonEncode({'token': token})).timeout(timeout);
    } catch (_) {}
  }
}
