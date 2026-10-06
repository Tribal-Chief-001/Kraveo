import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'format.dart';

/// A rupee amount that counts up to [value] like `KAnimatedNumber`, but always formatted with
/// [rupee] so paise are shown whenever the amount has any (the shared widget only offers a fixed
/// number of decimals).
class KMoneyText extends StatelessWidget {
  const KMoneyText({super.key, required this.value, this.style});

  final num value;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: value.toDouble()),
      duration: KMotion.slow,
      curve: KMotion.emphasized,
      builder: (_, v, __) => Text(rupee(v), style: style ?? KraveoType.numeric.copyWith(color: context.k.ink)),
    );
  }
}
