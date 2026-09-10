import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';
import '../theme/app_theme.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../services/customer_api_service.dart';
import '../widgets/coupon_box.dart';
import '../widgets/hostel_dropdown.dart';
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
  final Razorpay _razorpay = Razorpay();
  late String _currentHostel;
  final TextEditingController _deliveryNoteController = TextEditingController();
  String _selectedPaymentMethod = 'UPI via Razorpay';
  bool _isProcessingPayment = false;
  CartProvider? _pendingCart;
  OrderProvider? _pendingOrderProvider;
  String? _pendingServerOrderId;

  final List<Map<String, dynamic>> _paymentOptions = [
    {
      'name': 'UPI via Razorpay',
      'icon': Icons.account_balance_wallet,
      'sub': 'Google Pay, PhonePe, Paytm and more',
    },
  ];

  @override
  void initState() {
    super.initState();
    _currentHostel = widget.selectedHostel;
    _deliveryNoteController.text = 'Call when reaching hostel gate';
    _razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, _handlePaymentSuccess);
    _razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, _handlePaymentError);
    _razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, _handleExternalWallet);
  }

  @override
  void dispose() {
    _razorpay.clear();
    _deliveryNoteController.dispose();
    super.dispose();
  }

  Future<void> _handlePlaceOrder(CartProvider cart, OrderProvider orderProvider) async {
    if (cart.dhabaId == null || cart.items.isEmpty) {
      _showPaymentError('Your cart is empty or the restaurant is missing.');
      return;
    }

    setState(() => _isProcessingPayment = true);
    _pendingCart = cart;
    _pendingOrderProvider = orderProvider;

    try {
      final serverOrder = await CustomerApiService.createOrder(
        vendorId: cart.dhabaId!,
        items: cart.items.map((item) => {
          'itemId': item.item.id,
          'quantity': item.quantity,
        }).toList(),
        dropoffHostel: _currentHostel,
        dropoffNotes: _deliveryNoteController.text.trim(),
        couponCode: cart.appliedCouponCode,
      );
      final serverOrderId = serverOrder['id']?.toString();
      if (serverOrderId == null || serverOrderId.isEmpty) {
        throw Exception('The backend did not return an order ID.');
      }

      final customer = serverOrder['customer'];
      final customerPhone = customer is Map ? customer['phone']?.toString() : null;

      final paymentOrder = await CustomerApiService.createPaymentOrder(serverOrderId);
      final keyId = (paymentOrder['key_id'] ?? paymentOrder['keyId'])?.toString();
      final razorpayOrderId = (paymentOrder['order_id'] ?? paymentOrder['razorpayOrderId'])?.toString();
      final amount = paymentOrder['amount'];
      if (keyId == null || razorpayOrderId == null || amount is! num || amount < 100) {
        throw Exception('The payment gateway returned an invalid order.');
      }

      _pendingServerOrderId = serverOrderId;
      final checkoutOptions = <String, dynamic>{
        'key': keyId,
        'amount': amount.toInt(),
        'currency': paymentOrder['currency'] ?? 'INR',
        'order_id': razorpayOrderId,
        'name': 'Kraveo',
        'description': 'Campus food order',
        'theme': {'color': '#006B3C'},
      };
      if (customerPhone != null && customerPhone.isNotEmpty) {
        checkoutOptions['prefill'] = {'contact': customerPhone};
      }
      _razorpay.open(checkoutOptions);
    } catch (error) {
      _resetPendingPayment();
      _showPaymentError(_friendlyPaymentError(error));
    }
  }

  Future<void> _handlePaymentSuccess(PaymentSuccessResponse response) async {
    final paymentId = response.paymentId;
    final razorpayOrderId = response.orderId;
    final signature = response.signature;
    if (paymentId == null || razorpayOrderId == null || signature == null) {
      _resetPendingPayment();
      _showPaymentError('Razorpay returned an incomplete payment response.');
      return;
    }

    try {
      await CustomerApiService.verifyPayment(
        razorpayOrderId: razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      );

      final cart = _pendingCart;
      final orderProvider = _pendingOrderProvider;
      final serverOrderId = _pendingServerOrderId;
      if (cart == null || orderProvider == null || serverOrderId == null) {
        throw Exception('Payment verified, but the local checkout session was lost.');
      }

      _resetPendingPayment();
      if (!mounted) return;
      _completeOrderPlacement(
        cart,
        orderProvider,
        serverOrderId: serverOrderId,
      );
    } catch (error) {
      _resetPendingPayment();
      _showPaymentError(_friendlyPaymentError(error));
    }
  }

  void _handlePaymentError(PaymentFailureResponse response) {
    _resetPendingPayment();
    _showPaymentError(response.message ?? 'Payment was cancelled or failed.');
  }

  void _handleExternalWallet(ExternalWalletResponse response) {
    _resetPendingPayment();
    _showPaymentError('External wallet ${response.walletName ?? ''} is not supported for this checkout.');
  }

  void _completeOrderPlacement(
    CartProvider cart,
    OrderProvider orderProvider, {
    required String serverOrderId,
  }) {
    // Place Order in OrderProvider
    final newOrder = orderProvider.placeOrder(
      cart: cart,
      hostel: _currentHostel,
      deliveryNote: _deliveryNoteController.text.trim(),
      paymentMethod: _selectedPaymentMethod,
      serverOrderId: serverOrderId,
      syncBackend: false,
      simulateProgression: false,
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

  void _resetPendingPayment() {
    if (!mounted) return;
    setState(() => _isProcessingPayment = false);
    _pendingCart = null;
    _pendingOrderProvider = null;
    _pendingServerOrderId = null;
  }

  String _friendlyPaymentError(Object error) {
    final message = error.toString().replaceFirst('Exception: ', '').trim();
    return message.isEmpty ? 'Unable to start payment. Please try again.' : message;
  }

  void _showPaymentError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red.shade700),
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
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
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
                        HostelDropdown(
                          selectedHostel: _currentHostel,
                          onChanged: (newHostel) {
                            if (newHostel != null) {
                              setState(() {
                                _currentHostel = newHostel;
                              });
                            }
                          },
                          hostelBlocks: const [
                            'Block 1',
                            'Block 2',
                            'Block 3',
                            'Block 4',
                            'Block 5',
                            'Block 6',
                            'Girls Gate 1',
                            'Girls Gate 2',
                            'VIT Main Gate',
                          ],
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

            // Kraveo Coins Loyalty Rewards Card
            Card(
              color: const Color(0xFFFDD400).withValues(alpha: 0.15),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
                side: const BorderSide(color: Color(0xFFFDD400), width: 1.5),
              ),
              child: Padding(
                padding: const EdgeInsets.all(14.0),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: const BoxDecoration(
                        color: Color(0xFFFDD400),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.monetization_on, color: Color(0xFF1B1C1C), size: 22),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Kraveo Coins (${cart.userKraveoCoins} Coins)',
                            style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 14, color: AppTheme.textDark),
                          ),
                          const SizedBox(height: 2),
                          const Text(
                            'Redeem 50 Coins for Flat ₹20 OFF',
                            style: TextStyle(fontSize: 12, color: AppTheme.textMuted, fontWeight: FontWeight.bold),
                          ),
                        ],
                      ),
                    ),
                    Switch(
                      value: cart.isKraveoCoinsRedeemed,
                      activeThumbColor: AppTheme.primaryEmerald,
                      onChanged: (val) => cart.toggleKraveoCoinsRedemption(),
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
                        'Coupon Discount (${cart.appliedCouponCode})',
                        '-₹${cart.couponDiscountAmount.toInt()}',
                        isDiscount: true,
                      ),
                    if (cart.isKraveoCoinsRedeemed)
                      _buildRow(
                        'Kraveo Coins Discount',
                        '-₹${cart.kraveoCoinsDiscountAmount.toInt()}',
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
