import 'dart:async';
import 'package:flutter/material.dart';
import '../models/order_model.dart';

class OrderCard extends StatefulWidget {
  final OrderModel order;
  final VoidCallback onStatusChanged;
  final VoidCallback onItemToggle;

  const OrderCard({
    super.key,
    required this.order,
    required this.onStatusChanged,
    required this.onItemToggle,
  });

  @override
  State<OrderCard> createState() => _OrderCardState();
}

class _OrderCardState extends State<OrderCard> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    // Update countdown timer every second
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.order.status == OrderStatus.preparing) {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  String _formatCountdown(Duration duration) {
    if (duration.isNegative) {
      final positive = duration.abs();
      final mins = positive.inMinutes;
      final secs = positive.inSeconds % 60;
      return 'OVERDUE -${mins}m ${secs.toString().padLeft(2, '0')}s';
    }
    final mins = duration.inMinutes;
    final secs = duration.inSeconds % 60;
    return '${mins}m ${secs.toString().padLeft(2, '0')}s ETA';
  }

  Color _getTimerColor(Duration duration) {
    if (duration.isNegative) return const Color(0xFFBA1A1A); // Red
    if (duration.inMinutes < 5) return const Color(0xFF6F5C00); // Gold Dark
    return const Color(0xFF00450D); // Emerald
  }

  Color _getTimerBgColor(Duration duration) {
    if (duration.isNegative) return const Color(0xFFFFDAD6);
    if (duration.inMinutes < 5) return const Color(0xFFFFF099);
    return const Color(0xFFE2F7E4);
  }

  @override
  Widget build(BuildContext context) {
    final remaining = widget.order.remainingDuration;
    final isPreparing = widget.order.status == OrderStatus.preparing;
    final isReady = widget.order.status == OrderStatus.ready;
    final isCompleted = widget.order.status == OrderStatus.completed;

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: isPreparing
              ? const Color(0xFF00450D)
              : isReady
                  ? const Color(0xFFFDD400)
                  : const Color(0xFFE5E2E1),
          width: 2.5,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(18.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top Row: Order ID & Countdown Badge
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Text(
                      widget.order.id,
                      style: const TextStyle(
                        color: Color(0xFF00450D),
                        fontWeight: FontWeight.w900,
                        fontSize: 20,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: isPreparing
                            ? const Color(0xFF00450D)
                            : isReady
                                ? const Color(0xFFFDD400)
                                : Colors.grey,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        widget.order.status.name.toUpperCase(),
                        style: TextStyle(
                          color: isReady ? Colors.black87 : Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ],
                ),
                if (isPreparing)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: _getTimerBgColor(remaining),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.timer_outlined, size: 16, color: _getTimerColor(remaining)),
                        const SizedBox(width: 4),
                        Text(
                          _formatCountdown(remaining),
                          style: TextStyle(
                            color: _getTimerColor(remaining),
                            fontWeight: FontWeight.w900,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),

            // Student Info & Location
            Row(
              children: [
                const Icon(Icons.person_pin_circle_outlined, color: Color(0xFF6F5C00), size: 18),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${widget.order.studentName} (${widget.order.studentLocation})',
                    style: const TextStyle(
                      color: Color(0xFF1B1C1C),
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                    ),
                  ),
                ),
                Text(
                  '₹${widget.order.totalAmount.toStringAsFixed(0)}',
                  style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16, color: Color(0xFF00450D)),
                ),
              ],
            ),

            const Divider(height: 24, color: Color(0xFFE5E2E1), thickness: 1.5),

            // Preparation Checklist Header
            Row(
              children: const [
                Icon(Icons.checklist_rtl_rounded, color: Color(0xFF00450D), size: 20),
                SizedBox(width: 6),
                Text(
                  'Dish Preparation Checklist:',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13, color: Colors.grey),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Items Interactive Checklist
            ...widget.order.items.map((item) {
              return Container(
                margin: const EdgeInsets.only(bottom: 6),
                decoration: BoxDecoration(
                  color: item.isPrepared ? const Color(0xFFE2F7E4) : const Color(0xFFFCF9F8),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: item.isPrepared ? const Color(0xFF00450D) : const Color(0xFFE5E2E1),
                  ),
                ),
                child: Material(
                  color: Colors.transparent,
                  child: CheckboxListTile(
                  dense: true,
                  activeColor: const Color(0xFF00450D),
                  value: item.isPrepared,
                  title: Row(
                    children: [
                      Text(
                        '${item.quantity}x ',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 16,
                          color: item.isPrepared ? const Color(0xFF00450D) : const Color(0xFF1B1C1C),
                          decoration: item.isPrepared ? TextDecoration.lineThrough : null,
                        ),
                      ),
                      Expanded(
                        child: Text(
                          item.name,
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 15,
                            color: item.isPrepared ? Colors.grey[700] : const Color(0xFF1B1C1C),
                            decoration: item.isPrepared ? TextDecoration.lineThrough : null,
                          ),
                        ),
                      ),
                    ],
                  ),
                  onChanged: isCompleted
                      ? null
                      : (bool? val) {
                          item.isPrepared = val ?? false;
                          widget.onItemToggle();
                        },
                ),
              ),
              );
            }).toList(),

            // Customer Note Callout Box
            if (widget.order.customerNote != null && widget.order.customerNote!.isNotEmpty) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFDAD6),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFBA1A1A)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline, color: Color(0xFFBA1A1A), size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Spice Note: "${widget.order.customerNote}"',
                        style: const TextStyle(color: Color(0xFF93000A), fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 16),

            // Action Button based on Status
            if (isPreparing)
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: () {
                    widget.order.status = OrderStatus.ready;
                    // Mark all items prepared
                    for (var it in widget.order.items) {
                      it.isPrepared = true;
                    }
                    widget.onStatusChanged();
                  },
                  icon: const Icon(Icons.check_circle_outline, color: Colors.white),
                  label: const Text(
                    'MARK READY FOR PICKUP',
                    style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 15, letterSpacing: 0.5),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00450D),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                ),
              )
            else if (isReady)
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: () {
                    widget.order.status = OrderStatus.completed;
                    widget.onStatusChanged();
                  },
                  icon: const Icon(Icons.task_alt, color: Colors.black87),
                  label: const Text(
                    'HAND OVER & MARK COMPLETED',
                    style: TextStyle(color: Colors.black87, fontWeight: FontWeight.w900, fontSize: 15),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFFFDD400),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                ),
              )
            else
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFFFCF9F8),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFE5E2E1)),
                ),
                child: const Center(
                  child: Text(
                    'ORDER COMPLETED & PICKED UP',
                    style: TextStyle(color: Colors.grey, fontWeight: FontWeight.w900, fontSize: 13),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
