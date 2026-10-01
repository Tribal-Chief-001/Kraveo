/// Where this restaurant stands with Kraveo. New accounts are [pending] until an admin decides.
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
/// Never contains the JWT (that lives in VendorApiService) or a password.
class PartnerSession {
  const PartnerSession({
    required this.userId,
    required this.name,
    this.phone,
    this.avatarId,
    this.vendorId,
    this.vendorName,
    this.isAcceptingOrders,
    this.approval = PartnerApproval.approved,
    this.rejectionReason,
    this.category,
    this.address,
    this.fssaiNumber,
  });

  final String userId;

  /// The account holder's name (the owner / manager).
  final String name;
  final String? phone;
  final int? avatarId;
  final String? vendorId;
  final String? vendorName;
  final bool? isAcceptingOrders;

  /// Admin decision. Everything except [PartnerApproval.approved] keeps the partner out of the work screens.
  final PartnerApproval approval;

  /// The admin's reason when the application was rejected or the account suspended.
  final String? rejectionReason;

  /// What the restaurant told us when it applied (used to prefill "update details").
  final String? category;
  final String? address;
  final String? fssaiNumber;

  bool get isApproved => approval == PartnerApproval.approved;

  /// What to show as the restaurant's name: the vendor record, else the account name.
  String get restaurantName {
    final v = vendorName?.trim() ?? '';
    return v.isNotEmpty ? v : name;
  }

  /// Parses the `POST /auth/partner-login` body (`user` plus optional `vendor`).
  /// Returns null when the body has no usable user.
  static PartnerSession? fromLoginJson(Map<String, dynamic> json) {
    final base = fromUserJson(json['user']);
    if (base == null) return null;
    final approval = PartnerApproval.parse(json['approvalStatus']);
    final reason = json['rejectionReason']?.toString();
    final vendor = json['vendor'];
    if (vendor is! Map) return base.copyWith(approval: approval, rejectionReason: reason);
    return PartnerSession(
      userId: base.userId,
      name: base.name,
      phone: base.phone,
      avatarId: base.avatarId,
      vendorId: vendor['id']?.toString(),
      vendorName: vendor['name']?.toString(),
      isAcceptingOrders: vendor['isAcceptingOrders'] is bool ? vendor['isAcceptingOrders'] as bool : null,
      approval: approval,
      rejectionReason: reason,
      category: vendor['category']?.toString(),
      address: vendor['address']?.toString(),
      fssaiNumber: vendor['fssaiNumber']?.toString(),
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
        vendorId: vendorId,
        vendorName: vendorName,
        isAcceptingOrders: isAcceptingOrders,
        approval: approval ?? this.approval,
        rejectionReason: clearReason ? null : (rejectionReason ?? this.rejectionReason),
        category: category,
        address: address,
        fssaiNumber: fssaiNumber,
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

  /// Fresh account fields from `GET /auth/profile`, keeping the vendor details that only the
  /// login response carries.
  PartnerSession withUserFrom(PartnerSession fresh) => PartnerSession(
        userId: fresh.userId,
        name: fresh.name,
        phone: fresh.phone,
        avatarId: fresh.avatarId,
        vendorId: vendorId,
        vendorName: vendorName,
        isAcceptingOrders: isAcceptingOrders,
        approval: approval,
        rejectionReason: rejectionReason,
        category: category,
        address: address,
        fssaiNumber: fssaiNumber,
      );

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'name': name,
        'phone': phone,
        'avatarId': avatarId,
        'vendorId': vendorId,
        'vendorName': vendorName,
        'isAcceptingOrders': isAcceptingOrders,
        'approval': approval.name,
        'rejectionReason': rejectionReason,
        'category': category,
        'address': address,
        'fssaiNumber': fssaiNumber,
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
      vendorId: raw['vendorId']?.toString(),
      vendorName: raw['vendorName']?.toString(),
      isAcceptingOrders: raw['isAcceptingOrders'] is bool ? raw['isAcceptingOrders'] as bool : null,
      approval: PartnerApproval.parse(raw['approval']),
      rejectionReason: raw['rejectionReason']?.toString(),
      category: raw['category']?.toString(),
      address: raw['address']?.toString(),
      fssaiNumber: raw['fssaiNumber']?.toString(),
    );
  }
}
