import 'dart:async';
import 'package:flutter/material.dart';
import '../models/order_model.dart';
import '../services/vendor_api_service.dart';

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
  late Duration _remaining;
  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    _remaining = widget.order.remainingDuration;
    _startTimer();
  }

  void _startTimer() {
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) {
        setState(() {
          _remaining = widget.order.remainingDuration;
        });
      }
    });
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    super.dispose();
  }

  String _formatDuration(Duration d) {
    if (d.isNegative) return '00:00 (LATE)';
    final mins = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final secs = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$mins:$secs';
  }

  @override
  Widget build(BuildContext context) {
    final isPreparing = widget.order.status == OrderStatus.preparing;
    final isReady = widget.order.status == OrderStatus.readyForPickup;
    final isPickedUp = widget.order.status == OrderStatus.pickedUp || widget.order.status == OrderStatus.delivered;

    final isLate = _remaining.isNegative && isPreparing;

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: isLate
              ? const Color(0xFFBA1A1A)
              : isReady
                  ? const Color(0xFFFDD400)
                  : const Color(0xFF00450D),
          width: 2,
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
            // Top Header: Order ID & Countdown Badge
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFCF9F8),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFE5E2E1)),
                      ),
                      child: const Icon(Icons.receipt_rounded, color: Color(0xFF00450D), size: 20),
                    ),
                    const SizedBox(width: 10),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.order.id,
                          style: const TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 17,
                            color: Color(0xFF1B1C1C),
                          ),
                        ),
                        Text(
                          'ETA: ${widget.order.prepTimeMinutes} Mins',
                          style: const TextStyle(fontSize: 11, color: Colors.grey, fontWeight: FontWeight.bold),
                        ),
                      ],
                    ),
                  ],
                ),

                // Countdown Badge
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: isLate
                        ? const Color(0xFFFFDAD6)
                        : isReady
                            ? const Color(0xFFFFF7D1)
                            : const Color(0xFFE2F7E4),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: isLate
                          ? const Color(0xFFBA1A1A)
                          : isReady
                              ? const Color(0xFF6F5C00)
                              : const Color(0xFF00450D),
                      width: 1.5,
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        isLate
                            ? Icons.warning_amber_rounded
                            : isReady
                                ? Icons.check_circle_outline
                                : Icons.timer,
                        size: 16,
                        color: isLate
                            ? const Color(0xFFBA1A1A)
                            : isReady
                                ? const Color(0xFF6F5C00)
                                : const Color(0xFF00450D),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        isReady ? 'READY / तैयार' : _formatDuration(_remaining),
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 12,
                          color: isLate
                              ? const Color(0xFFBA1A1A)
                              : isReady
                                  ? const Color(0xFF6F5C00)
                                  : const Color(0xFF00450D),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const SizedBox(height: 14),

            // Student Info & Location
            Row(
              children: [
                const Icon(Icons.person, size: 18, color: Color(0xFF00450D)),
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
                  'Dish Preparation Checklist / सामग्री जाँच:',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13, color: Colors.grey),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Items Interactive Checklist (Non-dense 56px touch targets for greasy/gloved hands)
            ...widget.order.items.map((item) {
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                decoration: BoxDecoration(
                  color: item.isPrepared ? const Color(0xFFE2F7E4) : const Color(0xFFFCF9F8),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: item.isPrepared ? const Color(0xFF00450D) : const Color(0xFFE5E2E1),
                    width: 1.5,
                  ),
                ),
                child: Material(
                  color: Colors.transparent,
                  child: CheckboxListTile(
                    dense: false, // Large 56px touch target standard
                    activeColor: const Color(0xFF00450D),
                    value: item.isPrepared,
                    title: Row(
                      children: [
                        Text(
                          '${item.quantity}x ',
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 17,
                            color: item.isPrepared ? const Color(0xFF00450D) : const Color(0xFF1B1C1C),
                            decoration: item.isPrepared ? TextDecoration.lineThrough : null,
                          ),
                        ),
                        Expanded(
                          child: Text(
                            item.name,
                            style: TextStyle(
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                              color: item.isPrepared ? Colors.grey[700] : const Color(0xFF1B1C1C),
                              decoration: item.isPrepared ? TextDecoration.lineThrough : null,
                            ),
                          ),
                        ),
                      ],
                    ),
                    onChanged: isPickedUp
                        ? null
                        : (bool? val) {
                            setState(() {
                              item.isPrepared = val ?? false;
                            });
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
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFDAD6),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: const Color(0xFFBA1A1A)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline, color: Color(0xFFBA1A1A), size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Special Request: "${widget.order.customerNote}"',
                        style: const TextStyle(color: Color(0xFF93000A), fontSize: 13, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 16),

            // Action Button with Full 64px Touch Target & Bilingual Text
            if (isPreparing)
              SizedBox(
                width: double.infinity,
                height: 64, // 64px Standard Touch Target
                child: ElevatedButton.icon(
                  onPressed: () {
                    setState(() {
                      widget.order.status = OrderStatus.readyForPickup;
                      for (var it in widget.order.items) {
                        it.isPrepared = true;
                      }
                    });
                    VendorApiService.updateOrderStatus(
                      widget.order.id.replaceAll('#', ''),
                      'READY_FOR_PICKUP',
                    );
                    widget.onStatusChanged();
                  },
                  icon: const Icon(Icons.check_circle_outline, color: Colors.white, size: 26),
                  label: const Text(
                    'MARK READY FOR PICKUP / तैयार है',
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
                height: 64, // 64px Standard Touch Target
                child: ElevatedButton.icon(
                  onPressed: () {
                    setState(() {
                      widget.order.status = OrderStatus.pickedUp;
                    });
                    VendorApiService.updateOrderStatus(
                      widget.order.id.replaceAll('#', ''),
                      'PICKED_UP',
                    );
                    widget.onStatusChanged();
                  },
                  icon: const Icon(Icons.task_alt, color: Colors.black87, size: 26),
                  label: const Text(
                    'HAND OVER TO RUNNER / सुपुर्द किया',
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
                height: 54,
                padding: const EdgeInsets.symmetric(vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFFFCF9F8),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: const Color(0xFFE5E2E1)),
                ),
                child: const Center(
                  child: Text(
                    'PICKED UP BY RUNNER / सुपुर्द हो चुका है',
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
