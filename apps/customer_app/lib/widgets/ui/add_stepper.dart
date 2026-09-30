import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// "ADD" pill that morphs into a quantity stepper (with a small spring) once quantity > 0.
/// Also used for cart lines (always quantity >= 1).
class KAddButton extends StatelessWidget {
  const KAddButton({
    super.key,
    required this.quantity,
    required this.onAdd,
    required this.onRemove,
    this.enabled = true,
    this.itemName = 'item',
  });

  final int quantity;
  final VoidCallback onAdd;
  final VoidCallback onRemove;
  final bool enabled;
  final String itemName;

  static const double _height = 40;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final active = quantity > 0;

    final Widget content = active
        ? Row(key: const ValueKey('stepper'), children: [
            Expanded(
              child: KPressable(
                onTap: onRemove,
                semanticLabel: 'Remove one $itemName',
                child: SizedBox(height: _height, child: Center(child: Icon(LucideIcons.minus, size: 18, color: k.onBrand))),
              ),
            ),
            AnimatedSwitcher(
              duration: KMotion.fast,
              transitionBuilder: (child, anim) => ScaleTransition(scale: CurvedAnimation(parent: anim, curve: KMotion.spring), child: FadeTransition(opacity: anim, child: child)),
              child: Text('$quantity', key: ValueKey(quantity), style: KraveoType.numericSm.copyWith(color: k.onBrand, fontSize: 18)),
            ),
            Expanded(
              child: KPressable(
                onTap: onAdd,
                semanticLabel: 'Add one more $itemName',
                child: SizedBox(height: _height, child: Center(child: Icon(LucideIcons.plus, size: 18, color: k.onBrand))),
              ),
            ),
          ])
        : KPressable(
            key: const ValueKey('add'),
            onTap: enabled ? onAdd : null,
            semanticLabel: 'Add $itemName',
            child: SizedBox(
              height: _height,
              child: Center(
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text('ADD', style: KraveoType.button.copyWith(color: k.brand, fontSize: 14, letterSpacing: 0.8)),
                  const SizedBox(width: 4),
                  Icon(LucideIcons.plus, size: 16, color: k.brand),
                ]),
              ),
            ),
          );

    return Align(
      alignment: Alignment.center,
      child: Opacity(
        opacity: enabled || active ? 1 : 0.45,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.spring,
          width: active ? 112 : 96,
          height: _height,
          decoration: BoxDecoration(
            color: active ? k.brand : k.surface,
            borderRadius: BorderRadius.circular(KRadius.pill),
            border: Border.all(color: active ? k.brand : k.brand.withValues(alpha: 0.55), width: 1.4),
            boxShadow: active ? KShadow.soft(k.shadowTint) : null,
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(KRadius.pill),
            child: AnimatedSwitcher(
              duration: KMotion.fast,
              transitionBuilder: (child, anim) => FadeTransition(opacity: anim, child: child),
              child: content,
            ),
          ),
        ),
      ),
    );
  }
}
