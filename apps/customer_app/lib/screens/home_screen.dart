import 'dart:async';
import 'package:flutter/foundation.dart' show ValueListenable, visibleForTesting;
import 'package:flutter/rendering.dart' show ScrollCacheExtent;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../providers/banner_provider.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../widgets/dhaba_card.dart';
import '../widgets/home_banner_carousel.dart';
import '../widgets/ui/category_icons.dart';
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

/// Test hook: how many times the Home feed has been built (a swipe must not add to it).
@visibleForTesting
int debugHomeFeedBuilds = 0;

/// How often Home refreshes the promo banners while it is on screen and the app is in front.
const Duration kBannerRefreshInterval = Duration(minutes: 10);

/// How long after Home appears the other tabs are built in the background.
const Duration kWarmUpDelay = Duration(milliseconds: 1800);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// The tab pager (Home, Track, Orders, Me). Swiping moves it with the finger; the nav's
  /// highlight reads its page position. Pages are kept alive, so scroll positions and screen
  /// state survive swipes exactly as they did with the old IndexedStack.
  PageController _pager = PageController();

  /// The tab the user is on, or is being taken to (back button, selection). While a tap-driven
  /// animation runs this is the TARGET, not the tabs the pager passes through.
  ///
  /// The shell state lives in notifiers, never in setState: a swipe starting, ending or crossing
  /// a page boundary must not rebuild the Scaffold and the whole Home feed (only PopScope, the
  /// tab wrappers and the Track tab's `visible` flag listen).
  final ValueNotifier<int> _currentTab = ValueNotifier(0);

  /// The tab the pager has come to rest on; null while it is being dragged or animated. Drives
  /// the hidden tabs' tickers and semantics only.
  final ValueNotifier<int?> _settledTab = ValueNotifier(0);

  /// Whether the Track tab counts as shown (its timers, socket and map). True only once the pager
  /// has settled on it, and it stays true through a drag that springs back: it turns false when
  /// the page has actually left Track (more than half a page away), so a wobble costs no unwatch,
  /// no refresh and no socket churn.
  final ValueNotifier<bool> _trackVisible = ValueNotifier(false);

  /// The tab a tap-driven animation is heading for (null = none). While set, the pages the pager
  /// passes through are ignored and a second tap on the same target does not restart the animation.
  int? _animTarget;

  /// 1.0 or more while the other tabs are being built in the background (see [_warmUp]).
  final ValueNotifier<double> _warmExtent = ValueNotifier(0);
  Timer? _warmTimer;

  /// Refresh the promo banners now and then while Home is on screen (an admin switching a banner
  /// off reaches an app that stays open); one cheap GET, the last good list survives a failure.
  Timer? _bannerTimer;
  bool _bannerDue = false;

  /// Catch up on order changes and the kitchen catalog (open / closed, sold out, new kitchens)
  /// when the app returns to the foreground (contract 3).
  late final AppLifecycleListener _lifecycle = AppLifecycleListener(onResume: () {
    if (!mounted) return;
    context.read<OrderProvider>().onAppResumed();
    unawaited(context.read<DhabaProvider>().refreshHome());
    _refreshBanners();
  });
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lifecycle; // start listening
    _pager.addListener(_onPagerMoved);
    _bannerTimer = Timer.periodic(kBannerRefreshInterval, (_) => _refreshBannersIfVisible());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(Provider.of<DhabaProvider>(context, listen: false).refreshHome());
      _refreshBanners();
      _warmTimer = Timer(kWarmUpDelay, () => _warmUp(2));
    });
  }

  void _refreshBannersIfVisible() {
    if (!mounted) return;
    final life = WidgetsBinding.instance.lifecycleState;
    if (life != null && life != AppLifecycleState.resumed) return;
    if (_settledTab.value != 0) {
      _bannerDue = true; // refreshed when the user is back on Home
      return;
    }
    _refreshBanners();
  }

  /// Builds the other tabs once, shortly after Home is up, so the first swipe to Orders or Me does
  /// not construct a list mid-gesture (a PageView builds only what is on screen). The pager is
  /// asked to build 2, then 3 viewports around the current page for ~0.4 s each, then goes back to
  /// building nothing extra; the tabs stay alive (keep-alive) and their semantics stay excluded
  /// while hidden (see [_TabPage]), so a screen reader never meets them. The Track tab is built
  /// too, but its map is only created once it is shown (see LiveTrackingScreen).
  void _warmUp(int step) {
    if (!mounted) return;
    _warmExtent.value = step == 2 ? 2 : (step == 3 ? 3 : 0);
    if (step <= 3) _warmTimer = Timer(const Duration(milliseconds: 400), () => _warmUp(step == 2 ? 3 : 4));
  }

  /// The promo banners load in the background with the rest of Home (no spinner, failures keep the
  /// last list). The provider is optional: without it Home simply has no banner row.
  void _refreshBanners() {
    final banners = Provider.of<BannerProvider?>(context, listen: false);
    if (banners != null) unawaited(banners.refresh());
  }

  /// Pull-to-refresh on Home: kitchens and orders. Says so when the kitchens could not be refreshed.
  Future<void> _refreshHome() async {
    final orders = context.read<OrderProvider>();
    final dhabas = context.read<DhabaProvider>();
    unawaited(orders.refreshActive());
    _refreshBanners();
    final ok = await dhabas.refreshHome();
    if (!mounted || ok) return;
    showKSnack(context, 'Couldn\'t refresh the kitchens. Check your connection and try again.', error: true);
  }

  final List<String> hostelBlocks = kHostelBlocks;

  @override
  void dispose() {
    _lifecycle.dispose();
    _bannerTimer?.cancel();
    _warmTimer?.cancel();
    _pager.removeListener(_onPagerMoved);
    _pager.dispose();
    _currentTab.dispose();
    _settledTab.dispose();
    _trackVisible.dispose();
    _warmExtent.dispose();
    _searchController.dispose();
    super.dispose();
  }

  /// Opens a tab: animates the pager (a tap, a banner or a button elsewhere), or jumps when the
  /// platform asks to reduce motion. Before the pager is attached (first frame, app resume)
  /// the shell simply starts on that tab. A far jump animates through the tabs in between:
  /// they are kept alive, so each is built at most once and the motion stays continuous (a
  /// jump-then-animate trick would flash the neighbour's content for one frame).
  void _goToTab(int index) {
    if (index < 0 || index > 3 || index == _animTarget || (index == _currentTab.value && _settledTab.value == index)) return;
    if (!_pager.hasClients) {
      final old = _pager..removeListener(_onPagerMoved);
      _pager = PageController(initialPage: index)..addListener(_onPagerMoved);
      WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
      _currentTab.value = index;
      _settledTab.value = index;
      _trackVisible.value = index == 1;
      setState(() {}); // the PageView and the nav take the new controller
      return;
    }
    _animTarget = index;
    _currentTab.value = index;
    _settledTab.value = null;
    if (index != 1) _trackVisible.value = false;
    if (MediaQuery.disableAnimationsOf(context)) {
      _animTarget = null;
      _pager.jumpToPage(index);
    } else {
      final hops = ((_pager.page ?? index) - index).abs();
      unawaited(_pager
          .animateToPage(index, duration: Duration(milliseconds: hops > 1.5 ? 380 : 320), curve: Curves.easeInOutCubicEmphasized)
          .whenComplete(() {
        if (_animTarget == index) _animTarget = null; // also when there was nothing to animate
      }));
    }
  }

  /// Track stops counting as shown only once the page has really left it (not at drag start).
  void _onPagerMoved() {
    if (!_trackVisible.value || !_pager.hasClients) return;
    final page = _pager.page;
    if (page != null && (page - 1).abs() > 0.5) _trackVisible.value = false;
  }

  /// Tracks the pager's own scrolling (depth 0: scrollables inside the tabs are not ours).
  bool _onPagerScroll(ScrollNotification n) {
    if (n.depth != 0 || n.metrics.axis != Axis.horizontal || !mounted) return false;
    if (n is ScrollStartNotification) {
      if (n.dragDetails != null) _animTarget = null; // a finger took over from an animation
      if (_settledTab.value != null) _settledTab.value = null;
    } else if (n is ScrollEndNotification) {
      final page = (_pager.hasClients ? _pager.page : null)?.round();
      if (page != null) {
        _animTarget = null;
        _currentTab.value = page;
        _settledTab.value = page;
        _trackVisible.value = page == 1;
        if (page == 0 && _bannerDue) {
          _bannerDue = false;
          _refreshBanners();
        }
      }
    }
    return false;
  }

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
    // Only the PopScope listens to the current tab; the Scaffold below is passed in as `child`.
    return ValueListenableBuilder<int>(
      valueListenable: _currentTab,
      child: _buildScaffold(context, k, selectedHostel),
      builder: (context, tab, child) => PopScope(
        canPop: tab == 0,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && _currentTab.value != 0) _goToTab(0);
        },
        child: child!,
      ),
    );
  }

  Widget _buildScaffold(BuildContext context, KraveoTokens k, String? selectedHostel) {
    final pages = <Widget>[
      // Builder: the feed must read the padding Scaffold reports for the floating nav.
      _TabPage(index: 0, settled: _settledTab, child: Builder(builder: _buildHomeFeed)),
      _TabPage(
        index: 1,
        settled: _settledTab,
        child: ValueListenableBuilder<bool>(
          valueListenable: _trackVisible,
          builder: (context, visible, _) => LiveTrackingScreen(visible: visible, onExplore: () => _goToTab(0)),
        ),
      ),
      _TabPage(
        index: 2,
        settled: _settledTab,
        child: OrderHistoryScreen(
          selectedHostel: selectedHostel,
          onTrackOrder: () => _goToTab(1),
          onExplore: () => _goToTab(0),
        ),
      ),
      _TabPage(index: 3, settled: _settledTab, child: ProfileScreen(onOpenOrders: () => _goToTab(2), onTrackOrder: () => _goToTab(1))),
    ];
    return Scaffold(
      backgroundColor: k.bg,
      extendBody: true,
      body: KTabPagerScope(
        controller: _pager,
        child: NotificationListener<ScrollNotification>(
          onNotification: _onPagerScroll,
          child: ValueListenableBuilder<double>(
            valueListenable: _warmExtent,
            builder: (context, warm, _) => PageView(
              controller: _pager,
              // Warm-up only (see _warmUp): a cache extent makes the pager build the tabs around it.
              allowImplicitScrolling: warm > 0,
              scrollCacheExtent: warm > 0 ? ScrollCacheExtent.viewport(warm) : null,
              onPageChanged: (i) {
                if (_animTarget == null) _currentTab.value = i; // a tap's animation keeps its target
              },
              children: pages,
            ),
          ),
        ),
      ),
      bottomNavigationBar: KFluidNav(
        controller: _pager,
        onTap: _goToTab,
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
    debugHomeFeedBuilds++;
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
    final chips = dhabaProvider.categoryChips;
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
                // Promo banner carousel (Docs/25 section 4): no space at all until banners were loaded.
                // Its PageView hands a swipe past the first/last card to the tab pager (KTabPagerHandoff).
                const HomeBannerCarousel(),
                // The first-order promo is only shown to a student who has no earlier order (the
                // server refuses VITFIRST otherwise); while that is unknown it stays hidden.
                if (!filtering && orderProvider.isFirstTimeCustomer) const KReveal(index: 2, child: _PromoCard()) else const SizedBox(height: 16),
                // Chips come from the live menus; with nothing to choose between there is no row.
                if (chips.length > 1)
                  KReveal(
                    index: 3,
                    // The chips take their own horizontal drags; past either end the swipe moves the tab pager.
                    child: KTabPagerHandoff(
                      child: SizedBox(
                      height: 52,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        physics: KTabPagerHandoff.listPhysics,
                        padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter, vertical: 4),
                        itemCount: chips.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 8),
                        itemBuilder: (context, index) {
                          final chip = chips[index];
                          return KChoiceChip(
                            label: chip.label,
                            icon: categoryIcon(key: chip.iconKey, label: chip.label),
                            selected: dhabaProvider.selectedCategoryIndex == index,
                            onTap: () => dhabaProvider.setSelectedCategoryIndex(index),
                          );
                        },
                      ),
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
                    onPressed: () => unawaited(dhabaProvider.refreshHome()),
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
}

/// One tab of the pager: kept alive when it is swiped away. While it is not the resting tab its
/// tickers (entrance and pulse animations) are muted, as the IndexedStack used to do for hidden
/// tabs, and its semantics are excluded, so a screen reader only ever sees the tab on screen
/// (also while the other tabs are being built in the background). Listens to [settled] itself,
/// so a swipe never rebuilds the tab's content.
class _TabPage extends StatefulWidget {
  const _TabPage({required this.index, required this.settled, required this.child});

  final int index;
  final ValueListenable<int?> settled;
  final Widget child;

  @override
  State<_TabPage> createState() => _TabPageState();
}

class _TabPageState extends State<_TabPage> with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return ValueListenableBuilder<int?>(
      valueListenable: widget.settled,
      child: widget.child,
      builder: (context, settled, child) {
        final hidden = settled != null && settled != widget.index;
        return TickerMode(enabled: !hidden, child: ExcludeSemantics(excluding: hidden, child: child!));
      },
    );
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
