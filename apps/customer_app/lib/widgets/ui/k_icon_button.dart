import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Round icon-only button. Always carries a semantic label (screen readers) and a 44px+ target.
class KIconButton extends StatelessWidget {
  const KIconButton({
    super.key,
    required this.icon,
    required this.onTap,
    required this.semanticLabel,
    this.color,
    this.background,
    this.size = 44,
    this.iconSize = 20,
    this.bordered = true,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final String semanticLabel;
  final Color? color;
  final Color? background;
  final double size;
  final double iconSize;
  final bool bordered;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      onTap: onTap,
      semanticLabel: semanticLabel,
      child: Opacity(
        opacity: onTap == null ? 0.4 : 1,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: background ?? k.surface,
            shape: BoxShape.circle,
            border: bordered ? Border.all(color: k.line.withValues(alpha: 0.8)) : null,
          ),
          child: ExcludeSemantics(child: Icon(icon, size: iconSize, color: color ?? k.ink)),
        ),
      ),
    );
  }
}
