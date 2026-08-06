import 'package:flutter/material.dart';
import '../models/dish_model.dart';
import '../widgets/stock_card.dart';
import '../widgets/add_dish_modal.dart';

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

class _StockManagerScreenState extends State<StockManagerScreen> {
  String _selectedCategory = 'All';
  String _searchQuery = '';

  final List<String> _categories = [
    'All',
    'Main Course',
    'Breads',
    'Beverages',
    'Snacks',
    'Fast Food',
  ];

  void _openAddDishModal() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) {
        return AddDishModal(
          onDishAdded: (newDish) {
            setState(() {
              widget.dishes.add(newDish);
            });
            widget.onDishListChanged();
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('${newDish.name} added to menu!')),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final totalDishes = widget.dishes.length;
    final inStockCount = widget.dishes.where((d) => d.inStock).length;
    final soldOutCount = widget.dishes.where((d) => !d.inStock).length;

    final filteredDishes = widget.dishes.where((dish) {
      final matchesCategory = _selectedCategory == 'All' || dish.category == _selectedCategory;
      final matchesSearch = _searchQuery.isEmpty || dish.name.toLowerCase().contains(_searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    }).toList();

    return Scaffold(
      backgroundColor: const Color(0xFFFCF9F8),
      body: Column(
        children: [
          // Top Summary Header & Search/Filter
          Container(
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(
              children: [
                // Quick Stock Overview Pills
                Row(
                  children: [
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFF00450D).withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.inventory_2_outlined, size: 18, color: Color(0xFF00450D)),
                            const SizedBox(width: 6),
                            Text('TOTAL: $totalDishes', style: const TextStyle(fontWeight: FontWeight.w900, color: Color(0xFF00450D), fontSize: 13)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFF00450D),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.check_circle_outline, size: 18, color: Colors.white),
                            const SizedBox(width: 6),
                            Text('IN STOCK: $inStockCount', style: const TextStyle(fontWeight: FontWeight.w900, color: Colors.white, fontSize: 13)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFBA1A1A),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.block, size: 18, color: Colors.white),
                            const SizedBox(width: 6),
                            Text('SOLD OUT: $soldOutCount', style: const TextStyle(fontWeight: FontWeight.w900, color: Colors.white, fontSize: 13)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                // Search Box
                TextField(
                  onChanged: (val) => setState(() => _searchQuery = val),
                  decoration: InputDecoration(
                    hintText: 'Search dish in menu...',
                    prefixIcon: const Icon(Icons.search, size: 20, color: Colors.grey),
                    contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 12),
                    filled: true,
                    fillColor: const Color(0xFFFCF9F8),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: const BorderSide(color: Color(0xFFE5E2E1)),
                    ),
                  ),
                ),
                const SizedBox(height: 10),

                // Category Chips Scrollable List
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: _categories.map((cat) {
                      final isSelected = _selectedCategory == cat;
                      return Padding(
                        padding: const EdgeInsets.only(right: 8.0),
                        child: ChoiceChip(
                          showCheckmark: false,
                          label: Text(
                            cat,
                            style: TextStyle(
                              fontWeight: FontWeight.bold,
                              fontSize: 12,
                              color: isSelected ? Colors.white : const Color(0xFF1B1C1C),
                            ),
                          ),
                          selected: isSelected,
                          selectedColor: const Color(0xFF00450D),
                          backgroundColor: const Color(0xFFFCF9F8),
                          side: BorderSide(
                            color: isSelected ? const Color(0xFF00450D) : const Color(0xFFE5E2E1),
                          ),
                          onSelected: (sel) {
                            if (sel) setState(() => _selectedCategory = cat);
                          },
                        ),
                      );
                    }).toList(),
                  ),
                ),
              ],
            ),
          ),

          // Dishes GridView
          Expanded(
            child: filteredDishes.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32.0),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.no_meals_outlined, size: 64, color: Colors.grey),
                          const SizedBox(height: 16),
                          const Text(
                            'No Dishes Found',
                            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF1B1C1C)),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Try adjusting your search query or add a new dish to the menu.',
                            style: TextStyle(fontSize: 14, color: Colors.grey[600]),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  )
                : GridView.builder(
                    padding: const EdgeInsets.all(16),
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      childAspectRatio: 0.82,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                    ),
                    itemCount: filteredDishes.length,
                    itemBuilder: (context, index) {
                      final dish = filteredDishes[index];
                      return StockCard(
                        dish: dish,
                        onToggleStock: () {
                          setState(() {
                            dish.inStock = !dish.inStock;
                          });
                          widget.onDishListChanged();
                        },
                        onUpdatePrice: (newPrice) {
                          setState(() {
                            dish.price = newPrice;
                          });
                          widget.onDishListChanged();
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openAddDishModal,
        backgroundColor: const Color(0xFF00450D),
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('ADD DISH', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900)),
      ),
    );
  }
}
