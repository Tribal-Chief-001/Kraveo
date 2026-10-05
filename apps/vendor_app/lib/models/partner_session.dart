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
    this.hasLocation,
    this.lat,
    this.lng,
    this.locationSource,
    this.locationSetAt,
    this.locationAccuracyM,
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

  /// Does Kraveo have a real pin for this restaurant (riders navigate to it)? `null` = the server did not say
  /// (an older server that cannot store a location): the app then never nags, because it could not save one anyway.
  /// `false` = the server says there is no real pin yet, which is what makes the app ask for it.
  final bool? hasLocation;
  final double? lat;
  final double? lng;

  /// `DEVICE` (the restaurant detected it) or `ADMIN` (typed in the dashboard); null when unknown or not set.
  final String? locationSource;
  final DateTime? locationSetAt;

  /// How close the phone said the GPS fix was, in metres (only for a `DEVICE` pin).
  final double? locationAccuracyM;

  /// True only when the server explicitly says the restaurant has no pin yet.
  bool get needsLocation => hasLocation == false;

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
      hasLocation: vendor['hasLocation'] is bool ? vendor['hasLocation'] as bool : null,
      lat: _num(vendor['lat']),
      lng: _num(vendor['lng']),
      locationSource: vendor['locationSource'] is String ? vendor['locationSource'] as String : null,
      locationSetAt: _date(vendor['locationSetAt']),
      locationAccuracyM: _num(vendor['locationAccuracyM']),
    );
  }

  static double? _num(Object? raw) => raw is num && raw.isFinite ? raw.toDouble() : null;
  static DateTime? _date(Object? raw) => raw is String ? DateTime.tryParse(raw) : null;

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
        hasLocation: hasLocation,
        lat: lat,
        lng: lng,
        locationSource: locationSource,
        locationSetAt: locationSetAt,
        locationAccuracyM: locationAccuracyM,
      );

  /// The same restaurant after a successful `PUT /partner/vendor/location`.
  PartnerSession withLocation({required double lat, required double lng, String? source, DateTime? setAt, double? accuracyM}) => PartnerSession(
        userId: userId,
        name: name,
        phone: phone,
        avatarId: avatarId,
        vendorId: vendorId,
        vendorName: vendorName,
        isAcceptingOrders: isAcceptingOrders,
        approval: approval,
        rejectionReason: rejectionReason,
        category: category,
        address: address,
        fssaiNumber: fssaiNumber,
        hasLocation: true,
        lat: lat,
        lng: lng,
        locationSource: source ?? 'DEVICE',
        locationSetAt: setAt ?? DateTime.now().toUtc(),
        locationAccuracyM: accuracyM,
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
        hasLocation: hasLocation,
        lat: lat,
        lng: lng,
        locationSource: locationSource,
        locationSetAt: locationSetAt,
        locationAccuracyM: locationAccuracyM,
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
        'hasLocation': hasLocation,
        'lat': lat,
        'lng': lng,
        'locationSource': locationSource,
        'locationSetAt': locationSetAt?.toUtc().toIso8601String(),
        'locationAccuracyM': locationAccuracyM,
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
      hasLocation: raw['hasLocation'] is bool ? raw['hasLocation'] as bool : null,
      lat: _num(raw['lat']),
      lng: _num(raw['lng']),
      locationSource: raw['locationSource'] is String ? raw['locationSource'] as String : null,
      locationSetAt: _date(raw['locationSetAt']),
      locationAccuracyM: _num(raw['locationAccuracyM']),
    );
  }
}
