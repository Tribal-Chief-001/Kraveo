import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Glove-sized numeric keypad (0-9 + backspace). Each key is 64dp tall.
class KKeypad extends StatelessWidget {
  const KKeypad({super.key, required this.onDigit, required this.onBackspace, this.enabled = true});

  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    Widget row(List<Widget> keys) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(children: [
            for (var i = 0; i < keys.length; i++) ...[
              if (i > 0) const SizedBox(width: 10),
              Expanded(child: keys[i]),
            ],
          ]),
        );

    Widget digit(String d) => _Key(
          key: ValueKey('otp-key-$d'),
          semanticLabel: 'Digit $d',
          enabled: enabled,
          onTap: () => onDigit(d),
          child: _DigitLabel(d),
        );

    return Column(mainAxisSize: MainAxisSize.min, children: [
      row([digit('1'), digit('2'), digit('3')]),
      row([digit('4'), digit('5'), digit('6')]),
      row([digit('7'), digit('8'), digit('9')]),
      row([
        const SizedBox(height: 64),
        digit('0'),
        _Key(
          key: const ValueKey('otp-key-backspace'),
          semanticLabel: 'Delete last digit',
          enabled: enabled,
          onTap: onBackspace,
          quiet: true,
          child: Icon(LucideIcons.delete, size: 28, color: context.k.inkMuted),
        ),
      ]),
    ]);
  }
}

class _DigitLabel extends StatelessWidget {
  const _DigitLabel(this.d);
  final String d;

  @override
  Widget build(BuildContext context) => Text(d, style: KraveoType.numeric.copyWith(color: context.k.ink, fontSize: 30));
}

class _Key extends StatelessWidget {
  const _Key({super.key, required this.child, required this.onTap, required this.semanticLabel, this.enabled = true, this.quiet = false});

  final Widget child;
  final VoidCallback onTap;
  final String semanticLabel;
  final bool enabled;
  final bool quiet;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      semanticLabel: semanticLabel,
      haptic: false,
      onTap: enabled
          ? () {
              HapticFeedback.lightImpact();
              onTap();
            }
          : null,
      child: Container(
        height: 64,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: quiet ? Colors.transparent : k.surfaceAlt,
          borderRadius: BorderRadius.circular(KRadius.lg),
          border: Border.all(color: quiet ? Colors.transparent : k.line),
        ),
        child: ExcludeSemantics(child: child),
      ),
    );
  }
}
