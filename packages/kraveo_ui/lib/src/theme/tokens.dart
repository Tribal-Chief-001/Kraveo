import 'package:flutter/material.dart';
import '../tokens/colors.dart';

/// Semantic colour roles. Every widget reads these, so one theme flip restyles a whole app.
@immutable
class KraveoTokens extends ThemeExtension<KraveoTokens> {
  const KraveoTokens({
    required this.isDark,
    required this.bg,
    required this.surface,
    required this.surfaceAlt,
    required this.line,
    required this.ink,
    required this.inkMuted,
    required this.inkFaint,
    required this.brand,
    required this.onBrand,
    required this.brandSoft,
    required this.accent,
    required this.onAccent,
    required this.shadowTint,
    this.minTap = 52,
    this.textScale = 1.0,
  });

  final bool isDark;
  final Color bg, surface, surfaceAlt, line;
  final Color ink, inkMuted, inkFaint;
  final Color brand, onBrand, brandSoft;
  final Color accent, onAccent;
  final Color shadowTint;
  final double minTap;
  final double textScale;

  /// Customer: warm cream, appetising, image-led.
  static const customer = KraveoTokens(
    isDark: false,
    bg: KraveoPalette.cream,
    surface: KraveoPalette.paper,
    surfaceAlt: KraveoPalette.sand,
    line: KraveoPalette.line,
    ink: KraveoPalette.ink,
    inkMuted: KraveoPalette.ink2,
    inkFaint: KraveoPalette.ink3,
    brand: KraveoPalette.g800,
    onBrand: Colors.white,
    brandSoft: KraveoPalette.g50,
    accent: KraveoPalette.y400,
    onAccent: KraveoPalette.g900,
    shadowTint: KraveoPalette.g900,
  );

  /// Vendor: same DNA, but maximum contrast + oversized targets/type for a smoky, noisy kitchen.
  static const vendor = KraveoTokens(
    isDark: false,
    bg: Color(0xFFFFFDF7),
    surface: KraveoPalette.paper,
    surfaceAlt: Color(0xFFF3EFE3),
    line: Color(0xFFDDD8C8),
    ink: Color(0xFF0B140F),
    inkMuted: Color(0xFF39453D),
    inkFaint: Color(0xFF66716A),
    brand: KraveoPalette.g800,
    onBrand: Colors.white,
    brandSoft: KraveoPalette.g50,
    accent: KraveoPalette.y400,
    onAccent: KraveoPalette.g900,
    shadowTint: KraveoPalette.g900,
    minTap: 64,
    textScale: 1.12,
  );

  /// Driver: OLED-dark, neon-yellow accent, glanceable at night on a bike.
  static const driver = KraveoTokens(
    isDark: true,
    bg: KraveoPalette.nightBg,
    surface: KraveoPalette.nightSurface,
    surfaceAlt: KraveoPalette.nightSurface2,
    line: KraveoPalette.nightLine,
    ink: KraveoPalette.nightInk,
    inkMuted: KraveoPalette.nightInk2,
    inkFaint: KraveoPalette.nightInk3,
    brand: KraveoPalette.g400,
    onBrand: KraveoPalette.g950,
    brandSoft: Color(0xFF12281A),
    accent: KraveoPalette.y400,
    onAccent: KraveoPalette.g950,
    shadowTint: Colors.black,
    minTap: 64,
    textScale: 1.1,
  );

  @override
  KraveoTokens copyWith({bool? isDark}) => this;

  @override
  KraveoTokens lerp(ThemeExtension<KraveoTokens>? other, double t) => t < 0.5 ? this : (other as KraveoTokens? ?? this);
}

extension KraveoContext on BuildContext {
  KraveoTokens get k => Theme.of(this).extension<KraveoTokens>() ?? KraveoTokens.customer;
}
