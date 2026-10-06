import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../config/api_config.dart';
import '../../models/payout_account.dart';
import '../../models/settlement.dart';
import '../failure_messages.dart';
import '../vendor_api_service.dart';
import '../vendor_backend.dart';

/// Payout details and settlements (Docs/21 section 5). Separate from [VendorBackend] like the location API, so the
/// order screens and their fakes stay as they are. Tests use a fake.
abstract class PayoutApi {
  /// `GET /api/partner/payout-account`. A restaurant that never saved details is a SUCCESS with `data == null`.
  Future<ApiResult<PayoutAccount?>> fetchAccount();

  /// `PUT /api/partner/payout-account`. Answers the masked account; the full number is never sent back.
  Future<ApiResult<SavedPayout>> saveAccount(PayoutInput input);

  /// `GET /api/partner/settlements?page&pageSize` (newest first, restaurant amounts only).
  Future<ApiResult<SettlementsPage>> fetchSettlements({int page = 1, int pageSize = 25});

  /// `GET /api/partner/settlements/:id`.
  Future<ApiResult<SettlementDetail>> fetchSettlement(String id);
}

/// Server code for "the server has no PAYOUT_ENC_KEY yet": bank accounts cannot be stored, UPI still works.
const String kPayoutEncryptionCode = 'PAYOUT_ENCRYPTION_NOT_CONFIGURED';

/// The text to show when saving or reading payout details failed.
FailureText payoutFailureText(ApiResult<Object?> r) {
  if (r.code == kPayoutEncryptionCode) {
    return const FailureText('Bank details cannot be saved right now. Use UPI, or try again later.', 'बैंक की जानकारी अभी सेव नहीं हो सकती। UPI इस्तेमाल करें या बाद में कोशिश करें');
  }
  final failure = r.failure!;
  final server = r.message?.trim() ?? '';
  switch (failure) {
    case ApiFailure.invalid:
      // The server's own sentence says exactly what is wrong ("Account number must be 6 to 20 digits.").
      if (server.isNotEmpty && server.length <= 200) return FailureText(server, 'जानकारी जाँचकर फिर कोशिश करें');
      return const FailureText('Kraveo did not accept these details. Please check them.', 'Kraveo ने ये जानकारी नहीं ली, जाँचें');
    case ApiFailure.notFound:
      return const FailureText('Payout details are not available on this server yet. Please try again later.', 'पेआउट की जानकारी अभी उपलब्ध नहीं है, बाद में कोशिश करें');
    case ApiFailure.forbidden:
    case ApiFailure.notApproved:
      return const FailureText('Your restaurant account cannot do this right now. Please contact Kraveo.', 'अभी यह नहीं हो सकता, Kraveo से संपर्क करें');
    case ApiFailure.server:
      return const FailureText('Kraveo had a problem. Try again in a moment.', 'सर्वर में दिक्कत, थोड़ी देर में कोशिश करें');
    default:
      return failureText(failure, serverMessage: r.message, code: r.code);
  }
}

/// The text to show when the settlements could not be read.
FailureText settlementFailureText(ApiResult<Object?> r) {
  final failure = r.failure!;
  if (failure == ApiFailure.notFound) {
    return const FailureText('This payout is not available.', 'यह भुगतान उपलब्ध नहीं है');
  }
  return payoutFailureText(r);
}

class HttpPayoutApi implements PayoutApi {
  HttpPayoutApi({http.Client? client, this.timeout = const Duration(seconds: 12)}) : _client = client;

  final http.Client? _client;
  final Duration timeout;

  Future<ApiResult<Object?>> _send(String method, String path, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('${ApiConfig.baseUrl}$path');
    final headers = await VendorApiService.getAuthHeaders();
    final http.Response response;
    try {
      final client = _client;
      final Future<http.Response> call = switch (method) {
        'GET' => client != null ? client.get(uri, headers: headers) : http.get(uri, headers: headers),
        'PUT' => client != null ? client.put(uri, headers: headers, body: jsonEncode(body ?? const {})) : http.put(uri, headers: headers, body: jsonEncode(body ?? const {})),
        _ => throw ArgumentError(method),
      };
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
    if (status >= 200 && status < 300) return ApiResult.success(json);
    final failure = switch (status) {
      400 || 422 => ApiFailure.invalid,
      401 => ApiFailure.unauthorized,
      403 => code == 'PARTNER_NOT_APPROVED' ? ApiFailure.notApproved : ApiFailure.forbidden,
      404 => ApiFailure.notFound,
      409 || 423 => ApiFailure.conflict,
      429 => ApiFailure.rateLimited,
      _ => ApiFailure.server, // includes 503 PAYOUT_ENCRYPTION_NOT_CONFIGURED (told apart by its code)
    };
    return ApiResult.failure(failure, message: message, code: code, statusCode: status);
  }

  @override
  Future<ApiResult<PayoutAccount?>> fetchAccount() async {
    final res = await _send('GET', '/partner/payout-account');
    if (!res.ok) return res.cast();
    final json = res.data;
    if (json is! Map || !json.containsKey('data')) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable payout details');
    final data = json['data'];
    if (data == null) return const ApiResult.success(null); // nothing saved yet
    final account = PayoutAccount.fromJson(data);
    if (account == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable payout details');
    return ApiResult.success(account);
  }

  @override
  Future<ApiResult<SavedPayout>> saveAccount(PayoutInput input) async {
    final res = await _send('PUT', '/partner/payout-account', body: input.toJson());
    if (!res.ok) return res.cast();
    final json = res.data;
    final account = PayoutAccount.fromJson(json is Map ? json['data'] : null);
    if (account == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable payout details');
    final map = json as Map;
    return ApiResult.success(SavedPayout(account: account, changed: map['changed'] != false, message: map['message'] is String ? map['message'] as String : null));
  }

  @override
  Future<ApiResult<SettlementsPage>> fetchSettlements({int page = 1, int pageSize = 25}) async {
    final res = await _send('GET', '/partner/settlements?page=$page&pageSize=$pageSize');
    if (!res.ok) return res.cast();
    final json = res.data;
    final raw = json is Map && json['data'] is List ? json['data'] as List : null;
    if (raw == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable settlements');
    final items = <Settlement>[];
    var skipped = 0;
    for (final e in raw) {
      final s = Settlement.fromJson(e);
      if (s == null) {
        skipped++;
      } else {
        items.add(s);
      }
    }
    final map = json as Map;
    int whole(String key, int fallback) => map[key] is num ? (map[key] as num).toInt() : fallback;
    return ApiResult.success(SettlementsPage(items: items, page: whole('page', page), pages: whole('pages', 1), total: whole('total', items.length), skipped: skipped));
  }

  @override
  Future<ApiResult<SettlementDetail>> fetchSettlement(String id) async {
    final res = await _send('GET', '/partner/settlements/${Uri.encodeComponent(id)}');
    if (!res.ok) return res.cast();
    final json = res.data;
    final detail = SettlementDetail.fromJson(json is Map ? json['data'] : null);
    if (detail == null) return const ApiResult.failure(ApiFailure.server, message: 'Unreadable settlement');
    return ApiResult.success(detail);
  }
}
