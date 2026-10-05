import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../services/order_api.dart';
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
import 'payment_success_screen.dart';

/// Checkout: the order is created on the server FIRST (`POST /orders`, idempotent per cart),
/// the server's bill is shown, then Razorpay runs on that same order. A failed or cancelled
/// payment keeps the order (PENDING) and offers "Try payment again" on it; nothing here ever
/// creates a second order for the same cart.
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
  String? _currentHostel;
  final TextEditingController _deliveryNoteController = TextEditingController();
  String _selectedPaymentMethod = 'UPI via Razorpay';

  /// A request (place, pay or cancel) is running: buttons show progress, back is blocked.
  bool _busy = false;

  /// The server order this checkout created (or found again after back-navigation).
  String? _orderId;

  /// The cart estimate the student saw before the server priced the order.
  double? _previewTotal;

  /// Error / "payment not completed" text shown above the footer.
  String? _notice;
  bool _paymentAttempted = false;

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
    // Back in checkout with the same cart: show the unpaid order it already created.
    final cart = context.read<CartProvider>();
    if (cart.items.isNotEmpty) {
      final existing = context.read<OrderProvider>().openCheckoutOrder(CheckoutDraft.fromCart(cart, dropoffHostel: _currentHostel ?? '', dropoffNotes: ''));
      if (existing != null && existing.awaitsPayment) {
        _orderId = existing.id;
        _notice = 'You already placed this order. Complete the payment, or cancel it to change something.';
      }
    }
  }

  @override
  void dispose() {
    _deliveryNoteController.dispose();
    super.dispose();
  }

  void _setBusy(bool v) {
    if (mounted) setState(() => _busy = v);
  }

  Future<void> _onPrimary(CartProvider cart, OrderProvider orders) async {
    if (_busy) return;
    final existing = _orderId == null ? null : orders.orderById(_orderId!);
    if (existing != null && existing.isTerminal) {
      // Expired / cancelled: start over with a fresh order (new idempotency key).
      orders.clearCheckout();
      setState(() {
        _orderId = null;
        _notice = null;
        _paymentAttempted = false;
      });
      return;
    }
    if (existing != null && !existing.awaitsPayment) {
      _openTracking(existing.id);
      return;
    }
    if (_orderId == null) {
      final placed = await _placeOrder(cart, orders);
      if (placed == null) return;
    }
    await _pay(orders, cart);
  }

  /// Creates the server order. Returns it when payment should start right away, otherwise null
  /// (error shown, or the server's price differs and the student must see it first).
  Future<OrderModel?> _placeOrder(CartProvider cart, OrderProvider orders) async {
    if (cart.dhabaId == null || cart.items.isEmpty) {
      _showError('Your cart is empty or the restaurant is missing.');
      return null;
    }
    final dropoff = _currentHostel;
    if (dropoff == null) {
      // Never reach the payment gateway without a drop-off point.
      _chooseDropoff();
      return null;
    }
    if (!context.read<DhabaProvider>().isLiveVendor(cart.dhabaId)) {
      _showError('This kitchen\'s live menu hasn\'t loaded, so it can\'t take orders right now. Check your connection, then open the kitchen again from Home.');
      return null;
    }

    _previewTotal = cart.grandTotal;
    setState(() {
      _busy = true;
      _notice = null;
    });
    final result = await orders.placeOrder(CheckoutDraft.fromCart(cart, dropoffHostel: dropoff, dropoffNotes: _deliveryNoteController.text.trim()));
    if (!mounted) return null;
    final order = result.value;
    if (order == null) {
      final error = result.error!;
      var message = orderErrorMessage(error, action: 'place your order');
      if (error.isNetwork) message += ' Trying again is safe: you won\'t get a duplicate order.';
      _setBusy(false);
      _showError(message);
      return null;
    }
    setState(() => _orderId = order.id);
    if (!order.awaitsPayment) {
      _setBusy(false);
      if (order.isTerminal) {
        _showError('This order is no longer open. Tap the button to place it again.');
      } else {
        _openTracking(order.id);
      }
      return null;
    }
    if (order.totalPaise != ((_previewTotal ?? 0) * 100).round()) {
      // Show the server's numbers before taking any money.
      _setBusy(false);
      return null;
    }
    return order;
  }

  Future<void> _pay(OrderProvider orders, CartProvider cart) async {
    final id = _orderId;
    if (id == null) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    final outcome = await orders.payForOrder(id, contact: context.read<SessionProvider>().user?.phone);
    if (!mounted) return;
    switch (outcome.kind) {
      case PaymentOutcomeKind.paid:
      case PaymentOutcomeKind.confirming:
        final placed = orders.orderById(id) ?? outcome.order;
        cart.clearCart();
        orders.clearCheckout();
        _openPaymentSuccess(id, placed, confirming: outcome.kind == PaymentOutcomeKind.confirming);
      case PaymentOutcomeKind.orderClosed:
        // The server won't take money for this order any more: back to the editable cart so
        // the next tap places a fresh order (new idempotency key).
        orders.clearCheckout();
        setState(() {
          _busy = false;
          _orderId = null;
          _paymentAttempted = false;
          _notice = outcome.message ?? 'This order can no longer be paid. Please place it again.';
        });
      case PaymentOutcomeKind.cancelled:
      case PaymentOutcomeKind.failed:
        setState(() {
          _busy = false;
          _paymentAttempted = true;
          _notice = outcome.message ?? 'Payment not completed. You can try again.';
        });
    }
  }

  Future<void> _cancelOrder(OrderProvider orders, OrderModel order) async {
    if (_busy) return;
    final ok = await showKConfirm(
      context,
      title: 'Cancel this order?',
      message: 'Nothing has been paid for this order. Your cart stays as it is, so you can change it and order again.',
      confirmLabel: 'Cancel order',
      cancelLabel: 'Keep it',
      danger: true,
    );
    if (ok != true || !mounted) return;
    _setBusy(true);
    final r = await orders.cancelOrder(order.id, reason: 'Cancelled at checkout');
    if (!mounted) return;
    if (r.ok) {
      orders.clearCheckout();
      setState(() {
        _busy = false;
        _orderId = null;
        _notice = null;
        _paymentAttempted = false;
      });
      showKSnack(context, 'Order cancelled.', icon: LucideIcons.circleX);
    } else {
      _setBusy(false);
      _showError(orderErrorMessage(r.error!, action: 'cancel the order'));
    }
  }

  /// Success beat first, then tracking. Falls back to tracking straight away if the order is unknown.
  void _openPaymentSuccess(String orderId, OrderModel? order, {required bool confirming}) {
    if (order == null) {
      _openTracking(orderId);
      return;
    }
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(
        builder: (context) => PaymentSuccessScreen(
          orderId: orderId,
          amountLabel: rupee(order.totalAmount),
          vendorName: order.vendorName.isEmpty ? 'the kitchen' : order.vendorName,
          confirming: confirming,
          onContinue: () {
            if (!context.mounted) return;
            Navigator.pushAndRemoveUntil(
              context,
              MaterialPageRoute(builder: (context) => LiveTrackingScreen(orderId: orderId)),
              (route) => route.isFirst,
            );
          },
        ),
      ),
      (route) => route.isFirst,
    );
  }

  void _openTracking(String orderId) {
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(builder: (context) => LiveTrackingScreen(orderId: orderId)),
      (route) => route.isFirst,
    );
  }

  void _showError(String message) {
    if (!mounted) return;
    setState(() => _notice = message);
    showKSnack(context, message, error: true);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final cart = Provider.of<CartProvider>(context);
    final orders = Provider.of<OrderProvider>(context);
    final order = _orderId == null ? null : orders.orderById(_orderId!);
    final busy = _busy || (order != null && orders.isPaying(order.id));

    final Widget body;
    final Widget? footer;
    if (order != null) {
      body = _buildPlacedOrder(context, k, order);
      footer = _buildPlacedFooter(context, k, cart, orders, order, busy);
    } else if (cart.items.isEmpty) {
      body = KEmptyScroll(
        child: KEmptyState(
          icon: LucideIcons.shoppingBag,
          title: 'Your cart is empty',
          message: 'Add something delicious from a kitchen and come back to pay.',
          action: KButton(label: 'Back to menu', kind: KButtonKind.tonal, expand: false, onPressed: () => Navigator.of(context).maybePop()),
        ),
      );
      footer = null;
    } else {
      body = ListView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 24),
        children: [
          KReveal(child: _SectionCard(title: 'Drop-off', icon: LucideIcons.mapPin, child: _buildDropoff(context, k))),
          const SizedBox(height: 14),
          KReveal(index: 1, child: _SectionCard(title: cart.dhabaName ?? 'Your order', icon: LucideIcons.receiptText, child: _buildSummary(context, k, cart))),
          const SizedBox(height: 14),
          KReveal(index: 2, child: CoinsBalance(cart: cart)),
          const SizedBox(height: 14),
          KReveal(index: 3, child: _SectionCard(title: 'Payment', icon: LucideIcons.wallet, child: _buildPayment(context, k))),
          const SizedBox(height: 14),
          KReveal(index: 4, child: BillBreakdown.cart(cart: cart)),
        ],
      );
      footer = KSheetFooter(
        floating: true,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_notice != null) _NoticeLine(message: _notice!, error: true),
          KButton(
            label: _currentHostel == null ? 'Choose drop-off' : 'Pay ${rupee(cart.grandTotal)}',
            icon: _currentHostel == null ? LucideIcons.mapPin : LucideIcons.lock,
            kind: _currentHostel == null ? KButtonKind.accent : KButtonKind.primary,
            loading: busy,
            onPressed: busy ? null : () => _onPrimary(cart, orders),
          ),
          const SizedBox(height: 8),
          Text(
            busy
                ? 'Placing your order. Please do not close the app.'
                : (_currentHostel == null ? 'Tell us where to deliver first. Payment opens right after.' : 'Next: Kraveo confirms the price, then you pay by UPI.'),
            textAlign: TextAlign.center,
            style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12),
          ),
        ]),
      );
    }

    return PopScope(
      canPop: !busy,
      child: Scaffold(
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
                onTap: busy ? null : () => Navigator.of(context).maybePop(),
              ),
            ),
          ),
          title: const Text('Checkout'),
        ),
        body: body,
        bottomNavigationBar: footer,
      ),
    );
  }

  /// The order exists on the server: everything shown comes from it.
  Widget _buildPlacedOrder(BuildContext context, KraveoTokens k, OrderModel order) {
    final priceChanged = _previewTotal != null && order.awaitsPayment && order.totalPaise != (_previewTotal! * 100).round();
    return ListView(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 24),
      children: [
        if (priceChanged) ...[
          _InfoCard(
            icon: LucideIcons.badgeInfo,
            title: 'Updated total: ${rupee(order.totalAmount)}',
            message: 'Kraveo priced your order at ${rupee(order.totalAmount)} (your cart estimate was ${rupee(_previewTotal!)}). Check the bill below before you pay.',
          ),
          const SizedBox(height: 14),
        ],
        if (order.awaitsPayment) ...[
          _InfoCard(
            icon: LucideIcons.timer,
            title: _paymentAttempted ? 'Payment not completed' : 'Order saved, waiting for payment',
            message: 'Pay by ${clockLabel(order.paymentDeadline)}. Unpaid orders are cancelled automatically 15 minutes after they are placed.',
          ),
          const SizedBox(height: 14),
        ] else if (order.isTerminal) ...[
          _InfoCard(
            icon: LucideIcons.circleX,
            title: order.isPaymentNotCompletedCancel ? 'This order expired' : 'This order was cancelled',
            message: order.isPaymentNotCompletedCancel ? 'Payment was not completed within 15 minutes, so nothing was ordered.' : (order.cancelReason ?? 'It can no longer be paid.'),
          ),
          const SizedBox(height: 14),
        ],
        _SectionCard(
          title: 'Drop-off',
          icon: LucideIcons.mapPin,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(order.dropoffHostel.isEmpty ? 'Campus gate' : order.dropoffHostel, style: KraveoType.titleLg.copyWith(color: k.ink)),
            if (order.dropoffNotes.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(order.dropoffNotes, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ],
          ]),
        ),
        const SizedBox(height: 14),
        _SectionCard(
          title: order.vendorName,
          icon: LucideIcons.receiptText,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Order ${orderRef(order.id)}', style: KraveoType.label.copyWith(color: k.brand, fontSize: 13)),
            const SizedBox(height: 6),
            for (final line in order.items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: Text('${line.quantity} × ${line.name}', maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w600, fontSize: 14))),
                  const SizedBox(width: 12),
                  Text(rupee(line.lineTotal), style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w700, fontSize: 14)),
                ]),
              ),
          ]),
        ),
        const SizedBox(height: 14),
        BillBreakdown.order(order: order),
      ],
    );
  }

  Widget _buildPlacedFooter(BuildContext context, KraveoTokens k, CartProvider cart, OrderProvider orders, OrderModel order, bool busy) {
    final String label;
    final IconData icon;
    if (order.isTerminal) {
      label = 'Place the order again';
      icon = LucideIcons.rotateCcw;
    } else if (!order.awaitsPayment) {
      label = 'Track your order';
      icon = LucideIcons.bike;
    } else {
      label = _paymentAttempted ? 'Try payment again · ${rupee(order.totalAmount)}' : 'Pay ${rupee(order.totalAmount)}';
      icon = LucideIcons.lock;
    }
    return KSheetFooter(
      floating: true,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_notice != null) _NoticeLine(message: _notice!, error: _paymentAttempted || order.isTerminal),
        KButton(label: label, icon: icon, loading: busy, onPressed: busy ? null : () => _onPrimary(cart, orders)),
        if (order.awaitsPayment) ...[
          const SizedBox(height: 8),
          KButton(
            label: 'Cancel order',
            kind: KButtonKind.ghost,
            loading: orders.isCancelling(order.id),
            onPressed: busy ? null : () => _cancelOrder(orders, order),
          ),
        ],
      ]),
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

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.icon, required this.title, required this.message});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.lg)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 20, color: k.brand),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: KraveoType.titleMd.copyWith(color: k.ink)),
            const SizedBox(height: 4),
            Text(message, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
      ]),
    );
  }
}

/// One-line status above the footer button (announced to screen readers).
class _NoticeLine extends StatelessWidget {
  const _NoticeLine({required this.message, required this.error});

  final String message;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final color = error ? kDangerInk : k.inkMuted;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(error ? LucideIcons.circleAlert : LucideIcons.info, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(child: Text(message, style: KraveoType.bodySm.copyWith(color: color, fontWeight: FontWeight.w600))),
        ]),
      ),
    );
  }
}
