import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Rupee formatting used across the customer app. Whole rupees, rounded (never truncated).
String rupee(num value) => '₹${value.round()}';

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
