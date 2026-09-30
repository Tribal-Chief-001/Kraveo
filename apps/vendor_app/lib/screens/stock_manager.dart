import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/dish_model.dart';
import '../widgets/stock_card.dart';
import '../widgets/add_dish_modal.dart';
import '../widgets/ui/ui.dart';
import '../services/vendor_api_service.dart';

class StockManagerScreen extends StatefulWidget {
  final List<DishModel> dishes;
  final VoidCallback onDishListChanged;

  const StockManagerScreen({
    super.key,
    required this.dishes,
    required this.onDishListChanged,
  });

  @override
  State<StockManagerScreen> createState() => _StockManagerScreenState();
}

enum _StockFilter { all, inStock, soldOut }

class _StockManagerScreenState extends State<StockManagerScreen> {
  String _selectedCategory = 'All';
  String _searchQuery = '';
  _StockFilter _stockFilter = _StockFilter.all;

  final List<String> _categories = [
    'All',
    'Main Course',
    'Breads',
    'Beverages',
    'Snacks',
    'Fast Food',
  ];

  void _openAddDishModal() {
    showKSheet<void>(
      context,
      builder: (sheetContext) {
        return AddDishModal(
          onDishAdded: (newDish) {
            setState(() {
              widget.dishes.add(newDish);
            });
            widget.onDishListChanged();
            VendorApiService.updateDishStock(
              newDish.id,
              isAvailable: newDish.inStock,
              price: newDish.price,
            );
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('${newDish.name} added to menu!  ·  मेनू में जुड़ गया')),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final totalDishes = widget.dishes.length;
    final inStockCount = widget.dishes.where((d) => d.inStock).length;
    final soldOutCount = widget.dishes.where((d) => !d.inStock).length;

    final filteredDishes = widget.dishes.where((dish) {
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
                  for (final cat in _categories) ...[
                    VChoiceChip(
                      label: cat,
                      sublabel: hindiCategory(cat),
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
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: KEmptyState(
                  icon: LucideIcons.utensils,
                  title: 'No dishes found',
                  message: 'Try another search, or tap the yellow + button.\nदूसरा नाम खोजें या पीला + दबाएं।',
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
                      onToggleStock: () {
                        final dish = filteredDishes[i];
                        setState(() {
                          dish.inStock = !dish.inStock;
                        });
                        widget.onDishListChanged();
                        VendorApiService.updateDishStock(
                          dish.id,
                          isAvailable: dish.inStock,
                        );
                      },
                      onUpdatePrice: (newPrice) {
                        final dish = filteredDishes[i];
                        setState(() {
                          dish.price = newPrice;
                        });
                        widget.onDishListChanged();
                        VendorApiService.updateDishStock(
                          dish.id,
                          price: newPrice,
                        );
                      },
                    ),
                  ),
                ),
          ],
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
