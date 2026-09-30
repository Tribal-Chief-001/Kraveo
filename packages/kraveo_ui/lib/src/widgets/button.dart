import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/colors.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';
import 'pressable.dart';

enum KButtonKind { primary, accent, tonal, ghost, danger }

/// The one button. `large` = 64px target for vendor / driver surfaces.
class KButton extends StatelessWidget {
  const KButton({
    super.key,
    required this.label,
    this.onPressed,
    this.kind = KButtonKind.primary,
    this.icon,
    this.large = false,
    this.loading = false,
    this.expand = true,
    this.sublabel,
  });

  final String label;
  final String? sublabel; // e.g. Hindi line under English for vendors
  final VoidCallback? onPressed;
  final KButtonKind kind;
  final IconData? icon;
  final bool large;
  final bool loading;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final enabled = onPressed != null && !loading;
    final (bg, fg, border) = switch (kind) {
      KButtonKind.primary => (k.brand, k.onBrand, Colors.transparent),
      KButtonKind.accent => (k.accent, k.onAccent, Colors.transparent),
      KButtonKind.tonal => (k.brandSoft, k.isDark ? k.brand : k.brand, Colors.transparent),
      KButtonKind.ghost => (Colors.transparent, k.ink, k.line),
      KButtonKind.danger => (KraveoPalette.danger, Colors.white, Colors.transparent),
    };
    final h = large ? (k.minTap < 64 ? 64.0 : k.minTap) : k.minTap.clamp(52, 56).toDouble();
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: fg))
        else ...[
          if (icon != null) ...[Icon(icon, size: large ? 24 : 20, color: fg), const SizedBox(width: 10)],
          Flexible(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KraveoType.button.copyWith(color: fg, fontSize: large ? 18 : 16)),
                if (sublabel != null)
                  Text(sublabel!,
                      maxLines: 1,
                      style: KraveoType.caption.copyWith(color: fg.withValues(alpha: 0.8), fontSize: 12)),
              ],
            ),
          ),
        ],
      ],
    );

    return Opacity(
      opacity: onPressed == null && !loading ? 0.45 : 1,
      child: KPressable(
        onTap: enabled ? onPressed : null,
        child: AnimatedContainer(
          duration: KMotion.base,
          height: h,
          padding: EdgeInsets.symmetric(horizontal: large ? 28 : 22),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(large ? KRadius.xl : KRadius.lg),
            border: Border.all(color: border, width: 1.4),
            boxShadow: kind == KButtonKind.primary || kind == KButtonKind.accent
                ? KShadow.glow((kind == KButtonKind.primary ? k.brand : k.accent)).map((s) => s.copyWith(color: s.color.withValues(alpha: k.isDark ? 0.28 : 0.30))).toList()
                : null,
          ),
          child: content,
        ),
      ),
    );
  }
}
