import 'package:flutter/material.dart';

class EarningsHistoryScreen extends StatelessWidget {
  const EarningsHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    const gold = Color(0xFFFDD400);
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    const darkSurface = Color(0xFF151C2C);
    const darkBg = Color(0xFF1B1C1C);

    return Scaffold(
      backgroundColor: darkBg,
      appBar: AppBar(
        backgroundColor: darkBg,
        elevation: 0,
        title: const Text(
          'Earnings Dashboard',
          style: TextStyle(
            fontWeight: FontWeight.w900,
            fontSize: 20,
            color: Colors.white,
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Overview Header
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: darkSurface,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: gold.withValues(alpha: 0.4), width: 1.5),
              ),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'THIS WEEK\'S TOTAL',
                            style: TextStyle(
                              color: Colors.grey.shade400,
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.0,
                            ),
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            '₹3,240',
                            style: TextStyle(
                              color: gold,
                              fontSize: 34,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          color: emerald,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: emeraldLight),
                        ),
                        child: const Row(
                          children: [
                            Icon(Icons.star, color: gold, size: 14),
                            SizedBox(width: 4),
                            Text(
                              '4.9 Rating',
                              style: TextStyle(
                                color: emeraldLight,
                                fontWeight: FontWeight.bold,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildHeaderMiniStat('Today', '₹460'),
                      _buildDivider(),
                      _buildHeaderMiniStat('Trips', '84'),
                      _buildDivider(),
                      _buildHeaderMiniStat('Avg/Trip', '₹38.5'),
                      _buildDivider(),
                      _buildHeaderMiniStat('Incentives', '₹350'),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Weekly Breakdown Title
            const Text(
              'Weekly Performance',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 16,
              ),
            ),
            const SizedBox(height: 12),

            // Mock Bar Chart
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: darkSurface,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.white10),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  _buildBar('Mon', 0.4, '₹320', false),
                  _buildBar('Tue', 0.6, '₹480', false),
                  _buildBar('Wed', 0.8, '₹640', false),
                  _buildBar('Thu', 0.5, '₹410', false),
                  _buildBar('Fri', 0.9, '₹730', false),
                  _buildBar('Sat', 1.0, '₹850', true),
                  _buildBar('Sun', 0.6, '₹460', true),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Payout Breakdown Components
            const Text(
              'Earnings Breakdown',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 16,
              ),
            ),
            const SizedBox(height: 12),

            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: darkSurface,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.white10),
              ),
              child: Column(
                children: [
                  _buildBreakdownRow('Base Delivery Fare', '₹2,420', Icons.directions_bike),
                  const Divider(color: Colors.white10),
                  _buildBreakdownRow('Surge & Peak Bonus', '₹420', Icons.bolt),
                  const Divider(color: Colors.white10),
                  _buildBreakdownRow('Student Tips', '₹150', Icons.volunteer_activism),
                  const Divider(color: Colors.white10),
                  _buildBreakdownRow('Campus Target Incentives', '₹250', Icons.military_tech),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // Recent Direct Payouts
            const Text(
              'Recent Bank / UPI Transfers',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 16,
              ),
            ),
            const SizedBox(height: 12),

            _buildPayoutTile('Payout #PAY-9921', 'Aug 05, 2026', '₹2,780', 'COMPLETED'),
            const SizedBox(height: 10),
            _buildPayoutTile('Payout #PAY-9810', 'Jul 29, 2026', '₹3,150', 'COMPLETED'),
          ],
        ),
      ),
    );
  }

  static Widget _buildHeaderMiniStat(String label, String value) {
    return Column(
      children: [
        Text(
          label,
          style: const TextStyle(color: Colors.grey, fontSize: 11),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 14,
          ),
        ),
      ],
    );
  }

  static Widget _buildDivider() {
    return Container(
      height: 24,
      width: 1,
      color: Colors.white10,
    );
  }

  static Widget _buildBar(String day, double factor, String amount, bool isHighlight) {
    const gold = Color(0xFFFDD400);
    const emeraldLight = Color(0xFF91D78A);

    return Column(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        Text(
          amount,
          style: const TextStyle(color: Colors.grey, fontSize: 9, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        Container(
          height: 90 * factor,
          width: 22,
          decoration: BoxDecoration(
            color: isHighlight ? gold : emeraldLight.withValues(alpha: 0.7),
            borderRadius: BorderRadius.circular(6),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          day,
          style: TextStyle(
            color: isHighlight ? gold : Colors.grey,
            fontWeight: FontWeight.bold,
            fontSize: 11,
          ),
        ),
      ],
    );
  }

  static Widget _buildBreakdownRow(String label, String amount, IconData icon) {
    const gold = Color(0xFFFDD400);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8.0),
      child: Row(
        children: [
          Icon(icon, color: gold, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(color: Colors.white, fontSize: 14),
            ),
          ),
          Text(
            amount,
            style: const TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.bold,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  static Widget _buildPayoutTile(
      String id, String date, String amount, String status) {
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    const darkSurface = Color(0xFF151C2C);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: darkSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white10),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: emerald.withValues(alpha: 0.3),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.account_balance,
                    color: emeraldLight, size: 20),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    id,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    date,
                    style: const TextStyle(color: Colors.grey, fontSize: 11),
                  ),
                ],
              ),
            ],
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                amount,
                style: const TextStyle(
                  color: Color(0xFFFDD400),
                  fontWeight: FontWeight.w900,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: emerald.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  status,
                  style: const TextStyle(
                    color: emeraldLight,
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
