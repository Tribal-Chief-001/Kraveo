import 'package:flutter/material.dart';
import '../models/order_model.dart';
import '../widgets/order_card.dart';

class KitchenQueueScreen extends StatefulWidget {
  final List<OrderModel> orders;
  final VoidCallback onOrderUpdate;

  const KitchenQueueScreen({
    super.key,
    required this.orders,
    required this.onOrderUpdate,
  });

  @override
  State<KitchenQueueScreen> createState() => _KitchenQueueScreenState();
}

class _KitchenQueueScreenState extends State<KitchenQueueScreen> {
  int _selectedTab = 0; // 0 = Active Queue (Preparing & Ready), 1 = History/Completed
  String _searchQuery = '';

  @override
  Widget build(BuildContext context) {
    // Filter orders
    final activeOrders = widget.orders.where((o) => o.status == OrderStatus.preparing || o.status == OrderStatus.readyForPickup).toList();
    final completedOrders = widget.orders.where((o) => o.status == OrderStatus.pickedUp || o.status == OrderStatus.delivered || o.status == OrderStatus.cancelled).toList();

    final currentList = _selectedTab == 0 ? activeOrders : completedOrders;

    final filteredList = currentList.where((o) {
      if (_searchQuery.isEmpty) return true;
      final q = _searchQuery.toLowerCase();
      return o.id.toLowerCase().contains(q) ||
          o.studentName.toLowerCase().contains(q) ||
          o.studentLocation.toLowerCase().contains(q);
    }).toList();

    final preparingCount = activeOrders.where((o) => o.status == OrderStatus.preparing).length;
    final readyCount = activeOrders.where((o) => o.status == OrderStatus.readyForPickup).length;

    return Scaffold(
      backgroundColor: const Color(0xFFFCF9F8),
      body: Column(
        children: [
          // Top Summary Banner & Filter Chips
          Container(
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(
              children: [
                // Quick Summary Stats Bar
                Row(
                  children: [
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                        decoration: BoxDecoration(
                          color: const Color(0xFF00450D).withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: const Color(0xFF00450D).withValues(alpha: 0.2)),
                        ),
                        child: Column(
                          children: [
                            const Text('PREPARING', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF00450D))),
                            const SizedBox(height: 2),
                            Text('$preparingCount', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900, color: Color(0xFF00450D))),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFDD400).withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: const Color(0xFFFDD400)),
                        ),
                        child: Column(
                          children: [
                            const Text('READY FOR PICKUP', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF6F5C00))),
                            const SizedBox(height: 2),
                            Text('$readyCount', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900, color: Color(0xFF6F5C00))),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                        decoration: BoxDecoration(
                          color: Colors.grey.withValues(alpha: 0.08),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: Colors.grey.withValues(alpha: 0.3)),
                        ),
                        child: Column(
                          children: [
                            const Text('COMPLETED', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.grey)),
                            const SizedBox(height: 2),
                            Text('${completedOrders.length}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900, color: Colors.black87)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                // Search Bar & Filter Toggle
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        onChanged: (val) => setState(() => _searchQuery = val),
                        decoration: InputDecoration(
                          hintText: 'Search order # / student...',
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
                    ),
                    const SizedBox(width: 10),
                    SegmentedButton<int>(
                      segments: const [
                        ButtonSegment(value: 0, label: Text('Active Queue', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                        ButtonSegment(value: 1, label: Text('History', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                      ],
                      selected: {_selectedTab},
                      onSelectionChanged: (set) => setState(() => _selectedTab = set.first),
                      style: ButtonStyle(
                        backgroundColor: WidgetStateProperty.resolveWith((states) {
                          if (states.contains(WidgetState.selected)) {
                            return const Color(0xFF00450D);
                          }
                          return Colors.white;
                        }),
                        foregroundColor: WidgetStateProperty.resolveWith((states) {
                          if (states.contains(WidgetState.selected)) {
                            return Colors.white;
                          }
                          return Colors.black87;
                        }),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),

          // Main Orders List
          Expanded(
            child: filteredList.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32.0),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            _selectedTab == 0 ? Icons.soup_kitchen_outlined : Icons.history_toggle_off,
                            size: 64,
                            color: Colors.grey[400],
                          ),
                          const SizedBox(height: 16),
                          Text(
                            _selectedTab == 0 ? 'No Active Kitchen Orders' : 'No Order History Yet',
                            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF1B1C1C)),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _selectedTab == 0
                                ? 'New incoming orders will appear here automatically with loud alerts.'
                                : 'Completed orders will be logged here.',
                            style: TextStyle(fontSize: 14, color: Colors.grey[600]),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: filteredList.length,
                    itemBuilder: (context, index) {
                      final order = filteredList[index];
                      return OrderCard(
                        order: order,
                        onStatusChanged: () {
                          setState(() {});
                          widget.onOrderUpdate();
                        },
                        onItemToggle: () {
                          setState(() {});
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
