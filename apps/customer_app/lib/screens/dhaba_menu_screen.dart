import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/dhaba.dart';
import '../models/menu_item.dart';
import '../providers/dhaba_provider.dart';
import '../providers/cart_provider.dart';
import '../widgets/customization_modal.dart';
import '../widgets/cart_sheet.dart';

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
  String _searchQuery = '';
  String _selectedCategory = 'All';

  @override
  Widget build(BuildContext context) {
    final dhabaProvider = Provider.of<DhabaProvider>(context);
    final cart = Provider.of<CartProvider>(context);
    final List<MenuItemModel> allItems = dhabaProvider.getMenuItemsForDhaba(widget.dhaba.id);

    // Extract unique categories from menu items
    final categories = ['All', ...allItems.map((i) => i.category).toSet()];


    // Filter items
    final filteredItems = allItems.where((item) {
      if (_selectedCategory != 'All' && item.category != _selectedCategory) {
        return false;
      }
      if (_searchQuery.trim().isNotEmpty) {
        final query = _searchQuery.trim().toLowerCase();
        return item.name.toLowerCase().contains(query) ||
            item.description.toLowerCase().contains(query);
      }
      return true;
    }).toList();

    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      body: CustomScrollView(
        slivers: [
          // Hero Banner SliverAppBar
          SliverAppBar(
            expandedHeight: 200,
            pinned: true,
            flexibleSpace: FlexibleSpaceBar(
              title: Text(
                widget.dhaba.name,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  shadows: [Shadow(color: Colors.black54, blurRadius: 8)],
                ),
              ),
              background: Stack(
                fit: StackFit.expand,
                children: [
                  Image.network(
                    widget.dhaba.bannerUrl,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stackTrace) => Container(color: AppTheme.primaryEmerald),
                  ),
                  Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [Colors.black.withValues(alpha: 0.7), Colors.transparent, Colors.black.withValues(alpha: 0.6)],
                        begin: Alignment.bottomCenter,
                        end: Alignment.topCenter,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Header Info Section
          SliverToBoxAdapter(
            child: Container(
              color: Colors.white,
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          widget.dhaba.category,
                          style: const TextStyle(color: AppTheme.textMuted, fontSize: 13, fontWeight: FontWeight.w600),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: AppTheme.secondaryGold,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.star, size: 14, color: AppTheme.secondaryTextGold),
                            const SizedBox(width: 4),
                            Text(
                              '${widget.dhaba.rating}',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppTheme.textDark),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      const Icon(Icons.location_on, size: 14, color: AppTheme.primaryEmerald),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          widget.dhaba.address,
                          style: const TextStyle(fontSize: 12, color: AppTheme.textMuted),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Menu Item Search Bar
                  Container(
                    decoration: BoxDecoration(
                      color: AppTheme.surfaceVariant.withValues(alpha: 0.6),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: TextField(
                      onChanged: (val) => setState(() => _searchQuery = val),
                      decoration: const InputDecoration(
                        hintText: 'Search in menu...',
                        hintStyle: TextStyle(color: AppTheme.textMuted, fontSize: 13),
                        prefixIcon: Icon(Icons.search, color: AppTheme.textMuted, size: 20),
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.symmetric(vertical: 12, horizontal: 16),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Category Pills Selector
          SliverToBoxAdapter(
            child: Container(
              height: 50,
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: ListView.builder(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: categories.length,
                itemBuilder: (context, index) {
                  final cat = categories[index];
                  final isSelected = _selectedCategory == cat;
                  return Padding(
                    padding: const EdgeInsets.only(right: 8.0),
                    child: ChoiceChip(
                      label: Text(cat),
                      selected: isSelected,
                      selectedColor: AppTheme.primaryEmerald,
                      backgroundColor: AppTheme.surfaceVariant,
                      labelStyle: TextStyle(
                        color: isSelected ? Colors.white : AppTheme.textDark,
                        fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                        fontSize: 12,
                      ),
                      onSelected: (val) {
                        setState(() => _selectedCategory = cat);
                      },
                    ),
                  );
                },
              ),
            ),
          ),

          // Dishes List
          SliverPadding(
            padding: const EdgeInsets.all(16),
            sliver: filteredItems.isEmpty
                ? const SliverToBoxAdapter(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Center(
                        child: Text(
                          'No dishes found in this category.',
                          style: TextStyle(color: AppTheme.textMuted),
                        ),
                      ),
                    ),
                  )
                : SliverList(
                    delegate: SliverChildBuilderDelegate(
                      (context, index) {
                        final item = filteredItems[index];
                        final qtyInCart = cart.getItemQuantityInCart(item.id);

                        return Container(
                          margin: const EdgeInsets.only(bottom: 16),
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppTheme.borderLight),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Icon(
                                          item.isVeg ? Icons.radio_button_checked : Icons.crop_square,
                                          color: item.isVeg ? Colors.green : Colors.red,
                                          size: 14,
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          item.isVeg ? 'VEG' : 'NON-VEG',
                                          style: TextStyle(
                                            fontSize: 9,
                                            fontWeight: FontWeight.bold,
                                            color: item.isVeg ? Colors.green : Colors.red,
                                          ),
                                        ),
                                        if (item.hasCustomizations) ...[
                                          const SizedBox(width: 8),
                                          Container(
                                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                            decoration: BoxDecoration(
                                              color: AppTheme.secondaryGold.withValues(alpha: 0.3),
                                              borderRadius: BorderRadius.circular(4),
                                            ),
                                            child: const Text(
                                              'CUSTOMIZABLE',
                                              style: TextStyle(
                                                fontSize: 9,
                                                fontWeight: FontWeight.bold,
                                                color: AppTheme.secondaryTextGold,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      item.name,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 15,
                                        color: AppTheme.textDark,
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      '₹${item.price.toInt()}',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w800,
                                        fontSize: 14,
                                        color: AppTheme.primaryEmerald,
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      item.description,
                                      style: const TextStyle(color: AppTheme.textMuted, fontSize: 12),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 12),
                              Column(
                                children: [
                                  ClipRRect(
                                    borderRadius: BorderRadius.circular(12),
                                    child: Image.network(
                                      item.imageUrl,
                                      width: 90,
                                      height: 80,
                                      fit: BoxFit.cover,
                                      errorBuilder: (context, error, stackTrace) => Container(
                                        width: 90,
                                        height: 80,
                                        color: AppTheme.surfaceVariant,
                                        child: const Icon(Icons.fastfood, color: AppTheme.textMuted),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  
                                  // Add button / Stepper
                                  qtyInCart == 0
                                      ? ElevatedButton(
                                          onPressed: () {
                                            if (item.hasCustomizations) {
                                              showModalBottomSheet(
                                                context: context,
                                                isScrollControlled: true,
                                                shape: const RoundedRectangleBorder(
                                                  borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                                                ),
                                                builder: (context) => CustomizationModal(
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
                                                ),
                                              );
                                            } else {
                                              cart.addItem(
                                                item: item,
                                                dhabaId: widget.dhaba.id,
                                                dhabaName: widget.dhaba.name,
                                              );
                                            }
                                          },
                                          style: ElevatedButton.styleFrom(
                                            backgroundColor: AppTheme.secondaryGold,
                                            foregroundColor: AppTheme.secondaryTextGold,
                                            elevation: 0,
                                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                                            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
                                          ),
                                          child: const Text('ADD', style: TextStyle(fontWeight: FontWeight.w900)),
                                        )
                                      : Container(
                                          decoration: BoxDecoration(
                                            color: AppTheme.primaryEmerald,
                                            borderRadius: BorderRadius.circular(20),
                                          ),
                                          child: Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              IconButton(
                                                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                                                padding: EdgeInsets.zero,
                                                icon: const Icon(Icons.remove, size: 16, color: Colors.white),
                                                onPressed: () {
                                                  final matchingItems = cart.items.where((i) => i.item.id == item.id);
                                                  if (matchingItems.isNotEmpty) {
                                                    cart.decrementItem(matchingItems.last.cartItemId);
                                                  }
                                                },
                                              ),
                                              Text(
                                                '$qtyInCart',
                                                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                                              ),
                                              IconButton(
                                                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                                                padding: EdgeInsets.zero,
                                                icon: const Icon(Icons.add, size: 16, color: Colors.white),
                                                onPressed: () {
                                                  if (item.hasCustomizations) {
                                                    showModalBottomSheet(
                                                      context: context,
                                                      isScrollControlled: true,
                                                      shape: const RoundedRectangleBorder(
                                                        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                                                      ),
                                                      builder: (context) => CustomizationModal(
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
                                                      ),
                                                    );
                                                  } else {
                                                    cart.addItem(
                                                      item: item,
                                                      dhabaId: widget.dhaba.id,
                                                      dhabaName: widget.dhaba.name,
                                                    );
                                                  }
                                                },
                                              ),
                                            ],
                                          ),
                                        ),
                                ],
                              ),
                            ],
                          ),
                        );
                      },
                      childCount: filteredItems.length,
                    ),
                  ),
          ),
          const SliverPadding(padding: EdgeInsets.only(bottom: 80)),
        ],
      ),

      // Floating Cart Summary Bar
      bottomSheet: cart.itemCount > 0
          ? Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.1),
                    blurRadius: 10,
                    offset: const Offset(0, -4),
                  ),
                ],
              ),
              child: SafeArea(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '${cart.itemCount} ITEMS IN CART',
                          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppTheme.textMuted),
                        ),
                        Text(
                          '₹${cart.subtotal.toInt()}',
                          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: AppTheme.textDark),
                        ),
                      ],
                    ),
                    ElevatedButton(
                      onPressed: () {
                        showModalBottomSheet(
                          context: context,
                          isScrollControlled: true,
                          shape: const RoundedRectangleBorder(
                            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                          ),
                          builder: (context) => CartSheet(selectedHostel: widget.selectedHostel),
                        );
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.primaryEmerald,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                      ),
                      child: Row(
                        children: const [
                          Text('VIEW CART', style: TextStyle(fontWeight: FontWeight.bold)),
                          SizedBox(width: 8),
                          Icon(Icons.arrow_forward, size: 18),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }
}
