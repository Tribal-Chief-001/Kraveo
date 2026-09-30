import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// A big (64px) selectable chip for greasy-thumb use: prep times, categories, filters.
/// Same look as [KChoiceChip] but with a guaranteed tap height, an optional Hindi
/// [sublabel], and an optional numeral style for values like "15".
class VChoiceChip extends StatelessWidget {
  const VChoiceChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.sublabel,
    this.height = 64,
    this.numeral = false,
    this.semanticLabel,
  });

  final String label;
  final String? sublabel;
  final bool selected;
  final VoidCallback onTap;
  final double height;
  final bool numeral;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final fg = selected ? k.onBrand : k.ink;
    final sub = selected ? k.onBrand.withValues(alpha: 0.85) : k.inkMuted;
    return Semantics(
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: semanticLabel ?? (sublabel == null ? label : '$label, $sublabel'),
      excludeSemantics: true,
      button: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          constraints: BoxConstraints(minHeight: height, minWidth: 64),
          padding: EdgeInsets.symmetric(horizontal: numeral ? 6 : 16, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? k.brand : k.surface,
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: selected ? k.brand : k.line, width: 1.5),
            boxShadow: selected ? KShadow.glow(k.brand).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.25))).toList() : null,
          ),
          child: Center(
            widthFactor: 1,
            heightFactor: 1,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                label,
                maxLines: 1,
                style: (numeral ? KraveoType.headlineSm.copyWith(fontSize: 26) : KraveoType.titleMd.copyWith(fontSize: 16, fontWeight: FontWeight.w800)).copyWith(color: fg),
              ),
            ),
            if (sublabel != null)
              FittedBox(fit: BoxFit.scaleDown, child: Text(sublabel!, maxLines: 1, style: KraveoType.caption.copyWith(color: sub, fontSize: 12))),
          ]),
          ),
        ),
      ),
    );
  }
}
