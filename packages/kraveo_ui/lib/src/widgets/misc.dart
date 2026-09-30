import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';
import 'pressable.dart';

/// Fade + rise entrance. Wrap list items with increasing `index` for a staggered reveal.
class KReveal extends StatelessWidget {
  const KReveal({super.key, required this.child, this.index = 0, this.dy = 18});
  final Widget child;
  final int index;
  final double dy;

  @override
  Widget build(BuildContext context) {
    final delay = (index.clamp(0, 12)) * 55;
    final total = 380 + delay;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: total),
      curve: Interval(delay / total, 1, curve: Curves.easeOutCubic),
      builder: (_, v, c) => Opacity(opacity: v, child: Transform.translate(offset: Offset(0, (1 - v) * dy), child: c)),
      child: child,
    );
  }
}

/// Count-up numbers (earnings, order totals, coins).
class KAnimatedNumber extends StatelessWidget {
  const KAnimatedNumber({super.key, required this.value, this.prefix = '', this.suffix = '', this.style, this.decimals = 0});
  final num value;
  final String prefix, suffix;
  final TextStyle? style;
  final int decimals;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: value.toDouble()),
      duration: KMotion.slow,
      curve: KMotion.emphasized,
      builder: (_, v, __) => Text('$prefix${v.toStringAsFixed(decimals)}$suffix', style: style ?? KraveoType.numeric.copyWith(color: context.k.ink)),
    );
  }
}

class KSectionHeader extends StatelessWidget {
  const KSectionHeader(this.title, {super.key, this.action, this.onAction, this.padding = const EdgeInsets.fromLTRB(KSpace.gutter, 24, KSpace.gutter, 12)});
  final String title;
  final String? action;
  final VoidCallback? onAction;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: padding,
      child: Row(children: [
        Expanded(child: Text(title, style: KraveoType.headlineSm.copyWith(color: k.ink))),
        if (action != null)
          KPressable(onTap: onAction, child: Text(action!, style: KraveoType.label.copyWith(color: k.brand, fontSize: 13))),
      ]),
    );
  }
}

/// Selectable pill (categories, filters, prep-time picks).
class KChoiceChip extends StatelessWidget {
  const KChoiceChip({super.key, required this.label, required this.selected, required this.onTap, this.icon});
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      onTap: onTap,
      child: AnimatedContainer(
        duration: KMotion.base,
        curve: KMotion.emphasized,
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: k.minTap >= 64 ? 16 : 11),
        decoration: BoxDecoration(
          color: selected ? k.brand : k.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? k.brand : k.line, width: 1.2),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[Icon(icon, size: 16, color: selected ? k.onBrand : k.inkMuted), const SizedBox(width: 6)],
          Text(label, style: KraveoType.label.copyWith(fontSize: 13.5, color: selected ? k.onBrand : k.inkMuted)),
        ]),
      ),
    );
  }
}

class KEmptyState extends StatelessWidget {
  const KEmptyState({super.key, required this.icon, required this.title, this.message, this.action});
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(icon, size: 36, color: k.brand),
          ),
          const SizedBox(height: 20),
          Text(title, textAlign: TextAlign.center, style: KraveoType.headlineSm.copyWith(color: k.ink)),
          if (message != null) ...[
            const SizedBox(height: 8),
            Text(message!, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted)),
          ],
          if (action != null) ...[const SizedBox(height: 24), action!],
        ]),
      ),
    );
  }
}

class KStatTile extends StatelessWidget {
  const KStatTile({super.key, required this.label, required this.value, this.icon, this.hint, this.tint});
  final String label;
  final Widget value;
  final IconData? icon;
  final String? hint;
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final c = tint ?? k.brand;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: KRadius.card,
        border: Border.all(color: k.line.withValues(alpha: 0.7)),
        boxShadow: k.isDark ? null : KShadow.soft(k.shadowTint),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (icon != null)
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, size: 18, color: c),
            ),
          if (icon != null) const SizedBox(width: 10),
          Expanded(child: Text(label, style: KraveoType.label.copyWith(color: k.inkMuted))),
        ]),
        const SizedBox(height: 14),
        value,
        if (hint != null) ...[const SizedBox(height: 4), Text(hint!, style: KraveoType.bodySm.copyWith(color: k.inkFaint))],
      ]),
    );
  }
}

/// Big, unmistakable 4-digit code (gate OTP).
class KOtpDisplay extends StatelessWidget {
  const KOtpDisplay({super.key, required this.code});
  final String code;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(mainAxisAlignment: MainAxisAlignment.center, children: [
      for (final ch in code.split(''))
        Container(
          width: 62,
          height: 78,
          margin: const EdgeInsets.symmetric(horizontal: 5),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: k.accent,
            borderRadius: BorderRadius.circular(KRadius.lg),
            boxShadow: KShadow.glow(k.accent).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.35))).toList(),
          ),
          child: Text(ch, style: KraveoType.numeric.copyWith(color: k.onAccent, fontSize: 40)),
        ),
    ]);
  }
}

/// Bottom sheet with drag handle + Kraveo shape.
Future<T?> showKSheet<T>(BuildContext context, {required WidgetBuilder builder, bool scroll = true}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: scroll,
    useSafeArea: true,
    backgroundColor: context.k.surface,
    builder: (ctx) => Column(mainAxisSize: MainAxisSize.min, children: [
      const SizedBox(height: 10),
      Container(width: 44, height: 5, decoration: BoxDecoration(color: ctx.k.line, borderRadius: BorderRadius.circular(3))),
      const SizedBox(height: 6),
      Flexible(child: builder(ctx)),
    ]),
  );
}
