import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';
import 'pressable.dart';

class KCard extends StatelessWidget {
  const KCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(KSpace.x4), this.color, this.elevated = true, this.radius, this.borderColor, this.clip = false});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final bool elevated;
  final double? radius;
  final Color? borderColor;
  final bool clip;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final r = BorderRadius.circular(radius ?? KRadius.xl);
    final body = Container(
      padding: padding,
      clipBehavior: clip ? Clip.antiAlias : Clip.none,
      decoration: BoxDecoration(
        color: color ?? k.surface,
        borderRadius: r,
        border: Border.all(color: borderColor ?? (k.isDark ? k.line : k.line.withValues(alpha: 0.6))),
        boxShadow: elevated && !k.isDark ? KShadow.soft(k.shadowTint) : null,
      ),
      child: child,
    );
    return onTap == null ? body : KPressable(onTap: onTap, scale: 0.98, child: body);
  }
}
