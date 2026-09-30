import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/partner_session.dart';

/// The role this app signs in as. The backend rejects a phone registered under another role.
const String kPartnerRole = 'DRIVER';

enum LoginFailure { invalidCredentials, locked, wrongRole, offline, server }

class LoginResult {
  const LoginResult.success({required String this.token, required PartnerSession this.session})
      : failure = null,
        message = null,
        retryAfterSeconds = 0;

  const LoginResult.failure(LoginFailure this.failure, {this.message, this.retryAfterSeconds = 0})
      : token = null,
        session = null;

  final String? token;
  final PartnerSession? session;
  final LoginFailure? failure;

  /// Server-provided text (401 / 403 / 429) when there is one.
  final String? message;

  /// Seconds the phone stays locked (429 only).
  final int retryAfterSeconds;

  bool get ok => failure == null;
}

enum ProfileOutcome { valid, unauthorized, unreachable }

class ProfileResult {
  const ProfileResult(this.outcome, [this.session]);
  final ProfileOutcome outcome;

  /// Account basics from the server (no driver details) when [outcome] is valid.
  final PartnerSession? session;
}

/// Network side of partner authentication. The session controller talks only to this
/// interface, so tests can drive every state with a fake.
abstract class PartnerAuthService {
  Future<LoginResult> login({required String phone, required String password});

  /// Validates a stored token (`GET /auth/profile`).
  Future<ProfileResult> fetchProfile(String token);

  /// Best effort `POST /auth/logout`; never throws.
  Future<void> logout(String token);
}

class ApiPartnerAuthService implements PartnerAuthService {
  ApiPartnerAuthService();

  static const Duration _loginTimeout = Duration(seconds: 12);

  static Map<String, dynamic>? _decode(String body) {
    try {
      final decoded = jsonDecode(body);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<LoginResult> login({required String phone, required String password}) async {
    final http.Response response;
    try {
      response = await http
          .post(
            Uri.parse('${ApiConfig.baseUrl}/auth/partner-login'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'phone': phone, 'password': password, 'role': kPartnerRole}),
          )
          .timeout(_loginTimeout);
    } catch (_) {
      return const LoginResult.failure(LoginFailure.offline);
    }

    final json = _decode(response.body);
    final message = json?['message'] is String ? json!['message'] as String : null;
    switch (response.statusCode) {
      case 200:
        final token = json?['token'];
        final session = json == null ? null : PartnerSession.fromLoginJson(json);
        if (token is String && token.isNotEmpty && session != null) {
          return LoginResult.success(token: token, session: session);
        }
        return const LoginResult.failure(LoginFailure.server);
      case 400:
      case 401:
        return LoginResult.failure(LoginFailure.invalidCredentials, message: message);
      case 403:
        return LoginResult.failure(LoginFailure.wrongRole, message: message);
      case 429:
        final raw = json?['retryAfterSeconds'];
        final seconds = raw is num ? raw.toInt() : 0;
        return LoginResult.failure(LoginFailure.locked, message: message, retryAfterSeconds: seconds < 1 ? 60 : seconds);
      default:
        return const LoginResult.failure(LoginFailure.server);
    }
  }

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    try {
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/auth/profile'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 10));
      if (response.statusCode == 401) return const ProfileResult(ProfileOutcome.unauthorized);
      if (response.statusCode != 200) return const ProfileResult(ProfileOutcome.unreachable);
      final json = _decode(response.body);
      final session = PartnerSession.fromUserJson(json?['user']);
      if (session == null) return const ProfileResult(ProfileOutcome.unreachable);
      // A token that belongs to another role must not open this app.
      final role = (json!['user'] as Map)['role']?.toString();
      if (role != null && role != kPartnerRole) return const ProfileResult(ProfileOutcome.unauthorized);
      return ProfileResult(ProfileOutcome.valid, session);
    } catch (_) {
      return const ProfileResult(ProfileOutcome.unreachable);
    }
  }

  @override
  Future<void> logout(String token) async {
    try {
      await http.post(
        Uri.parse('${ApiConfig.baseUrl}/auth/logout'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 4));
    } catch (_) {}
  }
}
