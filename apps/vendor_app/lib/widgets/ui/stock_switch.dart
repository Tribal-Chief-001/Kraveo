import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'vendor_ui.dart';

/// One big 64px pill: green "IN STOCK" with the knob on the right, red "SOLD OUT" with
/// the knob on the left. A single tap anywhere flips it, with an animated slide + haptic.
class VStockSwitch extends StatelessWidget {
  const VStockSwitch({super.key, required this.inStock, required this.onToggle, this.dishName});
  final bool inStock;
  final VoidCallback onToggle;
  final String? dishName;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    const h = 64.0, knob = 52.0, pad = 6.0;
    final track = inStock ? k.brand : kDangerDeep;
    return Semantics(
      toggled: inStock,
      button: true,
      excludeSemantics: true,
      label: '${dishName ?? 'Dish'}: ${inStock ? 'in stock' : 'sold out'}. Double tap to mark ${inStock ? 'sold out' : 'in stock'}',
      onTap: onToggle,
      child: KPressable(
        onTap: onToggle,
        scale: 0.98,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          height: h,
          decoration: BoxDecoration(
            color: track,
            borderRadius: BorderRadius.circular(KRadius.pill),
            boxShadow: KShadow.glow(track).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.22))).toList(),
          ),
          child: Stack(children: [
            AnimatedPadding(
              duration: KMotion.base,
              curve: KMotion.emphasized,
              padding: EdgeInsets.only(left: inStock ? 20 : knob + pad * 2, right: inStock ? knob + pad * 2 : 20),
              child: Center(
                child: AnimatedSwitcher(
                  duration: KMotion.fast,
                  child: Column(
                    key: ValueKey(inStock),
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(inStock ? 'IN STOCK' : 'SOLD OUT',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: KraveoType.button.copyWith(color: k.onBrand, fontSize: 19, fontWeight: FontWeight.w800)),
                      Text(inStock ? 'उपलब्ध' : 'खत्म', maxLines: 1, style: KraveoType.caption.copyWith(color: k.onBrand.withValues(alpha: 0.9), fontSize: 13)),
                    ],
                  ),
                ),
              ),
            ),
            AnimatedAlign(
              duration: KMotion.base,
              curve: KMotion.spring,
              alignment: inStock ? Alignment.centerRight : Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.all(pad),
                child: Container(
                  width: knob,
                  height: knob,
                  decoration: BoxDecoration(color: k.onBrand, shape: BoxShape.circle),
                  child: Icon(inStock ? LucideIcons.check : LucideIcons.x, size: 28, color: track),
                ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
