import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

/// Where students write to Kraveo (decided by the owner; shown wherever the app says "contact
/// Kraveo support").
const String kSupportEmail = 'kraveo.contact@gmail.com';

/// Opens `tel:` and `mailto:` links through the phone's own apps. Every method answers
/// "did something open?" and never throws, so callers can fall back to copying the text.
class ExternalLinks {
  const ExternalLinks._();

  /// Test seam: replaces the platform launcher.
  @visibleForTesting
  static Future<bool> Function(Uri uri) launcher = _launch;

  static Future<bool> _launch(Uri uri) => launchUrl(uri, mode: LaunchMode.externalApplication);

  static Future<bool> open(Uri uri) async {
    try {
      return await launcher(uri);
    } catch (e) {
      debugPrint('[Links] could not open ${uri.scheme}: ${e.runtimeType}');
      return false;
    }
  }

  /// Opens the dialer with [phone] filled in. False for an empty or unusable number.
  static Future<bool> dial(String phone) {
    final number = dialableNumber(phone);
    if (number.isEmpty) return Future.value(false);
    return open(Uri(scheme: 'tel', path: number));
  }

  /// Opens the mail app addressed to support.
  static Future<bool> emailSupport({String? subject}) =>
      open(Uri(scheme: 'mailto', path: kSupportEmail, queryParameters: subject == null ? null : {'subject': subject}));

  /// Keeps only what a dialer needs: digits and a leading plus ("+91 98765-43210" -> "+919876543210").
  static String dialableNumber(String raw) {
    final trimmed = raw.trim();
    final digits = trimmed.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.isEmpty) return '';
    return trimmed.startsWith('+') ? '+$digits' : digits;
  }
}
