import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../models/payout_account.dart';
import '../driver_api_service.dart';
import '../rider_orders_api.dart';

/// Payout details of the rider (Docs/21 section 5): `GET/PUT /api/partner/payout-account`. Separate from the order API,
/// so the order screens and their fakes stay as they are. Tests use a fake.
abstract class PayoutApi {
  /// `GET /api/partner/payout-account`. A rider who never saved details is a SUCCESS with a null value.
  Future<ApiResult<PayoutAccount?>> fetchAccount();

  /// `PUT /api/partner/payout-account`. Answers the masked account; the full number is never sent back.
  Future<ApiResult<SavedPayout>> saveAccount(PayoutInput input);
}

/// Server code for "the server has no PAYOUT_ENC_KEY yet": bank accounts cannot be stored, UPI still works.
const String kPayoutEncryptionCode = 'PAYOUT_ENCRYPTION_NOT_CONFIGURED';

/// The plain-English text to show when reading or saving payout details failed.
String payoutFailureText(ApiResult<Object?> r) {
  if (r.code == kPayoutEncryptionCode) return 'Bank details cannot be saved right now. Use UPI, or try again later.';
  final server = r.message?.trim() ?? '';
  switch (r.failure!) {
    case ApiFailure.offline:
      return 'No internet. Check the connection and try again.';
    case ApiFailure.timeout:
      return 'Kraveo is slow to answer. Try again.';
    case ApiFailure.unauthorized:
      return 'Session expired. Please log in again.';
    case ApiFailure.notApproved:
    case ApiFailure.forbidden:
      return 'Your account cannot do this right now. Please contact Kraveo.';
    case ApiFailure.notFound:
      return 'Payout details are not available on this server yet. Please try again later.';
    case ApiFailure.rateLimited:
      return 'Too many tries. Wait a few seconds and try again.';
    case ApiFailure.badRequest:
      // The server's own sentence says exactly what is wrong ("Account number must be 6 to 20 digits.").
      if (server.isNotEmpty && server.length <= 200) return server;
      return 'Kraveo did not accept these details. Please check them.';
    case ApiFailure.conflict:
    case ApiFailure.locked:
    case ApiFailure.server:
    case ApiFailure.badResponse:
      return 'Kraveo had a problem. Try again in a moment.';
  }
}

class HttpPayoutApi implements PayoutApi {
  HttpPayoutApi({http.Client? client, String? baseUrl, this.timeout = const Duration(seconds: 12)})
      : _client = client,
        _base = baseUrl ?? ApiConfig.baseUrl;

  final http.Client? _client;
  final String _base;
  final Duration timeout;

  Future<ApiResult<Object?>> _send(String method, String path, {Map<String, dynamic>? body}) async {
    try {
      final uri = Uri.parse('$_base$path');
      final headers = await DriverApiService.getAuthHeaders();
      final client = _client;
      final Future<http.Response> call = switch (method) {
        'GET' => client != null ? client.get(uri, headers: headers) : http.get(uri, headers: headers),
        _ => client != null ? client.put(uri, headers: headers, body: jsonEncode(body ?? const {})) : http.put(uri, headers: headers, body: jsonEncode(body ?? const {})),
      };
      final res = await call.timeout(timeout);
      DriverApiService.checkAuthResponse(res);
      Object? json;
      try {
        json = res.body.isEmpty ? null : jsonDecode(res.body);
      } catch (_) {}
      if (res.statusCode >= 200 && res.statusCode < 300) return ApiResult.ok(json);
      final map = json is Map ? json : const {};
      final code = map['code']?.toString().toUpperCase();
      final message = map['message'] is String ? map['message'] as String : null;
      final status = res.statusCode;
      final ApiFailure kind;
      if (status == 401) {
        kind = ApiFailure.unauthorized;
      } else if (status == 403 && code == 'PARTNER_NOT_APPROVED') {
        kind = ApiFailure.notApproved;
      } else if (status == 403) {
        kind = ApiFailure.forbidden;
      } else if (status == 404) {
        kind = ApiFailure.notFound;
      } else if (status == 409 || status == 423) {
        kind = ApiFailure.conflict;
      } else if (status == 429) {
        kind = ApiFailure.rateLimited;
      } else if (status >= 400 && status < 500) {
        kind = ApiFailure.badRequest;
      } else {
        kind = ApiFailure.server; // includes 503 PAYOUT_ENCRYPTION_NOT_CONFIGURED (told apart by its code)
      }
      return ApiResult.fail(kind, statusCode: status, code: code, message: message);
    } on TimeoutException {
      return const ApiResult.fail(ApiFailure.timeout);
    } catch (_) {
      return const ApiResult.fail(ApiFailure.offline);
    }
  }

  static ApiResult<T> _carry<T>(ApiResult<Object?> r) => ApiResult.fail(r.failure, statusCode: r.statusCode, code: r.code, message: r.message);

  @override
  Future<ApiResult<PayoutAccount?>> fetchAccount() async {
    final r = await _send('GET', '/partner/payout-account');
    if (!r.ok) return _carry(r);
    final json = r.value;
    if (json is! Map || !json.containsKey('data')) return const ApiResult.fail(ApiFailure.badResponse);
    final data = json['data'];
    if (data == null) return const ApiResult.ok(null); // nothing saved yet
    final account = PayoutAccount.fromJson(data);
    return account == null ? const ApiResult.fail(ApiFailure.badResponse) : ApiResult.ok(account);
  }

  @override
  Future<ApiResult<SavedPayout>> saveAccount(PayoutInput input) async {
    final r = await _send('PUT', '/partner/payout-account', body: input.toJson());
    if (!r.ok) return _carry(r);
    final json = r.value;
    final account = PayoutAccount.fromJson(json is Map ? json['data'] : null);
    if (account == null) return const ApiResult.fail(ApiFailure.badResponse);
    final map = json as Map;
    return ApiResult.ok(SavedPayout(account: account, changed: map['changed'] != false, message: map['message'] is String ? map['message'] as String : null));
  }
}
