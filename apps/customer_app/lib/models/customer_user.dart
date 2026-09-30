/// The signed-in student, as returned by /auth/verify-otp and /auth/profile.
class CustomerUser {
  const CustomerUser({
    required this.id,
    required this.phone,
    this.name,
    this.role = 'STUDENT',
    this.hostelBlock,
    this.kraveoCoins = 0,
  });

  final String id;
  final String phone;
  final String? name;
  final String role;
  final String? hostelBlock;
  final int kraveoCoins;

  factory CustomerUser.fromJson(Map<String, dynamic> json) {
    final rawName = json['name']?.toString().trim();
    final rawHostel = json['hostelBlock']?.toString().trim();
    final coins = json['kraveoCoins'];
    return CustomerUser(
      id: json['id']?.toString() ?? '',
      phone: json['phone']?.toString() ?? '',
      name: rawName == null || rawName.isEmpty ? null : rawName,
      role: json['role']?.toString() ?? 'STUDENT',
      hostelBlock: rawHostel == null || rawHostel.isEmpty ? null : rawHostel,
      kraveoCoins: coins is num ? coins.round() : int.tryParse('$coins') ?? 0,
    );
  }

  CustomerUser copyWith({String? name, String? hostelBlock, int? kraveoCoins}) => CustomerUser(
        id: id,
        phone: phone,
        name: name ?? this.name,
        role: role,
        hostelBlock: hostelBlock ?? this.hostelBlock,
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
  String get maskedPhone => maskIndianPhone(phone);
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
