import 'package:flutter/material.dart';

/// Raw brand palette. Derived from the Kraveo bowl logo (forest green + electric yellow).
/// Screens should NOT use these directly - read semantic roles via `context.k`.
class KraveoPalette {
  KraveoPalette._();

  // Forest green ramp (brand = 800)
  static const g50 = Color(0xFFEEF8EF);
  static const g100 = Color(0xFFD5EFD8);
  static const g200 = Color(0xFFA9DEB0);
  static const g300 = Color(0xFF74C880);
  static const g400 = Color(0xFF43AE55);
  static const g500 = Color(0xFF23913A);
  static const g600 = Color(0xFF147A2C);
  static const g700 = Color(0xFF0C6423);
  static const g800 = Color(0xFF075219); // brand
  static const g900 = Color(0xFF063D14);
  static const g950 = Color(0xFF032309);

  // Electric yellow ramp (brand = 400)
  static const y100 = Color(0xFFFFF6C2);
  static const y200 = Color(0xFFFFEC85);
  static const y300 = Color(0xFFFFE24D);
  static const y400 = Color(0xFFFFD600); // brand
  static const y500 = Color(0xFFE6BE00);
  static const y700 = Color(0xFF8A6D00);

  // Warm neutrals (light)
  static const cream = Color(0xFFFAF7F0);
  static const paper = Color(0xFFFFFFFF);
  static const sand = Color(0xFFF1EDE2);
  static const line = Color(0xFFE8E4D9);
  static const ink = Color(0xFF14201A);
  static const ink2 = Color(0xFF46534B);
  static const ink3 = Color(0xFF7B877F);

  // Green-black neutrals (dark)
  static const nightBg = Color(0xFF080D09);
  static const nightSurface = Color(0xFF111812);
  static const nightSurface2 = Color(0xFF1A241C);
  static const nightLine = Color(0xFF26322A);
  static const nightInk = Color(0xFFF4F7F2);
  static const nightInk2 = Color(0xFFB4BFB6);
  static const nightInk3 = Color(0xFF7C897F);

  // Semantic
  static const success = g500;
  static const warning = Color(0xFFF59E0B);
  static const danger = Color(0xFFE5484D);
  static const info = Color(0xFF3B82F6);
}

/// One status colour language shared by every Kraveo surface (apps + dashboard).
enum KStatus { placed, accepted, preparing, ready, pickedUp, atGate, delivered, cancelled }

extension KStatusX on KStatus {
  Color get color => switch (this) {
        KStatus.placed => const Color(0xFFF5A524),
        KStatus.accepted => const Color(0xFF14B8A6),
        KStatus.preparing => const Color(0xFFF97316),
        KStatus.ready => const Color(0xFF84CC16),
        KStatus.pickedUp => const Color(0xFF3B82F6),
        KStatus.atGate => const Color(0xFF8B5CF6),
        KStatus.delivered => const Color(0xFF16A34A),
        KStatus.cancelled => const Color(0xFFE5484D),
      };

  String get label => switch (this) {
        KStatus.placed => 'Placed',
        KStatus.accepted => 'Accepted',
        KStatus.preparing => 'Preparing',
        KStatus.ready => 'Ready',
        KStatus.pickedUp => 'On the way',
        KStatus.atGate => 'At gate',
        KStatus.delivered => 'Delivered',
        KStatus.cancelled => 'Cancelled',
      };

  /// Tolerant parser for backend strings (PLACED, READY_FOR_PICKUP, ARRIVED_AT_GATE ...).
  static KStatus parse(String raw) {
    final s = raw.toUpperCase().replaceAll(' ', '_');
    if (s.contains('CANCEL')) return KStatus.cancelled;
    if (s.contains('DELIVERED')) return KStatus.delivered;
    if (s.contains('GATE')) return KStatus.atGate;
    if (s.contains('PICKED') || s.contains('TRANSIT') || s.contains('WAY')) return KStatus.pickedUp;
    if (s.contains('READY')) return KStatus.ready;
    if (s.contains('PREPAR')) return KStatus.preparing;
    if (s.contains('ACCEPT') || s.contains('ASSIGN')) return KStatus.accepted;
    return KStatus.placed;
  }
}
