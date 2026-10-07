import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../widgets/dhaba_card.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/floating_bar.dart';
import '../widgets/ui/hostel_pill.dart';
import '../widgets/ui/k_icon_button.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/status_map.dart';
import 'dhaba_menu_screen.dart';
import 'live_tracking_screen.dart';
import 'order_history_screen.dart';
import 'profile_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _currentTab = 0;

  /// Catch up on order changes and the kitchen catalog (open / closed, sold out, new kitchens)
  /// when the app returns to the foreground (contract 3).
  late final AppLifecycleListener _lifecycle = AppLifecycleListener(onResume: () {
    if (!mounted) return;
    context.read<OrderProvider>().onAppResumed();
    unawaited(context.read<DhabaProvider>().loadCatalog());
  });
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lifecycle; // start listening
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(Provider.of<DhabaProvider>(context, listen: false).loadCatalog());
    });
  }

  /// Pull-to-refresh on Home: kitchens and orders. Says so when the kitchens could not be refreshed.
  Future<void> _refreshHome() async {
    final orders = context.read<OrderProvider>();
    final dhabas = context.read<DhabaProvider>();
    unawaited(orders.refreshActive());
    final ok = await dhabas.loadCatalog();
    if (!mounted || ok) return;
    showKSnack(context, 'Couldn\'t refresh the kitchens. Check your connection and try again.', error: true);
  }

  final List<String> hostelBlocks = kHostelBlocks;

  @override
  void dispose() {
    _lifecycle.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _goToTab(int index) => setState(() => _currentTab = index);

  /// Drop-off point changes made from Home are saved to the profile too, so the Me tab,
  /// checkout and the next launch all agree. Reverts (with a message) if saving fails.
  Future<void> _changeHostel(String block) async {
    final result = await context.read<SessionProvider>().changeHostel(block);
    if (!mounted || result.success || result.unauthorized) return;
    showKSnack(
      context,
      result.networkError ? 'Couldn\'t save your drop-off point. Check your connection.' : (result.message ?? 'Couldn\'t save your drop-off point.'),
      error: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final selectedHostel = context.select<SessionProvider, String?>((s) => s.deliveryPoint);
    // Back on Orders / Track / Me returns to the Home tab first; only Home itself leaves the app.
    return PopScope(
      canPop: _currentTab == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _currentTab != 0) _goToTab(0);
      },
      child: _buildScaffold(context, k, selectedHostel),
    );
  }

  Widget _buildScaffold(BuildContext context, KraveoTokens k, String? selectedHostel) {
    return Scaffold(
      backgroundColor: k.bg,
      extendBody: true,
      body: IndexedStack(
        index: _currentTab,
        children: [
          // Builder: the feed must read the padding Scaffold reports for the floating nav.
          Builder(builder: _buildHomeFeed),
          LiveTrackingScreen(visible: _currentTab == 1, onExplore: () => _goToTab(0)),
          OrderHistoryScreen(
            selectedHostel: selectedHostel,
            onTrackOrder: () => _goToTab(1),
            onExplore: () => _goToTab(0),
          ),
          ProfileScreen(onOpenOrders: () => _goToTab(2), onTrackOrder: () => _goToTab(1)),
        ],
      ),
      bottomNavigationBar: KGlassNav(
        index: _currentTab,
        onChanged: _goToTab,
        items: const [
          KNavItem(LucideIcons.house, 'Home'),
          KNavItem(LucideIcons.bike, 'Track'),
          KNavItem(LucideIcons.receiptText, 'Orders'),
          KNavItem(LucideIcons.user, 'Me'),
        ],
      ),
    );
  }

  String _greeting() {
    final hour = DateTime.now().hour;
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 22) return 'Good evening';
    return 'Up late?';
  }

  Widget _buildHomeFeed(BuildContext context) {
    final k = context.k;
    final dhabaProvider = Provider.of<DhabaProvider>(context);
    final orderProvider = Provider.of<OrderProvider>(context);
    final session = context.watch<SessionProvider>();
    final selectedHostel = session.deliveryPoint;
    final activeOrder = orderProvider.activeOrder;
    final showActiveBar = activeOrder != null && activeOrder.status.isLive;
    final dhabas = dhabaProvider.dhabas;
    final catalogLoading = dhabaProvider.isCatalogLoading;
    final catalogFailed = dhabaProvider.hasCatalogFailed;
    final noKitchens = dhabaProvider.allDhabas.isEmpty;
    final chips = dhabaProvider.categories;
    final filtering = dhabaProvider.searchQuery.trim().isNotEmpty || dhabaProvider.selectedCategoryIndex != 0 || dhabaProvider.showFavoritesOnly;
    // With extendBody the scaffold reports the floating nav's height as bottom padding.
    final navInset = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      backgroundColor: k.bg,
      body: Stack(children: [
        RefreshIndicator(
          onRefresh: _refreshHome,
          edgeOffset: 76,
          child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverAppBar(
              pinned: true,
              toolbarHeight: 76,
              backgroundColor: k.bg,
              surfaceTintColor: Colors.transparent,
              automaticallyImplyLeading: false,
              titleSpacing: KSpace.gutter,
              title: Align(
                alignment: Alignment.centerLeft,
                child: HostelPill(
                  selectedHostel: selectedHostel,
                  hostelBlocks: hostelBlocks,
                  onChanged: _changeHostel,
                ),
              ),
              actions: [
                KIconButton(
                  icon: LucideIcons.heart,
                  semanticLabel: dhabaProvider.showFavoritesOnly ? 'Show all kitchens' : 'Show favourite kitchens only',
                  color: dhabaProvider.showFavoritesOnly ? KraveoPalette.danger : k.ink,
                  background: dhabaProvider.showFavoritesOnly ? KraveoPalette.danger.withValues(alpha: 0.12) : k.surface,
                  onTap: dhabaProvider.toggleFavoritesOnly,
                ),
                const SizedBox(width: KSpace.gutter),
              ],
            ),
            SliverToBoxAdapter(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                KReveal(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 0),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        if (session.user?.avatarId != null) ...[
                          ExcludeSemantics(child: KAvatar(id: session.user!.avatarId, size: 30)),
                          const SizedBox(width: 10),
                        ],
                        Expanded(
                          child: Text(
                            session.user?.firstName.isNotEmpty == true ? '${_greeting()}, ${session.user!.firstName}'.toUpperCase() : _greeting().toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.2),
                          ),
                        ),
                      ]),
                      const SizedBox(height: 6),
                      KDisplayText('What are you\ncraving?', style: KraveoType.displayMd.copyWith(color: k.ink)),
                    ]),
                  ),
                ),
                KReveal(
                  index: 1,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 18, KSpace.gutter, 0),
                    child: _SearchField(
                      controller: _searchController,
                      onChanged: dhabaProvider.setSearchQuery,
                      onClear: () {
                        _searchController.clear();
                        dhabaProvider.setSearchQuery('');
                      },
                    ),
                  ),
                ),
                // The first-order promo is only shown to a student who has no earlier order (the
                // server refuses VITFIRST otherwise); while that is unknown it stays hidden.
                if (!filtering && orderProvider.isFirstTimeCustomer) const KReveal(index: 2, child: _PromoCard()) else const SizedBox(height: 16),
                // Chips come from the live menus; with nothing to choose between there is no row.
                if (chips.length > 1)
                  KReveal(
                    index: 3,
                    child: SizedBox(
                      height: 52,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter, vertical: 4),
                        itemCount: chips.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 8),
                        itemBuilder: (context, index) {
                          final label = chips[index];
                          return KChoiceChip(
                            label: label,
                            icon: _categoryIcon(label),
                            selected: dhabaProvider.selectedCategoryIndex == index,
                            onTap: () => dhabaProvider.setSelectedCategoryIndex(index),
                          );
                        },
                      ),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(KSpace.gutter, 22, KSpace.gutter, 14),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                    Expanded(
                      child: Text(
                        dhabaProvider.showFavoritesOnly ? 'Your favourites' : 'Kitchens near campus',
                        style: KraveoType.headlineSm.copyWith(color: k.ink),
                      ),
                    ),
                    if (!catalogLoading && !catalogFailed)
                      Text(dhabas.length == 1 ? '1 place' : '${dhabas.length} places', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
                  ]),
                ),
              ]),
            ),
            if (catalogLoading)
              const SliverPadding(padding: EdgeInsets.symmetric(horizontal: KSpace.gutter), sliver: _SkeletonList())
            else if (catalogFailed && noKitchens)
              SliverToBoxAdapter(
                child: KEmptyState(
                  icon: LucideIcons.wifiOff,
                  title: 'Can\'t load kitchens',
                  message: 'Check your connection, then try again. Pull down to refresh also works.',
                  action: KButton(
                    label: 'Try again',
                    kind: KButtonKind.tonal,
                    expand: false,
                    icon: LucideIcons.rotateCcw,
                    onPressed: () => unawaited(dhabaProvider.loadCatalog()),
                  ),
                ),
              )
            else if (noKitchens)
              SliverToBoxAdapter(
                child: KEmptyState(
                  icon: LucideIcons.store,
                  title: 'No kitchens are open right now',
                  message: 'Kitchens near campus will show up here as soon as they open. Pull down to check again.',
                  action: KButton(
                    label: 'Refresh',
                    kind: KButtonKind.tonal,
                    expand: false,
                    icon: LucideIcons.rotateCcw,
                    onPressed: _refreshHome,
                  ),
                ),
              )
            else if (dhabas.isEmpty)
              SliverToBoxAdapter(
                child: KEmptyState(
                  icon: dhabaProvider.showFavoritesOnly ? LucideIcons.heartOff : LucideIcons.searchX,
                  title: dhabaProvider.showFavoritesOnly ? 'No favourites yet' : 'No kitchens match',
                  message: dhabaProvider.showFavoritesOnly
                      ? 'Tap the heart on any kitchen to keep it here for quick reorders.'
                      : 'Try a different search or category, or clear the filters to see every kitchen.',
                  action: KButton(
                    label: 'Clear filters',
                    kind: KButtonKind.tonal,
                    expand: false,
                    icon: LucideIcons.rotateCcw,
                    onPressed: () {
                      _searchController.clear();
                      dhabaProvider.setSearchQuery('');
                      dhabaProvider.setSelectedCategoryIndex(0);
                      if (dhabaProvider.showFavoritesOnly) dhabaProvider.toggleFavoritesOnly();
                    },
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final dhaba = dhabas[index];
                      return KReveal(
                        key: ValueKey(dhaba.id),
                        index: index,
                        child: DhabaCard(
                          dhaba: dhaba,
                          onFavoriteToggle: () => dhabaProvider.toggleFavorite(dhaba.id),
                          onTap: () {
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (context) => DhabaMenuScreen(
                                  dhaba: dhaba,
                                  selectedHostel: selectedHostel,
                                ),
                              ),
                            );
                          },
                        ),
                      );
                    },
                    childCount: dhabas.length,
                  ),
                ),
              ),
            SliverToBoxAdapter(child: SizedBox(height: navInset + (showActiveBar ? 96 : 24))),
          ],
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: navInset + 8,
          child: KBarSwitcher(
            visible: showActiveBar,
            child: showActiveBar ? _ActiveOrderBar(orderProvider: orderProvider, onTap: () => _goToTab(1)) : const SizedBox.shrink(),
          ),
        ),
      ]),
    );
  }

  static IconData _categoryIcon(String label) {
    switch (label.toLowerCase()) {
      case 'all':
        return LucideIcons.utensilsCrossed;
      case 'night mess':
        return LucideIcons.moon;
      case 'thalis':
        return LucideIcons.cookingPot;
      case 'fast food':
        return LucideIcons.sandwich;
      case 'beverages':
        return LucideIcons.cupSoda;
      case 'north indian':
        return LucideIcons.flame;
      case 'parathas':
        return LucideIcons.wheat;
      default:
        return LucideIcons.utensils;
    }
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({required this.controller, required this.onChanged, required this.onClear});

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      decoration: BoxDecoration(borderRadius: KRadius.control, boxShadow: KShadow.soft(k.shadowTint)),
      child: ValueListenableBuilder<TextEditingValue>(
        valueListenable: controller,
        builder: (context, value, _) => TextField(
          controller: controller,
          onChanged: onChanged,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'Search parathas, thalis, kitchens',
            prefixIcon: Icon(LucideIcons.search, size: 20, color: k.brand),
            suffixIcon: value.text.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear search',
                    icon: Icon(LucideIcons.x, size: 18, color: k.inkMuted),
                    onPressed: onClear,
                  ),
            contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          ),
        ),
      ),
    );
  }
}

/// The one promo we actually have: the VITFIRST coupon that the cart understands.
class _PromoCard extends StatelessWidget {
  const _PromoCard();

  static const String _code = 'VITFIRST';

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 18, KSpace.gutter, 18),
      child: KPressable(
        semanticLabel: 'Copy coupon code $_code',
        onTap: () {
          Clipboard.setData(const ClipboardData(text: _code));
          showKSnack(context, '$_code copied. Apply it in your cart.', icon: LucideIcons.ticket);
        },
        scale: 0.98,
        child: Container(
          width: double.infinity,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: k.brand,
            borderRadius: BorderRadius.circular(KRadius.xl),
            boxShadow: KShadow.lift(k.shadowTint),
          ),
          child: Stack(children: [
            Positioned(
              right: -34,
              top: -34,
              child: Container(width: 150, height: 150, decoration: BoxDecoration(color: KraveoPalette.g700.withValues(alpha: 0.55), shape: BoxShape.circle)),
            ),
            Positioned(
              right: 14,
              bottom: 10,
              child: Icon(LucideIcons.badgePercent, size: 64, color: k.onBrand.withValues(alpha: 0.14)),
            ),
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('FIRST ORDER', style: KraveoType.label.copyWith(color: k.onBrand.withValues(alpha: 0.75), letterSpacing: 1.2)),
                const SizedBox(height: 6),
                Text('20% off,\nup to ₹50', style: KraveoType.headline.copyWith(color: k.onBrand)),
                const SizedBox(height: 4),
                Text('On orders of ₹100 or more.', style: KraveoType.bodySm.copyWith(color: k.onBrand.withValues(alpha: 0.85))),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  decoration: BoxDecoration(color: k.accent, borderRadius: BorderRadius.circular(KRadius.pill)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(_code, style: KraveoType.button.copyWith(color: k.onAccent, fontSize: 14, letterSpacing: 1.2)),
                    const SizedBox(width: 8),
                    Icon(LucideIcons.copy, size: 15, color: k.onAccent),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _SkeletonList extends StatelessWidget {
  const _SkeletonList();

  @override
  Widget build(BuildContext context) {
    return SliverList(
      delegate: SliverChildListDelegate([
        for (var i = 0; i < 3; i++)
          const Padding(
            padding: EdgeInsets.only(bottom: 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              KSkeleton(height: 210, radius: KRadius.xl),
              SizedBox(height: 12),
              KSkeleton(width: 190, height: 16),
              SizedBox(height: 8),
              KSkeleton(width: 120, height: 12),
            ]),
          ),
      ]),
    );
  }
}

class _ActiveOrderBar extends StatelessWidget {
  const _ActiveOrderBar({required this.orderProvider, required this.onTap});

  final OrderProvider orderProvider;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final order = orderProvider.activeOrder!;
    return KFloatingBar(
      semanticLabel: 'Active order from ${order.title}: ${orderHeadline(order)}. Open tracking',
      onTap: onTap,
      leading: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.16), shape: BoxShape.circle),
        child: Icon(LucideIcons.bike, size: 22, color: k.onBrand),
      ),
      title: Text(orderHeadline(order), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.onBrand)),
      subtitle: order.otpCode != null
          ? 'Gate OTP ${order.otpCode}'
          : (order.awaitsPayment ? 'Pay by ${clockLabel(order.paymentDeadline)} · ${order.title}' : order.title),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Text('Track', style: KraveoType.button.copyWith(color: k.onBrand, fontSize: 14)),
        const SizedBox(width: 4),
        Icon(LucideIcons.arrowRight, size: 18, color: k.onBrand),
      ]),
    );
  }
}
