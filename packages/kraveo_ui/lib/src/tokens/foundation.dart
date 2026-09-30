import 'package:flutter/material.dart';

class KSpace {
  KSpace._();
  static const double x1 = 4, x2 = 8, x3 = 12, x4 = 16, x5 = 20, x6 = 24, x8 = 32, x10 = 40, x12 = 48;
  static const double gutter = 20; // page horizontal padding
}

class KRadius {
  KRadius._();
  static const double sm = 12, md = 16, lg = 20, xl = 24, xxl = 32, pill = 999;
  static BorderRadius get card => BorderRadius.circular(xl);
  static BorderRadius get control => BorderRadius.circular(lg);
  static BorderRadius get sheet => const BorderRadius.vertical(top: Radius.circular(xxl));
}

class KShadow {
  KShadow._();
  /// Soft, green-tinted elevation (never grey/black) - feels warm and premium.
  static List<BoxShadow> soft(Color tint) => [
        BoxShadow(color: tint.withValues(alpha: 0.06), blurRadius: 4, offset: const Offset(0, 1)),
        BoxShadow(color: tint.withValues(alpha: 0.10), blurRadius: 28, offset: const Offset(0, 12)),
      ];
  static List<BoxShadow> lift(Color tint) => [
        BoxShadow(color: tint.withValues(alpha: 0.14), blurRadius: 40, offset: const Offset(0, 18)),
      ];
  static List<BoxShadow> glow(Color c) => [
        BoxShadow(color: c.withValues(alpha: 0.45), blurRadius: 30, spreadRadius: -4, offset: const Offset(0, 10)),
      ];
}

class KMotion {
  KMotion._();
  static const fast = Duration(milliseconds: 140);
  static const base = Duration(milliseconds: 260);
  static const slow = Duration(milliseconds: 480);
  static const emphasized = Curves.easeOutCubic;
  /// Slight overshoot - the "expressive" bounce, use for key moments only.
  static const spring = Curves.easeOutBack;
  static const standard = Curves.easeInOutCubic;
}
