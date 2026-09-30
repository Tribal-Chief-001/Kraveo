import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/dhaba.dart';
import '../models/menu_item.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';
import '../widgets/cart_sheet.dart';
import '../widgets/customization_modal.dart';
import '../widgets/dhaba_card.dart';
import '../widgets/ui/add_stepper.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/floating_bar.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/info_chip.dart';
import '../widgets/ui/k_icon_button.dart';
import '../widgets/ui/k_image.dart';
import '../widgets/ui/sheet_chrome.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/veg_mark.dart';

class DhabaMenuScreen extends StatefulWidget {
  final Dhaba dhaba;
  final String selectedHostel;

  const DhabaMenuScreen({
    super.key,
    required this.dhaba,
    required this.selectedHostel,
  });

  @override
  State<DhabaMenuScreen> createState() => _DhabaMenuScreenState();
}

class _DhabaMenuScreenState extends State<DhabaMenuScreen> {
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';
  String _selectedCategory = 'All';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  /// Adds an item, asking first when it would replace a cart from another kitchen,
  /// and routing customisable dishes through the customisation sheet.
  Future<void> _addItem(CartProvider cart, MenuItemModel item) async {
    if (!widget.dhaba.isAcceptingOrders) {
      showKSnack(context, '${widget.dhaba.name} is not taking orders right now.', error: true, icon: LucideIcons.moon);
      return;
    }
    if (cart.items.isNotEmpty && cart.dhabaId != null && cart.dhabaId != widget.dhaba.id) {
      final replace = await showKConfirm(
        context,
        title: 'Start a new cart?',
        message: 'Your cart has items from ${cart.dhabaName ?? 'another kitchen'}. You can order from one kitchen at a time, so adding this will clear them.',
        confirmLabel: 'Start new cart',
        cancelLabel: 'Keep my cart',
      );
      if (replace != true || !mounted) return;
    }
    if (item.hasCustomizations) {
      CustomizationModal.show(
        context,
        item: item,
        onAddToCart: (selectedOptions, notes) {
          cart.addItem(
            item: item,
            dhabaId: widget.dhaba.id,
            dhabaName: widget.dhaba.name,
            selectedOptions: selectedOptions,
            specialInstructions: notes,
          );
        },
      );
    } else {
      cart.addItem(item: item, dhabaId: widget.dhaba.id, dhabaName: widget.dhaba.name);
    }
  }

  void _removeOne(CartProvider cart, MenuItemModel item) {
    final matching = cart.items.where((i) => i.item.id == item.id);
    if (matching.isNotEmpty) cart.decrementItem(matching.last.cartItemId);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final dhabaProvider = Provider.of<DhabaProvider>(context);
    final cart = Provider.of<CartProvider>(context);
    final List<MenuItemModel> allItems = dhabaProvider.getMenuItemsForDhaba(widget.dhaba.id);
    final open = widget.dhaba.isAcceptingOrders;

    // Unique categories from menu items
    final categories = ['All', ...allItems.map((i) => i.category).toSet()];
    final selectedCategory = categories.contains(_selectedCategory) ? _selectedCategory : 'All';

    final filteredItems = allItems.where((item) {
      if (selectedCategory != 'All' && item.category != selectedCategory) return false;
      if (_searchQuery.trim().isNotEmpty) {
        final query = _searchQuery.trim().toLowerCase();
        return item.name.toLowerCase().contains(query) || item.description.toLowerCase().contains(query);
      }
      return true;
    }).toList();

    final safeBottom = MediaQuery.paddingOf(context).bottom;
    final showCartBar = cart.itemCount > 0;

    return Scaffold(
      backgroundColor: k.bg,
      body: Stack(children: [
        CustomScrollView(
          slivers: [
            SliverAppBar(
              pinned: true,
              expandedHeight: 250,
              backgroundColor: k.bg,
              surfaceTintColor: Colors.transparent,
              automaticallyImplyLeading: false,
              leadingWidth: 64,
              leading: Padding(
                padding: const EdgeInsets.only(left: 16),
                child: Center(
                  child: KIconButton(
                    icon: LucideIcons.arrowLeft,
                    semanticLabel: 'Back',
                    background: k.surface.withValues(alpha: 0.94),
                    bordered: false,
                    onTap: () => Navigator.of(context).maybePop(),
                  ),
                ),
              ),
              flexibleSpace: _MenuHeader(dhaba: widget.dhaba),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    KInfoChip(icon: LucideIcons.star, label: widget.dhaba.rating.toStringAsFixed(1), iconColor: kStarColor),
                    KInfoChip(icon: LucideIcons.clock, label: widget.dhaba.eta),
                    KInfoChip(icon: LucideIcons.wallet, label: 'Min ${rupee(widget.dhaba.minOrder)}'),
                    KInfoChip(icon: LucideIcons.mapPin, label: 'To ${widget.selectedHostel}', iconColor: k.brand),
                  ]),
                  if (widget.dhaba.address.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.store, size: 15, color: k.inkFaint)),
                      const SizedBox(width: 8),
                      Expanded(child: Text(widget.dhaba.address, style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                    ]),
                  ],
                  if (!open) ...[
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(KRadius.md)),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(LucideIcons.moon, size: 18, color: kDangerInk),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'This kitchen is not taking orders right now. You can browse the menu and come back soon.',
                            style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ]),
                    ),
                  ],
                  const SizedBox(height: 16),
                  TextField(
                    controller: _searchController,
                    onChanged: (val) => setState(() => _searchQuery = val),
                    textInputAction: TextInputAction.search,
                    decoration: InputDecoration(
                      hintText: 'Search this menu',
                      prefixIcon: Icon(LucideIcons.search, size: 20, color: k.inkMuted),
                      suffixIcon: _searchQuery.isEmpty
                          ? null
                          : IconButton(
                              tooltip: 'Clear search',
                              icon: Icon(LucideIcons.x, size: 18, color: k.inkMuted),
                              onPressed: () {
                                _searchController.clear();
                                setState(() => _searchQuery = '');
                              },
                            ),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                    ),
                  ),
                ]),
              ),
            ),
            SliverPersistentHeader(
              pinned: true,
              delegate: _CategoryChipsDelegate(
                background: k.bg,
                categories: categories,
                selected: selectedCategory,
                onSelected: (cat) => setState(() => _selectedCategory = cat),
              ),
            ),
            if (filteredItems.isEmpty)
              SliverToBoxAdapter(
                child: KEmptyState(
                  icon: allItems.isEmpty ? LucideIcons.chefHat : LucideIcons.searchX,
                  title: allItems.isEmpty ? 'Menu coming soon' : 'No dishes found',
                  message: allItems.isEmpty
                      ? 'This kitchen has not published its menu yet. Try another kitchen for now.'
                      : 'Nothing matches that search here. Try another category or clear the search.',
                  action: allItems.isEmpty
                      ? null
                      : KButton(
                          label: 'Show full menu',
                          kind: KButtonKind.tonal,
                          expand: false,
                          onPressed: () {
                            _searchController.clear();
                            setState(() {
                              _searchQuery = '';
                              _selectedCategory = 'All';
                            });
                          },
                        ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 0),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final item = filteredItems[index];
                      return KReveal(
                        key: ValueKey(item.id),
                        index: index,
                        child: _MenuRow(
                          item: item,
                          quantity: cart.getItemQuantityInCart(item.id),
                          kitchenOpen: open,
                          onAdd: () => _addItem(cart, item),
                          onRemove: () => _removeOne(cart, item),
                        ),
                      );
                    },
                    childCount: filteredItems.length,
                  ),
                ),
              ),
            SliverToBoxAdapter(child: SizedBox(height: (showCartBar ? 112 : 32) + safeBottom)),
          ],
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: safeBottom + 12,
          child: KBarSwitcher(
            visible: showCartBar,
            child: showCartBar ? _CartBar(cart: cart, kitchenName: widget.dhaba.name, onTap: () => CartSheet.show(context, selectedHostel: widget.selectedHostel)) : const SizedBox.shrink(),
          ),
        ),
      ]),
    );
  }
}

/// Collapsing hero: full-bleed photo that fades into the cream page as it scrolls away.
class _MenuHeader extends StatelessWidget {
  const _MenuHeader({required this.dhaba});

  final Dhaba dhaba;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final settings = context.dependOnInheritedWidgetOfExactType<FlexibleSpaceBarSettings>();
    final range = settings == null ? 1.0 : (settings.maxExtent - settings.minExtent);
    final t = settings == null || range <= 0 ? 1.0 : ((settings.currentExtent - settings.minExtent) / range).clamp(0.0, 1.0);
    final top = MediaQuery.paddingOf(context).top;

    return ClipRect(
      child: Stack(fit: StackFit.expand, children: [
        Hero(tag: DhabaCard.heroTag(dhaba.id), child: KImage(dhaba.bannerUrl, grayscale: !dhaba.isAcceptingOrders)),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [KraveoPalette.g950.withValues(alpha: 0.45), Colors.transparent, KraveoPalette.g950.withValues(alpha: 0.88)],
              stops: const [0, 0.4, 1],
            ),
          ),
        ),
        // Solidifies into the page colour as the header collapses.
        IgnorePointer(child: Opacity(opacity: (1 - t).clamp(0.0, 1.0), child: ColoredBox(color: k.bg))),
        Positioned(
          left: KSpace.gutter,
          right: KSpace.gutter,
          bottom: 40,
          child: Opacity(
            opacity: ((t - 0.35) / 0.65).clamp(0.0, 1.0),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              KDisplayText(dhaba.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.displayMd.copyWith(color: Colors.white)),
              const SizedBox(height: 4),
              Text(dhaba.category, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: Colors.white.withValues(alpha: 0.88))),
            ]),
          ),
        ),
        // Collapsed title, sits beside the back button.
        Positioned(
          left: 72,
          right: KSpace.gutter,
          top: top,
          height: kToolbarHeight,
          child: Opacity(
            opacity: ((0.35 - t) / 0.35).clamp(0.0, 1.0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(dhaba.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink)),
            ),
          ),
        ),
        // Rounded cream lip so the photo tucks under the page.
        Positioned(
          left: 0,
          right: 0,
          bottom: -1,
          height: 28,
          child: Opacity(
            opacity: t,
            child: DecoratedBox(
              decoration: BoxDecoration(color: k.bg, borderRadius: const BorderRadius.vertical(top: Radius.circular(28))),
            ),
          ),
        ),
      ]),
    );
  }
}

class _CategoryChipsDelegate extends SliverPersistentHeaderDelegate {
  _CategoryChipsDelegate({required this.background, required this.categories, required this.selected, required this.onSelected});

  final Color background;
  final List<String> categories;
  final String selected;
  final ValueChanged<String> onSelected;

  @override
  double get minExtent => 64;
  @override
  double get maxExtent => 64;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return Container(
      color: background,
      alignment: Alignment.center,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter, vertical: 8),
        itemCount: categories.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, index) => Center(
          child: KChoiceChip(
            label: categories[index],
            selected: categories[index] == selected,
            onTap: () => onSelected(categories[index]),
          ),
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _CategoryChipsDelegate old) =>
      old.selected != selected || old.categories.length != categories.length || old.background != background;
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({
    required this.item,
    required this.quantity,
    required this.kitchenOpen,
    required this.onAdd,
    required this.onRemove,
  });

  final MenuItemModel item;
  final int quantity;
  final bool kitchenOpen;
  final VoidCallback onAdd;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final soldOut = !item.isAvailable;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Opacity(
        opacity: soldOut ? 0.6 : 1,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: k.surface,
            borderRadius: BorderRadius.circular(KRadius.xl),
            boxShadow: soldOut ? null : KShadow.soft(k.shadowTint),
            border: soldOut ? Border.all(color: k.line) : null,
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  VegMark(isVeg: item.isVeg),
                  if (item.hasCustomizations) ...[
                    const SizedBox(width: 8),
                    Icon(LucideIcons.slidersHorizontal, size: 13, color: k.inkFaint),
                    const SizedBox(width: 4),
                    Flexible(child: Text('Customisable', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.caption.copyWith(color: k.inkMuted))),
                  ],
                ]),
                const SizedBox(height: 8),
                Text(item.name, style: KraveoType.titleMd.copyWith(color: k.ink)),
                const SizedBox(height: 4),
                Text(rupee(item.price), style: KraveoType.numericSm.copyWith(color: soldOut ? k.inkFaint : k.ink, fontSize: 20)),
                if (item.description.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(item.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                ],
              ]),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 112,
              height: 130,
              child: Stack(children: [
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 104,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(KRadius.lg),
                    child: KImage(item.imageUrl, grayscale: soldOut),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: soldOut
                      ? Container(
                          height: 40,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.pill)),
                          child: Text('Sold out', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
                        )
                      : KAddButton(quantity: quantity, onAdd: onAdd, onRemove: onRemove, enabled: kitchenOpen, itemName: item.name),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _CartBar extends StatelessWidget {
  const _CartBar({required this.cart, required this.kitchenName, required this.onTap});

  final CartProvider cart;
  final String kitchenName;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final fromOther = cart.dhabaName != null && cart.dhabaName != kitchenName;
    final count = cart.itemCount;
    return KFloatingBar(
      semanticLabel: 'View cart, $count ${count == 1 ? 'item' : 'items'}, ${rupee(cart.subtotal)}',
      onTap: onTap,
      leading: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.16), shape: BoxShape.circle),
        child: AnimatedSwitcher(
          duration: KMotion.fast,
          transitionBuilder: (child, anim) => ScaleTransition(scale: CurvedAnimation(parent: anim, curve: KMotion.spring), child: child),
          child: Text('$count', key: ValueKey(count), style: KraveoType.numericSm.copyWith(color: k.onBrand, fontSize: 19)),
        ),
      ),
      title: KAnimatedNumber(value: cart.subtotal, prefix: '₹', style: KraveoType.numericSm.copyWith(color: k.onBrand, fontSize: 21)),
      subtitle: fromOther ? 'From ${cart.dhabaName}' : '${count == 1 ? '1 item' : '$count items'} · plus fees',
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Text('View cart', style: KraveoType.button.copyWith(color: k.onBrand, fontSize: 14)),
        const SizedBox(width: 6),
        Icon(LucideIcons.shoppingBag, size: 18, color: k.onBrand),
      ]),
    );
  }
}
