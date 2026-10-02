import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../widgets/stock_card.dart';
import '../widgets/add_dish_modal.dart';
import '../widgets/ui/ui.dart';
import '../services/failure_messages.dart';
import '../services/menu_stock_controller.dart';

/// The Menu tab: the restaurant's real menu from Kraveo. Sold-out switches and prices save to the server
/// and roll back (with a message) if saving fails.
class StockManagerScreen extends StatefulWidget {
  final MenuStockController controller;

  const StockManagerScreen({super.key, required this.controller});

  @override
  State<StockManagerScreen> createState() => _StockManagerScreenState();
}

enum _StockFilter { all, inStock, soldOut }

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
          onSubmit: (name, category, price, inStock) async {
            final problem = await _c.addDish(name: name, category: category, price: price, inStock: inStock);
            if (problem == null && mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('$name added to menu!  ·  मेनू में जुड़ गया')),
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
    final inStockCount = dishes.where((d) => d.inStock).length;
    final soldOutCount = dishes.where((d) => !d.inStock).length;
    final categories = ['All', ...{for (final d in dishes) d.category}];
    if (!categories.contains(_selectedCategory)) _selectedCategory = 'All';

    final filteredDishes = dishes.where((dish) {
      final matchesCategory = _selectedCategory == 'All' || dish.category == _selectedCategory;
      final matchesSearch = _searchQuery.isEmpty || dish.name.toLowerCase().contains(_searchQuery.toLowerCase());
      final matchesStock = switch (_stockFilter) {
        _StockFilter.all => true,
        _StockFilter.inStock => dish.inStock,
        _StockFilter.soldOut => !dish.inStock,
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
                  title: dishes.isEmpty ? 'Your menu is empty' : 'No dishes found',
                  message: dishes.isEmpty
                      ? 'Tap the yellow + button to add your first dish.\nपहला व्यंजन जोड़ने के लिए पीला + दबाएं।'
                      : 'Try another search, or tap the yellow + button.\nदूसरा नाम खोजें या पीला + दबाएं।',
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
