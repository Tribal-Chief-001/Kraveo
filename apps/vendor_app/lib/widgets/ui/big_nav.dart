import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'vendor_ui.dart';

class VNavItem {
  const VNavItem({required this.icon, required this.label, required this.hindi, this.badge = 0});
  final IconData icon;
  final String label;
  final String hindi;
  final int badge;
}

/// Big three-tab bottom navigation. Every tab always shows its icon + English + Hindi
/// label (no hidden labels), and the active tab is a solid green block.
class VBigNav extends StatelessWidget {
  const VBigNav({super.key, required this.items, required this.index, required this.onChanged});
  final List<VNavItem> items;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(KRadius.xl + 4)),
        border: Border(top: BorderSide(color: k.line.withValues(alpha: 0.8))),
        boxShadow: KShadow.lift(k.shadowTint),
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.only(bottom: 8),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 10, 2),
          child: Row(children: [
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(child: _NavTab(item: items[i], selected: i == index, onTap: () => onChanged(i))),
            ],
          ]),
        ),
      ),
    );
  }
}

class _NavTab extends StatelessWidget {
  const _NavTab({required this.item, required this.selected, required this.onTap});
  final VNavItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final fg = selected ? k.onBrand : k.inkMuted;
    return Semantics(
      selected: selected,
      button: true,
      excludeSemantics: true,
      label: item.badge > 0 ? '${item.label}, ${item.badge} waiting' : item.label,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
          decoration: BoxDecoration(
            color: selected ? k.brand : Colors.transparent,
            borderRadius: BorderRadius.circular(KRadius.lg),
          ),
          child: Column(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
            Stack(clipBehavior: Clip.none, children: [
              Icon(item.icon, size: 28, color: fg),
              if (item.badge > 0)
                Positioned(
                  right: -14,
                  top: -8,
                  child: Container(
                    constraints: const BoxConstraints(minWidth: 22, minHeight: 22),
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: kDangerDeep, borderRadius: BorderRadius.circular(11), border: Border.all(color: k.surface, width: 2)),
                    child: Text(item.badge > 99 ? '99+' : '${item.badge}', style: KraveoType.caption.copyWith(color: k.onBrand, fontSize: 12, fontWeight: FontWeight.w800)),
                  ),
                ),
            ]),
            const SizedBox(height: 4),
            Text(item.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: fg, fontSize: 15, fontWeight: FontWeight.w800)),
            Text(item.hindi, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.caption.copyWith(color: fg, fontSize: 12)),
          ]),
        ),
      ),
    );
  }
}
