import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Icon-only button with a mandatory screen-reader label and a 56dp target.
class KIconButton extends StatelessWidget {
  const KIconButton({super.key, required this.icon, required this.semanticLabel, required this.onTap, this.tint, this.size = 56});

  final IconData icon;
  final String semanticLabel;
  final VoidCallback onTap;
  final Color? tint;
  final double size;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final c = tint ?? k.ink;
    return KPressable(
      semanticLabel: semanticLabel,
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: tint == null ? k.surfaceAlt : tint!.withValues(alpha: 0.14),
          shape: BoxShape.circle,
          border: Border.all(color: tint == null ? k.line : tint!.withValues(alpha: 0.45)),
        ),
        child: ExcludeSemantics(child: Icon(icon, size: 24, color: c)),
      ),
    );
  }
}
