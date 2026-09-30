import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Hero duty control: one giant, glowing ON DUTY / OFF DUTY switch. Tap anywhere to flip.
class DutyToggle extends StatelessWidget {
  final bool isOnline;
  final ValueChanged<bool> onChanged;

  const DutyToggle({
    super.key,
    required this.isOnline,
    required this.onChanged,
  });

  static const double _height = 96;
  static const double _thumb = 76;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final on = isOnline;
    return KPressable(
      semanticLabel: on ? 'You are on duty. Double tap to go off duty.' : 'You are off duty. Double tap to go on duty.',
      scale: 0.98,
      onTap: () => onChanged(!isOnline),
      child: ExcludeSemantics(
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          height: _height,
          decoration: BoxDecoration(
            color: on ? k.brand.withValues(alpha: 0.14) : k.surface,
            borderRadius: BorderRadius.circular(KRadius.pill),
            border: Border.all(color: on ? k.brand : k.line, width: 2),
            boxShadow: on ? KShadow.glow(k.brand) : null,
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Positioned.fill(
                child: AnimatedPadding(
                  duration: KMotion.base,
                  curve: KMotion.emphasized,
                  padding: EdgeInsets.only(left: on ? 30 : _thumb + 24, right: on ? _thumb + 24 : 30),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(on ? 'ON DUTY' : 'OFF DUTY',
                              style: KraveoType.displayMd.copyWith(color: on ? k.brand : k.inkMuted, fontSize: 32, letterSpacing: 0.4)),
                          Text(on ? 'Live location on' : 'Tap to go online',
                              style: KraveoType.bodySm.copyWith(color: on ? k.inkMuted : k.inkFaint)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              AnimatedAlign(
                duration: KMotion.base,
                curve: KMotion.spring,
                alignment: on ? Alignment.centerRight : Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.all((_height - _thumb) / 2),
                  child: AnimatedContainer(
                    duration: KMotion.base,
                    width: _thumb,
                    height: _thumb,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: on ? k.brand : k.surfaceAlt,
                      border: Border.all(color: on ? k.brand : k.line, width: 1.5),
                      boxShadow: on ? KShadow.glow(k.brand) : null,
                    ),
                    child: Icon(LucideIcons.power, size: 34, color: on ? k.onBrand : k.inkFaint),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
