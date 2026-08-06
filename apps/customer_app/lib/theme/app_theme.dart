import 'package:flutter/material.dart';

class AppTheme {
  // Exact Color Tokens from Google Stitch Customer App Design
  static const Color primaryEmerald = Color(0xFF00450D);
  static const Color primaryContainer = Color(0xFF1B5E20);
  static const Color secondaryGold = Color(0xFFFDD400);
  static const Color secondaryTextGold = Color(0xFF6F5C00);
  static const Color surfaceBackground = Color(0xFFFCF9F8);
  static const Color cardWhite = Color(0xFFFFFFFF);
  static const Color surfaceVariant = Color(0xFFE5E2E1);
  static const Color textDark = Color(0xFF1B1C1C);
  static const Color textMuted = Color(0xFF41493E);
  static const Color accentRed = Color(0xFFD32F2F);
  static const Color accentGreen = Color(0xFF2E7D32);
  static const Color borderLight = Color(0xFFE5E2E1);

  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      fontFamily: 'Plus Jakarta Sans',
      colorScheme: ColorScheme.fromSeed(
        seedColor: primaryEmerald,
        primary: primaryEmerald,
        secondary: secondaryGold,
        surface: surfaceBackground,
        surfaceContainerHighest: surfaceVariant,
      ),
      scaffoldBackgroundColor: surfaceBackground,
      appBarTheme: const AppBarTheme(
        backgroundColor: surfaceBackground,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: textDark),
        titleTextStyle: TextStyle(
          color: textDark,
          fontSize: 18,
          fontWeight: FontWeight.bold,
        ),
      ),
      cardTheme: CardThemeData(
        color: cardWhite,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: borderLight),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    );
  }
}

