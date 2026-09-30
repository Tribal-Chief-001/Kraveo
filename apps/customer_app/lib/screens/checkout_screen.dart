import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../services/customer_api_service.dart';
import '../widgets/coupon_box.dart';
import '../widgets/ui/bill_breakdown.dart';
import '../widgets/ui/coins_toggle.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/hostel_pill.dart';
import '../widgets/ui/k_icon_button.dart';
import '../widgets/ui/scroll_empty.dart';
import '../widgets/ui/sheet_chrome.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/veg_mark.dart';
import 'live_tracking_screen.dart';

class CheckoutScreen extends StatefulWidget {
  /// The saved drop-off point, or null when the student has none (non-students, or no hostel
  /// saved yet). Null forces an explicit choice before the Pay button works.
  final String? selectedHostel;

  const CheckoutScreen({
    super.key,
    required this.selectedHostel,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final Razorpay _razorpay = Razorpay();
  String? _currentHostel;
  final TextEditingController _deliveryNoteController = TextEditingController();
  String _selectedPaymentMethod = 'UPI via Razorpay';
  bool _isProcessingPayment = false;
  CartProvider? _pendingCart;
  OrderProvider? _pendingOrderProvider;
  String? _pendingServerOrderId;

  final List<Map<String, dynamic>> _paymentOptions = [
    {
      'name': 'UPI via Razorpay',
      'icon': LucideIcons.smartphone,
      'sub': 'Google Pay, PhonePe, Paytm and more',
    },
  ];

  @override
  void initState() {
    super.initState();
    _currentHostel = widget.selectedHostel ?? context.read<SessionProvider>().deliveryPoint;
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
    final dropoff = _currentHostel;
    if (dropoff == null) {
      // Never reach the payment gateway without a drop-off point.
      _chooseDropoff();
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
        dropoffHostel: dropoff,
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
      hostel: _currentHostel ?? kHostelBlocks.first,
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
    showKSnack(context, message, error: true);
  }


  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final cart = Provider.of<CartProvider>(context);
    final orderProvider = Provider.of<OrderProvider>(context, listen: false);

    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leadingWidth: 68,
        toolbarHeight: 68,
        leading: Padding(
          padding: const EdgeInsets.only(left: 20),
          child: Center(
            child: KIconButton(
              icon: LucideIcons.arrowLeft,
              semanticLabel: 'Back',
              onTap: _isProcessingPayment ? null : () => Navigator.of(context).maybePop(),
            ),
          ),
        ),
        title: const Text('Checkout'),
      ),
      body: cart.items.isEmpty
          ? KEmptyScroll(
              child: KEmptyState(
              icon: LucideIcons.shoppingBag,
              title: 'Your cart is empty',
              message: 'Add something delicious from a kitchen and come back to pay.',
              action: KButton(label: 'Back to menu', kind: KButtonKind.tonal, expand: false, onPressed: () => Navigator.of(context).maybePop()),
              ),
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 24),
              children: [
                KReveal(child: _SectionCard(title: 'Drop-off', icon: LucideIcons.mapPin, child: _buildDropoff(context, k))),
                const SizedBox(height: 14),
                KReveal(index: 1, child: _SectionCard(title: cart.dhabaName ?? 'Your order', icon: LucideIcons.receiptText, child: _buildSummary(context, k, cart))),
                const SizedBox(height: 14),
                KReveal(index: 2, child: CoinsToggle(cart: cart)),
                const SizedBox(height: 14),
                KReveal(index: 3, child: _SectionCard(title: 'Payment', icon: LucideIcons.wallet, child: _buildPayment(context, k))),
                const SizedBox(height: 14),
                KReveal(index: 4, child: BillBreakdown(cart: cart)),
              ],
            ),
      bottomNavigationBar: cart.items.isEmpty
          ? null
          : KSheetFooter(
              floating: true,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                KButton(
                  label: _currentHostel == null ? 'Choose drop-off' : 'Pay ${rupee(cart.grandTotal)}',
                  icon: _currentHostel == null ? LucideIcons.mapPin : LucideIcons.lock,
                  kind: _currentHostel == null ? KButtonKind.accent : KButtonKind.primary,
                  loading: _isProcessingPayment,
                  onPressed: () => _handlePlaceOrder(cart, orderProvider),
                ),
                const SizedBox(height: 8),
                Text(
                  _isProcessingPayment
                      ? 'Opening secure payment. Please do not close the app.'
                      : (_currentHostel == null ? 'Tell us where to deliver first. Payment opens right after.' : 'Next: pay by UPI, then get your gate OTP and live tracking.'),
                  textAlign: TextAlign.center,
                  style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12),
                ),
              ]),
            ),
    );
  }

  /// Opens the picker. Students keep their saved default; everyone else's choice is remembered
  /// for this session so the next checkout is pre-filled.
  Future<void> _chooseDropoff() async {
    final picked = await showHostelPicker(context, blocks: kHostelBlocks, selected: _currentHostel ?? '');
    if (picked != null) _setDropoff(picked);
  }

  void _setDropoff(String block) {
    if (!mounted) return;
    setState(() => _currentHostel = block);
    final session = context.read<SessionProvider>();
    if (session.user?.isStudent != true) session.changeHostel(block); // in-memory only
  }

  Widget _buildDropoff(BuildContext context, KraveoTokens k) {
    final chosen = _currentHostel;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (chosen == null)
        KPressable(
          onTap: _chooseDropoff,
          semanticLabel: 'Choose a drop-off point. Required before you can pay',
          child: AnimatedContainer(
            duration: KMotion.base,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: k.brandSoft,
              borderRadius: BorderRadius.circular(KRadius.lg),
              border: Border.all(color: k.brand, width: 2),
            ),
            child: ExcludeSemantics(
              child: Row(children: [
                Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(color: k.brand, shape: BoxShape.circle),
                  child: Icon(LucideIcons.mapPin, size: 22, color: k.onBrand),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Choose drop-off point', style: KraveoType.titleLg.copyWith(color: k.ink)),
                    const SizedBox(height: 2),
                    Text('Required before you can pay', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                  ]),
                ),
                Icon(LucideIcons.chevronRight, size: 22, color: k.brand),
              ]),
            ),
          ),
        )
      else
        HostelPill(
          caption: 'DELIVER TO',
          selectedHostel: chosen,
          hostelBlocks: kHostelBlocks,
          onChanged: _setDropoff,
        ),
      const SizedBox(height: 12),
      Text(
        'Your runner meets you at the gate. After you pay you get a 4-digit OTP: share it only when they arrive.',
        style: KraveoType.bodySm.copyWith(color: k.inkMuted),
      ),
      const SizedBox(height: 14),
      TextField(
        controller: _deliveryNoteController,
        textInputAction: TextInputAction.done,
        decoration: InputDecoration(
          hintText: 'Note for your runner, e.g. call 5 mins before',
          prefixIcon: Icon(LucideIcons.messageSquare, size: 18, color: k.inkMuted),
        ),
      ),
    ]);
  }

  Widget _buildSummary(BuildContext context, KraveoTokens k, CartProvider cart) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('${cart.itemCount} ${cart.itemCount == 1 ? 'item' : 'items'} in your order', style: KraveoType.label.copyWith(color: k.brand, fontSize: 13)),
      const SizedBox(height: 6),
      for (final item in cart.items)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 3), child: VegMark(isVeg: item.item.isVeg, size: 14)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${item.quantity} × ${item.item.name}', maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w600, fontSize: 14)),
                if (item.selectedOptions.isNotEmpty)
                  Text(item.customizationSummary, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
              ]),
            ),
            const SizedBox(width: 12),
            Text(rupee(item.totalPrice), style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w700, fontSize: 14)),
          ]),
        ),
      Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Divider(height: 1, color: k.line)),
      const CouponBox(),
    ]);
  }

  Widget _buildPayment(BuildContext context, KraveoTokens k) {
    return Column(children: [
      for (final opt in _paymentOptions)
        Builder(builder: (context) {
          final isSelected = _selectedPaymentMethod == opt['name'];
          return KPressable(
            onTap: () => setState(() => _selectedPaymentMethod = opt['name']),
            scale: 0.985,
            semanticLabel: '${opt['name']}, ${opt['sub']}${isSelected ? ', selected' : ''}',
            child: AnimatedContainer(
              duration: KMotion.base,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: isSelected ? k.brandSoft : k.surface,
                borderRadius: BorderRadius.circular(KRadius.md),
                border: Border.all(color: isSelected ? k.brand : k.line, width: isSelected ? 1.6 : 1.2),
              ),
              child: Row(children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(color: isSelected ? k.brand : k.surfaceAlt, shape: BoxShape.circle),
                  child: Icon(opt['icon'] as IconData, size: 20, color: isSelected ? k.onBrand : k.inkMuted),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(opt['name'] as String, style: KraveoType.titleMd.copyWith(color: k.ink)),
                    Text(opt['sub'] as String, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                  ]),
                ),
                const SizedBox(width: 8),
                Icon(isSelected ? LucideIcons.circleCheck : LucideIcons.circle, color: isSelected ? k.brand : k.inkFaint),
              ]),
            ),
          );
        }),
    ]);
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.icon, required this.child});

  final String title;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      padding: const EdgeInsets.all(18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(icon, size: 17, color: k.brand),
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink))),
        ]),
        const SizedBox(height: 14),
        child,
      ]),
    );
  }
}
