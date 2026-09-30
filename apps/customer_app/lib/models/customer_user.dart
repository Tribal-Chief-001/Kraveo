import 'package:kraveo_ui/kraveo_ui.dart' show kAvatarCount;

/// The signed-in student, as returned by /auth/google and /auth/profile.
class CustomerUser {
  const CustomerUser({
    required this.id,
    this.email,
    this.phone,
    this.name,
    this.role = 'STUDENT',
    this.isStudent,
    this.hostelBlock,
    this.avatarId,
    this.kraveoCoins = 0,
  });

  final String id;
  final String? email;

  /// Stored as `+91 XXXXXXXXXX` by the server; null until the student adds one.
  final String? phone;
  final String? name;
  final String role;

  /// null = not answered yet ("Are you a student?" is part of sign-up).
  final bool? isStudent;
  final String? hostelBlock;

  /// 1..[kAvatarCount]; null until chosen.
  final int? avatarId;
  final int kraveoCoins;

  static String? _clean(Object? raw) {
    final v = raw?.toString().trim();
    return v == null || v.isEmpty ? null : v;
  }

  factory CustomerUser.fromJson(Map<String, dynamic> json) {
    final coins = json['kraveoCoins'];
    final rawAvatar = json['avatarId'];
    final avatar = rawAvatar is num ? rawAvatar.round() : int.tryParse('${rawAvatar ?? ''}');
    final student = json['isStudent'];
    return CustomerUser(
      id: json['id']?.toString() ?? '',
      email: _clean(json['email']),
      phone: _clean(json['phone']),
      name: _clean(json['name']),
      role: json['role']?.toString() ?? 'STUDENT',
      isStudent: student is bool ? student : null,
      hostelBlock: _clean(json['hostelBlock']),
      avatarId: avatar != null && avatar >= 1 && avatar <= kAvatarCount ? avatar : null,
      kraveoCoins: coins is num ? coins.round() : int.tryParse('$coins') ?? 0,
    );
  }

  CustomerUser copyWith({
    String? name,
    String? phone,
    bool? isStudent,
    String? hostelBlock,
    bool clearHostelBlock = false,
    int? avatarId,
    int? kraveoCoins,
  }) =>
      CustomerUser(
        id: id,
        email: email,
        phone: phone ?? this.phone,
        name: name ?? this.name,
        role: role,
        isStudent: isStudent ?? this.isStudent,
        hostelBlock: clearHostelBlock ? null : (hostelBlock ?? this.hostelBlock),
        avatarId: avatarId ?? this.avatarId,
        kraveoCoins: kraveoCoins ?? this.kraveoCoins,
      );

  /// Name for display; falls back to a friendly placeholder for accounts without one.
  String get displayName => name ?? 'Kraveo student';

  String get firstName {
    final n = name;
    if (n == null) return '';
    return n.split(RegExp(r'\s+')).first;
  }

  /// One or two capital letters for the avatar.
  String get initials {
    final parts = (name ?? '').split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return 'K';
    String first(String s) => String.fromCharCodes(s.runes.take(1)).toUpperCase();
    if (parts.length == 1) return first(parts.first);
    return first(parts.first) + first(parts.last);
  }

  /// `+91 98••• ••210`: enough to recognise the number, not enough to read it over a shoulder.
  String get maskedPhone => maskIndianPhone(phone ?? '');
}

/// Masks the middle of an Indian mobile number. Accepts +91 / 91 / 0 prefixes.
String maskIndianPhone(String raw) {
  var digits = raw.replaceAll(RegExp(r'\D'), '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.substring(digits.length - 10);
  if (digits.length != 10) return digits.isEmpty ? '' : '+91 $digits';
  return '+91 ${digits.substring(0, 2)}••• ••${digits.substring(7)}';
}

/// Maps whatever the backend has stored (including legacy free-text such as
/// "Boys Hostel Block 3") onto one of [blocks]. Returns null when nothing sensible matches.
String? normalizeHostelBlock(String? raw, List<String> blocks) {
  final value = raw?.trim() ?? '';
  if (value.isEmpty) return null;
  for (final b in blocks) {
    if (b.toLowerCase() == value.toLowerCase()) return b;
  }
  final lower = value.toLowerCase();
  final block = RegExp(r'block\s*[-#]?\s*(\d+)').firstMatch(lower);
  if (block != null) {
    final candidate = 'Block ${block.group(1)}';
    if (blocks.contains(candidate)) return candidate;
  }
  final gate = RegExp(r'gate\s*[-#]?\s*(\d+)').firstMatch(lower);
  if (gate != null && lower.contains('girl')) {
    final candidate = 'Girls Gate ${gate.group(1)}';
    if (blocks.contains(candidate)) return candidate;
  }
  if (lower.contains('main gate')) {
    for (final b in blocks) {
      if (b.toLowerCase().contains('main gate')) return b;
    }
  }
  return null;
}
