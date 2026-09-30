import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../widgets/ui/bar_chart.dart';
import '../widgets/ui/screen_header.dart';

enum _Period { day, week }

class _PeriodData {
  const _PeriodData({
    required this.total,
    required this.trips,
    required this.labels,
    required this.values,
    required this.breakdown,
    required this.incentives,
  });

  final int total, trips, incentives;
  final List<String> labels;
  final List<double> values;
  final List<(String, int, IconData)> breakdown;
}

class EarningsHistoryScreen extends StatefulWidget {
  const EarningsHistoryScreen({super.key});

  @override
  State<EarningsHistoryScreen> createState() => _EarningsHistoryScreenState();
}

class _EarningsHistoryScreenState extends State<EarningsHistoryScreen> {
  _Period _period = _Period.week;
  int _selected = 5; // Saturday in week view

  // Placeholder figures (unchanged from the previous screen) until the earnings API is wired.
  static const _week = _PeriodData(
    total: 3240,
    trips: 84,
    incentives: 350,
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    values: [320, 480, 640, 410, 730, 850, 460],
    breakdown: [
      ('Base delivery fare', 2420, LucideIcons.bike),
      ('Surge & peak bonus', 420, LucideIcons.zap),
      ('Student tips', 150, LucideIcons.gift),
      ('Campus target incentives', 250, LucideIcons.target),
    ],
  );

  static const _day = _PeriodData(
    total: 460,
    trips: 11,
    incentives: 50,
    labels: ['12p', '3p', '6p', '9p', '12a'],
    values: [40, 60, 120, 160, 80],
    breakdown: [
      ('Base delivery fare', 360, LucideIcons.bike),
      ('Surge & peak bonus', 60, LucideIcons.zap),
      ('Student tips', 20, LucideIcons.gift),
      ('Campus target incentives', 20, LucideIcons.target),
    ],
  );

  _PeriodData get _data => _period == _Period.week ? _week : _day;

  void _setPeriod(_Period p) {
    setState(() {
      _period = p;
      _selected = p == _Period.week ? 5 : 3;
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final d = _data;
    final sel = _selected.clamp(0, d.values.length - 1);
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    final avg = d.trips > 0 ? (d.total / d.trips) : 0.0;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.only(bottom: bottomInset + 24),
          children: [
            const ScreenHeader(title: 'Earnings'),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: Row(children: [
                KChoiceChip(label: 'Today', selected: _period == _Period.day, onTap: () => _setPeriod(_Period.day)),
                const SizedBox(width: 10),
                KChoiceChip(label: 'This week', selected: _period == _Period.week, onTap: () => _setPeriod(_Period.week)),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 20, KSpace.gutter, 0),
              child: KCard(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_period == _Period.week ? 'TOTAL THIS WEEK' : 'TOTAL TODAY', style: KraveoType.label.copyWith(color: k.inkMuted, letterSpacing: 1.2)),
                    const SizedBox(height: 2),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: KAnimatedNumber(key: ValueKey(_period), value: d.total, prefix: '₹', style: KraveoType.displayLg.copyWith(fontSize: 64, height: 1.05, color: k.ink)),
                    ),
                    const SizedBox(height: 18),
                    KBarChart(
                      values: d.values,
                      labels: d.labels,
                      selected: sel,
                      onSelect: (i) => setState(() => _selected = i),
                    ),
                    const SizedBox(height: 14),
                    Row(children: [
                      Icon(LucideIcons.chartColumn, size: 18, color: k.inkMuted),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text('${d.labels[sel]}: ₹${d.values[sel].toInt()}',
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
                      ),
                    ]),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 0),
              child: Row(children: [
                Expanded(child: KStatTile(label: 'Trips', icon: LucideIcons.bike, tint: KStatus.pickedUp.color, value: KAnimatedNumber(key: ValueKey('t$_period'), value: d.trips, style: KraveoType.numeric.copyWith(color: k.ink)))),
                const SizedBox(width: 12),
                Expanded(child: KStatTile(label: 'Per trip', icon: LucideIcons.trendingUp, value: KAnimatedNumber(key: ValueKey('a$_period'), value: avg, prefix: '₹', decimals: 0, style: KraveoType.numeric.copyWith(color: k.ink)))),
              ]),
            ),
            const SectionLabel('Where it came from'),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: KCard(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
                child: Column(children: [
                  for (var i = 0; i < d.breakdown.length; i++) ...[
                    if (i > 0) Divider(color: k.line, height: 1),
                    _BreakdownRow(label: d.breakdown[i].$1, amount: d.breakdown[i].$2, icon: d.breakdown[i].$3),
                  ],
                ]),
              ),
            ),
            const SectionLabel('Bank / UPI payouts'),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: Column(children: [
                _PayoutTile(id: 'Payout #PAY-9921', date: 'Aug 05, 2026', amount: '₹2,780'),
                SizedBox(height: 10),
                _PayoutTile(id: 'Payout #PAY-9810', date: 'Jul 29, 2026', amount: '₹3,150'),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

class _BreakdownRow extends StatelessWidget {
  const _BreakdownRow({required this.label, required this.amount, required this.icon});
  final String label;
  final int amount;
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
        Expanded(child: Text(label, style: KraveoType.body.copyWith(color: k.ink))),
        const SizedBox(width: 8),
        Text('₹$amount', style: KraveoType.numericSm.copyWith(color: k.ink)),
      ]),
    );
  }
}

class _PayoutTile extends StatelessWidget {
  const _PayoutTile({required this.id, required this.date, required this.amount});
  final String id, date, amount;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      padding: const EdgeInsets.all(16),
      child: Row(children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
          child: Icon(LucideIcons.landmark, size: 22, color: k.brand),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(id, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink)),
            Text(date, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
        const SizedBox(width: 8),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(amount, style: KraveoType.numericSm.copyWith(color: k.ink)),
          const SizedBox(height: 4),
          const KStatusPill(status: KStatus.delivered, label: 'Paid', compact: true),
        ]),
      ]),
    );
  }
}
