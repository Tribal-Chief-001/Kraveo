import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Home hero: today's delivery fees (summed from the rider's real delivered orders) + two tiles.
/// These are the orders' delivery fees, not a payout statement: Kraveo has no payout API yet.
class EarningsCard extends StatelessWidget {
  final double todayEarnings;
  final int completedTrips;
  final double weekFees;
  final VoidCallback? onTap;

  /// The delivery history could not be loaded, so the sums above are unknown, not zero: the numbers show "—"
  /// with a small retry hint instead of a made-up "₹0".
  final bool unavailable;
  final VoidCallback? onRetry;

  const EarningsCard({
    super.key,
    required this.todayEarnings,
    required this.completedTrips,
    required this.weekFees,
    this.onTap,
    this.unavailable = false,
    this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final avg = completedTrips > 0 ? (todayEarnings / completedTrips).round() : 0;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        KCard(
          onTap: onTap,
          padding: const EdgeInsets.fromLTRB(20, 18, 16, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(LucideIcons.wallet, size: 18, color: k.inkMuted),
                const SizedBox(width: 8),
                Expanded(child: Text('DELIVERY FEES TODAY', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.inkMuted, letterSpacing: 1.2))),
                if (onTap != null) Icon(LucideIcons.chevronRight, size: 22, color: k.inkFaint),
              ]),
              const SizedBox(height: 4),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: unavailable
                    ? Text('—', key: const ValueKey('earnings-unavailable'), style: KraveoType.displayLg.copyWith(fontSize: 60, height: 1.05, color: k.inkFaint))
                    : KAnimatedNumber(
                        value: todayEarnings,
                        prefix: '₹',
                        style: KraveoType.displayLg.copyWith(fontSize: 60, height: 1.05, color: k.ink),
                      ),
              ),
              if (unavailable)
                KPressable(
                  key: const ValueKey('earnings-retry'),
                  semanticLabel: 'Could not load your fees. Double tap to retry.',
                  onTap: onRetry,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: ExcludeSemantics(
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(LucideIcons.rotateCcw, size: 16, color: k.brand),
                        const SizedBox(width: 6),
                        Flexible(child: Text('Could not load. Tap to retry', style: KraveoType.bodySm.copyWith(color: k.brand))),
                      ]),
                    ),
                  ),
                )
              else if (completedTrips > 0)
                Text('Avg ₹$avg per trip', style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: _MiniStat(
              icon: LucideIcons.bike,
              tint: KStatus.pickedUp.color,
              label: 'Trips today',
              value: unavailable
                  ? Text('—', style: KraveoType.numericSm.copyWith(color: k.inkFaint, fontSize: 28))
                  : KAnimatedNumber(value: completedTrips, style: KraveoType.numericSm.copyWith(color: k.ink, fontSize: 28)),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _MiniStat(
              icon: LucideIcons.calendarDays,
              tint: k.brand,
              label: 'Fees, 7 days',
              value: unavailable
                  ? Text('—', style: KraveoType.numericSm.copyWith(color: k.inkFaint, fontSize: 28))
                  : KAnimatedNumber(value: weekFees, prefix: '₹', style: KraveoType.numericSm.copyWith(color: k.ink, fontSize: 28)),
            ),
          ),
        ]),
      ],
    );
  }
}

/// Compact stat tile: icon, big value, small label. Roughly 72dp tall.
class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.icon, required this.tint, required this.label, required this.value});

  final IconData icon;
  final Color tint;
  final String label;
  final Widget value;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      constraints: const BoxConstraints(minHeight: 72),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: k.line),
      ),
      child: Row(children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(color: tint.withValues(alpha: 0.16), shape: BoxShape.circle),
          child: Icon(icon, size: 18, color: tint),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: value),
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.caption.copyWith(color: k.inkMuted)),
            ],
          ),
        ),
      ]),
    );
  }
}
