import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../widgets/animated_rider_map.dart';
import '../widgets/review_modal.dart';
import '../widgets/split_bill_modal.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/info_chip.dart';
import '../widgets/ui/k_icon_button.dart';
import '../widgets/ui/otp_boxes.dart';
import '../widgets/ui/scroll_empty.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/status_map.dart';

class LiveTrackingScreen extends StatefulWidget {
  final OrderModel? order;
  final String? hostel;
  final String? dhabaName;
  final double? totalAmount;

  /// Called from the empty state's button when this screen is a tab (so it can switch to Home).
  final VoidCallback? onExplore;

  const LiveTrackingScreen({
    super.key,
    this.order,
    this.hostel,
    this.dhabaName,
    this.totalAmount,
    this.onExplore,
  });

  @override
  State<LiveTrackingScreen> createState() => _LiveTrackingScreenState();
}

class _LiveTrackingScreenState extends State<LiveTrackingScreen> {
  final TextEditingController _otpInputController = TextEditingController();
  int _otpErrorTick = 0;
  bool _otpHasError = false;

  @override
  void dispose() {
    _otpInputController.dispose();
    super.dispose();
  }

  void _explore() {
    if (widget.onExplore != null) {
      widget.onExplore!();
    } else {
      Navigator.of(context).maybePop();
    }
  }

  static String _clock(DateTime d) {
    final hour = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final minute = d.minute.toString().padLeft(2, '0');
    return '$hour:$minute ${d.hour >= 12 ? 'PM' : 'AM'}';
  }

  void _verifyHandover(OrderProvider orderProvider) {
    final success = orderProvider.verifyGateHandshakeOtp(_otpInputController.text);
    if (success) {
      setState(() => _otpHasError = false);
      showKSnack(context, 'Handover confirmed. Order delivered!', icon: LucideIcons.packageCheck);
    } else {
      setState(() {
        _otpHasError = true;
        _otpErrorTick++;
      });
      showKSnack(context, 'That OTP does not match. Check the code above.', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final orderProvider = Provider.of<OrderProvider>(context);
    final activeOrder = widget.order ?? orderProvider.activeOrder;
    final canPop = Navigator.of(context).canPop();
    final bottomInset = MediaQuery.paddingOf(context).bottom;

    final leading = canPop
        ? Padding(
            padding: const EdgeInsets.only(left: 20),
            child: Center(child: KIconButton(icon: LucideIcons.arrowLeft, semanticLabel: 'Back', onTap: () => Navigator.of(context).maybePop())),
          )
        : null;

    if (activeOrder == null) {
      return Scaffold(
        backgroundColor: k.bg,
        appBar: AppBar(
          automaticallyImplyLeading: false,
          leading: leading,
          leadingWidth: canPop ? 68 : null,
          toolbarHeight: 68,
          titleSpacing: canPop ? 0 : KSpace.gutter,
          title: const Text('Track order'),
        ),
        body: KEmptyScroll(
          bottomInset: bottomInset,
          child: KEmptyState(
            icon: LucideIcons.bike,
            title: 'No active order',
            message: 'Place an order and its live status, gate OTP and delivery partner show up here.',
            action: KButton(label: 'Explore kitchens', icon: LucideIcons.utensils, kind: KButtonKind.tonal, expand: false, onPressed: _explore),
          ),
        ),
      );
    }

    final status = activeOrder.status;
    final hasRunner = status.index >= OrderProgressStatus.pickedUp.index && status != OrderProgressStatus.cancelled;

    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: leading,
        leadingWidth: canPop ? 68 : null,
        toolbarHeight: 68,
        titleSpacing: canPop ? 0 : KSpace.gutter,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          const Text('Live tracking'),
          Text('Order ${activeOrder.id}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        ]),
        actions: [
          // Demo status step button (existing feature).
          if (status.isLive)
            KPressable(
              semanticLabel: 'Advance order status (demo)',
              onTap: orderProvider.advanceActiveOrderStatus,
              child: Container(
                margin: const EdgeInsets.only(right: KSpace.gutter),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.pill)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(LucideIcons.fastForward, size: 15, color: k.inkMuted),
                  const SizedBox(width: 6),
                  Text('Next step', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
                ]),
              ),
            ),
        ],
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, bottomInset + 24),
        children: [
          KReveal(child: _StatusHero(order: activeOrder, clock: _clock(activeOrder.createdAt))),
          const SizedBox(height: 14),
          if (status.isLive) ...[
            KReveal(index: 1, child: _buildOtpCard(context, activeOrder, orderProvider)),
            const SizedBox(height: 14),
          ],
          if (status == OrderProgressStatus.cancelled)
            KReveal(
              index: 1,
              child: KCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Icon(LucideIcons.circleX, size: 20, color: kDangerInk),
                    const SizedBox(width: 10),
                    Expanded(child: Text('This order was cancelled', style: KraveoType.titleLg.copyWith(color: k.ink))),
                  ]),
                  const SizedBox(height: 8),
                  Text('Nothing will be delivered for this order. You can place a fresh one any time.', style: KraveoType.body.copyWith(color: k.inkMuted)),
                  const SizedBox(height: 14),
                  KButton(label: 'Order again', icon: LucideIcons.utensils, kind: KButtonKind.tonal, expand: false, onPressed: _explore),
                ]),
              ),
            )
          else ...[
            KReveal(index: 2, child: AnimatedRiderMap(status: status, hostel: activeOrder.hostel, dhabaName: activeOrder.dhabaName)),
            const SizedBox(height: 14),
            KReveal(index: 3, child: _TimelineCard(status: status)),
          ],
          const SizedBox(height: 14),
          if (hasRunner) ...[
            KReveal(index: 4, child: _RunnerCard(order: activeOrder)),
          ] else if (status.isLive) ...[
            KReveal(
              index: 4,
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(LucideIcons.bike, size: 18, color: k.inkMuted),
                  const SizedBox(width: 10),
                  Expanded(child: Text('Your delivery partner’s details appear here once your food is picked up.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                ]),
              ),
            ),
          ],
          const SizedBox(height: 14),
          if (status == OrderProgressStatus.delivered) ...[
            KButton(
              label: 'Rate your meal · +10 coins',
              icon: LucideIcons.star,
              onPressed: () {
                final cart = Provider.of<CartProvider>(context, listen: false);
                ReviewModal.show(
                  context,
                  orderId: activeOrder.id,
                  dhabaName: activeOrder.dhabaName,
                  driverName: activeOrder.riderName,
                  dishNames: activeOrder.items.map((i) => i.item.name).toList(),
                  onReviewSubmitted: (coins) => cart.addKraveoCoins(coins),
                );
              },
            ),
            const SizedBox(height: 10),
          ],
          if (status != OrderProgressStatus.cancelled)
            KButton(
              label: 'Split the bill with roommates',
              icon: LucideIcons.users,
              kind: KButtonKind.ghost,
              onPressed: () => SplitBillModal.show(context, order: activeOrder),
            ),
        ],
      ),
    );
  }

  Widget _buildOtpCard(BuildContext context, OrderModel order, OrderProvider orderProvider) {
    final k = context.k;
    final atGate = order.status == OrderProgressStatus.arrivedAtGate;
    return KCard(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
      borderColor: atGate ? order.status.kStatus.color : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(LucideIcons.keyRound, size: 18, color: k.brand),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Your gate OTP', style: KraveoType.titleLg.copyWith(color: k.ink)),
              Text(
                atGate ? 'Your runner is here. Tell them this code.' : 'Keep it handy. Share it only when your runner reaches the gate.',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted),
              ),
            ]),
          ),
        ]),
        const SizedBox(height: 18),
        FittedBox(fit: BoxFit.scaleDown, child: KOtpDisplay(code: order.otpCode)),
        const SizedBox(height: 14),
        KButton(
          label: 'Copy code',
          icon: LucideIcons.copy,
          kind: KButtonKind.tonal,
          onPressed: () {
            Clipboard.setData(ClipboardData(text: order.otpCode));
            showKSnack(context, 'Gate OTP copied.', icon: LucideIcons.copyCheck, duration: const Duration(seconds: 2));
          },
        ),
        if (atGate) ...[
          const SizedBox(height: 20),
          Text('Confirm handover', style: KraveoType.titleMd.copyWith(color: k.ink)),
          const SizedBox(height: 4),
          Text('Once you have your food, enter the OTP to close the order.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 12),
          OtpBoxes(
            controller: _otpInputController,
            autofocus: false,
            boxHeight: 56,
            hasError: _otpHasError,
            errorTick: _otpErrorTick,
            onChanged: (_) {
              if (_otpHasError) setState(() => _otpHasError = false);
            },
          ),
          const SizedBox(height: 12),
          KButton(label: 'Verify and complete', icon: LucideIcons.badgeCheck, onPressed: () => _verifyHandover(orderProvider)),
        ],
      ]),
    );
  }
}

/// Current status, what happens next, and honest context (placed time, kitchen's usual ETA).
class _StatusHero extends StatelessWidget {
  const _StatusHero({required this.order, required this.clock});

  final OrderModel order;
  final String clock;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = order.status;
    final color = status.kStatus.color;
    final dhabas = Provider.of<DhabaProvider>(context, listen: false).dhabas.where((d) => d.id == order.dhabaId);
    final usualEta = dhabas.isEmpty ? null : dhabas.first.eta;

    return KCard(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        KStatusPill(status: status.kStatus, label: status.pillLabel),
        const SizedBox(height: 14),
        AnimatedSwitcher(
          duration: KMotion.base,
          transitionBuilder: (child, anim) => FadeTransition(opacity: anim, child: SlideTransition(position: Tween<Offset>(begin: const Offset(0, 0.15), end: Offset.zero).animate(anim), child: child)),
          child: Align(
            key: ValueKey(status),
            alignment: Alignment.centerLeft,
            child: Text(status.headline, style: KraveoType.headline.copyWith(color: k.ink)),
          ),
        ),
        const SizedBox(height: 6),
        Text(status.nextHint, style: KraveoType.body.copyWith(color: k.inkMuted)),
        if (status != OrderProgressStatus.cancelled) ...[
          const SizedBox(height: 18),
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: status.progressValue),
            duration: KMotion.slow,
            curve: KMotion.emphasized,
            builder: (context, value, _) => ClipRRect(
              borderRadius: BorderRadius.circular(KRadius.pill),
              child: LinearProgressIndicator(value: value, minHeight: 8, color: color, backgroundColor: color.withValues(alpha: 0.16)),
            ),
          ),
        ],
        const SizedBox(height: 16),
        if (status.isLive && usualEta != null) ...[
          KInfoChip(icon: LucideIcons.timer, label: 'Kitchen usually delivers in $usualEta'),
          const SizedBox(height: 12),
        ],
        Text(
          '${order.dhabaName} \u00B7 ${order.hostel.isEmpty ? 'Campus gate' : order.hostel} \u00B7 ${rupee(order.totalAmount)}',
          style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 2),
        Text('Placed at $clock', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      ]),
    );
  }
}

class _TimelineStep {
  const _TimelineStep(this.status, this.icon, this.title, this.subtitle);
  final OrderProgressStatus status;
  final IconData icon;
  final String title;
  final String subtitle;
}

const List<_TimelineStep> _steps = [
  _TimelineStep(OrderProgressStatus.placed, LucideIcons.receipt, 'Order placed', 'The kitchen has your order'),
  _TimelineStep(OrderProgressStatus.preparing, LucideIcons.chefHat, 'Preparing', 'Your food is being cooked fresh'),
  _TimelineStep(OrderProgressStatus.pickedUp, LucideIcons.packageCheck, 'Picked up', 'Your delivery partner collected it'),
  _TimelineStep(OrderProgressStatus.onTheWay, LucideIcons.bike, 'On the way', 'Travelling from the kitchen to campus'),
  _TimelineStep(OrderProgressStatus.arrivedAtGate, LucideIcons.doorOpen, 'At the gate', 'Share your OTP to receive your food'),
  _TimelineStep(OrderProgressStatus.delivered, LucideIcons.circleCheck, 'Delivered', 'Enjoy your meal'),
];

class _TimelineCard extends StatelessWidget {
  const _TimelineCard({required this.status});

  final OrderProgressStatus status;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final current = status.index;
    return KCard(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Order journey', style: KraveoType.titleLg.copyWith(color: k.ink)),
        const SizedBox(height: 16),
        for (var i = 0; i < _steps.length; i++)
          _TimelineRow(
            step: _steps[i],
            isDone: _steps[i].status.index < current || (status == OrderProgressStatus.delivered),
            isCurrent: _steps[i].status.index == current,
            isLast: i == _steps.length - 1,
          ),
      ]),
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.step, required this.isDone, required this.isCurrent, required this.isLast});

  final _TimelineStep step;
  final bool isDone;
  final bool isCurrent;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final color = step.status.kStatus.color;
    final reached = isDone || isCurrent;
    final live = isCurrent && step.status.isLive;
    return Stack(children: [
      Padding(
        padding: EdgeInsets.only(left: 48, top: 4, bottom: isLast ? 4 : 22),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Flexible(
              child: Text(step.title, style: KraveoType.titleMd.copyWith(color: reached ? k.ink : k.inkFaint)),
            ),
            if (live) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(KRadius.pill)),
                child: Text('NOW', style: KraveoType.caption.copyWith(color: k.ink, fontSize: 10.5, letterSpacing: 0.8)),
              ),
            ],
          ]),
          const SizedBox(height: 2),
          Text(step.subtitle, style: KraveoType.bodySm.copyWith(color: reached ? k.inkMuted : k.inkFaint)),
        ]),
      ),
      if (!isLast)
        Positioned(
          left: 16.5,
          top: 38,
          bottom: 2,
          width: 3,
          child: Stack(fit: StackFit.expand, children: [
            DecoratedBox(decoration: BoxDecoration(color: k.line, borderRadius: BorderRadius.circular(2))),
            AnimatedFractionallySizedBox(
              duration: KMotion.slow,
              curve: KMotion.emphasized,
              heightFactor: isDone ? 1 : 0,
              alignment: Alignment.topCenter,
              child: DecoratedBox(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2))),
            ),
          ]),
        ),
      Positioned(left: 0, top: 0, child: _Node(color: color, icon: isDone ? LucideIcons.check : step.icon, reached: reached, pulsing: live)),
    ]);
  }
}

class _Node extends StatefulWidget {
  const _Node({required this.color, required this.icon, required this.reached, required this.pulsing});

  final Color color;
  final IconData icon;
  final bool reached;
  final bool pulsing;

  @override
  State<_Node> createState() => _NodeState();
}

class _NodeState extends State<_Node> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500));
    if (widget.pulsing) _pulse.repeat();
  }

  @override
  void didUpdateWidget(covariant _Node old) {
    super.didUpdateWidget(old);
    if (widget.pulsing && !_pulse.isAnimating) {
      _pulse.repeat();
    } else if (!widget.pulsing && _pulse.isAnimating) {
      _pulse.stop();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SizedBox(
      width: 36,
      height: 36,
      child: Stack(alignment: Alignment.center, children: [
        if (widget.pulsing)
          AnimatedBuilder(
            animation: _pulse,
            builder: (context, _) => Container(
              width: 32 + 8 * _pulse.value,
              height: 32 + 8 * _pulse.value,
              decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.32 * (1 - _pulse.value))),
            ),
          ),
        AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          width: 30,
          height: 30,
          decoration: BoxDecoration(color: widget.reached ? widget.color : k.surfaceAlt, shape: BoxShape.circle),
          child: AnimatedSwitcher(
            duration: KMotion.fast,
            transitionBuilder: (child, anim) => ScaleTransition(scale: CurvedAnimation(parent: anim, curve: KMotion.spring), child: child),
            child: Icon(widget.icon, key: ValueKey(widget.icon), size: 15, color: widget.reached ? Colors.white : k.inkFaint),
          ),
        ),
      ]),
    );
  }
}

class _RunnerCard extends StatelessWidget {
  const _RunnerCard({required this.order});

  final OrderModel order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      padding: const EdgeInsets.all(16),
      child: Row(children: [
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
          child: Icon(LucideIcons.userRound, size: 24, color: k.brand),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('YOUR DELIVERY PARTNER', style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
            Text(order.riderName, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
            Text(order.riderVehicle, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
        const SizedBox(width: 10),
        KIconButton(
          icon: LucideIcons.phone,
          semanticLabel: 'Call ${order.riderName}',
          color: k.onBrand,
          background: k.brand,
          bordered: false,
          size: 48,
          onTap: () {
            Clipboard.setData(ClipboardData(text: order.riderPhone));
            showKSnack(context, '${order.riderName}’s number (${order.riderPhone}) copied. Paste it in your dialer.', icon: LucideIcons.phone);
          },
        ),
      ]),
    );
  }
}
