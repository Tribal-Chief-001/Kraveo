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
