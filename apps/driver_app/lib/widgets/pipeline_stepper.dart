import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_view.dart';

/// Horizontal 4-step delivery tracker. The current step is enlarged and glowing,
/// finished steps show a check, upcoming steps are muted. The step always comes from the order's
/// real status on the server ([stepFor]); tapping a step never changes anything.
class PipelineStepper extends StatelessWidget {
  final int currentStep; // 0 to 3
  final ValueChanged<int>? onStepTapped;

  const PipelineStepper({
    super.key,
    required this.currentStep,
    this.onStepTapped,
  });

  static const List<({String label, IconData icon})> steps = [
    (label: 'Go to\nrestaurant', icon: LucideIcons.store),
    (label: 'Ride to\ndrop', icon: LucideIcons.package),
    (label: 'At drop\npoint', icon: LucideIcons.mapPin),
    (label: 'Delivered', icon: LucideIcons.packageCheck),
  ];

  /// Server status -> step index.
  static int stepFor(OrderStatus status) => switch (status) {
        OrderStatus.pickedUp => 1,
        OrderStatus.arrivedAtGate => 2,
        OrderStatus.delivered => 3,
        _ => 0,
      };

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < steps.length; i++)
          Expanded(
            child: _StepNode(
              index: i,
              currentStep: currentStep,
              label: steps[i].label,
              icon: steps[i].icon,
              isFirst: i == 0,
              isLast: i == steps.length - 1,
              onTap: onStepTapped == null ? null : () => onStepTapped!(i),
            ),
          ),
      ],
    );
  }
}

class _StepNode extends StatelessWidget {
  const _StepNode({
    required this.index,
    required this.currentStep,
    required this.label,
    required this.icon,
    required this.isFirst,
    required this.isLast,
    required this.onTap,
  });

  final int index, currentStep;
  final String label;
  final IconData icon;
  final bool isFirst, isLast;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final done = currentStep > index;
    final current = currentStep == index;
    final size = current ? 48.0 : 38.0;
    final lineLeft = currentStep >= index ? k.brand : k.line;
    final lineRight = currentStep > index ? k.brand : k.line;

    final node = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: 48,
          child: Row(
            children: [
              Expanded(
                  child: Container(
                      height: 3,
                      color: isFirst ? Colors.transparent : lineLeft)),
              AnimatedContainer(
                duration: KMotion.base,
                curve: KMotion.spring,
                width: size,
                height: size,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: done
                      ? k.brandSoft
                      : current
                          ? k.brand
                          : k.surfaceAlt,
                  border: Border.all(
                      color: done || current ? k.brand : k.line, width: 2),
                  boxShadow: current ? KShadow.glow(k.brand) : null,
                ),
                child: Icon(
                  done ? LucideIcons.check : icon,
                  size: current ? 24 : 18,
                  color: done
                      ? k.brand
                      : current
                          ? k.onBrand
                          : k.inkFaint,
                ),
              ),
              Expanded(
                  child: Container(
                      height: 3,
                      color: isLast ? Colors.transparent : lineRight)),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label,
              textAlign: TextAlign.center,
              maxLines: 2,
              softWrap: false,
              style: KraveoType.caption.copyWith(
                color: current ? k.ink : (done ? k.inkMuted : k.inkFaint),
                fontWeight: current ? FontWeight.w800 : FontWeight.w600,
                fontVariations: [FontVariation('wght', current ? 800 : 600)],
                fontSize: 12,
                height: 1.2,
              ),
            ),
          ),
        ),
      ],
    );

    final semantic =
        'Step ${index + 1} of 4: ${label.replaceAll('\n', ' ')}${current ? ', current step' : done ? ', done' : ''}';
    if (onTap == null) {
      return Semantics(label: semantic, child: ExcludeSemantics(child: node));
    }
    return KPressable(
        semanticLabel: semantic,
        onTap: onTap,
        scale: 0.94,
        child: ExcludeSemantics(child: node));
  }
}
