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
  });

  final String userId;

  /// The account holder's name (the owner / manager).
  final String name;
  final String? phone;
  final int? avatarId;
  final String? vendorId;
  final String? vendorName;
  final bool? isAcceptingOrders;

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
    final vendor = json['vendor'];
    if (vendor is! Map) return base;
    return PartnerSession(
      userId: base.userId,
      name: base.name,
      phone: base.phone,
      avatarId: base.avatarId,
      vendorId: vendor['id']?.toString(),
      vendorName: vendor['name']?.toString(),
      isAcceptingOrders: vendor['isAcceptingOrders'] is bool ? vendor['isAcceptingOrders'] as bool : null,
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
      );

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'name': name,
        'phone': phone,
        'avatarId': avatarId,
        'vendorId': vendorId,
        'vendorName': vendorName,
        'isAcceptingOrders': isAcceptingOrders,
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
    );
  }
}
