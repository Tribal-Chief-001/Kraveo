/// Where this rider stands with Kraveo. New accounts are [pending] until an admin decides.
enum PartnerApproval {
  pending,
  approved,
  rejected,
  suspended;

  /// Tolerant parser for the backend's `approvalStatus`. Unknown or missing means approved,
  /// so accounts created before approvals existed keep working.
  static PartnerApproval parse(Object? raw) {
    switch (raw?.toString().toUpperCase()) {
      case 'PENDING':
        return PartnerApproval.pending;
      case 'REJECTED':
        return PartnerApproval.rejected;
      case 'SUSPENDED':
        return PartnerApproval.suspended;
      default:
        return PartnerApproval.approved;
    }
  }
}

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
    this.approval = PartnerApproval.approved,
    this.rejectionReason,
    this.vehicleType,
    this.vehicleRegNo,
    this.emergencyPhone,
    this.upiId,
  });

  final String userId;
  final String name;
  final String? phone;
  final int? avatarId;
  final String? driverId;

  /// The rider's public code (shown on the runner pass), e.g. "RUN-8042".
  final String? runnerCode;

  /// Admin decision. Everything except [PartnerApproval.approved] keeps the rider out of the work screens.
  final PartnerApproval approval;

  /// The admin's reason when the application was rejected or the account suspended.
  final String? rejectionReason;

  /// What the rider told us when applying (used to prefill "update details").
  final String? vehicleType;
  final String? vehicleRegNo;
  final String? emergencyPhone;
  final String? upiId;

  bool get isApproved => approval == PartnerApproval.approved;

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
    final approval = PartnerApproval.parse(json['approvalStatus']);
    final reason = json['rejectionReason']?.toString();
    final driver = json['driver'];
    if (driver is! Map) return base.copyWith(approval: approval, rejectionReason: reason);
    return PartnerSession(
      userId: base.userId,
      name: base.name,
      phone: base.phone,
      avatarId: base.avatarId,
      driverId: driver['id']?.toString(),
      runnerCode: driver['runnerCode']?.toString(),
      approval: approval,
      rejectionReason: reason,
      vehicleType: driver['vehicleType']?.toString(),
      vehicleRegNo: driver['vehicleRegNo']?.toString(),
      emergencyPhone: driver['emergencyPhone']?.toString(),
      upiId: driver['upiId']?.toString(),
    );
  }

  /// Parses `GET /partner/me`, `POST /auth/partner-signup` and `PUT /partner/application`
  /// (all share the same shape). Returns null when the body has no usable user.
  static PartnerSession? fromMeJson(Map<String, dynamic> json) => fromLoginJson(json);

  PartnerSession copyWith({PartnerApproval? approval, String? rejectionReason, bool clearReason = false}) => PartnerSession(
        userId: userId,
        name: name,
        phone: phone,
        avatarId: avatarId,
        driverId: driverId,
        runnerCode: runnerCode,
        approval: approval ?? this.approval,
        rejectionReason: clearReason ? null : (rejectionReason ?? this.rejectionReason),
        vehicleType: vehicleType,
        vehicleRegNo: vehicleRegNo,
        emergencyPhone: emergencyPhone,
        upiId: upiId,
      );

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
        approval: approval,
        rejectionReason: rejectionReason,
        vehicleType: vehicleType,
        vehicleRegNo: vehicleRegNo,
        emergencyPhone: emergencyPhone,
        upiId: upiId,
      );

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'name': name,
        'phone': phone,
        'avatarId': avatarId,
        'driverId': driverId,
        'runnerCode': runnerCode,
        'approval': approval.name,
        'rejectionReason': rejectionReason,
        'vehicleType': vehicleType,
        'vehicleRegNo': vehicleRegNo,
        'emergencyPhone': emergencyPhone,
        'upiId': upiId,
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
      approval: PartnerApproval.parse(raw['approval']),
      rejectionReason: raw['rejectionReason']?.toString(),
      vehicleType: raw['vehicleType']?.toString(),
      vehicleRegNo: raw['vehicleRegNo']?.toString(),
      emergencyPhone: raw['emergencyPhone']?.toString(),
      upiId: raw['upiId']?.toString(),
    );
  }
}
