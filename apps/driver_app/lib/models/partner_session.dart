/// Who is signed in: the basics the login / profile endpoints return.
/// Never contains the JWT (that lives in DriverApiService) or a password.
class PartnerSession {
  const PartnerSession({
    required this.userId,
    required this.name,
    this.phone,
    this.avatarId,
    this.driverId,
    this.runnerCode,
  });

  final String userId;
  final String name;
  final String? phone;
  final int? avatarId;
  final String? driverId;

  /// The rider's public code (shown on the runner pass), e.g. "RUN-8042".
  final String? runnerCode;

  /// First name for greetings; falls back to the whole name.
  String get firstName {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    return parts.isEmpty ? 'Runner' : parts.first;
  }

  /// Parses the `POST /auth/partner-login` body (`user` plus optional `driver`).
  /// Returns null when the body has no usable user.
  static PartnerSession? fromLoginJson(Map<String, dynamic> json) {
    final base = fromUserJson(json['user']);
    if (base == null) return null;
    final driver = json['driver'];
    if (driver is! Map) return base;
    return PartnerSession(
      userId: base.userId,
      name: base.name,
      phone: base.phone,
      avatarId: base.avatarId,
      driverId: driver['id']?.toString(),
      runnerCode: driver['runnerCode']?.toString(),
    );
  }

  /// Parses a contract `user` object.
  static PartnerSession? fromUserJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString();
    if (id == null || id.isEmpty) return null;
    final name = raw['name']?.toString().trim() ?? '';
    return PartnerSession(
      userId: id,
      name: name,
      phone: raw['phone']?.toString(),
      avatarId: raw['avatarId'] is num ? (raw['avatarId'] as num).toInt() : null,
    );
  }

  /// Fresh account fields from `GET /auth/profile`, keeping the driver details that only the
  /// login response carries.
  PartnerSession withUserFrom(PartnerSession fresh) => PartnerSession(
        userId: fresh.userId,
        name: fresh.name,
        phone: fresh.phone,
        avatarId: fresh.avatarId,
        driverId: driverId,
        runnerCode: runnerCode,
      );

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'name': name,
        'phone': phone,
        'avatarId': avatarId,
        'driverId': driverId,
        'runnerCode': runnerCode,
      };

  static PartnerSession? fromStoredJson(Object? raw) {
    if (raw is! Map) return null;
    final userId = raw['userId']?.toString();
    if (userId == null || userId.isEmpty) return null;
    return PartnerSession(
      userId: userId,
      name: raw['name']?.toString() ?? '',
      phone: raw['phone']?.toString(),
      avatarId: raw['avatarId'] is num ? (raw['avatarId'] as num).toInt() : null,
      driverId: raw['driverId']?.toString(),
      runnerCode: raw['runnerCode']?.toString(),
    );
  }
}
