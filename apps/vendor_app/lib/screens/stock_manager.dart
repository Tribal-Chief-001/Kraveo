import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/dish_model.dart';
import '../widgets/stock_card.dart';
import '../widgets/add_dish_modal.dart';
import '../widgets/ui/ui.dart';
import '../services/failure_messages.dart';
import '../services/menu_stock_controller.dart';

/// The Menu tab: the restaurant's real menu from Kraveo, each dish with its approval status and the restaurant's OWN
/// price (never a customer price). Sold-out switches (live dishes only) save at once; a new dish and a price change on a
/// live dish go to Kraveo for approval. Failed saves roll back with a message.
class StockManagerScreen extends StatefulWidget {
  final MenuStockController controller;

  const StockManagerScreen({super.key, required this.controller});

  @override
  State<StockManagerScreen> createState() => _StockManagerScreenState();
}

enum _StockFilter { all, inStock, soldOut, needsAttention }

class _StockManagerScreenState extends State<StockManagerScreen> {
  String _selectedCategory = 'All';
  String _searchQuery = '';
  _StockFilter _stockFilter = _StockFilter.all;

  MenuStockController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    _c.onError = _showError;
    if (!_c.loadedOnce && !_c.loading) _c.load();
  }

  @override
  void dispose() {
    if (_c.onError == _showError) _c.onError = null;
    super.dispose();
  }

  void _showError(FailureText text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('Not saved. ${text.both}'), backgroundColor: kDangerDeep, duration: const Duration(seconds: 4)));
  }

  void _openAddDishModal() {
    showKSheet<void>(
      context,
      builder: (sheetContext) {
        return AddDishModal(
          onSubmit: (name, category, price, inStock, {bool isVeg = true}) async {
            final problem = await _c.addDish(name: name, category: category, price: price, inStock: inStock, isVeg: isVeg);
            if (problem == null && mounted) {
              final pending = _c.lastAdded?.status == DishStatus.pending;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(pending ? '$name: Sent to Kraveo for approval  ·  मंज़ूरी के लिए भेजा' : '$name added to menu!  ·  मेनू में जुड़ गया'),
                  duration: const Duration(seconds: 4),
                ),
              );
            }
            return problem;
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: _c, builder: (context, _) => _build(context));

  Widget _build(BuildContext context) {
    final k = context.k;
    final dishes = _c.dishes;

    if (!_c.loadedOnce) {
      return VMaxWidth(
        child: _c.loadFailure == null
            ? const Center(child: CircularProgressIndicator())
            : VScrollCenter(
                child: KEmptyState(
                  icon: LucideIcons.wifiOff,
                  title: "Can't load your menu",
                  message: failureText(_c.loadFailure!).both,
                  action: KButton(label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, onPressed: _c.load),
                ),
              ),
      );
    }

    final totalDishes = dishes.length;
    // In stock / sold out only count dishes customers can see; the rest are shown under "needs attention".
    final inStockCount = dishes.where((d) => d.isLive && d.inStock).length;
    final soldOutCount = dishes.where((d) => d.isLive && !d.inStock).length;
    final waitingCount = _c.waitingCount;
    final rejectedCount = _c.rejectedCount;
    final liveCount = dishes.where((d) => d.isLive).length;
    final categories = ['All', ...{for (final d in dishes) d.category}];
    if (!categories.contains(_selectedCategory)) _selectedCategory = 'All';

    final filteredDishes = dishes.where((dish) {
      final matchesCategory = _selectedCategory == 'All' || dish.category == _selectedCategory;
      final matchesSearch = _searchQuery.isEmpty || dish.name.toLowerCase().contains(_searchQuery.toLowerCase());
      final matchesStock = switch (_stockFilter) {
        _StockFilter.all => true,
        _StockFilter.inStock => dish.isLive && dish.inStock,
        _StockFilter.soldOut => dish.isLive && !dish.inStock,
        _StockFilter.needsAttention => dish.status != DishStatus.live,
      };
      return matchesCategory && matchesSearch && matchesStock;
    }).toList();

    return Material(
      color: Colors.transparent,
      child: VMaxWidth(
        child: RefreshIndicator(
          onRefresh: _c.load,
          child: ListView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 32),
          children: [
            // Tap a tile to show only that group
            Row(children: [
              Expanded(
                child: _CountTile(
                  count: totalDishes,
                  label: 'All',
                  hindi: 'सभी',
                  color: k.brand,
                  selected: _stockFilter == _StockFilter.all,
                  onTap: () => setState(() => _stockFilter = _StockFilter.all),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _CountTile(
                  count: inStockCount,
                  label: 'In stock',
                  hindi: 'उपलब्ध',
                  color: k.brand,
                  selected: _stockFilter == _StockFilter.inStock,
                  onTap: () => setState(() => _stockFilter = _stockFilter == _StockFilter.inStock ? _StockFilter.all : _StockFilter.inStock),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _CountTile(
                  count: soldOutCount,
                  label: 'Sold out',
                  hindi: 'खत्म',
                  color: kDangerDeep,
                  selected: _stockFilter == _StockFilter.soldOut,
                  onTap: () => setState(() => _stockFilter = _stockFilter == _StockFilter.soldOut ? _StockFilter.all : _StockFilter.soldOut),
                ),
              ),
            ]),
            if (waitingCount > 0 || rejectedCount > 0) ...[
              const SizedBox(height: 12),
              _ApprovalBanner(
                waiting: waitingCount,
                rejected: rejectedCount,
                noLiveDish: liveCount == 0,
                selected: _stockFilter == _StockFilter.needsAttention,
                onTap: () => setState(() => _stockFilter = _stockFilter == _StockFilter.needsAttention ? _StockFilter.all : _StockFilter.needsAttention),
              ),
            ],
            const SizedBox(height: 14),

            Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              Expanded(
                child: TextField(
                  onChanged: (val) => setState(() => _searchQuery = val),
                  style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 18),
                  decoration: InputDecoration(
                    hintText: 'Search dish · खोजें',
                    prefixIcon: Icon(LucideIcons.search, size: 22, color: k.inkFaint),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              _AddDishButton(onTap: _openAddDishModal),
            ]),
            const SizedBox(height: 12),

            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              clipBehavior: Clip.none,
              child: Row(
                children: [
                  for (final cat in categories) ...[
                    VChoiceChip(
                      label: cat,
                      sublabel: hindiCategory(cat).isEmpty ? null : hindiCategory(cat),
                      selected: _selectedCategory == cat,
                      onTap: () => setState(() => _selectedCategory = cat),
                    ),
                    const SizedBox(width: 8),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 18),

            if (filteredDishes.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: KEmptyState(
                  icon: LucideIcons.utensils,
                  title: dishes.isEmpty ? 'Your menu is empty' : (_stockFilter == _StockFilter.needsAttention ? 'Nothing waiting for approval' : 'No dishes found'),
                  message: dishes.isEmpty
                      ? 'Tap the yellow + button to add your first dish. Kraveo checks every new dish, then customers can see it.\nपहला व्यंजन जोड़ने के लिए पीला + दबाएं। Kraveo जाँचेगा, फिर ग्राहकों को दिखेगा।'
                      : (_stockFilter == _StockFilter.needsAttention
                          ? 'All your dishes are live.\nआपके सभी व्यंजन चालू हैं।'
                          : 'Try another search, or tap the yellow + button.\nदूसरा नाम खोजें या पीला + दबाएं।'),
                ),
              )
            else
              for (var i = 0; i < filteredDishes.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: KReveal(
                    key: ValueKey('dish-${filteredDishes[i].id}'),
                    index: i,
                    child: StockCard(
                      dish: filteredDishes[i],
                      onToggleStock: () => _c.toggleStock(filteredDishes[i]),
                      onUpdatePrice: (newPrice) => _c.changePrice(filteredDishes[i], newPrice),
                      onResubmit: (price) => _c.resubmit(filteredDishes[i], price),
                    ),
                  ),
                ),
          ],
        ),
        ),
      ),
    );
  }
}

/// "2 waiting for approval · 1 rejected": tap to show only those dishes.
class _ApprovalBanner extends StatelessWidget {
  const _ApprovalBanner({required this.waiting, required this.rejected, required this.noLiveDish, required this.selected, required this.onTap});
  final int waiting;
  final int rejected;
  final bool noLiveDish;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final parts = <String>[
      if (waiting > 0) '$waiting waiting for approval',
      if (rejected > 0) '$rejected not approved',
    ];
    final headline = parts.join(' · ');
    return Semantics(
      button: true,
      selected: selected,
      label: '$headline. Tap to show only these.',
      excludeSemantics: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: Container(
          key: const ValueKey('approval-banner'),
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Color.alphaBlend(KraveoPalette.warning.withValues(alpha: selected ? 0.26 : 0.14), k.surface),
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: selected ? KraveoPalette.warning : Colors.transparent, width: 1.5),
          ),
          child: Row(children: [
            Icon(LucideIcons.clock, size: 24, color: k.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(headline, style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 16)),
                Text(
                  noLiveDish
                      ? 'Customers will see your menu once Kraveo approves a dish.\nजब Kraveo एक व्यंजन मंज़ूर करेगा, तब ग्राहकों को मेनू दिखेगा।'
                      : 'Tap to see them.  ·  देखने के लिए दबाएं',
                  style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13.5),
                ),
              ]),
            ),
            Icon(LucideIcons.chevronRight, size: 22, color: k.inkFaint),
          ]),
        ),
      ),
    );
  }
}

class _CountTile extends StatelessWidget {
  const _CountTile({required this.count, required this.label, required this.hindi, required this.color, required this.selected, required this.onTap});
  final int count;
  final String label;
  final String hindi;
  final Color color;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      selected: selected,
      label: '$label: $count. Tap to show only these.',
      excludeSemantics: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          constraints: const BoxConstraints(minHeight: 84),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
          decoration: BoxDecoration(
            color: selected ? color : k.surface,
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: selected ? color : k.line, width: 1.5),
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            FittedBox(fit: BoxFit.scaleDown, child: Text('$count', style: KraveoType.displayMd.copyWith(fontSize: 32, height: 1.1, color: selected ? k.onBrand : color))),
            FittedBox(fit: BoxFit.scaleDown, child: Text(label, maxLines: 1, style: KraveoType.titleMd.copyWith(fontSize: 14, fontWeight: FontWeight.w800, color: selected ? k.onBrand : k.ink))),
            FittedBox(fit: BoxFit.scaleDown, child: Text(hindi, maxLines: 1, style: KraveoType.caption.copyWith(fontSize: 12, color: selected ? k.onBrand : k.inkMuted))),
          ]),
        ),
      ),
    );
  }
}

/// The one yellow highlight on the Menu tab: a big square "+" that opens the add-dish sheet.
class _AddDishButton extends StatelessWidget {
  const _AddDishButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      label: 'Add a new dish',
      excludeSemantics: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: Container(
          width: 72,
          height: 64,
          decoration: BoxDecoration(
            color: k.accent,
            borderRadius: BorderRadius.circular(KRadius.lg),
            boxShadow: KShadow.glow(k.accent).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.30))).toList(),
          ),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(LucideIcons.plus, size: 28, color: k.onAccent),
            Text('Add', style: KraveoType.caption.copyWith(color: k.onAccent, fontSize: 13, fontWeight: FontWeight.w800)),
          ]),
        ),
      ),
    );
  }
}
