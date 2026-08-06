import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/order.dart';
import '../providers/order_provider.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';

class OrderHistoryScreen extends StatelessWidget {
  const OrderHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final orderProvider = Provider.of<OrderProvider>(context);
    final cart = Provider.of<CartProvider>(context, listen: false);
    final dhabaProvider = Provider.of<DhabaProvider>(context, listen: false);
    final history = orderProvider.orderHistory;

    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      appBar: AppBar(
        title: const Text('Order History'),
      ),
      body: history.isEmpty
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: const [
                  Icon(Icons.history_outlined, size: 70, color: AppTheme.textMuted),
                  SizedBox(height: 16),
                  Text(
                    'No Past Orders Yet',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                  ),
                  SizedBox(height: 8),
                  Text(
                    'Your completed orders will appear here!',
                    style: TextStyle(color: AppTheme.textMuted, fontSize: 13),
                  ),
                ],
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: history.length,
              itemBuilder: (context, index) {
                final order = history[index];
                return _buildOrderCard(context, order, orderProvider, cart, dhabaProvider);
              },
            ),
    );
  }

  Widget _buildOrderCard(
    BuildContext context,
    OrderModel order,
    OrderProvider orderProvider,
    CartProvider cart,
    DhabaProvider dhabaProvider,
  ) {
    final isDelivered = order.status == OrderProgressStatus.delivered;

    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      order.dhabaName,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                    ),
                    Text(
                      'ID: ${order.id} • ${order.hostel}',
                      style: const TextStyle(fontSize: 11, color: AppTheme.textMuted),
                    ),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: isDelivered
                        ? AppTheme.accentGreen.withValues(alpha: 0.12)
                        : AppTheme.secondaryGold.withValues(alpha: 0.25),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    order.status.displayName,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: isDelivered ? AppTheme.accentGreen : AppTheme.secondaryTextGold,
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 20, color: AppTheme.borderLight),

            // Items list summary
            if (order.items.isNotEmpty)
              ...order.items.map((item) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2.0),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        '${item.quantity}x ${item.item.name}',
                        style: const TextStyle(fontSize: 13, color: AppTheme.textDark),
                      ),
                      Text(
                        '₹${item.totalPrice.toInt()}',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                      ),
                    ],
                  ),
                );
              })
            else
              Text(
                'Subtotal: ₹${order.subtotal.toInt()} • Delivery: ₹${order.deliveryFee.toInt()}',
                style: const TextStyle(fontSize: 12, color: AppTheme.textMuted),
              ),

            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Total Amount Paid', style: TextStyle(fontSize: 10, color: AppTheme.textMuted)),
                    Text(
                      '₹${order.totalAmount.toInt()}',
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: AppTheme.primaryEmerald),
                    ),
                  ],
                ),
                ElevatedButton.icon(
                  onPressed: () {
                    orderProvider.reorder(order, cart, dhabaProvider);
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('Items from ${order.dhabaName} added to cart!'),
                        backgroundColor: AppTheme.primaryEmerald,
                      ),
                    );
                  },
                  icon: const Icon(Icons.replay, size: 16),
                  label: const Text('REORDER', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.secondaryGold,
                    foregroundColor: AppTheme.secondaryTextGold,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
