import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../widgets/ui/ui.dart';

/// Earnings, kept honest and simple: everything below is computed from real orders the app has loaded from
/// Kraveo (the active queue plus the history pages). Nothing is invented; when today's history could not be
/// loaded completely the screen says so instead of showing a confident number.
class SalesAnalyticsScreen extends StatelessWidget {
  final List<OrderModel> orders;

  /// "Now" (injected by tests); defaults to the phone's clock.
  final DateTime? now;

  /// False when some of today's orders may be missing (history still loading or failed to load).
  final bool complete;
  final bool loading;
  final VoidCallback? onRetry;

  const SalesAnalyticsScreen({super.key, required this.orders, this.now, this.complete = true, this.loading = false, this.onRetry});

  static String _h12(int h) => '${h % 12 == 0 ? 12 : h % 12}';
  static String _ampm(int h) => (h % 24) < 12 ? 'AM' : 'PM';

  /// "10-11 PM", or "11 PM-12 AM" when the hour crosses noon / midnight.
  static String _hourRange(int h) {
    final next = (h + 1) % 24;
    return _ampm(h) == _ampm(next) ? '${_h12(h)}-${_h12(next)} ${_ampm(h)}' : '${_h12(h)} ${_ampm(h)}-${_h12(next)} ${_ampm(next)}';
  }

  /// Orders that count as sales: paid and not cancelled.
  static bool _counts(OrderModel o) => o.status != OrderStatus.cancelled && o.status != OrderStatus.unknown && o.isPaid;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final clock = (now ?? DateTime.now()).toLocal();
    final startOfToday = DateTime(clock.year, clock.month, clock.day);

    final counted = orders.where(_counts).toList();
    final today = counted.where((o) => !o.createdAt.isBefore(startOfToday)).toList();
    final cancelledToday = orders.where((o) => o.status == OrderStatus.cancelled && !o.createdAt.isBefore(startOfToday)).length;
    final totalSales = today.fold<double>(0, (sum, o) => sum + o.foodValue);
    final totalOrdersCount = today.length;

    if (counted.isEmpty) {
      if (loading) return const Center(child: CircularProgressIndicator());
      return VMaxWidth(
        child: VScrollCenter(
          child: KEmptyState(
            icon: LucideIcons.chartColumn,
            title: 'No orders yet',
            message: complete ? 'Your earnings will show up here after your first order.\nपहला ऑर्डर आते ही कमाई यहाँ दिखेगी।' : "Could not load your past orders.\nपुराने ऑर्डर नहीं आ पाए।",
            action: (!complete && onRetry != null) ? KButton(label: 'Try again', sublabel: 'फिर कोशिश करें', kind: KButtonKind.tonal, large: true, onPressed: onRetry) : null,
          ),
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
    final oldest = counted.map((o) => o.createdAt).reduce((a, b) => a.isBefore(b) ? a : b);
    final windowLabel = 'From your last ${counted.length} paid orders, since ${oldest.day}/${oldest.month}  ·  पिछले ${counted.length} ऑर्डर से';

    final hasTrend = counted.length >= 3;

    return VMaxWidth(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 32),
        children: [
          if (!complete)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: KCard(
                key: const ValueKey('earnings-incomplete'),
                color: Color.alphaBlend(KraveoPalette.warning.withValues(alpha: 0.16), k.surface),
                elevated: false,
                child: Row(children: [
                  Icon(LucideIcons.triangleAlert, size: 22, color: k.ink),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      loading ? 'Loading today\'s orders… numbers may still grow.  ·  लोड हो रहा है' : 'Some of today\'s orders could not be loaded. Numbers may be low.  ·  पूरी जानकारी नहीं आई',
                      style: KraveoType.bodySm.copyWith(color: k.ink, fontSize: 14),
                    ),
                  ),
                  if (!loading && onRetry != null) TextButton(onPressed: onRetry, child: const Text('Retry')),
                ]),
              ),
            ),
          // 3 honest numbers, all for today (since midnight)
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
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
            child: Text('Food items of today\'s paid orders (since midnight), before Kraveo fees.  ·  सिर्फ खाने का दाम', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
          ),
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: KReveal(
                index: 1,
                child: KStatTile(
                  label: 'ORDERS TODAY',
                  icon: LucideIcons.receipt,
                  hint: 'आज के ऑर्डर',
                  value: FittedBox(
                      fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: KAnimatedNumber(value: totalOrdersCount, style: KraveoType.numeric.copyWith(fontSize: 44, color: k.ink))),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: KReveal(
                index: 2,
                child: KStatTile(
                  label: 'CANCELLED TODAY',
                  icon: LucideIcons.circleX,
                  hint: 'आज रद्द',
                  tint: KraveoPalette.warning,
                  value:
                      FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: KAnimatedNumber(value: cancelledToday, style: KraveoType.numeric.copyWith(fontSize: 44, color: k.ink))),
                ),
              ),
            ),
          ]),

          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
            child: Text(windowLabel, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
          ),
          const VSectionLabel(english: 'Busy hours', hindi: 'व्यस्त समय'),
          KReveal(
            index: 3,
            child: KCard(
              padding: const EdgeInsets.fromLTRB(14, 18, 14, 16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                VHourChart(
                  hours: hours,
                  counts: counts,
                  semanticsLabel: hasTrend ? 'Orders per hour. Busiest: ${_hourRange(peakHour)}, ${perHour[peak]} orders.' : 'Orders per hour. Not enough orders yet.',
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
