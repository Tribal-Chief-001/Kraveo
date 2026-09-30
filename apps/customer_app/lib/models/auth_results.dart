// Typed outcomes of the auth endpoints, so screens never parse HTTP themselves.

/// Base for every auth call: what happened and what we can tell the user.
abstract class ApiOutcome {
  const ApiOutcome({
    required this.success,
    this.message,
    this.statusCode,
    this.networkError = false,
    this.retryAfterSeconds,
  });

  final bool success;

  /// Server message when it sent one (already user-safe), otherwise null.
  final String? message;
  final int? statusCode;

  /// True when the request never got an HTTP answer (offline, DNS, timeout).
  final bool networkError;

  /// Seconds until a rate-limited (429) action may be retried.
  final int? retryAfterSeconds;

  bool get rateLimited => statusCode == 429;

  /// 502 / 503: an upstream (SMS gateway, database) is down.
  bool get unavailable => statusCode == 502 || statusCode == 503;
}

class SendOtpResult extends ApiOutcome {
  const SendOtpResult({
    required super.success,
    super.message,
    super.statusCode,
    super.networkError,
    super.retryAfterSeconds,
    this.resendAfterSeconds = 30,
    this.expiresInSeconds = 300,
  });

  final int resendAfterSeconds;
  final int expiresInSeconds;
}

class VerifyOtpResult extends ApiOutcome {
  const VerifyOtpResult({
    required super.success,
    super.message,
    super.statusCode,
    super.networkError,
    super.retryAfterSeconds,
    this.attemptsLeft,
    this.token,
    this.user,
    this.isNewUser = false,
    this.needsProfile = false,
  });

  final int? attemptsLeft;
  final String? token;
  final Map<String, dynamic>? user;
  final bool isNewUser;
  final bool needsProfile;

  /// 403: this number belongs to a different Kraveo app (vendor / driver).
  bool get roleNotAllowed => statusCode == 403;

  /// 429 after too many wrong tries.
  bool get locked => rateLimited;
}

/// GET / PUT /auth/profile.
class ProfileResult extends ApiOutcome {
  const ProfileResult({
    required super.success,
    super.message,
    super.statusCode,
    super.networkError,
    this.user,
    this.needsProfile = false,
    this.field,
  });

  final Map<String, dynamic>? user;
  final bool needsProfile;

  /// Which input the server rejected: 'name' or 'hostelBlock'.
  final String? field;

  /// 401: the stored token is expired or invalid.
  bool get unauthorized => statusCode == 401;
}

/// POST /auth/logout and DELETE /auth/account.
class ActionResult extends ApiOutcome {
  const ActionResult({
    required super.success,
    super.message,
    super.statusCode,
    super.networkError,
  });

  bool get unauthorized => statusCode == 401;

  /// 409: an order is still in progress, so the account cannot be deleted yet.
  bool get conflict => statusCode == 409;
}
