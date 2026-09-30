import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/colors.dart';

/// The Kraveo bowl mark (transparent PNG). On dark surfaces the green wordmark would vanish,
/// so it sits on a soft cream badge automatically.
class KBrandMark extends StatelessWidget {
  const KBrandMark({super.key, this.height = 56});
  final double height;

  @override
  Widget build(BuildContext context) {
    final img = Image.asset('assets/brand/kraveo-mark.png', package: 'kraveo_ui', height: height, fit: BoxFit.contain);
    if (!context.k.isDark) return img;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: height * 0.22, vertical: height * 0.12),
      decoration: BoxDecoration(color: KraveoPalette.cream, borderRadius: BorderRadius.circular(height * 0.36)),
      child: img,
    );
  }
}
