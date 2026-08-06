import 'package:flutter/material.dart';
import '../models/order_model.dart';

class SalesAnalyticsScreen extends StatelessWidget {
  final List<OrderModel> orders;

  const SalesAnalyticsScreen({super.key, required this.orders});

  @override
  Widget build(BuildContext context) {
    // Calculate live analytics metrics
    final completedOrders = orders.where((o) => o.status == OrderStatus.completed).toList();
    final totalSales = orders.fold<double>(0, (sum, o) => sum + o.totalAmount);
    final totalCompletedSales = completedOrders.fold<double>(0, (sum, o) => sum + o.totalAmount);
    final totalOrdersCount = orders.length;
    final avgOrderValue = totalOrdersCount > 0 ? totalSales / totalOrdersCount : 0.0;
    final avgPrepTime = orders.isNotEmpty
        ? (orders.fold<int>(0, (sum, o) => sum + o.prepTimeMinutes) / orders.length).round()
        : 15;

    // Hourly peak breakdown mock data
    final peakHoursData = [
      {'time': '8 PM - 9 PM', 'orders': 8, 'sales': 1420},
      {'time': '9 PM - 10 PM', 'orders': 18, 'sales': 3240},
      {'time': '10 PM - 11 PM', 'orders': 24, 'sales': 4560},
      {'time': '11 PM - 12 AM', 'orders': 15, 'sales': 2700},
      {'time': '12 AM - 1 AM', 'orders': 6, 'sales': 980},
    ];

    // Top selling dishes mock calculation
    final topDishes = [
      {'name': 'Paneer Butter Masala', 'qty': 42, 'revenue': 7560},
      {'name': 'Tandoori Roti', 'qty': 180, 'revenue': 2700},
      {'name': 'Cheese Butter Maggi', 'qty': 35, 'revenue': 2450},
      {'name': 'Mango Lassi', 'qty': 28, 'revenue': 1680},
      {'name': 'Paneer Sandwich', 'qty': 22, 'revenue': 1980},
    ];

    return Scaffold(
      backgroundColor: const Color(0xFFFCF9F8),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top Header Title
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const [
                    Text(
                      'DAILY EARNINGS & ANALYTICS',
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w900, color: Color(0xFF00450D)),
                    ),
                    SizedBox(height: 2),
                    Text('Real-time revenue performance for FC Night Mess', style: TextStyle(fontSize: 13, color: Colors.grey)),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFDD400),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Text('TODAY', style: TextStyle(fontWeight: FontWeight.w900, color: Color(0xFF6F5C00), fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Hero Earnings Banner Card
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF00450D), Color(0xFF006817)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(24),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFF00450D).withValues(alpha: 0.3),
                    blurRadius: 12,
                    offset: const Offset(0, 6),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: const [
                      Text(
                        'Total Gross Revenue Today',
                        style: TextStyle(color: Colors.white70, fontSize: 14, fontWeight: FontWeight.bold),
                      ),
                      Icon(Icons.payments_rounded, color: Color(0xFFFDD400), size: 28),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '₹${totalSales.toStringAsFixed(0)}',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 38,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 1,
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Divider(color: Colors.white24, height: 1),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Completed Payout: ₹${totalCompletedSales.toStringAsFixed(0)}',
                        style: const TextStyle(color: Color(0xFFFDD400), fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      Text(
                        'Active Orders: ${orders.length - completedOrders.length}',
                        style: const TextStyle(color: Colors.white70, fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // 4 Grid Key Stat Cards
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              childAspectRatio: 1.6,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              children: [
                _buildStatCard('Total Orders', '$totalOrdersCount', Icons.receipt_long, const Color(0xFF00450D)),
                _buildStatCard('Avg Order Value', '₹${avgOrderValue.toStringAsFixed(0)}', Icons.point_of_sale, const Color(0xFF6F5C00)),
                _buildStatCard('Completed', '${completedOrders.length}', Icons.check_circle_outline, const Color(0xFF00450D)),
                _buildStatCard('Avg Prep ETA', '$avgPrepTime mins', Icons.timer_outlined, const Color(0xFFBA1A1A)),
              ],
            ),
            const SizedBox(height: 24),

            // Peak Hours Hourly Chart Breakdown
            const Text(
              'PEAK HOURS & ORDER VOLUME',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: Color(0xFF1B1C1C)),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFE5E2E1)),
              ),
              child: Column(
                children: peakHoursData.map((hourData) {
                  final int ordersCount = hourData['orders'] as int;
                  final double progress = (ordersCount / 30).clamp(0.1, 1.0);
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 12.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              hourData['time'] as String,
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF1B1C1C)),
                            ),
                            Text(
                              '${hourData['orders']} orders (₹${hourData['sales']})',
                              style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 13, color: Color(0xFF00450D)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: LinearProgressIndicator(
                            value: progress,
                            minHeight: 10,
                            backgroundColor: const Color(0xFFFCF9F8),
                            color: ordersCount > 20
                                ? const Color(0xFF00450D)
                                : ordersCount > 10
                                    ? const Color(0xFFFDD400)
                                    : Colors.green[300],
                          ),
                        ),
                      ],
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 24),

            // Top Selling Dishes List
            const Text(
              'TOP SELLING DISHES TODAY',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: Color(0xFF1B1C1C)),
            ),
            const SizedBox(height: 10),
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFE5E2E1)),
              ),
              child: ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: topDishes.length,
                separatorBuilder: (context, idx) => const Divider(height: 1, color: Color(0xFFE5E2E1)),
                itemBuilder: (context, idx) {
                  final dish = topDishes[idx];
                  return ListTile(
                    leading: CircleAvatar(
                      backgroundColor: idx == 0
                          ? const Color(0xFFFDD400)
                          : idx == 1
                              ? const Color(0xFFE0E0E0)
                              : const Color(0xFFFCF9F8),
                      child: Text(
                        '#${idx + 1}',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          color: idx == 0 ? const Color(0xFF6F5C00) : const Color(0xFF00450D),
                        ),
                      ),
                    ),
                    title: Text(
                      dish['name'] as String,
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF1B1C1C)),
                    ),
                    subtitle: Text('${dish['qty']} portions sold', style: const TextStyle(fontSize: 12, color: Colors.grey)),
                    trailing: Text(
                      '₹${dish['revenue']}',
                      style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16, color: Color(0xFF00450D)),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 24),

            // Payment Summary Breakdown Card
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFFFCF9F8),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFE5E2E1)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      children: const [
                        Icon(Icons.qr_code_2, color: Color(0xFF00450D), size: 30),
                        SizedBox(height: 4),
                        Text('UPI / Online', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey)),
                        SizedBox(height: 2),
                        Text('88% (₹4,260)', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: Color(0xFF00450D))),
                      ],
                    ),
                  ),
                  Container(height: 40, width: 1, color: const Color(0xFFE5E2E1)),
                  Expanded(
                    child: Column(
                      children: const [
                        Icon(Icons.account_balance_wallet, color: Color(0xFF6F5C00), size: 30),
                        SizedBox(height: 4),
                        Text('Cash / Pickup', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey)),
                        SizedBox(height: 2),
                        Text('12% (₹590)', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: Color(0xFF6F5C00))),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _buildStatCard(String label, String value, IconData icon, Color color) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE5E2E1)),
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 6, offset: const Offset(0, 2)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey)),
              Icon(icon, color: color, size: 20),
            ],
          ),
          Text(
            value,
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: color),
          ),
        ],
      ),
    );
  }
}
