import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../tokens/colors.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';
import 'tokens.dart';

/// Builds a full Material 3 ThemeData from Kraveo tokens.
/// `KraveoTheme.customer()`, `.vendor()`, `.driver()` share one DNA, differ in personality.
class KraveoTheme {
  KraveoTheme._();

  static ThemeData customer() => _build(KraveoTokens.customer);
  static ThemeData vendor() => _build(KraveoTokens.vendor);
  static ThemeData driver() => _build(KraveoTokens.driver);

  static ThemeData _build(KraveoTokens t) {
    final brightness = t.isDark ? Brightness.dark : Brightness.light;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: t.brand,
      onPrimary: t.onBrand,
      secondary: t.accent,
      onSecondary: t.onAccent,
      error: KraveoPalette.danger,
      onError: Colors.white,
      surface: t.surface,
      onSurface: t.ink,
      surfaceContainerHighest: t.surfaceAlt,
      outline: t.line,
      outlineVariant: t.line,
    );

    TextStyle c(TextStyle s, [Color? color]) =>
        KraveoType.scaled(s, t.textScale).copyWith(color: color ?? t.ink);

    final text = TextTheme(
      displayLarge: c(KraveoType.displayLg),
      displayMedium: c(KraveoType.displayMd),
      headlineMedium: c(KraveoType.headline),
      headlineSmall: c(KraveoType.headlineSm),
      titleLarge: c(KraveoType.titleLg),
      titleMedium: c(KraveoType.titleMd),
      bodyLarge: c(KraveoType.body),
      bodyMedium: c(KraveoType.body),
      bodySmall: c(KraveoType.bodySm, t.inkMuted),
      labelLarge: c(KraveoType.button),
      labelMedium: c(KraveoType.label, t.inkMuted),
      labelSmall: c(KraveoType.caption, t.inkFaint),
    );

    OutlineInputBorder border(Color col, [double w = 1.2]) => OutlineInputBorder(
          borderRadius: KRadius.control,
          borderSide: BorderSide(color: col, width: w),
        );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: t.bg,
      canvasColor: t.bg,
      textTheme: text,
      primaryTextTheme: text,
      extensions: [t],
      splashFactory: InkSparkle.splashFactory,
      dividerColor: t.line,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        foregroundColor: t.ink,
        titleTextStyle: c(KraveoType.headlineSm),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: t.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        hintStyle: c(KraveoType.body, t.inkFaint),
        border: border(t.line),
        enabledBorder: border(t.line),
        focusedBorder: border(t.brand, 2),
        errorBorder: border(KraveoPalette.danger),
        focusedErrorBorder: border(KraveoPalette.danger, 2),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: t.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: KRadius.sheet),
        showDragHandle: false,
        clipBehavior: Clip.antiAlias,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: t.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KRadius.xxl)),
        titleTextStyle: c(KraveoType.headlineSm),
        contentTextStyle: c(KraveoType.body, t.inkMuted),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: t.isDark ? KraveoPalette.nightSurface2 : KraveoPalette.g900,
        contentTextStyle: c(KraveoType.bodySm, Colors.white).copyWith(fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KRadius.md)),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? t.onBrand : t.inkFaint),
        trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? t.brand : t.surfaceAlt),
        trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: t.brand, linearTrackColor: t.surfaceAlt),
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: CupertinoPageTransitionsBuilder(),
      }),
    );
  }
}
