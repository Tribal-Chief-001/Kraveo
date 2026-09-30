import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Brand-green floating action bar (cart bar on the menu, active-order bar on home).
class KFloatingBar extends StatelessWidget {
  const KFloatingBar({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    required this.trailing,
    required this.onTap,
    this.semanticLabel,
  });

  final Widget leading;
  final Widget title;
  final String? subtitle;
  final Widget trailing;
  final VoidCallback onTap;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: KPressable(
        onTap: onTap,
        scale: 0.98,
        semanticLabel: semanticLabel,
        child: Container(
          constraints: const BoxConstraints(minHeight: 68),
          padding: const EdgeInsets.fromLTRB(12, 10, 18, 10),
          decoration: BoxDecoration(
            color: k.brand,
            borderRadius: BorderRadius.circular(KRadius.xl + 4),
            boxShadow: KShadow.lift(k.shadowTint),
          ),
          child: Row(children: [
            leading,
            const SizedBox(width: 12),
            Expanded(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                title,
                if (subtitle != null)
                  Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.onBrand.withValues(alpha: 0.78))),
              ]),
            ),
            const SizedBox(width: 10),
            trailing,
          ]),
        ),
      ),
    );
  }
}

/// Slides a floating bar in / out (used so bars appear and vanish smoothly).
class KBarSwitcher extends StatelessWidget {
  const KBarSwitcher({super.key, required this.visible, required this.child});

  final bool visible;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: KMotion.base,
      switchInCurve: KMotion.spring,
      switchOutCurve: Curves.easeIn,
      transitionBuilder: (c, anim) => FadeTransition(
        opacity: anim,
        child: SlideTransition(position: Tween<Offset>(begin: const Offset(0, 0.6), end: Offset.zero).animate(anim), child: c),
      ),
      child: visible ? KeyedSubtree(key: const ValueKey('bar-visible'), child: child) : const SizedBox.shrink(key: ValueKey('bar-hidden')),
    );
  }
}
