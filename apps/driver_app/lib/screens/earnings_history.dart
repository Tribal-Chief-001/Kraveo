import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../state/rider_controller.dart';
import '../widgets/swipe_accept_card.dart' show OfferCard;
import '../widgets/ui/bar_chart.dart';
import '../widgets/ui/screen_header.dart';

enum _Period { day, week }

/// Delivery fees from the rider's real delivered orders (`GET /orders?scope=history`).
///
/// Kraveo has no payout API yet, so this screen never shows payouts, bonuses or tips: only the sum
/// of `deliveryFee` on orders this rider delivered, labelled as such.
class EarningsHistoryScreen extends StatefulWidget {
  const EarningsHistoryScreen({super.key, required this.controller});

  final RiderController controller;

  @override
  State<EarningsHistoryScreen> createState() => _EarningsHistoryScreenState();
}

class _EarningsHistoryScreenState extends State<EarningsHistoryScreen> {
  _Period _period = _Period.week;
  int? _selected;

  static const _weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: widget.controller, builder: (context, _) => _build(context));
  }

  Widget _build(BuildContext context) {
    final k = context.k;
    final c = widget.controller;
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    final days = c.last7Days;
    final values = [for (final d in days) RiderController.feesOf(c.deliveredOn(d))];
    final labels = [for (final d in days) _weekday[d.weekday - 1]];
    final sel = (_selected ?? days.length - 1).clamp(0, days.length - 1);
    final orders = _period == _Period.week ? c.deliveredThisWeek : c.deliveredToday;
    final total = RiderController.feesOf(orders);
    final avg = orders.isEmpty ? 0.0 : total / orders.length;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: c.loadHistory,
          child: ListView(
            padding: EdgeInsets.only(bottom: bottomInset + 24),
            children: [
              const ScreenHeader(title: 'Earnings'),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
                child: Row(children: [
                  KChoiceChip(label: 'Today', selected: _period == _Period.day, onTap: () => setState(() => _period = _Period.day)),
                  const SizedBox(width: 10),
                  KChoiceChip(label: 'This week', selected: _period == _Period.week, onTap: () => setState(() => _period = _Period.week)),
                ]),
              ),
              if (c.historyError)
                Padding(
                  padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 0),
                  child: Row(children: [
                    Icon(LucideIcons.wifiOff, size: 18, color: k.inkMuted),
                    const SizedBox(width: 8),
                    Expanded(child: Text('Could not load all your orders. Pull down to try again.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                  ]),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 20, KSpace.gutter, 0),
                child: KCard(
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                  child: !c.historyLoaded && c.historyLoading
                      ? const Padding(
                          padding: EdgeInsets.symmetric(vertical: 32),
                          child: Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))),
                        )
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(_period == _Period.week ? 'DELIVERY FEES · LAST 7 DAYS' : 'DELIVERY FEES TODAY',
                                style: KraveoType.label.copyWith(color: k.inkMuted, letterSpacing: 1.2)),
                            const SizedBox(height: 2),
                            FittedBox(
                              fit: BoxFit.scaleDown,
                              alignment: Alignment.centerLeft,
                              child: KAnimatedNumber(key: ValueKey(_period), value: total, prefix: '₹', style: KraveoType.displayLg.copyWith(fontSize: 64, height: 1.05, color: k.ink)),
                            ),
                            if (_period == _Period.week) ...[
                              const SizedBox(height: 18),
                              KBarChart(values: values, labels: labels, selected: sel, onSelect: (i) => setState(() => _selected = i)),
                              const SizedBox(height: 14),
                              Row(children: [
                                Icon(LucideIcons.chartColumn, size: 18, color: k.inkMuted),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text('${labels[sel]}: ₹${values[sel].toStringAsFixed(values[sel] == values[sel].roundToDouble() ? 0 : 2)}',
                                      maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
                                ),
                              ]),
                            ],
                          ],
                        ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 0),
                child: Row(children: [
                  Expanded(child: KStatTile(label: 'Delivered', icon: LucideIcons.bike, tint: KStatus.pickedUp.color, value: KAnimatedNumber(key: ValueKey('t$_period'), value: orders.length, style: KraveoType.numeric.copyWith(color: k.ink)))),
                  const SizedBox(width: 12),
                  Expanded(child: KStatTile(label: 'Fee per trip', icon: LucideIcons.trendingUp, value: KAnimatedNumber(key: ValueKey('a$_period'), value: avg, prefix: '₹', decimals: 0, style: KraveoType.numeric.copyWith(color: k.ink)))),
                ]),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(LucideIcons.info, size: 18, color: k.inkFaint),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'This is the delivery fee on each order you delivered, from Kraveo\'s records. Payouts are settled by Kraveo separately and are not shown in the app yet.',
                      style: KraveoType.bodySm.copyWith(color: k.inkFaint),
                    ),
                  ),
                ]),
              ),
              const SectionLabel('Delivered orders'),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
                child: orders.isEmpty
                    ? Text(_period == _Period.week ? 'No delivered orders in the last 7 days.' : 'No delivered orders today yet.',
                        style: KraveoType.body.copyWith(color: k.inkMuted))
                    : KCard(
                        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
                        child: Column(children: [
                          for (var i = 0; i < orders.length; i++) ...[
                            if (i > 0) Divider(color: k.line, height: 1),
                            _BreakdownRow(
                              label: '${orders[i].shortRef} · ${orders[i].restaurantName}',
                              amount: OfferCard.rupees(orders[i].deliveryFee),
                              icon: LucideIcons.bike,
                            ),
                          ],
                        ]),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BreakdownRow extends StatelessWidget {
  const _BreakdownRow({required this.label, required this.amount, required this.icon});
  final String label;
  final String amount;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      constraints: const BoxConstraints(minHeight: 60),
      alignment: Alignment.center,
      child: Row(children: [
        Icon(icon, size: 22, color: k.brand),
        const SizedBox(width: 14),
        Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.ink))),
        const SizedBox(width: 8),
        Text(amount, style: KraveoType.numericSm.copyWith(color: k.ink)),
      ]),
    );
  }
}
