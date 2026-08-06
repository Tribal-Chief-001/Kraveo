import 'package:flutter/material.dart';
import '../services/audio_alert_service.dart';
import '../models/order_model.dart';

class IncomingOrderDialog extends StatefulWidget {
  final OrderModel? orderPayload;
  final Function(OrderModel acceptedOrder)? onAccept;
  final VoidCallback? onDecline;

  const IncomingOrderDialog({
    super.key,
    this.orderPayload,
    this.onAccept,
    this.onDecline,
  });

  @override
  State<IncomingOrderDialog> createState() => _IncomingOrderDialogState();
}

class _IncomingOrderDialogState extends State<IncomingOrderDialog>
    with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;
  late Animation<double> _pulseAnimation;
  int _selectedPrepTimeMinutes = 15;
  late OrderModel _order;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);

    _pulseAnimation = Tween<double>(begin: 0.97, end: 1.03).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _order = widget.orderPayload ??
        OrderModel(
          id: '#ord-${8490 + (DateTime.now().second % 10)}',
          studentName: 'Rahul Sharma',
          studentLocation: 'Block A, Room 302',
          items: [
            OrderItem(name: 'Paneer Butter Masala', quantity: 1, unitPrice: 180),
            OrderItem(name: 'Tandoori Roti', quantity: 4, unitPrice: 15),
            OrderItem(name: 'Mango Lassi', quantity: 2, unitPrice: 60),
          ],
          totalAmount: 360,
          prepTimeMinutes: 15,
          createdAt: DateTime.now(),
          customerNote: 'Make it extra spicy please! No onions in lassi.',
        );
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  void _handleAccept() {
    AudioAlertService.stopAlarm();
    _order.prepTimeMinutes = _selectedPrepTimeMinutes;
    if (widget.onAccept != null) {
      widget.onAccept!(_order);
    }
    Navigator.of(context).pop(true);
  }

  void _handleDecline() {
    AudioAlertService.stopAlarm();
    if (widget.onDecline != null) {
      widget.onDecline!();
    }
    Navigator.of(context).pop(false);
  }

  @override
  Widget build(BuildContext context) {
    return Dialog.fullscreen(
      child: AnimatedBuilder(
        animation: _pulseAnimation,
        builder: (context, child) {
          return Container(
            color: const Color(0xFFFDD400), // Stitch Gold
            child: SafeArea(
              child: Column(
                children: [
                  // Header Alert Bar with Pulsing Scale Effect
                  Transform.scale(
                    scale: _pulseAnimation.value,
                    child: Container(
                      width: double.infinity,
                      margin: const EdgeInsets.all(12),
                      padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 16),
                      decoration: BoxDecoration(
                        color: const Color(0xFF00450D), // Stitch Emerald
                        borderRadius: BorderRadius.circular(24),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.25),
                            blurRadius: 12,
                            offset: const Offset(0, 6),
                          ),
                        ],
                      ),
                      child: Column(
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: const [
                              Icon(Icons.notifications_active, color: Color(0xFFFDD400), size: 32),
                              SizedBox(width: 10),
                              Text(
                                'NEW ORDER ARRIVED!',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 24,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 1.5,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            '${_order.id} • ${_order.studentName} (${_order.studentLocation})',
                            style: const TextStyle(color: Color(0xFFFDD400), fontSize: 15, fontWeight: FontWeight.w700),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  ),

                  // Middle Content Card
                  Expanded(
                    child: Container(
                      width: double.infinity,
                      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(color: const Color(0xFF00450D), width: 3),
                        boxShadow: const [
                          BoxShadow(color: Colors.black12, blurRadius: 16, offset: Offset(0, 8)),
                        ],
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text(
                                'Item Checklist:',
                                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Color(0xFF1B1C1C)),
                              ),
                              Text(
                                'Total: ₹${_order.totalAmount.toStringAsFixed(0)}',
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Color(0xFF00450D)),
                              ),
                            ],
                          ),
                          const Divider(height: 20, color: Color(0xFFE5E2E1), thickness: 1.5),

                          // Items List
                          Expanded(
                            child: ListView.builder(
                              itemCount: _order.items.length,
                              itemBuilder: (context, idx) {
                                final item = _order.items[idx];
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 10),
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFFCF9F8),
                                    borderRadius: BorderRadius.circular(14),
                                    border: Border.all(color: const Color(0xFFE5E2E1)),
                                  ),
                                  child: Row(
                                    children: [
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                        decoration: BoxDecoration(
                                          color: const Color(0xFF00450D),
                                          borderRadius: BorderRadius.circular(10),
                                        ),
                                        child: Text(
                                          '${item.quantity}x',
                                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 18),
                                        ),
                                      ),
                                      const SizedBox(width: 14),
                                      Expanded(
                                        child: Text(
                                          item.name,
                                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF1B1C1C)),
                                        ),
                                      ),
                                      Text(
                                        '₹${(item.quantity * item.unitPrice).toStringAsFixed(0)}',
                                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.grey),
                                      ),
                                    ],
                                  ),
                                );
                              },
                            ),
                          ),

                          // Customer Spice / Special Notes Box
                          if (_order.customerNote != null && _order.customerNote!.isNotEmpty) ...[
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFDAD6),
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(color: const Color(0xFFBA1A1A), width: 2),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: const [
                                      Icon(Icons.warning_amber_rounded, color: Color(0xFFBA1A1A), size: 20),
                                      SizedBox(width: 6),
                                      Text(
                                        'CUSTOMER SPICE & SPECIAL NOTE:',
                                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w900, color: Color(0xFFBA1A1A)),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    '"${_order.customerNote}"',
                                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Color(0xFF93000A)),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                          ],

                          // Preparation Time Selector (10 / 15 / 20 mins)
                          const Text(
                            'Select Preparation Time ETA:',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF1B1C1C)),
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [10, 15, 20].map((timeOption) {
                              final isSelected = _selectedPrepTimeMinutes == timeOption;
                              return Expanded(
                                child: Container(
                                  margin: const EdgeInsets.symmetric(horizontal: 4),
                                  child: ChoiceChip(
                                    showCheckmark: false,
                                    label: Padding(
                                      padding: const EdgeInsets.symmetric(vertical: 6),
                                      child: Text(
                                        '$timeOption mins',
                                        style: TextStyle(
                                          fontWeight: FontWeight.w900,
                                          fontSize: 15,
                                          color: isSelected ? Colors.white : const Color(0xFF00450D),
                                        ),
                                      ),
                                    ),
                                    selected: isSelected,
                                    selectedColor: const Color(0xFF00450D),
                                    backgroundColor: const Color(0xFFFCF9F8),
                                    side: BorderSide(
                                      color: isSelected ? const Color(0xFF00450D) : const Color(0xFFE5E2E1),
                                      width: 2,
                                    ),
                                    onSelected: (selected) {
                                      if (selected) {
                                        setState(() => _selectedPrepTimeMinutes = timeOption);
                                      }
                                    },
                                  ),
                                ),
                              );
                            }).toList(),
                          ),
                        ],
                      ),
                    ),
                  ),

                  // Bottom Giant 64px CTA Action Buttons
                  Padding(
                    padding: const EdgeInsets.all(16.0),
                    child: Row(
                      children: [
                        Expanded(
                          child: SizedBox(
                            height: 64,
                            child: ElevatedButton.icon(
                              onPressed: _handleDecline,
                              icon: const Icon(Icons.cancel_outlined, color: Colors.white, size: 28),
                              label: const Text(
                                'DECLINE',
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 18, letterSpacing: 1),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFFBA1A1A), // Crimson Red
                                elevation: 6,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          flex: 1,
                          child: SizedBox(
                            height: 64,
                            child: ElevatedButton.icon(
                              onPressed: _handleAccept,
                              icon: const Icon(Icons.check_circle_outline, color: Colors.white, size: 28),
                              label: Text(
                                'ACCEPT (${_selectedPrepTimeMinutes}M)',
                                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 17, letterSpacing: 0.5),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF00450D), // Emerald
                                elevation: 6,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
