import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../failure_messages.dart';
import '../vendor_api_service.dart';
import '../vendor_backend.dart';

/// What `PUT /partner/vendor/location` answers with (`data`).
class SavedLocation {
  const SavedLocation({required this.lat, required this.lng, this.source, this.setAt, this.accuracyM});

  final double lat;
  final double lng;
  final String? source;
  final DateTime? setAt;
  final double? accuracyM;
}

/// Saves the restaurant's own pin. Tests use a fake.
abstract class VendorLocationApi {
  /// `PUT /api/partner/vendor/location` `{lat, lng, accuracyM?}` for the signed-in restaurant (the server never takes
  /// a restaurant id from the app).
  Future<ApiResult<SavedLocation>> save({required double lat, required double lng, double? accuracyM});
}

/// The text to show when a save failed: the server's own message when it sent one (it says exactly what is wrong,
/// e.g. "The location must be within 3 km of the campus."), else the standard bilingual wording.
String locationSaveFailureText(ApiResult<Object?> result) {
  final server = result.message?.trim() ?? '';
  final failure = result.failure!;
  if (server.isNotEmpty && server.length <= 200 && failure != ApiFailure.server && failure != ApiFailure.unauthorized) return server;
  return switch (failure) {
    ApiFailure.forbidden || ApiFailure.notApproved => 'Your restaurant account cannot save a location right now. Please call Kraveo.  ·  अभी लोकेशन सेव नहीं हो सकती, Kraveo को फ़ोन करें',
    ApiFailure.rateLimited => 'Too many tries. Please try again in a while.  ·  बहुत कोशिशें हो गईं, थोड़ी देर बाद फिर कोशिश करें',
    ApiFailure.notFound => 'This server cannot save a location yet. Please try again later.  ·  अभी लोकेशन सेव नहीं हो सकती, बाद में कोशिश करें',
    _ => failureText(failure, serverMessage: result.message, code: result.code).both,
  };
}

class HttpVendorLocationApi implements VendorLocationApi {
  HttpVendorLocationApi({http.Client? client, this.timeout = const Duration(seconds: 12)}) : _client = client;

  final http.Client? _client;
  final Duration timeout;

  @override
  Future<ApiResult<SavedLocation>> save({required double lat, required double lng, double? accuracyM}) async {
    final uri = Uri.parse('${ApiConfig.baseUrl}/partner/vendor/location');
    final headers = await VendorApiService.getAuthHeaders();
    final body = jsonEncode({
      'lat': lat,
      'lng': lng,
      if (accuracyM != null && accuracyM.isFinite) 'accuracyM': double.parse(accuracyM.toStringAsFixed(1)),
    });
    final http.Response response;
    try {
      final client = _client;
      final call = client != null ? client.put(uri, headers: headers, body: body) : http.put(uri, headers: headers, body: body);
      response = await call.timeout(timeout);
    } on TimeoutException {
      return const ApiResult.failure(ApiFailure.timeout);
    } catch (_) {
      return const ApiResult.failure(ApiFailure.offline);
    }
    VendorApiService.checkResponse(response);
    Object? json;
    try {
      json = response.body.isEmpty ? null : jsonDecode(response.body);
    } catch (_) {}
    final map = json is Map ? json : const {};
    final message = map['message'] is String ? map['message'] as String : null;
    final code = map['code'] is String ? map['code'] as String : null;
    final status = response.statusCode;
    if (status >= 200 && status < 300) {
      final data = map['data'] is Map ? map['data'] as Map : map;
      final dlat = data['lat'];
      final dlng = data['lng'];
      // A 2xx without readable coordinates is still a save; fall back to what was sent.
      return ApiResult.success(SavedLocation(
        lat: dlat is num ? dlat.toDouble() : lat,
        lng: dlng is num ? dlng.toDouble() : lng,
        source: data['locationSource'] is String ? data['locationSource'] as String : 'DEVICE',
        setAt: data['locationSetAt'] is String ? DateTime.tryParse(data['locationSetAt'] as String) : null,
        accuracyM: data['locationAccuracyM'] is num ? (data['locationAccuracyM'] as num).toDouble() : accuracyM,
      ));
    }
    final failure = switch (status) {
      400 || 422 => ApiFailure.invalid,
      401 => ApiFailure.unauthorized,
      403 => code == 'PARTNER_NOT_APPROVED' ? ApiFailure.notApproved : ApiFailure.forbidden,
      404 => ApiFailure.notFound,
      409 || 423 => ApiFailure.conflict,
      429 => ApiFailure.rateLimited,
      _ => ApiFailure.server,
    };
    return ApiResult.failure(failure, message: message, code: code, statusCode: status);
  }
}
