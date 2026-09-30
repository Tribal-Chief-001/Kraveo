import 'package:flutter/material.dart';

/// Type system: Bricolage Grotesque (display, numerals - characterful) +
/// Plus Jakarta Sans (UI/body - clean). Both are bundled as assets, so the apps
/// render identically offline (no runtime font fetch).
class KraveoType {
  KraveoType._();
  static const _pkg = 'kraveo_ui';

  static TextStyle _display(double size, double h, double w, {double ls = -0.5}) => TextStyle(
        fontFamily: 'Bricolage',
        package: _pkg,
        fontSize: size,
        height: h / size,
        fontWeight: _fw(w),
        fontVariations: [FontVariation('wght', w)],
        letterSpacing: ls,
      );

  static TextStyle _ui(double size, double h, double w, {double ls = 0}) => TextStyle(
        fontFamily: 'Jakarta',
        package: _pkg,
        fontSize: size,
        height: h / size,
        fontWeight: _fw(w),
        fontVariations: [FontVariation('wght', w)],
        letterSpacing: ls,
      );

  static FontWeight _fw(double w) => FontWeight.values[((w / 100).round().clamp(1, 9)) - 1];

  // Display / headline - Bricolage
  static final displayLg = _display(44, 48, 800, ls: -1.2);
  static final displayMd = _display(34, 38, 800, ls: -0.8);
  static final headline = _display(26, 30, 700, ls: -0.5);
  static final headlineSm = _display(22, 26, 700, ls: -0.3);
  static final numeric = _display(40, 44, 800, ls: -1.0);
  static final numericSm = _display(24, 28, 700, ls: -0.4);

  // UI - Jakarta
  static final titleLg = _ui(19, 26, 700, ls: -0.2);
  static final titleMd = _ui(16, 22, 700, ls: -0.1);
  static final body = _ui(15, 22, 500);
  static final bodySm = _ui(13, 18, 500);
  static final label = _ui(12, 16, 700, ls: 0.4);
  static final button = _ui(16, 20, 700, ls: 0.1);
  static final caption = _ui(11, 14, 600, ls: 0.3);

  /// Scale for accessibility-first surfaces (vendor kitchen, driver on a bike).
  static TextStyle scaled(TextStyle s, double f) => s.copyWith(fontSize: (s.fontSize ?? 14) * f);
}
