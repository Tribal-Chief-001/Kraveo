import 'dart:ui';
import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';
import 'pressable.dart';

class KNavItem {
  const KNavItem(this.icon, this.label, {this.badge = 0});
  final IconData icon;
  final String label;
  final int badge;
}

/// Floating, blurred pill navigation. The selected item expands with its label.
class KGlassNav extends StatelessWidget {
  const KGlassNav({super.key, required this.items, required this.index, required this.onChanged});
  final List<KNavItem> items;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SafeArea(
      minimum: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(KRadius.pill),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
          child: Container(
            height: 68,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: BoxDecoration(
              color: (k.isDark ? k.surfaceAlt : k.surface).withValues(alpha: 0.82),
              borderRadius: BorderRadius.circular(KRadius.pill),
              border: Border.all(color: k.line.withValues(alpha: 0.7)),
              boxShadow: KShadow.lift(k.shadowTint),
            ),
            child: Row(children: [
              for (var i = 0; i < items.length; i++)
                Expanded(
                  flex: i == index ? 3 : 2,
                  child: KPressable(
                    onTap: () => onChanged(i),
                    child: AnimatedContainer(
                      duration: KMotion.base,
                      curve: KMotion.emphasized,
                      margin: const EdgeInsets.symmetric(horizontal: 3, vertical: 9),
                      decoration: BoxDecoration(
                        color: i == index ? k.brand : Colors.transparent,
                        borderRadius: BorderRadius.circular(KRadius.pill),
                      ),
                      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        Badge(
                          isLabelVisible: items[i].badge > 0,
                          label: Text('${items[i].badge}'),
                          backgroundColor: k.accent,
                          textColor: k.onAccent,
                          child: Icon(items[i].icon, size: 22, color: i == index ? k.onBrand : k.inkFaint),
                        ),
                        if (i == index) ...[
                          const SizedBox(width: 8),
                          Flexible(child: Text(items[i].label, maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: KraveoType.label.copyWith(color: k.onBrand, fontSize: 13))),
                        ],
                      ]),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}
