import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../models/order.dart';
import '../providers/order_provider.dart';
import '../widgets/animated_rider_map.dart';
import '../widgets/split_bill_modal.dart';

class LiveTrackingScreen extends StatefulWidget {
  final OrderModel? order;
  final String? hostel;
  final String? dhabaName;
  final double? totalAmount;

  const LiveTrackingScreen({
    super.key,
    this.order,
    this.hostel,
    this.dhabaName,
    this.totalAmount,
  });

  @override
  State<LiveTrackingScreen> createState() => _LiveTrackingScreenState();
}

class _LiveTrackingScreenState extends State<LiveTrackingScreen> {
  final TextEditingController _otpInputController = TextEditingController();

  @override
  void dispose() {
    _otpInputController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final orderProvider = Provider.of<OrderProvider>(context);
    final activeOrder = widget.order ?? orderProvider.activeOrder;

    if (activeOrder == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Live Order Tracking')),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.two_wheeler_outlined, size: 70, color: AppTheme.textMuted),
              const SizedBox(height: 16),
              const Text(
                'No Active Orders Right Now',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.textDark),
              ),
              const SizedBox(height: 8),
              const Text(
                'Place an order from any Dhaba to track live delivery!',
                style: TextStyle(color: AppTheme.textMuted, fontSize: 13),
              ),
              const SizedBox(height: 20),
              ElevatedButton(
                onPressed: () => Navigator.pop(context),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryEmerald,
                  foregroundColor: Colors.white,
                ),
                child: const Text('EXPLORE DHABAS'),
              ),
            ],
          ),
        ),
      );
    }

    final status = activeOrder.status;

    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Live Order Tracking', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            Text('ID: ${activeOrder.id}', style: const TextStyle(fontSize: 11, color: AppTheme.textMuted)),
          ],
        ),
        actions: [
          // Demo status step button
          if (status != OrderProgressStatus.delivered)
            TextButton.icon(
              onPressed: () {
                orderProvider.advanceActiveOrderStatus();
              },
              icon: const Icon(Icons.fast_forward, size: 16, color: AppTheme.primaryEmerald),
              label: const Text(
                'Next Step',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.primaryEmerald),
              ),
            ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Status Hero Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [AppTheme.primaryEmerald, AppTheme.primaryContainer],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(24),
                boxShadow: [
                  BoxShadow(
                    color: AppTheme.primaryEmerald.withValues(alpha: 0.3),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  )
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'CURRENT STATUS',
                            style: TextStyle(fontSize: 10, color: Colors.white70, fontWeight: FontWeight.bold, letterSpacing: 0.5),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            status.displayName,
                            style: const TextStyle(
                              color: AppTheme.secondaryGold,
                              fontWeight: FontWeight.w800,
                              fontSize: 20,
                            ),
                          ),
                        ],
                      ),
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.15),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.two_wheeler, color: AppTheme.secondaryGold, size: 32),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: LinearProgressIndicator(
                      value: status.progressValue,
                      minHeight: 8,
                      backgroundColor: Colors.white24,
                      color: AppTheme.secondaryGold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Dhaba: ${activeOrder.dhabaName}',
                        style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w500),
                      ),
                      Text(
                        'Total: ₹${activeOrder.totalAmount.toInt()}',
                        style: const TextStyle(color: AppTheme.secondaryGold, fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),

            // Roommate Split-Bill Tool Shortcut
            SizedBox(
              width: double.infinity,
              height: 44,
              child: OutlinedButton.icon(
                onPressed: () {
                  showModalBottomSheet(
                    context: context,
                    isScrollControlled: true,
                    shape: const RoundedRectangleBorder(
                      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                    ),
                    builder: (context) => SplitBillModal(order: activeOrder),
                  );
                },
                icon: const Icon(Icons.groups, color: AppTheme.primaryEmerald, size: 20),
                label: const Text('Split Bill with Roommates on WhatsApp', style: TextStyle(color: AppTheme.primaryEmerald, fontWeight: FontWeight.bold, fontSize: 12)),
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: AppTheme.primaryEmerald),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Animated Map View
            AnimatedRiderMap(
              status: status,
              hostel: activeOrder.hostel,
              dhabaName: activeOrder.dhabaName,
            ),
            const SizedBox(height: 16),

            // Gate Handshake OTP Card (Prominent Requirement)
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
                side: BorderSide(
                  color: status == OrderProgressStatus.arrivedAtGate
                      ? AppTheme.secondaryGold
                      : AppTheme.primaryEmerald.withValues(alpha: 0.3),
                  width: 2.0,
                ),
              ),
              color: status == OrderProgressStatus.arrivedAtGate
                  ? AppTheme.secondaryGold.withValues(alpha: 0.1)
                  : Colors.white,
              child: Padding(
                padding: const EdgeInsets.all(18.0),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: AppTheme.primaryEmerald.withValues(alpha: 0.1),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.lock_open, color: AppTheme.primaryEmerald, size: 24),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: const [
                              Text(
                                'GATE HANDSHAKE SECURITY OTP',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w800,
                                  color: AppTheme.primaryEmerald,
                                  letterSpacing: 0.5,
                                ),
                              ),
                              SizedBox(height: 2),
                              Text(
                                'Share code with runner at gate to unlock delivery',
                                style: TextStyle(fontSize: 12, color: AppTheme.textMuted),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                      decoration: BoxDecoration(
                        color: AppTheme.surfaceVariant.withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppTheme.borderLight),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            children: activeOrder.otpCode.split('').map((char) {
                              return Container(
                                margin: const EdgeInsets.only(right: 8),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(color: AppTheme.primaryEmerald.withValues(alpha: 0.4)),
                                ),
                                child: Text(
                                  char,
                                  style: const TextStyle(
                                    fontSize: 22,
                                    fontWeight: FontWeight.w900,
                                    color: AppTheme.textDark,
                                    letterSpacing: 2,
                                  ),
                                ),
                              );
                            }).toList(),
                          ),
                          IconButton(
                            icon: const Icon(Icons.copy, color: AppTheme.primaryEmerald),
                            tooltip: 'Copy OTP',
                            onPressed: () {
                              Clipboard.setData(ClipboardData(text: activeOrder.otpCode));
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('Gate Handshake OTP copied to clipboard!'),
                                  backgroundColor: AppTheme.primaryEmerald,
                                  duration: Duration(seconds: 2),
                                ),
                              );
                            },
                          ),
                        ],
                      ),
                    ),
                    if (status == OrderProgressStatus.arrivedAtGate) ...[
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _otpInputController,
                              keyboardType: TextInputType.number,
                              maxLength: 4,
                              decoration: InputDecoration(
                                hintText: 'Enter OTP to verify',
                                counterText: '',
                                isDense: true,
                                filled: true,
                                fillColor: Colors.white,
                                border: OutlineInputBorder(
                                  borderRadius: BorderRadius.circular(12),
                                  borderSide: const BorderSide(color: AppTheme.borderLight),
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          ElevatedButton(
                            onPressed: () {
                              final success = orderProvider.verifyGateHandshakeOtp(_otpInputController.text);
                              if (success) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Handshake Verified! Order Delivered.'),
                                    backgroundColor: AppTheme.accentGreen,
                                  ),
                                );
                              } else {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Incorrect OTP. Check code above.'),
                                    backgroundColor: AppTheme.accentRed,
                                  ),
                                );
                              }
                            },
                            style: ElevatedButton.styleFrom(
                              backgroundColor: AppTheme.accentGreen,
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                            ),
                            child: const Text('VERIFY', style: TextStyle(fontWeight: FontWeight.bold)),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Delivery Timeline Visualizer Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(18.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Delivery Progress Timeline',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                    ),
                    const SizedBox(height: 16),
                    _buildTimelineTile(
                      title: 'Order Placed',
                      subtitle: 'Order confirmed with Dhaba',
                      icon: Icons.check_circle,
                      isCompleted: true,
                      isCurrent: status == OrderProgressStatus.placed,
                    ),
                    _buildTimelineTile(
                      title: 'Preparing Dish',
                      subtitle: 'Dhaba is cooking your meal fresh',
                      icon: Icons.soup_kitchen,
                      isCompleted: status.index >= OrderProgressStatus.preparing.index,
                      isCurrent: status == OrderProgressStatus.preparing,
                    ),
                    _buildTimelineTile(
                      title: 'Runner Picked Up',
                      subtitle: 'Student Runner collected package',
                      icon: Icons.inventory_2,
                      isCompleted: status.index >= OrderProgressStatus.pickedUp.index,
                      isCurrent: status == OrderProgressStatus.pickedUp,
                    ),
                    _buildTimelineTile(
                      title: 'On The Way',
                      subtitle: 'Travelling highway route to campus',
                      icon: Icons.two_wheeler,
                      isCompleted: status.index >= OrderProgressStatus.onTheWay.index,
                      isCurrent: status == OrderProgressStatus.onTheWay,
                    ),
                    _buildTimelineTile(
                      title: 'Arrived at Gate',
                      subtitle: 'Awaiting Gate Handshake OTP verification',
                      icon: Icons.sensor_door,
                      isCompleted: status.index >= OrderProgressStatus.arrivedAtGate.index,
                      isCurrent: status == OrderProgressStatus.arrivedAtGate,
                      isLast: true,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Runner Information Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const CircleAvatar(
                        radius: 24,
                        backgroundColor: AppTheme.primaryEmerald,
                        child: Icon(Icons.person, color: Colors.white, size: 28),
                      ),
                      title: Text(
                        activeOrder.riderName,
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      subtitle: Text(
                        'VIT Student Runner • ${activeOrder.riderVehicle}',
                        style: const TextStyle(fontSize: 12, color: AppTheme.textMuted),
                      ),
                      trailing: CircleAvatar(
                        backgroundColor: AppTheme.accentGreen.withValues(alpha: 0.15),
                        child: IconButton(
                          icon: const Icon(Icons.phone, color: AppTheme.accentGreen, size: 20),
                          onPressed: () {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text('Calling runner ${activeOrder.riderPhone}...'),
                                backgroundColor: AppTheme.primaryEmerald,
                              ),
                            );
                          },
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _buildTimelineTile({
    required String title,
    required String subtitle,
    required IconData icon,
    required bool isCompleted,
    required bool isCurrent,
    bool isLast = false,
  }) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Column(
          children: [
            Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: isCompleted ? AppTheme.primaryEmerald : AppTheme.surfaceVariant,
                shape: BoxShape.circle,
                border: isCurrent
                    ? Border.all(color: AppTheme.secondaryGold, width: 2)
                    : null,
              ),
              child: Icon(
                icon,
                size: 16,
                color: isCompleted ? Colors.white : AppTheme.textMuted,
              ),
            ),
            if (!isLast)
              Container(
                width: 2,
                height: 36,
                color: isCompleted ? AppTheme.primaryEmerald : AppTheme.borderLight,
              ),
          ],
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 2.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontWeight: isCompleted ? FontWeight.bold : FontWeight.w600,
                    fontSize: 14,
                    color: isCompleted ? AppTheme.textDark : AppTheme.textMuted,
                  ),
                ),
                Text(
                  subtitle,
                  style: const TextStyle(fontSize: 11, color: AppTheme.textMuted),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
