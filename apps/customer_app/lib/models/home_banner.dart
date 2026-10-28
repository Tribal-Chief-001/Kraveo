import 'package:flutter/foundation.dart';

/// `DARK` = light text on a dark gradient, `LIGHT` = dark text on a light gradient (Docs/25 section 1).
enum BannerTheme { dark, light }

/// One promo from `GET /api/banners` (Docs/25 section 7.2). Parsed defensively: a row without a usable
/// id, title or https image is dropped; a link that is not a plain https address is treated as "no
/// link" (the card is then display only), whatever the server sent.
@immutable
class HomeBanner {
  const HomeBanner({required this.id, required this.title, required this.imageUrl, this.subtitle, this.linkUrl, this.ctaLabel, this.theme = BannerTheme.dark});

  final String id;
  final String title;
  final String? subtitle;
  final String imageUrl;

  /// Always an https address or null.
  final String? linkUrl;
  final String? ctaLabel;
  final BannerTheme theme;

  /// The only address this banner may open, or null.
  Uri? get linkUri => linkUrl == null ? null : Uri.tryParse(linkUrl!);
  bool get hasLink => linkUrl != null;

  /// Screen-reader text: "Title, subtitle. Opens link".
  String get semanticLabel => '${subtitle == null ? title : '$title, $subtitle'}${hasLink ? '. Opens link' : ''}';

  /// The most banners the app shows (the server sends at most 10).
  static const int maxShown = 10;

  /// Trimmed https address (no spaces, no user info, a host with a dot) or null.
  static String? safeHttps(Object? raw) {
    if (raw is! String) return null;
    final s = raw.trim();
    if (s.isEmpty || s.length > 500 || s.contains(RegExp(r'\s'))) return null;
    final u = Uri.tryParse(s);
    if (u == null || u.scheme != 'https' || !u.hasAuthority || u.userInfo.isNotEmpty || !u.host.contains('.')) return null;
    return u.toString();
  }

  static String? _text(Object? raw) {
    if (raw is! String) return null;
    final t = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
    return t.isEmpty ? null : t;
  }

  static HomeBanner? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    final title = _text(raw['title']);
    final image = safeHttps(raw['imageUrl']);
    if (id == null || title == null || image == null) return null;
    final link = safeHttps(raw['linkUrl']);
    return HomeBanner(
      id: id,
      title: title,
      subtitle: _text(raw['subtitle']),
      imageUrl: image,
      linkUrl: link,
      ctaLabel: _text(raw['ctaLabel']),
      theme: raw['theme'] is String && (raw['theme'] as String).trim().toUpperCase() == 'LIGHT' ? BannerTheme.light : BannerTheme.dark,
    );
  }

  /// Parses a whole `data` list: unusable rows and repeated ids are dropped, at most [maxShown] kept.
  static List<HomeBanner> parseList(Object? raw) {
    if (raw is! List) return const [];
    final seen = <String>{};
    final out = <HomeBanner>[];
    for (final row in raw) {
      final b = tryParse(row);
      if (b != null && seen.add(b.id)) out.add(b);
      if (out.length == maxShown) break;
    }
    return List.unmodifiable(out);
  }

  @override
  bool operator ==(Object other) =>
      other is HomeBanner &&
      other.id == id &&
      other.title == title &&
      other.subtitle == subtitle &&
      other.imageUrl == imageUrl &&
      other.linkUrl == linkUrl &&
      other.ctaLabel == ctaLabel &&
      other.theme == theme;

  @override
  int get hashCode => Object.hash(id, title, subtitle, imageUrl, linkUrl, ctaLabel, theme);
}
