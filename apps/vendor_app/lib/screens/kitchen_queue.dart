import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../services/failure_messages.dart';
import '../services/order_queue_controller.dart';
import '../widgets/order_card.dart';
import '../widgets/ui/ui.dart';

/// The Orders tab: everything comes from [OrderQueueController] (the server's copy of each order).
class KitchenQueueScreen extends StatefulWidget {
  const KitchenQueueScreen({super.key, required this.controller, this.onOpenIncoming, this.firstRun});

  /// A card shown above the "No orders right now" text on the Active tab ("1. Add a dish  2. Tap OPEN").
  final Widget? firstRun;

  final OrderQueueController controller;

  /// Opens the accept / reject takeover for a waiting order.
  final void Function(String orderId)? onOpenIncoming;

  @override
  State<KitchenQueueScreen> createState() => _KitchenQueueScreenState();
}

class _KitchenQueueScreenState extends State<KitchenQueueScreen> {
  int _selectedTab = 0; // 0 = Active (new, preparing, ready), 1 = History
  String _searchQuery = '';
  bool _searchOpen = false;
  final TextEditingController _searchController = TextEditingController();

  OrderQueueController get _c => widget.controller;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _openHistory() {
    setState(() => _selectedTab = 1);
    if (!_c.historyLoadedOnce && !_c.historyLoading) _c.loadMoreHistory();
  }

  bool _matches(OrderModel o) {
    if (_searchQuery.isEmpty) return true;
    final q = _searchQuery.toLowerCase();
    return o.shortCode.toLowerCase().contains(q) ||
        o.id.toLowerCase().contains(q) ||
        o.studentName.toLowerCase().contains(q) ||
        o.studentLocation.toLowerCase().contains(q) ||
        o.items.any((it) => it.name.toLowerCase().contains(q));
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: _c, builder: (context, _) => _build(context));
  }

  Widget _build(BuildContext context) {
    final k = context.k;
    final incoming = _c.incoming.where(_matches).toList();
    final kitchen = _c.kitchen;
    final finished = _c.finished.where(_matches).toList();
    final activeCount = _c.incoming.length + kitchen.length;

    final toStart = kitchen.where((o) => o.status == OrderStatus.accepted && _matches(o)).toList()
      ..sort((a, b) => _c.prepDeadlineFor(a).compareTo(_c.prepDeadlineFor(b)));
    // Most urgent first: the promised-by time never changes, so this order stays put
    // under the cook's thumb while the countdowns tick.
    final cooking = kitchen.where((o) => o.status == OrderStatus.preparing && _matches(o)).toList()
      ..sort((a, b) => _c.prepDeadlineFor(a).compareTo(_c.prepDeadlineFor(b)));
    final ready = kitchen.where((o) => o.status == OrderStatus.readyForPickup && _matches(o)).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));

    final children = <Widget>[];
    var revealIndex = 0;
    Widget card(OrderModel o) => KReveal(
          key: ValueKey('reveal-${o.id}'),
          index: revealIndex++,
          child: OrderCard(
            key: ValueKey(o.id),
            order: o,
            controller: _c,
            onOpenIncoming: widget.onOpenIncoming == null ? null : () => widget.onOpenIncoming!(o.id),
          ),
        );

    if (_selectedTab == 0) {
      if (incoming.isNotEmpty) {
        children.add(VSectionLabel(english: 'New orders', hindi: 'नए ऑर्डर', count: incoming.length, color: kDangerDeep));
        children.addAll(incoming.map(card));
      }
      if (toStart.isNotEmpty) {
        children.add(VSectionLabel(english: 'Accepted', hindi: 'शुरू करना है', count: toStart.length));
        children.addAll(toStart.map(card));
      }
      if (cooking.isNotEmpty) {
        children.add(VSectionLabel(english: 'Preparing', hindi: 'बन रहे हैं', count: cooking.length));
        children.addAll(cooking.map(card));
      }
      if (ready.isNotEmpty) {
        children.add(VSectionLabel(english: 'Ready for pickup', hindi: 'तैयार', count: ready.length));
        children.addAll(ready.map(card));
      }
    } else {
      children.addAll(finished.map(card));
      if (_c.historyFailure != null) {
        children.add(_InlineProblem(text: failureText(_c.historyFailure!), onRetry: _c.loadMoreHistory));
      } else if (_c.historyLoading) {
        children.add(const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())));
      } else if (_c.historyHasMore && _c.historyLoadedOnce) {
        children.add(Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 8),
          child: KButton(
            key: const ValueKey('history-more'),
            label: 'Show older orders',
            sublabel: 'पुराने ऑर्डर दिखाएं',
            kind: KButtonKind.tonal,
            large: true,
            onPressed: _c.loadMoreHistory,
          ),
        ));
      }
    }

    final Widget body;
    if (!_c.loadedOnce && _selectedTab == 0 && children.isEmpty) {
      body = _c.syncFailure == null
          ? const VScrollCenter(child: _Loading())
          : VScrollCenter(child: KEmptyState(
              icon: LucideIcons.wifiOff,
              title: "Can't load orders",
              message: '${failureText(_c.syncFailure!).both}\nRetrying every 15 seconds.',
              action: KButton(label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, onPressed: _c.refresh),
            ));
    } else if (children.isEmpty) {
      body = RefreshIndicator(
        onRefresh: _selectedTab == 0 ? _c.refresh : _c.reloadHistory,
        child: ListView(children: [
          if (_selectedTab == 0 && _searchQuery.isEmpty && widget.firstRun != null)
            Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 0), child: widget.firstRun),
          KEmptyState(
            icon: _selectedTab == 0 ? LucideIcons.chefHat : LucideIcons.history,
            title: _searchQuery.isNotEmpty
                ? 'No matching orders'
                : _selectedTab == 0
                    ? 'No orders right now'
                    : 'No history yet',
            message: _searchQuery.isNotEmpty
                ? 'Try a different name or order number.\nदूसरा नाम या नंबर आज़माएं।'
                : _selectedTab == 0
                    ? 'New orders will ring loudly and show here.\nनया ऑर्डर आते ही अलार्म बजेगा।'
                    : 'Finished orders will be listed here.\nपूरे हुए ऑर्डर यहाँ दिखेंगे।',
          ),
        ]),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: _selectedTab == 0 ? _c.refresh : _c.reloadHistory,
        child: ListView(
          // One scroll position per tab (switching tabs must not land in the middle of the other list).
          key: PageStorageKey<String>('orders-tab-$_selectedTab'),
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 24),
          children: children,
        ),
      );
    }

    return VMaxWidth(
      child: Column(
        children: [
          if (_c.syncFailure != null && _c.loadedOnce)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 10, KSpace.gutter, 0),
              child: _SyncBanner(controller: _c),
            ),
          if (_c.liveAlertsRefused && _c.syncFailure == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 10, KSpace.gutter, 0),
              child: Container(
                key: const ValueKey('live-alerts-off'),
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.md)),
                child: Row(children: [
                  Icon(LucideIcons.radioTower, size: 20, color: k.inkMuted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text('Live alerts are off. New orders still show within 15 seconds.  ·  लाइव अलर्ट बंद, हर 15 सेकंड में जाँच',
                        style: KraveoType.bodySm.copyWith(color: k.ink, fontSize: 13)),
                  ),
                ]),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 8),
            child: Row(children: [
              Expanded(
                child: VChoiceChip(
                  label: 'Active',
                  sublabel: 'चालू · $activeCount',
                  selected: _selectedTab == 0,
                  onTap: () => setState(() => _selectedTab = 0),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: VChoiceChip(
                  label: 'History',
                  sublabel: 'पुराने · ${_c.finished.length}',
                  selected: _selectedTab == 1,
                  onTap: _openHistory,
                ),
              ),
              const SizedBox(width: 8),
              Semantics(
                button: true,
                label: _searchOpen ? 'Close search' : 'Search orders',
                excludeSemantics: true,
                child: KPressable(
                  onTap: () => setState(() {
                    _searchOpen = !_searchOpen;
                    if (!_searchOpen) {
                      _searchQuery = '';
                      _searchController.clear();
                    }
                  }),
                  child: Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: _searchOpen ? k.brandSoft : k.surface,
                      borderRadius: BorderRadius.circular(KRadius.lg),
                      border: Border.all(color: _searchOpen ? k.brand : k.line, width: 1.5),
                    ),
                    child: Icon(_searchOpen ? LucideIcons.x : LucideIcons.search, size: 26, color: k.brand),
                  ),
                ),
              ),
            ]),
          ),
          AnimatedSize(
            duration: KMotion.base,
            curve: KMotion.emphasized,
            alignment: Alignment.topCenter,
            child: _searchOpen
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 8),
                    child: TextField(
                      controller: _searchController,
                      autofocus: true,
                      onChanged: (val) => setState(() => _searchQuery = val),
                      style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 18),
                      decoration: InputDecoration(
                        hintText: 'Search order, name or dish  ·  खोजें',
                        prefixIcon: Icon(LucideIcons.search, size: 22, color: k.inkFaint),
                      ),
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
          Expanded(child: body),
        ],
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(width: 32, height: 32, child: CircularProgressIndicator(strokeWidth: 3)),
        const SizedBox(height: 14),
        Text('Loading orders…', style: KraveoType.titleMd.copyWith(color: k.ink)),
        Text('ऑर्डर आ रहे हैं', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
      ]),
    );
  }
}

/// "Offline - showing orders from 7:42 PM": the list on screen is the last good copy, never wiped.
class _SyncBanner extends StatelessWidget {
  const _SyncBanner({required this.controller});
  final OrderQueueController controller;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final at = controller.lastSyncAt;
    final text = failureText(controller.syncFailure!);
    return Semantics(
      liveRegion: true,
      child: Container(
        key: const ValueKey('sync-banner'),
        padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
        decoration: BoxDecoration(
          color: Color.alphaBlend(KraveoPalette.warning.withValues(alpha: 0.16), k.surface),
          borderRadius: BorderRadius.circular(KRadius.md),
          border: Border.all(color: KraveoPalette.warning, width: 1.5),
        ),
        child: Row(children: [
          Icon(LucideIcons.wifiOff, size: 22, color: k.ink),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(text.english, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w700)),
              Text(
                at == null ? 'Retrying every 15 s · फिर कोशिश जारी' : 'Showing orders from ${formatClock(at)} · पुरानी जानकारी',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13),
              ),
            ]),
          ),
          Semantics(
            button: true,
            label: 'Retry now',
            excludeSemantics: true,
            child: KPressable(
              onTap: controller.refresh,
              child: SizedBox(width: 52, height: 52, child: Icon(LucideIcons.rotateCcw, size: 24, color: k.brand)),
            ),
          ),
        ]),
      ),
    );
  }
}

class _InlineProblem extends StatelessWidget {
  const _InlineProblem({required this.text, required this.onRetry});
  final FailureText text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(children: [
        Text(text.english, textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.ink)),
        Text(text.hindi, textAlign: TextAlign.center, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        const SizedBox(height: 8),
        KButton(label: 'Try again', sublabel: 'फिर कोशिश करें', kind: KButtonKind.tonal, large: true, onPressed: onRetry),
      ]),
    );
  }
}
