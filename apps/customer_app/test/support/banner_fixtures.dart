// Home banner payloads copied from the REAL backend (Docs/25 section 7.2, produced by
// backend/test/e2e/home_banners.test.ts against PostgreSQL). Ids differ per run; shapes do not.
import 'package:customer_app/models/home_banner.dart';

/// `GET /api/banners`: the two rows of the contract (a display-only DARK banner, a LIGHT one with a Google Form link).
Map<String, dynamic> realBannersBody() => {
      'success': true,
      'data': [
        {
          'id': '3a6fef14-70ff-47de-b0c2-1d328e4b597e',
          'title': 'Second',
          'subtitle': null,
          'imageUrl': 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg',
          'linkUrl': null,
          'ctaLabel': null,
          'theme': 'DARK',
        },
        {
          'id': 'dc939b34-9465-4318-a3cf-7b40dd25a208',
          'title': 'First',
          'subtitle': 'Sub',
          'imageUrl': 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg',
          'linkUrl': 'https://forms.gle/AbC123',
          'ctaLabel': 'Join now',
          'theme': 'LIGHT',
        },
      ],
    };

/// The empty answer of the real server.
Map<String, dynamic> emptyBannersBody() => {'success': true, 'data': <dynamic>[]};

/// One banner row in the real shape.
Map<String, dynamic> bannerRow(String id, {String? title, String? subtitle, String? linkUrl, String? ctaLabel, String theme = 'DARK', String? imageUrl}) => {
      'id': id,
      'title': title ?? 'Banner $id',
      'subtitle': subtitle,
      'imageUrl': imageUrl ?? 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg',
      'linkUrl': linkUrl,
      'ctaLabel': ctaLabel,
      'theme': theme,
    };

Map<String, dynamic> bannersBody(List<Map<String, dynamic>> rows) => {'success': true, 'data': rows};

HomeBanner banner(String id, {String? title, String? subtitle, String? linkUrl, String? ctaLabel, BannerTheme theme = BannerTheme.dark}) => HomeBanner(
      id: id,
      title: title ?? 'Banner $id',
      subtitle: subtitle,
      imageUrl: 'https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg',
      linkUrl: linkUrl,
      ctaLabel: ctaLabel,
      theme: theme,
    );
