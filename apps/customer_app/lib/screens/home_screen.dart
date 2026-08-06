import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/order.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../widgets/hostel_dropdown.dart';
import '../widgets/category_pills.dart';
import '../widgets/dhaba_card.dart';
import 'dhaba_menu_screen.dart';
import 'live_tracking_screen.dart';
import 'order_history_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _currentTab = 0;
  String selectedHostel = 'Block 1';
  final TextEditingController _searchController = TextEditingController();

  final List<String> hostelBlocks = [
    'Block 1',
    'Block 2',
    'Block 3',
    'Block 4',
    'Block 5',
    'Block 6',
    'Girls Gate 1',
    'Girls Gate 2',
    'VIT Main Gate'
  ];

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      body: IndexedStack(
        index: _currentTab,
        children: [
          _buildHomeFeed(context),
          const LiveTrackingScreen(),
          const OrderHistoryScreen(),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.06),
              blurRadius: 10,
              offset: const Offset(0, -2),
            ),
          ],
        ),
        child: BottomNavigationBar(
          currentIndex: _currentTab,
          onTap: (idx) => setState(() => _currentTab = idx),
          selectedItemColor: AppTheme.primaryEmerald,
          unselectedItemColor: AppTheme.textMuted,
          selectedLabelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
          type: BottomNavigationBarType.fixed,
          items: const [
            BottomNavigationBarItem(
              icon: Icon(Icons.storefront_outlined),
              activeIcon: Icon(Icons.storefront),
              label: 'Dhabas',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.two_wheeler_outlined),
              activeIcon: Icon(Icons.two_wheeler),
              label: 'Track Order',
            ),
            BottomNavigationBarItem(
              icon: Icon(Icons.receipt_long_outlined),
              activeIcon: Icon(Icons.receipt_long),
              label: 'History',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHomeFeed(BuildContext context) {
    final dhabaProvider = Provider.of<DhabaProvider>(context);
    final orderProvider = Provider.of<OrderProvider>(context);
    final activeOrder = orderProvider.activeOrder;
    final dhabas = dhabaProvider.dhabas;

    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      appBar: AppBar(
        toolbarHeight: 70,
        backgroundColor: AppTheme.surfaceBackground,
        elevation: 0,
        title: HostelDropdown(
          selectedHostel: selectedHostel,
          hostelBlocks: hostelBlocks,
          onChanged: (val) {
            if (val != null) setState(() => selectedHostel = val);
          },
        ),
        actions: [
          // Favorites filter toggle button
          IconButton(
            icon: Icon(
              dhabaProvider.showFavoritesOnly ? Icons.favorite : Icons.favorite_border,
              color: dhabaProvider.showFavoritesOnly ? AppTheme.accentRed : AppTheme.textDark,
            ),
            tooltip: 'Show Favorites',
            onPressed: () => dhabaProvider.toggleFavoritesOnly(),
          ),
          const Padding(
            padding: EdgeInsets.only(right: 16.0, left: 4.0),
            child: CircleAvatar(
              radius: 18,
              backgroundColor: AppTheme.primaryEmerald,
              child: Text(
                'VIT',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
              ),
            ),
          ),
        ],
      ),
      body: CustomScrollView(
        slivers: [
          // Search & Promo Header
          SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Real-time Search Input
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppTheme.borderLight),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: 0.04),
                          blurRadius: 8,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    child: TextField(
                      controller: _searchController,
                      onChanged: (val) => dhabaProvider.setSearchQuery(val),
                      decoration: InputDecoration(
                        hintText: 'Search parathas, thalis, dhabas...',
                        hintStyle: const TextStyle(color: AppTheme.textMuted, fontSize: 14),
                        prefixIcon: const Icon(Icons.search, color: AppTheme.primaryEmerald),
                        suffixIcon: _searchController.text.isNotEmpty
                            ? IconButton(
                                icon: const Icon(Icons.clear, size: 18, color: AppTheme.textMuted),
                                onPressed: () {
                                  _searchController.clear();
                                  dhabaProvider.setSearchQuery('');
                                },
                              )
                            : null,
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
                      ),
                    ),
                  ),
                ),

                // Active Order Live Shortcut Banner (if active order present)
                if (activeOrder != null && activeOrder.status != OrderProgressStatus.delivered) ...[
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 6.0),
                    child: InkWell(
                      onTap: () => setState(() => _currentTab = 1), // Switch to Live Track tab
                      borderRadius: BorderRadius.circular(16),
                      child: Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppTheme.primaryEmerald,
                          borderRadius: BorderRadius.circular(16),
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.primaryEmerald.withValues(alpha: 0.3),
                              blurRadius: 8,
                              offset: const Offset(0, 3),
                            ),
                          ],
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.two_wheeler, color: AppTheme.secondaryGold, size: 28),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'ACTIVE ORDER: ${activeOrder.status.displayName}',
                                    style: const TextStyle(
                                      color: AppTheme.secondaryGold,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 12,
                                    ),
                                  ),
                                  Text(
                                    '${activeOrder.dhabaName} • OTP ${activeOrder.otpCode}',
                                    style: const TextStyle(color: Colors.white, fontSize: 11),
                                  ),
                                ],
                              ),
                            ),
                            const Icon(Icons.arrow_forward_ios, size: 14, color: Colors.white),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],

                // Special Promo Banner Card
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
                  child: Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [
                          AppTheme.secondaryGold,
                          AppTheme.secondaryGold.withValues(alpha: 0.8),
                        ],
                      ),
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: const [
                              Text(
                                'VITIAN SPECIAL OFFER 🎁',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w900,
                                  color: AppTheme.secondaryTextGold,
                                  letterSpacing: 0.5,
                                ),
                              ),
                              SizedBox(height: 4),
                              Text(
                                'Get 20% OFF on First Order',
                                style: TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w800,
                                  color: AppTheme.textDark,
                                ),
                              ),
                              SizedBox(height: 2),
                              Text(
                                'Use promo code VITFIRST at checkout',
                                style: TextStyle(fontSize: 12, color: AppTheme.secondaryTextGold),
                              ),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: const BoxDecoration(
                            color: Colors.white,
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.local_offer, color: AppTheme.primaryEmerald, size: 24),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),

                // Category Pills
                CategoryPills(
                  categories: dhabaProvider.categories,
                  selectedIndex: dhabaProvider.selectedCategoryIndex,
                  onSelectCategory: (idx) => dhabaProvider.setSelectedCategoryIndex(idx),
                ),
                const SizedBox(height: 16),

                // Section Title
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16.0),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        dhabaProvider.showFavoritesOnly ? 'Your Favorite Dhabas' : 'Popular Dhabas Near You',
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                      ),
                      Text(
                        '${dhabas.length} Places',
                        style: const TextStyle(fontSize: 12, color: AppTheme.textMuted, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
              ],
            ),
          ),

          // Dhaba Cards List
          dhabas.isEmpty
              ? SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(40.0),
                    child: Column(
                      children: [
                        const Icon(Icons.search_off, size: 60, color: AppTheme.textMuted),
                        const SizedBox(height: 12),
                        const Text(
                          'No Dhabas Found',
                          style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Try clearing search filters or checking back later!',
                          style: TextStyle(color: AppTheme.textMuted, fontSize: 12),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: () {
                            _searchController.clear();
                            dhabaProvider.setSearchQuery('');
                            dhabaProvider.setSelectedCategoryIndex(0);
                            if (dhabaProvider.showFavoritesOnly) {
                              dhabaProvider.toggleFavoritesOnly();
                            }
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.primaryEmerald,
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('Reset Filters'),
                        ),
                      ],
                    ),
                  ),
                )
              : SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  sliver: SliverList(
                    delegate: SliverChildBuilderDelegate(
                      (context, index) {
                        final dhaba = dhabas[index];
                        return DhabaCard(
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
                        );
                      },
                      childCount: dhabas.length,
                    ),
                  ),
                ),
          const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
        ],
      ),
    );
  }
}
