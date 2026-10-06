import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/settlement.dart';
import '../services/payout/payout_api.dart';
import '../services/payout/settlements_controller.dart';
import '../widgets/ui/settlement_status_chip.dart';
import '../widgets/ui/vendor_ui.dart';

/// Keys for tests.
const Key kSettlementsRetryKey = ValueKey('settlements-retry');
const Key kSettlementsEmptyKey = ValueKey('settlements-empty');
const Key kSettlementsMoreKey = ValueKey('settlements-load-more');
const Key kSettlementsStaleKey = ValueKey('settlements-stale-note');
ValueKey<String> settlementCardKey(String id) => ValueKey('settlement-card-$id');

/// "+₹5" / "-₹3" for a credit or a debit.
String formatSigned(double amount) => amount > 0 ? '+${formatRupees(amount)}' : formatRupees(amount);

/// "My settlements": read-only list of what Kraveo pays this restaurant. Only restaurant-side amounts are shown
/// (what the restaurant earned, adjustments, what it receives); never customer prices, fees or commission.
class SettlementsScreen extends StatefulWidget {
  const SettlementsScreen({super.key, required this.controller, required this.api});

  final SettlementsController controller;

  /// For the detail screen opened from a row.
  final PayoutApi api;

  @override
  State<SettlementsScreen> createState() => _SettlementsScreenState();
}

class _SettlementsScreenState extends State<SettlementsScreen> {
  SettlementsController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_c.loadedOnce && !_c.loading) _c.load();
    });
  }

  void _open(Settlement s) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SettlementDetailScreen(controller: SettlementDetailController(api: widget.api, id: s.id), summary: s),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        backgroundColor: k.bg,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(tooltip: 'Back', icon: Icon(LucideIcons.arrowLeft, color: k.ink, size: 26), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(child: ListenableBuilder(listenable: _c, builder: (context, _) => _body(context, k))),
    );
  }

  Widget _title(KraveoTokens k) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 0, 4, 14),
        child: Semantics(
          header: true,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('My settlements', style: KraveoType.headline.copyWith(color: k.ink, fontSize: 28)),
            const SizedBox(height: 4),
            Text('मेरे भुगतान', style: KraveoType.titleLg.copyWith(color: k.inkMuted, fontSize: 21)),
          ]),
        ),
      );

  Widget _body(BuildContext context, KraveoTokens k) {
    if (!_c.loadedOnce) {
      if (_c.failure == null) return const Center(child: CircularProgressIndicator());
      return VMaxWidth(
        child: VScrollCenter(
          child: KEmptyState(
            icon: LucideIcons.wifiOff,
            title: "Can't load your settlements",
            message: _c.failure!.both,
            action: KButton(key: kSettlementsRetryKey, label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, loading: _c.loading, onPressed: _c.load),
          ),
        ),
      );
    }
    final items = _c.items;
    return Material(
      color: Colors.transparent,
      child: VMaxWidth(
        child: RefreshIndicator(
          onRefresh: _c.load,
          child: items.isEmpty
              ? VScrollCenter(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    if (_c.failure != null) Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 8), child: _StaleNote(text: _c.failure!.both)),
                    const KEmptyState(
                      key: kSettlementsEmptyKey,
                      icon: LucideIcons.wallet,
                      title: 'No payouts yet',
                      message: 'Payouts are made every evening for delivered orders.\nडिलीवर हुए ऑर्डर का पेआउट हर शाम होता है।',
                    ),
                  ]),
                )
              : ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 32),
                  children: [
                    _title(k),
                    if (_c.failure != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: _StaleNote(text: 'Could not refresh. ${_c.failure!.both}')),
                    for (final s in items) Padding(padding: const EdgeInsets.only(bottom: 12), child: _SettlementCard(settlement: s, onTap: () => _open(s))),
                    if (_c.moreFailure != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: _StaleNote(text: _c.moreFailure!.both)),
                    if (_c.hasMore)
                      KButton(
                        key: kSettlementsMoreKey,
                        label: 'Show older payouts',
                        sublabel: 'पुराने भुगतान दिखाएं',
                        kind: KButtonKind.tonal,
                        large: true,
                        loading: _c.loadingMore,
                        onPressed: _c.loadMore,
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _StaleNote extends StatelessWidget {
  const _StaleNote({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      key: kSettlementsStaleKey,
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: KraveoPalette.warning.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(KRadius.lg), border: Border.all(color: KraveoPalette.warning.withValues(alpha: 0.6))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(LucideIcons.triangleAlert, size: 20, color: k.ink),
        const SizedBox(width: 10),
        Expanded(child: Text(text, style: KraveoType.bodySm.copyWith(color: k.ink, fontSize: 14, fontWeight: FontWeight.w700))),
      ]),
    );
  }
}

class _SettlementCard extends StatelessWidget {
  const _SettlementCard({required this.settlement, required this.onTap});

  final Settlement settlement;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final s = settlement;
    final period = settlementPeriodText(s.periodStart, s.periodEnd);
    final orders = '${s.orderCount} ${s.orderCount == 1 ? 'order' : 'orders'}';
    return Semantics(
      button: true,
      label: 'Settlement $period, ${settlementStatusWords(s.status).english}, $orders, you receive ${formatRupees(s.netPayable)}',
      excludeSemantics: true,
      onTap: onTap,
      child: KCard(
        key: settlementCardKey(s.id),
        onTap: onTap,
        elevated: false,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text(period, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800))),
            const SizedBox(width: 8),
            VSettlementStatusChip(status: s.status),
          ]),
          const SizedBox(height: 4),
          Text(orders, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          const SizedBox(height: 10),
          Text('You receive  ·  आपको मिलेगा', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
          Row(children: [
            Expanded(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(formatRupees(s.netPayable), key: const ValueKey('settlement-net'), style: KraveoType.headline.copyWith(color: k.ink, fontSize: 28)))),
            Icon(LucideIcons.chevronRight, size: 22, color: k.inkFaint),
          ]),
          if (s.adjustmentTotal != 0)
            Text('Includes ${formatSigned(s.adjustmentTotal)} adjustment', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          if (s.isPaid) ..._paidLines(k),
          if (s.status == SettlementStatus.onHold)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Kraveo is holding this payout for now.  ·  Kraveo ने यह भुगतान अभी रोका है', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
            ),
        ]),
      ),
    );
  }

  List<Widget> _paidLines(KraveoTokens k) {
    final s = settlement;
    return [
      const SizedBox(height: 6),
      if (s.paidAt != null) Text('Paid on ${formatIstDate(s.paidAt!)}', style: KraveoType.body.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w700)),
      if (s.paymentReference != null) Text('UTR: ${s.paymentReference}', style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
    ];
  }
}

/// One settlement: the per-dish lines, the orders and the adjustments. All amounts are what the RESTAURANT earns.
class SettlementDetailScreen extends StatefulWidget {
  const SettlementDetailScreen({super.key, required this.controller, this.summary});

  final SettlementDetailController controller;

  /// The list row it was opened from: shown at once while the details load.
  final Settlement? summary;

  @override
  State<SettlementDetailScreen> createState() => _SettlementDetailScreenState();
}

class _SettlementDetailScreenState extends State<SettlementDetailScreen> {
  SettlementDetailController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _c.detail == null && !_c.loading) _c.load();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        backgroundColor: k.bg,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: IconButton(tooltip: 'Back', icon: Icon(LucideIcons.arrowLeft, color: k.ink, size: 26), onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(child: ListenableBuilder(listenable: _c, builder: (context, _) => _body(context, k))),
    );
  }

  Widget _body(BuildContext context, KraveoTokens k) {
    final detail = _c.detail;
    final s = detail?.settlement ?? widget.summary;
    if (s == null) {
      if (_c.failure == null) return const Center(child: CircularProgressIndicator());
      return VMaxWidth(
        child: VScrollCenter(
          child: KEmptyState(
            icon: LucideIcons.wifiOff,
            title: "Can't load this payout",
            message: _c.failure!.both,
            action: KButton(key: kSettlementsRetryKey, label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, loading: _c.loading, onPressed: _c.load),
          ),
        ),
      );
    }
    return Material(
      color: Colors.transparent,
      child: VMaxWidth(
        child: RefreshIndicator(
          onRefresh: _c.load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 32),
            children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Semantics(header: true, child: Text(settlementPeriodText(s.periodStart, s.periodEnd), style: KraveoType.headline.copyWith(color: k.ink, fontSize: 26)))),
                const SizedBox(width: 8),
                VSettlementStatusChip(status: s.status),
              ]),
              const SizedBox(height: 14),
              _Summary(settlement: s),
              if (_c.failure != null) Padding(padding: const EdgeInsets.only(top: 12), child: _StaleNote(text: _c.failure!.both)),
              if (detail == null && _c.failure == null) const Padding(padding: EdgeInsets.symmetric(vertical: 28), child: Center(child: CircularProgressIndicator())),
              if (detail != null) ..._sections(k, detail),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _sections(KraveoTokens k, SettlementDetail d) {
    Widget heading(String en, String hi) => VSectionLabel(english: en, hindi: hi);
    return [
      const SizedBox(height: 8),
      heading('Dishes', 'व्यंजन'),
      if (d.dishes.isEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('No dish lines.  ·  कोई व्यंजन नहीं', style: KraveoType.body.copyWith(color: k.inkMuted)))
      else
        KCard(
          elevated: false,
          child: Column(children: [
            for (var i = 0; i < d.dishes.length; i++) ...[
              if (i > 0) Divider(height: 18, color: k.line),
              _Line(key: ValueKey('dish-line-$i'), title: d.dishes[i].name, subtitle: '${d.dishes[i].units} ${d.dishes[i].units == 1 ? 'portion' : 'portions'}', amount: formatRupees(d.dishes[i].amount)),
            ],
          ]),
        ),
      heading('Orders', 'ऑर्डर'),
      if (d.orders.isEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('No orders listed.  ·  कोई ऑर्डर नहीं', style: KraveoType.body.copyWith(color: k.inkMuted)))
      else
        KCard(
          elevated: false,
          child: Column(children: [
            for (var i = 0; i < d.orders.length; i++) ...[
              if (i > 0) Divider(height: 18, color: k.line),
              _Line(
                key: ValueKey('order-line-$i'),
                title: 'Order ${d.orders[i].shortId}',
                subtitle: d.orders[i].deliveredAt == null ? null : 'Delivered ${formatIstDateTime(d.orders[i].deliveredAt!)}',
                amount: formatRupees(d.orders[i].amount),
              ),
            ],
          ]),
        ),
      if (d.ordersTruncated)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text('Only the first ${d.orders.length} of ${d.settlement.orderCount} orders are listed.  ·  पूरी सूची नहीं दिखाई गई', key: const ValueKey('orders-truncated'), style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        ),
      if (d.adjustments.isNotEmpty) ...[
        heading('Adjustments', 'समायोजन'),
        KCard(
          elevated: false,
          child: Column(children: [
            for (var i = 0; i < d.adjustments.length; i++) ...[
              if (i > 0) Divider(height: 18, color: k.line),
              _Line(
                key: ValueKey('adjustment-line-$i'),
                title: d.adjustments[i].reason.isEmpty ? 'Adjustment' : d.adjustments[i].reason,
                subtitle: d.adjustments[i].createdAt == null ? null : formatIstDate(d.adjustments[i].createdAt!),
                amount: formatSigned(d.adjustments[i].amount),
              ),
            ],
          ]),
        ),
      ],
    ];
  }
}

/// Earned + adjustments = you receive, and the payment reference once paid.
class _Summary extends StatelessWidget {
  const _Summary({required this.settlement});

  final Settlement settlement;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final s = settlement;
    final orders = '${s.orderCount} ${s.orderCount == 1 ? 'order' : 'orders'}';
    return KCard(
      key: const ValueKey('settlement-summary'),
      color: k.brandSoft,
      elevated: false,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _Line(title: 'You earned for $orders', amount: formatRupees(s.vendorAmount)),
        if (s.adjustmentTotal != 0) ...[
          const SizedBox(height: 8),
          _Line(title: 'Adjustments', amount: formatSigned(s.adjustmentTotal)),
        ],
        Divider(height: 24, color: k.line),
        Text('You receive  ·  आपको मिलेगा', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
        FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(formatRupees(s.netPayable), key: const ValueKey('settlement-net'), style: KraveoType.headline.copyWith(color: k.ink, fontSize: 32))),
        if (s.isPaid) ...[
          const SizedBox(height: 8),
          if (s.paidAt != null) Text('Paid on ${formatIstDateTime(s.paidAt!)}', style: KraveoType.body.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w700)),
          if (s.paymentReference != null) Text('UTR: ${s.paymentReference}', key: const ValueKey('settlement-utr'), style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
        ],
      ]),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({super.key, required this.title, required this.amount, this.subtitle});

  final String title;
  final String? subtitle;
  final String amount;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w700)),
          if (subtitle != null) Text(subtitle!, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13.5)),
        ]),
      ),
      const SizedBox(width: 12),
      Text(amount, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w800)),
    ]);
  }
}
