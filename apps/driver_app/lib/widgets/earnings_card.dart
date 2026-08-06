import 'package:flutter/material.dart';

class EarningsCard extends StatelessWidget {
  final double todayEarnings;
  final int completedTrips;
  final VoidCallback? onTap;

  const EarningsCard({
    super.key,
    required this.todayEarnings,
    required this.completedTrips,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    const gold = Color(0xFFFDD400);
    const emeraldLight = Color(0xFF91D78A);
    const darkSurface = Color(0xFF151C2C);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(24),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: darkSurface,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: gold.withValues(alpha: 0.4), width: 1.5),
          boxShadow: [
            BoxShadow(
              color: gold.withValues(alpha: 0.1),
              blurRadius: 16,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Column(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.account_balance_wallet_outlined,
                            color: Colors.grey, size: 14),
                        const SizedBox(width: 4),
                        Text(
                          'TODAY\'S PAYOUT',
                          style: TextStyle(
                            color: Colors.grey.shade400,
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 1.0,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '₹${todayEarnings.toInt()}',
                      style: const TextStyle(
                        color: gold,
                        fontSize: 36,
                        fontWeight: FontWeight.w900,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.check_circle_outline,
                            color: emeraldLight, size: 14),
                        const SizedBox(width: 4),
                        Text(
                          '$completedTrips Trips Completed',
                          style: const TextStyle(
                            color: emeraldLight,
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: gold.withValues(alpha: 0.15),
                    shape: BoxShape.circle,
                    border: Border.all(color: gold, width: 2),
                  ),
                  child: const Icon(
                    Icons.electric_bike,
                    color: gold,
                    size: 32,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Divider(color: Colors.white10, height: 1),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _buildSubStat('Avg / Order', '₹${(completedTrips > 0 ? (todayEarnings / completedTrips) : 40).toStringAsFixed(0)}'),
                _buildSubStat('Duty Hours', '4.5 hrs'),
                _buildSubStat('Incentive', '₹50 Earned'),
                if (onTap != null)
                  const Row(
                    children: [
                      Text(
                        'Details',
                        style: TextStyle(
                          color: gold,
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                        ),
                      ),
                      Icon(Icons.chevron_right, color: gold, size: 16),
                    ],
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSubStat(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: Colors.grey, fontSize: 10, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700),
        ),
      ],
    );
  }
}
