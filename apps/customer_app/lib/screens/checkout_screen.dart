import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/app_theme.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../widgets/coupon_box.dart';
import 'live_tracking_screen.dart';

class CheckoutScreen extends StatefulWidget {
  final String selectedHostel;

  const CheckoutScreen({
    super.key,
    required this.selectedHostel,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  late String _currentHostel;
  final TextEditingController _deliveryNoteController = TextEditingController();
  String _selectedPaymentMethod = 'PhonePe UPI';
  bool _isProcessingPayment = false;

  final List<Map<String, dynamic>> _paymentOptions = [
    {'name': 'PhonePe UPI', 'icon': Icons.account_balance_wallet, 'sub': 'Instant Demo UPI Checkout'},
    {'name': 'Google Pay UPI', 'icon': Icons.g_mobiledata, 'sub': 'Direct bank transfer'},
    {'name': 'Paytm UPI', 'icon': Icons.payment, 'sub': 'Pay via Paytm wallet / UPI'},
    {'name': 'CRED UPI', 'icon': Icons.credit_card, 'sub': 'Earn CRED coins'},
    {'name': 'Cash on Gate Delivery', 'icon': Icons.money, 'sub': 'Pay runner at hostel gate'},
  ];

  @override
  void initState() {
    super.initState();
    _currentHostel = widget.selectedHostel;
    _deliveryNoteController.text = 'Call when reaching hostel gate';
  }

  @override
  void dispose() {
    _deliveryNoteController.dispose();
    super.dispose();
  }

  void _handlePlaceOrder(CartProvider cart, OrderProvider orderProvider) async {
    setState(() => _isProcessingPayment = true);

    // Show sleek Instant Payment Success Sheet
    showModalBottomSheet(
      context: context,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (context) {
        return Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: const BoxDecoration(
                  color: AppTheme.accentGreen,
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.check_circle_outline, color: Colors.white, size: 48),
              ),
              const SizedBox(height: 16),
              const Text(
                'UPI Payment Successful! 🎉',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: AppTheme.textDark),
              ),
              const SizedBox(height: 8),
              Text(
                'Authorized ₹${cart.grandTotal.toInt()} via $_selectedPaymentMethod',
                style: const TextStyle(fontSize: 13, color: AppTheme.textMuted),
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () {
                    Navigator.pop(context); // Close sheet
                    _completeOrderPlacement(cart, orderProvider);
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryEmerald,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  child: const Text(
                    'VIEW LIVE TRACKING & GATE OTP',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _completeOrderPlacement(CartProvider cart, OrderProvider orderProvider) {
    // Place Order in OrderProvider
    final newOrder = orderProvider.placeOrder(
      cart: cart,
      hostel: _currentHostel,
      deliveryNote: _deliveryNoteController.text.trim(),
      paymentMethod: _selectedPaymentMethod,
    );

    // Navigate to Live Tracking replacing checkout stack
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(
        builder: (context) => LiveTrackingScreen(order: newOrder),
      ),
      (route) => route.isFirst,
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = Provider.of<CartProvider>(context);
    final orderProvider = Provider.of<OrderProvider>(context, listen: false);

    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      appBar: AppBar(
        title: const Text('Checkout'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Dropoff Location Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: const [
                        Icon(Icons.location_on, color: AppTheme.primaryEmerald, size: 20),
                        SizedBox(width: 8),
                        Text(
                          'DELIVERY HOSTEL GATE',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            color: AppTheme.primaryEmerald,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _currentHostel,
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Runner will meet you at the primary gate entrance.',
                      style: TextStyle(fontSize: 12, color: AppTheme.textMuted),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _deliveryNoteController,
                      decoration: InputDecoration(
                        labelText: 'Gate Handshake Note / Instructions',
                        hintText: 'e.g. Call 5 mins before arrival...',
                        hintStyle: const TextStyle(color: AppTheme.textMuted, fontSize: 13),
                        isDense: true,
                        filled: true,
                        fillColor: AppTheme.surfaceVariant.withValues(alpha: 0.5),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Order Summary Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          cart.dhabaName ?? 'Order Summary',
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                        ),
                        Text(
                          '${cart.itemCount} Items',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppTheme.primaryEmerald),
                        ),
                      ],
                    ),
                    const Divider(height: 20, color: AppTheme.borderLight),
                    ...cart.items.map((item) {
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4.0),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Expanded(
                              child: Text(
                                '${item.quantity}x ${item.item.name}',
                                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppTheme.textDark),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            Text(
                              '₹${item.totalPrice.toInt()}',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppTheme.textDark),
                            ),
                          ],
                        ),
                      );
                    }),
                    const SizedBox(height: 12),
                    const CouponBox(),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Payment Options Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Select Payment Method',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                    ),
                    const SizedBox(height: 12),
                    ..._paymentOptions.map((opt) {
                      final isSelected = _selectedPaymentMethod == opt['name'];
                      return InkWell(
                        onTap: () => setState(() => _selectedPaymentMethod = opt['name']),
                        borderRadius: BorderRadius.circular(12),
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          decoration: BoxDecoration(
                            color: isSelected ? AppTheme.primaryEmerald.withValues(alpha: 0.08) : Colors.white,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                              color: isSelected ? AppTheme.primaryEmerald : AppTheme.borderLight,
                              width: isSelected ? 1.5 : 1.0,
                            ),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                opt['icon'] as IconData,
                                color: isSelected ? AppTheme.primaryEmerald : AppTheme.textMuted,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      opt['name'] as String,
                                      style: TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 14,
                                        color: isSelected ? AppTheme.primaryEmerald : AppTheme.textDark,
                                      ),
                                    ),
                                    Text(
                                      opt['sub'] as String,
                                      style: const TextStyle(fontSize: 11, color: AppTheme.textMuted),
                                    ),
                                  ],
                                ),
                              ),
                              Icon(
                                isSelected ? Icons.radio_button_checked : Icons.radio_button_off,
                                color: isSelected ? AppTheme.primaryEmerald : AppTheme.textMuted,
                              ),
                            ],
                          ),
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Final Bill Summary
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  children: [
                    _buildRow('Subtotal', '₹${cart.subtotal.toInt()}'),
                    _buildRow('Delivery Fee', '₹${cart.deliveryFee.toInt()}'),
                    _buildRow('Taxes & Packaging', '₹${cart.taxAndPackaging.toInt()}'),
                    if (cart.appliedCouponCode != null)
                      _buildRow(
                        'Discount (${cart.appliedCouponCode})',
                        '-₹${cart.couponDiscountAmount.toInt()}',
                        isDiscount: true,
                      ),
                    const Divider(height: 20, color: AppTheme.borderLight),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Grand Total',
                          style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                        ),
                        Text(
                          '₹${cart.grandTotal.toInt()}',
                          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AppTheme.primaryEmerald),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.08),
              blurRadius: 10,
              offset: const Offset(0, -4),
            )
          ],
        ),
        child: SafeArea(
          child: SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _isProcessingPayment || cart.items.isEmpty
                  ? null
                  : () => _handlePlaceOrder(cart, orderProvider),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.primaryEmerald,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                ),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    'PAY ₹${cart.grandTotal.toInt()} VIA $_selectedPaymentMethod',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                  ),
                  const SizedBox(width: 8),
                  const Icon(Icons.lock, size: 16, color: AppTheme.secondaryGold),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRow(String label, String value, {bool isDiscount = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 13,
              color: isDiscount ? AppTheme.accentGreen : AppTheme.textMuted,
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: isDiscount ? AppTheme.accentGreen : AppTheme.textDark,
            ),
          ),
        ],
      ),
    );
  }
}
