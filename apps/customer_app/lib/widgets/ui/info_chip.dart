import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Small icon + label chip. `glass` = readable over photography, otherwise a quiet inline chip.
class KInfoChip extends StatelessWidget {
  const KInfoChip({super.key, required this.icon, required this.label, this.glass = false, this.iconColor, this.textColor});

  final IconData icon;
  final String label;
  final bool glass;
  final Color? iconColor;
  final Color? textColor;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: glass ? k.surface.withValues(alpha: 0.94) : k.surfaceAlt,
        borderRadius: BorderRadius.circular(KRadius.pill),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: iconColor ?? k.inkMuted),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: KraveoType.label.copyWith(color: textColor ?? k.ink, fontSize: 12.5),
          ),
        ),
      ]),
    );
  }
}
