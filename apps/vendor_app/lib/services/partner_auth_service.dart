import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/partner_session.dart';

/// The role this app signs in as. The backend rejects a phone registered under another role.
const String kPartnerRole = 'VENDOR';

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

  /// Account basics from the server (no vendor details) when [outcome] is valid.
  final PartnerSession? session;
}

/// What the restaurant fills in when it creates an account (and when it updates a rejected application).
class PartnerSignupForm {
  const PartnerSignupForm({
    required this.ownerName,
    required this.phone,
    required this.password,
    required this.restaurantName,
    required this.address,
    this.category = '',
    this.fssaiNumber = '',
  });

  final String ownerName;
  final String phone;
  final String password;
  final String restaurantName;
  final String address;
  final String category;
  final String fssaiNumber;

  /// Body for `POST /auth/partner-signup`.
  Map<String, dynamic> toSignupJson() => {
        'role': kPartnerRole,
        'name': ownerName,
        'phone': phone,
        'password': password,
        'restaurantName': restaurantName,
        'category': category,
        'address': address,
        'fssaiNumber': fssaiNumber,
      };

  /// Body for `PUT /partner/application` (phone and password cannot change there).
  Map<String, dynamic> toUpdateJson() => {
        'name': ownerName,
        'restaurantName': restaurantName,
        'category': category,
        'address': address,
        'fssaiNumber': fssaiNumber,
      };
}

enum SignupFailure { invalid, phoneTaken, rateLimited, unauthorized, offline, server }

/// Outcome of creating an account or re-sending an application.
class SignupResult {
  const SignupResult.success({this.token, required PartnerSession this.session})
      : failure = null,
        field = null,
        message = null;

  const SignupResult.failure(SignupFailure this.failure, {this.field, this.message})
      : token = null,
        session = null;

  /// Present for a new account (sign-up); null when an existing account re-sent its application.
  final String? token;
  final PartnerSession? session;
  final SignupFailure? failure;

  /// Which form field the server complained about (`restaurantName`, `phone`, ...), when it said.
  final String? field;
  final String? message;

  bool get ok => failure == null;
}

/// Network side of partner authentication. The session controller talks only to this
/// interface, so tests can drive every state with a fake.
abstract class PartnerAuthService {
  Future<LoginResult> login({required String phone, required String password});

  /// Validates a stored token and returns the account with its approval state (`GET /partner/me`).
  Future<ProfileResult> fetchProfile(String token);

  /// Creates a restaurant account; it starts out pending approval (`POST /auth/partner-signup`).
  Future<SignupResult> signUp(PartnerSignupForm form);

  /// Fixes and re-sends an application that is pending or was rejected (`PUT /partner/application`).
  Future<SignupResult> resubmit(String token, PartnerSignupForm form);

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
  Future<SignupResult> signUp(PartnerSignupForm form) async {
    final http.Response response;
    try {
      response = await http
          .post(
            Uri.parse('${ApiConfig.baseUrl}/auth/partner-signup'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode(form.toSignupJson()),
          )
          .timeout(_loginTimeout);
    } catch (_) {
      return const SignupResult.failure(SignupFailure.offline);
    }
    return _signupResult(response, expectToken: true);
  }

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async {
    final http.Response response;
    try {
      response = await http
          .put(
            Uri.parse('${ApiConfig.baseUrl}/partner/application'),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
            body: jsonEncode(form.toUpdateJson()),
          )
          .timeout(_loginTimeout);
    } catch (_) {
      return const SignupResult.failure(SignupFailure.offline);
    }
    return _signupResult(response, expectToken: false);
  }

  SignupResult _signupResult(http.Response response, {required bool expectToken}) {
    final json = _decode(response.body);
    final message = json?['message'] is String ? json!['message'] as String : null;
    final field = json?['field'] is String ? json!['field'] as String : null;
    switch (response.statusCode) {
      case 200:
      case 201:
        final session = json == null ? null : PartnerSession.fromMeJson(json);
        final token = json?['token'];
        if (session == null) return const SignupResult.failure(SignupFailure.server);
        if (expectToken && (token is! String || token.isEmpty)) return const SignupResult.failure(SignupFailure.server);
        return SignupResult.success(token: token is String ? token : null, session: session);
      case 400:
        return SignupResult.failure(SignupFailure.invalid, field: field, message: message);
      case 401:
        return const SignupResult.failure(SignupFailure.unauthorized);
      case 409:
        return SignupResult.failure(field == 'phone' ? SignupFailure.phoneTaken : SignupFailure.invalid, field: field, message: message);
      case 429:
        return SignupResult.failure(SignupFailure.rateLimited, message: message);
      default:
        return const SignupResult.failure(SignupFailure.server);
    }
  }

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    try {
      final response = await http.get(
        Uri.parse('${ApiConfig.baseUrl}/partner/me'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 10));
      if (response.statusCode == 401) return const ProfileResult(ProfileOutcome.unauthorized);
      if (response.statusCode != 200) return const ProfileResult(ProfileOutcome.unreachable);
      final json = _decode(response.body);
      final session = json == null ? null : PartnerSession.fromMeJson(json);
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
