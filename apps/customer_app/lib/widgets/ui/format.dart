import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Rupee formatting used across the customer app, in Indian digit grouping (₹12,345, ₹1,23,456).
///
/// Whole amounts print without decimals; an amount that has paise prints both digits
/// (₹190.40, never ₹190 or ₹190.4) so every screen shows exactly what Razorpay charges.
String rupee(num value) {
  final paise = (value.abs() * 100).round();
  final negative = value < 0 && paise != 0;
  final whole = paise ~/ 100;
  final cents = paise % 100;
  final grouped = _groupIndian(whole);
  final text = cents == 0 ? grouped : '$grouped.${cents.toString().padLeft(2, '0')}';
  return negative ? '-₹$text' : '₹$text';
}

/// Digit grouping 1,23,456 for a non-negative whole number.
String _groupIndian(int n) {
  final s = n.toString();
  if (s.length <= 3) return s;
  final head = s.substring(0, s.length - 3);
  final tail = s.substring(s.length - 3);
  final b = StringBuffer();
  for (var i = 0; i < head.length; i++) {
    if (i > 0 && (head.length - i) % 2 == 0) b.write(',');
    b.write(head[i]);
  }
  return '$b,$tail';
}

/// Danger red that keeps >= 4.5:1 contrast for text on cream / white surfaces.
final Color kDangerInk = Color.alphaBlend(Colors.black.withValues(alpha: 0.32), KraveoPalette.danger);

/// Amber used for star ratings (semantic warning tone, distinct from the accent yellow CTA).
const Color kStarColor = KraveoPalette.warning;

/// Darker amber for rating text that sits on light surfaces.
final Color kStarInk = Color.alphaBlend(Colors.black.withValues(alpha: 0.4), KraveoPalette.warning);

/// "9:42 PM" in the phone's local time.
String clockLabel(DateTime d) {
  final l = d.toLocal();
  final hour = l.hour % 12 == 0 ? 12 : l.hour % 12;
  return '$hour:${l.minute.toString().padLeft(2, '0')} ${l.hour >= 12 ? 'PM' : 'AM'}';
}

/// Order display code shared by every Kraveo app: '#' + the last 6 characters of the id, uppercased.
String orderRef(String id) => '#${(id.length <= 6 ? id : id.substring(id.length - 6)).toUpperCase()}';
