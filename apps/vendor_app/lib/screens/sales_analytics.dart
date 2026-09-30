import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../widgets/ui/ui.dart';

/// Earnings, kept honest and simple: everything below is computed from the orders the
/// app is holding right now - nothing is invented.
class SalesAnalyticsScreen extends StatelessWidget {
  final List<OrderModel> orders;

  const SalesAnalyticsScreen({super.key, required this.orders});

  static String _h12(int h) => '${h % 12 == 0 ? 12 : h % 12}';
  static String _ampm(int h) => (h % 24) < 12 ? 'AM' : 'PM';

  /// "10-11 PM", or "11 PM-12 AM" when the hour crosses noon / midnight.
  static String _hourRange(int h) {
    final next = (h + 1) % 24;
    return _ampm(h) == _ampm(next) ? '${_h12(h)}-${_h12(next)} ${_ampm(h)}' : '${_h12(h)} ${_ampm(h)}-${_h12(next)} ${_ampm(next)}';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;

    // Live metrics, same sources as before.
    final counted = orders.where((o) => o.status != OrderStatus.cancelled).toList();
    final totalSales = counted.fold<double>(0, (sum, o) => sum + o.totalAmount);
    final totalOrdersCount = counted.length;
    final avgPrepTime = counted.isNotEmpty ? (counted.fold<int>(0, (sum, o) => sum + o.prepTimeMinutes) / counted.length).round() : 0;

    if (counted.isEmpty) {
      return const VMaxWidth(
        child: KEmptyState(
          icon: LucideIcons.chartColumn,
          title: 'No orders yet',
          message: 'Your earnings will show up here after your first order.\nपहला ऑर्डर आते ही कमाई यहाँ दिखेगी।',
        ),
      );
    }

    // Orders per hour. The day is counted from 6 AM so a night shift (8 PM - 2 AM) stays
    // in one continuous run instead of splitting at midnight.
    final perHour = List<int>.filled(24, 0); // index = hours since 6 AM
    for (final o in counted) {
      perHour[(o.createdAt.hour - 6 + 24) % 24]++;
    }
    var first = perHour.indexWhere((c) => c > 0);
    var last = perHour.lastIndexWhere((c) => c > 0);
    var peak = 0;
    for (var i = 0; i < 24; i++) {
      if (perHour[i] > perHour[peak]) peak = i;
    }
    // Show at least 5 bars and at most 10 (a window around the busiest hour).
    while (last - first + 1 < 5) {
      if (first > 0) first--;
      if (last - first + 1 < 5 && last < 23) last++;
    }
    if (last - first + 1 > 10) {
      first = (peak - 5).clamp(first, last - 9).toInt();
      last = first + 9;
    }
    final shifted = [for (var i = first; i <= last; i++) i];
    final hours = [for (final i in shifted) (i + 6) % 24];
    final counts = [for (final i in shifted) perHour[i]];
    final peakHour = (peak + 6) % 24;

    // Top dishes by portions sold.
    final qty = <String, int>{};
    final revenue = <String, double>{};
    for (final o in counted) {
      for (final it in o.items) {
        qty[it.name] = (qty[it.name] ?? 0) + it.quantity;
        revenue[it.name] = (revenue[it.name] ?? 0) + it.totalPrice;
      }
    }
    final topNames = qty.keys.toList()..sort((a, b) => qty[b]!.compareTo(qty[a]!));
    final top = topNames.take(5).toList();
    final maxQty = top.isEmpty ? 1 : qty[top.first]!;

    final hasTrend = totalOrdersCount >= 3;

    return VMaxWidth(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 32),
        children: [
          // 3 honest numbers
          KReveal(
            child: KStatTile(
              label: "TODAY'S EARNINGS",
              icon: LucideIcons.wallet,
              hint: 'आज की कमाई',
              value: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: VMoneyCount(value: totalSales, style: KraveoType.displayLg.copyWith(fontSize: 52, color: k.brand)),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: KReveal(
                index: 1,
                child: KStatTile(
                  label: 'ORDERS',
                  icon: LucideIcons.receipt,
                  hint: 'ऑर्डर',
                  value: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: KAnimatedNumber(value: totalOrdersCount, style: KraveoType.numeric.copyWith(fontSize: 44, color: k.ink))),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: KReveal(
                index: 2,
                child: KStatTile(
                  label: 'AVG PREP TIME',
                  icon: LucideIcons.timer,
                  hint: 'औसत समय',
                  tint: KraveoPalette.warning,
                  value: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: KAnimatedNumber(value: avgPrepTime, suffix: ' min', style: KraveoType.numeric.copyWith(fontSize: 44, color: k.ink))),
                ),
              ),
            ),
          ]),

          const SizedBox(height: 12),
          const VSectionLabel(english: 'Busy hours', hindi: 'व्यस्त समय'),
          KReveal(
            index: 3,
            child: KCard(
              padding: const EdgeInsets.fromLTRB(14, 18, 14, 16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                VHourChart(
                  hours: hours,
                  counts: counts,
                  semanticsLabel: hasTrend
                      ? 'Orders per hour. Busiest: ${_hourRange(peakHour)}, ${perHour[peak]} orders.'
                      : 'Orders per hour. Not enough orders yet.',
                ),
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(LucideIcons.lightbulb, size: 26, color: k.brand),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(
                          hasTrend ? 'Most orders come ${_hourRange(peakHour)}' : 'Not enough orders to see a busy time yet',
                          style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 19, fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          hasTrend ? 'सबसे ज़्यादा ऑर्डर ${_hourRange(peakHour)} के बीच आते हैं' : 'कुछ और ऑर्डर के बाद सबसे व्यस्त समय दिखेगा',
                          style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15),
                        ),
                      ]),
                    ),
                  ]),
                ),
              ]),
            ),
          ),

          const SizedBox(height: 12),
          const VSectionLabel(english: 'Top dishes', hindi: 'सबसे ज़्यादा बिके'),
          KReveal(
            index: 4,
            child: KCard(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              child: Column(children: [
                for (var i = 0; i < top.length; i++) ...[
                  if (i > 0) Divider(height: 1, color: k.line),
                  _TopDishRow(rank: i + 1, name: top[i], sold: qty[top[i]]!, revenue: revenue[top[i]]!, fraction: qty[top[i]]! / maxQty),
                ],
              ]),
            ),
          ),
        ],
      ),
    );
  }
}

class _TopDishRow extends StatelessWidget {
  const _TopDishRow({required this.rank, required this.name, required this.sold, required this.revenue, required this.fraction});
  final int rank;
  final String name;
  final int sold;
  final double revenue;
  final double fraction;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final first = rank == 1;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(children: [
        Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: first ? k.brand : k.brandSoft, shape: BoxShape.circle),
          child: Text('$rank', style: KraveoType.headlineSm.copyWith(color: first ? k.onBrand : k.brand)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 19, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: LinearProgressIndicator(value: fraction.clamp(0.05, 1.0), minHeight: 8, backgroundColor: k.surfaceAlt, color: first ? k.brand : k.brand.withValues(alpha: 0.45)),
            ),
            const SizedBox(height: 4),
            Text('$sold sold  ·  बिके', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          ]),
        ),
        const SizedBox(width: 12),
        Text(formatRupees(revenue), style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
      ]),
    );
  }
}
