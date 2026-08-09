import 'package:flutter/material.dart';
import '../models/order_model.dart';
import '../services/audio_alert_service.dart';

class IncomingOrderDialog extends StatefulWidget {
  final OrderModel? order;
  final Function(OrderModel acceptedOrder) onAccept;
  final VoidCallback onDecline;

  const IncomingOrderDialog({
    super.key,
    this.order,
    required this.onAccept,
    required this.onDecline,
  });

  @override
  State<IncomingOrderDialog> createState() => _IncomingOrderDialogState();
}

class _IncomingOrderDialogState extends State<IncomingOrderDialog> with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;
  late Animation<double> _scaleAnimation;

  int _selectedPrepTimeMinutes = 15;
  late OrderModel _order;

  @override
  void initState() {
    super.initState();

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);

    _scaleAnimation = Tween<double>(begin: 0.98, end: 1.02).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    // Initialize order data or use mock fallback with unique timestamp ID
    _order = widget.order ?? OrderModel(
      id: '#ord-${(DateTime.now().millisecondsSinceEpoch % 10000).toString().padLeft(4, '0')}',
      studentName: 'Aarav Sharma',
      studentLocation: 'Hostel Block A, R-304',
      items: [
        OrderItem(name: 'Special Shahi Paneer Thali', quantity: 2, unitPrice: 180),
        OrderItem(name: 'Kulhad Sweet Lassi', quantity: 2, unitPrice: 50),
      ],
      totalAmount: 460,
      prepTimeMinutes: 15,
      createdAt: DateTime.now(),
      customerNote: 'Make it extra spicy with extra curd please!',
      status: OrderStatus.placed,
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
    _order.status = OrderStatus.preparing;
    widget.onAccept(_order);
    Navigator.of(context).pop();
  }

  void _handleDecline() {
    AudioAlertService.stopAlarm();
    widget.onDecline();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: AnimatedBuilder(
        animation: _scaleAnimation,
        builder: (context, child) {
          return Transform.scale(
            scale: _scaleAnimation.value,
            child: child,
          );
        },
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(28),
            border: Border.all(color: const Color(0xFFFDD400), width: 4),
            boxShadow: [
              BoxShadow(
                color: const Color(0xFFFDD400).withValues(alpha: 0.4),
                blurRadius: 24,
                spreadRadius: 4,
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Emergency Header Alert Banner
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
                decoration: const BoxDecoration(
                  color: Color(0xFFFDD400),
                  borderRadius: BorderRadius.only(
                    topLeft: Radius.circular(24),
                    topRight: Radius.circular(24),
                  ),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: const [
                        Icon(Icons.notifications_active, color: Color(0xFF1B1C1C), size: 28),
                        SizedBox(width: 10),
                        Text(
                          'NEW ORDER / नया ऑर्डर',
                          style: TextStyle(
                            color: Color(0xFF1B1C1C),
                            fontWeight: FontWeight.w900,
                            fontSize: 18,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ],
                    ),
                    Text(
                      _order.id,
                      style: const TextStyle(
                        color: Color(0xFF1B1C1C),
                        fontWeight: FontWeight.w900,
                        fontSize: 16,
                      ),
                    ),
                  ],
                ),
              ),

              Padding(
                padding: const EdgeInsets.all(20.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Student Dropoff Location
                    Row(
                      children: [
                        const Icon(Icons.location_on, color: Color(0xFF00450D), size: 22),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                _order.studentName,
                                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Color(0xFF1B1C1C)),
                              ),
                              Text(
                                _order.studentLocation,
                                style: const TextStyle(fontSize: 13, color: Colors.grey, fontWeight: FontWeight.bold),
                              ),
                            ],
                          ),
                        ),
                        Text(
                          '₹${_order.totalAmount.toStringAsFixed(0)}',
                          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: Color(0xFF00450D)),
                        ),
                      ],
                    ),

                    const SizedBox(height: 14),
                    const Divider(),

                    // Order Items Checklist List
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 180),
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: _order.items.length,
                        itemBuilder: (context, index) {
                          final item = _order.items[index];
                          return Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4.0),
                            child: Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF00450D),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text(
                                    '${item.quantity}x',
                                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 14),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    item.name,
                                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Color(0xFF1B1C1C)),
                                  ),
                                ),
                                Text(
                                  '₹${(item.quantity * item.unitPrice).toStringAsFixed(0)}',
                                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.grey),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),

                    // Customer Special Request Note
                    if (_order.customerNote != null && _order.customerNote!.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFDAD6),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0xFFBA1A1A)),
                        ),
                        child: Text(
                          'Note: "${_order.customerNote}"',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF93000A)),
                        ),
                      ),
                    ],

                    const SizedBox(height: 16),

                    // Select Preparation Time ETA
                    const Text(
                      'Select Prep Time / समय चुनें:',
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: Color(0xFF1B1C1C)),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [10, 15, 20, 30].map((timeOption) {
                        final isSelected = _selectedPrepTimeMinutes == timeOption;
                        return Expanded(
                          child: GestureDetector(
                            onTap: () => setState(() => _selectedPrepTimeMinutes = timeOption),
                            child: Container(
                              margin: const EdgeInsets.symmetric(horizontal: 3),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                              decoration: BoxDecoration(
                                color: isSelected ? const Color(0xFF00450D) : const Color(0xFFFCF9F8),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                  color: isSelected ? const Color(0xFF00450D) : const Color(0xFFE5E2E1),
                                  width: 1.5,
                                ),
                              ),
                              child: Text(
                                '$timeOption Mins',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontWeight: FontWeight.w900,
                                  fontSize: 12,
                                  color: isSelected ? Colors.white : const Color(0xFF1B1C1C),
                                ),
                              ),
                            ),
                          ),
                        );
                      }).toList(),
                    ),

                    const SizedBox(height: 20),

                    // Giant 64px Touch Target Buttons (DECLINE / ACCEPT)
                    Row(
                      children: [
                        Expanded(
                          flex: 1,
                          child: SizedBox(
                            height: 64, // 64px Standard Touch Target
                            child: OutlinedButton(
                              onPressed: _handleDecline,
                              style: OutlinedButton.styleFrom(
                                side: const BorderSide(color: Color(0xFFBA1A1A), width: 2),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                              ),
                              child: const Text(
                                'DECLINE\nअस्वीकार',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Color(0xFFBA1A1A), fontWeight: FontWeight.w900, fontSize: 13),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          flex: 2,
                          child: SizedBox(
                            height: 64, // 64px Standard Touch Target
                            child: ElevatedButton.icon(
                              onPressed: _handleAccept,
                              icon: const Icon(Icons.check_circle, color: Colors.white, size: 26),
                              label: const Text(
                                'ACCEPT ORDER\nस्वीकार करें',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 15),
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF00450D),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
