import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../services/order_api.dart';
import '../widgets/map/map_view.dart';
import '../widgets/map/tracking_map.dart';
import '../widgets/push_permission.dart';
import '../widgets/review_modal.dart';
import '../widgets/split_bill_modal.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/k_icon_button.dart';
import '../widgets/ui/scroll_empty.dart';
import '../widgets/ui/sheet_chrome.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/status_map.dart';
import '../widgets/ui/support_contact.dart';
import '../widgets/reorder.dart';
import '../services/external_links.dart';
import '../models/drop_point.dart';

/// Live tracking of one real order. Everything comes from the server: `GET /orders/:id` when
/// shown, every 15 s while visible (polling), and `order_updated` / `rider_location` on the
/// socket. The gate OTP is the server's and only appears at ARRIVED_AT_GATE.
///
/// A combined order (Docs/22) is ONE screen: opened with the id of any of its restaurants' parts
/// (history card, push, Track tab), it shows a row per restaurant with its own status, one rider,
/// one gate OTP and one total. Cancelling or a failed payment applies to the whole order.
class LiveTrackingScreen extends StatefulWidget {
  /// The order to show. Null (the Track tab) shows the student's current order.
  final String? orderId;

  /// Whether this screen is on screen (the Track tab stays mounted while another tab shows).
  /// Polling and the socket only run while visible.
  final bool visible;

  /// Called from the empty state's button when this screen is a tab (so it can switch to Home).
  final VoidCallback? onExplore;

  /// Test seam: builds the real map. Null uses the production Google map (which stays out of the
  /// way, showing the stylised map, whenever it is unavailable).
  final MapViewFactory? mapFactory;

  const LiveTrackingScreen({super.key, this.orderId, this.visible = true, this.onExplore, this.mapFactory});

  @override
  State<LiveTrackingScreen> createState() => _LiveTrackingScreenState();
}

class _LiveTrackingScreenState extends State<LiveTrackingScreen> {
  OrderProvider? _orders;
  String? _watching;

  /// The provider [_watching] was registered on (balanced even if the provider is swapped).
  OrderProvider? _watchingOn;

  /// The order picked from the switcher when several are live (Track tab only).
  String? _picked;

  /// "Try again" on the can't-load state is running.
  bool _retrying = false;

  Future<void> _retryLoad(String id) async {
    if (_retrying) return;
    setState(() => _retrying = true);
    try {
      await _orders?.refreshOrder(id);
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _orders = Provider.of<OrderProvider>(context, listen: false);
  }

  @override
  void dispose() {
    final id = _watching;
    if (id != null) _watchingOn?.unwatch(id);
    super.dispose();
  }

  void _syncWatch(String? wanted) {
    final target = widget.visible ? wanted : null;
    if (target == _watching && identical(_watchingOn, _orders)) return;
    final previous = _watching;
    if (previous != null) _watchingOn?.unwatch(previous);
    _watching = target;
    _watchingOn = _orders;
    if (target != null) _orders?.watch(target);
  }

  void _explore() {
    if (widget.onExplore != null) {
      widget.onExplore!();
    } else {
      Navigator.of(context).maybePop();
    }
  }

  Future<void> _pay(OrderProvider orders, OrderModel order) async {
    final outcome = await orders.payForOrder(order.id, contact: context.read<SessionProvider>().user?.phone);
    if (!mounted) return;
    switch (outcome.kind) {
      case PaymentOutcomeKind.paid:
        showKSnack(context, 'Payment successful. The restaurant has your order now.', icon: LucideIcons.circleCheck);
      case PaymentOutcomeKind.confirming:
        showKSnack(context, outcome.message ?? 'Payment received. Confirming it with Kraveo.', icon: LucideIcons.loader);
      case PaymentOutcomeKind.cancelled:
      case PaymentOutcomeKind.failed:
      case PaymentOutcomeKind.orderClosed:
        showKSnack(context, outcome.message ?? 'Payment not completed. You can try again.', error: true);
    }
  }

  Future<void> _cancel(OrderProvider orders, OrderModel order) async {
    final whole = order.isGroup ? 'This cancels your whole order, from all ${order.group!.size} restaurants. ' : '';
    final ok = await showKConfirm(
      context,
      title: 'Cancel this order?',
      message: '$whole${order.isPaid ? '${order.isGroup ? 'None of the restaurants has accepted yet. ' : 'The restaurant has not accepted it yet. '}Your ${rupee(order.totalAmount)} will be refunded to your account.' : 'You have not completed a payment for this order, so nothing is charged. If your bank did take money, Kraveo refunds it automatically.'}',
      confirmLabel: 'Cancel order',
      cancelLabel: 'Keep it',
      danger: true,
    );
    if (ok != true || !mounted) return;
    final r = await orders.cancelOrder(order.id, reason: 'Cancelled by customer');
    if (!mounted) return;
    if (r.ok) {
      showKSnack(context, order.isPaid ? 'Order cancelled. Your refund has been started.' : 'Order cancelled.', icon: LucideIcons.circleX);
    } else {
      final e = r.error!;
      showKSnack(
        context,
        e.kind == OrderErrorKind.conflict || e.kind == OrderErrorKind.rejected
            ? (e.message ?? (order.isGroup ? 'A restaurant already accepted this order, so it can\'t be cancelled in the app.' : 'The restaurant already accepted this order, so it can\'t be cancelled in the app.'))
            : orderErrorMessage(e, action: 'cancel the order'),
        error: true,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final orders = Provider.of<OrderProvider>(context);
    final live = orders.liveOrders;
    String? id = widget.orderId;
    if (id == null) {
      final picked = _picked;
      id = (picked != null && live.any((o) => o.id == picked)) ? picked : orders.currentOrder?.id;
    }
    final order = id == null ? null : orders.orderById(id);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _syncWatch(id);
    });

    final canPop = Navigator.of(context).canPop();
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    final leading = canPop
        ? Padding(
            padding: const EdgeInsets.only(left: 20),
            child: Center(child: KIconButton(icon: LucideIcons.arrowLeft, semanticLabel: 'Back', onTap: () => Navigator.of(context).maybePop())),
          )
        : null;

    AppBar bar(Widget title) => AppBar(
          automaticallyImplyLeading: false,
          leading: leading,
          leadingWidth: canPop ? 68 : null,
          toolbarHeight: 68,
          titleSpacing: canPop ? 0 : KSpace.gutter,
          title: title,
        );

    if (order == null) {
      final Widget body;
      final loadError = id == null ? null : orders.loadErrorFor(id);
      if (id != null && loadError != null && !_retrying) {
        // The order cannot be loaded (someone else's, deleted, offline): say so instead of
        // spinning forever, and let the student retry or leave.
        final missing = loadError.kind == OrderErrorKind.notFound || loadError.kind == OrderErrorKind.forbidden;
        final orderId = id;
        body = RefreshIndicator(
          onRefresh: () => _retryLoad(orderId),
          child: KEmptyScroll(
            bottomInset: bottomInset,
            child: KEmptyState(
              icon: missing ? LucideIcons.searchX : LucideIcons.wifiOff,
              title: missing ? 'We couldn\'t find this order' : 'Couldn\'t load this order',
              message: missing
                  ? 'It may belong to a different account, or it is no longer available. Check Your orders, or email $kSupportEmail if you think this is a mistake.'
                  : orderErrorMessage(loadError, action: 'load this order'),
              action: Column(mainAxisSize: MainAxisSize.min, children: [
                if (!missing) KButton(label: 'Try again', icon: LucideIcons.rotateCcw, kind: KButtonKind.tonal, expand: false, onPressed: () => _retryLoad(orderId)),
                if (missing) KButton(label: 'Check again', icon: LucideIcons.rotateCcw, kind: KButtonKind.ghost, expand: false, onPressed: () => _retryLoad(orderId)),
                const SizedBox(height: 4),
                if (canPop) KButton(label: 'Go back', kind: KButtonKind.ghost, expand: false, onPressed: () => Navigator.of(context).maybePop()),
              ]),
            ),
          ),
        );
      } else if (id != null || (orders.isLoadingActive && !orders.hasLoadedActive)) {
        body = const Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)));
      } else if (orders.activeError != null && !orders.hasLoadedActive) {
        body = KEmptyScroll(
          bottomInset: bottomInset,
          child: KEmptyState(
            icon: LucideIcons.wifiOff,
            title: 'Couldn\'t load your orders',
            message: orderErrorMessage(orders.activeError!, action: 'load your orders'),
            action: KButton(label: 'Try again', icon: LucideIcons.rotateCcw, kind: KButtonKind.tonal, expand: false, onPressed: orders.refreshActive),
          ),
        );
      } else {
        body = RefreshIndicator(
          onRefresh: orders.refreshActive,
          child: KEmptyScroll(
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
      return Scaffold(backgroundColor: k.bg, appBar: bar(const Text('Track order')), body: body);
    }

    final status = order.status;
    final confirming = orders.isConfirmingPayment(order.id);
    final paidAndLive = order.isLive && !order.awaitsPayment;

    return Scaffold(
      backgroundColor: k.bg,
      appBar: bar(Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        const Text('Live tracking'),
        Text('Order ${orderRef(order.id)}${order.isGroup ? ' · ${order.group!.size} restaurants' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      ])),
      body: RefreshIndicator(
        onRefresh: () async {
          await orders.refreshOrder(order.id);
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, bottomInset + 24),
          children: [
            if (widget.orderId == null && live.length > 1) ...[
              SizedBox(
                key: const ValueKey('order-switcher'),
                height: 48,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: live.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (context, i) => KChoiceChip(
                    label: '${live[i].title} · ${live[i].awaitsPayment ? 'Unpaid' : live[i].status.pillLabel}',
                    selected: live[i].id == order.id,
                    onTap: () => setState(() => _picked = live[i].id),
                  ),
                ),
              ),
              const SizedBox(height: 10),
            ],
            const NotificationsOffHint(key: ValueKey('notifications-hint')),
            KReveal(key: const ValueKey('hero'), child: _StatusHero(order: order, confirming: confirming)),
            const SizedBox(height: 14),
            if (order.awaitsPayment) ...[
              KReveal(
                key: const ValueKey('payment'),
                index: 1,
                child: _PaymentCard(
                  order: order,
                  confirming: confirming,
                  unconfirmed: orders.paymentUnconfirmed(order.id),
                  paying: orders.isPaying(order.id),
                  cancelling: orders.isCancelling(order.id),
                  onPay: () => _pay(orders, order),
                  onCancel: () => _cancel(orders, order),
                ),
              ),
              const SizedBox(height: 14),
            ],
            if (status == OrderProgressStatus.arrivedAtGate || (order.isGroup && order.otpCode != null && status != OrderProgressStatus.cancelled)) ...[
              KReveal(key: const ValueKey('otp'), index: 1, child: _OtpCard(order: order)),
              const SizedBox(height: 14),
            ],
            if (order.isGroup) ...[
              KReveal(key: const ValueKey('restaurants'), index: 1, child: _RestaurantsCard(order: order)),
              const SizedBox(height: 14),
            ],
            if (status == OrderProgressStatus.cancelled)
              KReveal(
                key: const ValueKey('cancelled'),
                index: 1,
                child: _CancelledCard(
                  order: order,
                  onAgain: () => reorderOrder(context, order, selectedHostel: context.read<SessionProvider>().deliveryPoint),
                ),
              )
            else if (!order.awaitsPayment) ...[
              // Keyed so the map (a platform view) survives cards appearing above it, e.g. the OTP.
              KReveal(
                key: const ValueKey('map'),
                index: 2,
                child: TrackingMap(
                  key: ValueKey('tracking-map-${order.id}'),
                  order: order,
                  rider: orders.riderLocationListenable(order.id),
                  factory: widget.mapFactory,
                ),
              ),
              const SizedBox(height: 14),
              KReveal(key: const ValueKey('timeline'), index: 3, child: _TimelineCard(status: status)),
            ],
            const SizedBox(height: 14),
            if (order.rider != null && status != OrderProgressStatus.cancelled)
              KReveal(key: const ValueKey('runner'), index: 4, child: _RunnerCard(rider: order.rider!))
            else if (paidAndLive)
              KReveal(
                key: const ValueKey('runner'),
                index: 4,
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(LucideIcons.bike, size: 18, color: k.inkMuted),
                    const SizedBox(width: 10),
                    Expanded(child: Text('Your delivery partner’s name and number appear here once a rider takes your order.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                  ]),
                ),
              ),
            if (status == OrderProgressStatus.placed && order.isPaid) ...[
              const SizedBox(height: 14),
              Text(
                order.isGroup
                    ? (order.acceptBy != null
                        ? 'The restaurants have until ${clockLabel(order.acceptBy!)} to accept. If any of them doesn’t, your whole order is cancelled and refunded automatically.'
                        : 'The restaurants have 10 minutes to accept. If any of them doesn’t, your whole order is cancelled and refunded automatically.')
                    : (order.acceptBy != null
                        ? 'The restaurant has until ${clockLabel(order.acceptBy!)} to accept. If it doesn’t, the order is cancelled and refunded automatically.'
                        : 'The restaurant has 10 minutes to accept. If it doesn’t, the order is cancelled and refunded automatically.'),
                style: KraveoType.bodySm.copyWith(color: k.inkMuted),
              ),
              // A combined order can be cancelled only while EVERY restaurant is still waiting.
              if (order.canCancel) ...[
                const SizedBox(height: 10),
                KButton(
                  label: 'Cancel order',
                  icon: LucideIcons.circleX,
                  kind: KButtonKind.ghost,
                  loading: orders.isCancelling(order.id),
                  onPressed: orders.isCancelling(order.id) ? null : () => _cancel(orders, order),
                ),
                if (order.isGroup) ...[
                  const SizedBox(height: 6),
                  Text('This cancels your whole order, from all ${order.group!.size} restaurants.', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12)),
                ],
              ],
            ],
            const SizedBox(height: 14),
            if (status == OrderProgressStatus.delivered && !order.isGroup && !orders.hasReviewed(order.id)) ...[
              KButton(
                label: 'Rate your meal',
                icon: LucideIcons.star,
                onPressed: () {
                  final cart = Provider.of<CartProvider>(context, listen: false);
                  ReviewModal.show(context, order: order, onReviewed: (r) {
                    if (r.totalCoins != null) cart.setKraveoCoins(r.totalCoins!);
                  });
                },
              ),
              const SizedBox(height: 10),
            ],
            if (order.isPaid && status != OrderProgressStatus.cancelled)
              KButton(
                label: 'Split the bill with roommates',
                icon: LucideIcons.users,
                kind: KButtonKind.ghost,
                onPressed: () => SplitBillModal.show(context, order: order),
              ),
          ],
        ),
      ),
    );
  }
}

/// Current status, what happens next, and honest context (placed time, drop point, total).
class _StatusHero extends StatelessWidget {
  const _StatusHero({required this.order, required this.confirming});

  final OrderModel order;
  final bool confirming;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = order.status;
    final color = status.kStatus.color;
    final unpaid = order.awaitsPayment;
    final String hint;
    if (unpaid) {
      hint = confirming ? 'Razorpay reported your payment. Kraveo is confirming it; this page updates by itself.' : 'The restaurant only sees your order after you pay.';
    } else {
      hint = order.isGroup ? groupNextHint(status) : status.nextHint;
    }

    return KCard(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        KStatusPill(status: status.kStatus, label: unpaid ? 'Unpaid' : status.pillLabel),
        const SizedBox(height: 14),
        AnimatedSwitcher(
          duration: KMotion.base,
          transitionBuilder: (child, anim) => FadeTransition(opacity: anim, child: SlideTransition(position: Tween<Offset>(begin: const Offset(0, 0.15), end: Offset.zero).animate(anim), child: child)),
          child: Align(
            key: ValueKey('${status.name}-${order.paymentStatus.name}-$confirming'),
            alignment: Alignment.centerLeft,
            child: Text(orderHeadline(order, confirmingPayment: confirming), style: KraveoType.headline.copyWith(color: k.ink)),
          ),
        ),
        const SizedBox(height: 6),
        Text(hint, style: KraveoType.body.copyWith(color: k.inkMuted)),
        if (status != OrderProgressStatus.cancelled && !unpaid) ...[
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
        Text(
          '${order.title} · ${order.dropoffHostel.isEmpty ? 'Campus gate' : displayDropPoint(order.dropoffHostel)} · ${rupee(order.totalAmount)}',
          style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 2),
        Text('Placed at ${clockLabel(order.createdAt)}', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      ]),
    );
  }
}

/// One row per restaurant of a combined order: its name, its own status (same wording as a
/// single order) and what was ordered there.
class _RestaurantsCard extends StatelessWidget {
  const _RestaurantsCard({required this.order});

  final OrderModel order;

  String _items(OrderModel? part, GroupStop? stop) {
    final lines = part?.items ?? const <OrderLine>[];
    if (lines.isEmpty) {
      final n = stop?.itemCount ?? 0;
      return n == 0 ? '' : '$n ${n == 1 ? 'item' : 'items'}';
    }
    final parts = lines.map((i) => '${i.quantity} × ${i.name}').toList();
    return parts.length <= 3 ? parts.join(', ') : '${parts.take(3).join(', ')} +${parts.length - 3} more';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final byId = {for (final m in order.members ?? const <OrderModel>[]) m.id: m};
    final stops = order.group?.stops ?? const <GroupStop>[];
    final rows = <({String name, OrderProgressStatus status, String items})>[
      if (stops.isNotEmpty)
        for (final s in stops) (name: byId[s.orderId]?.vendorName ?? s.vendorName, status: byId[s.orderId]?.status ?? s.status, items: _items(byId[s.orderId], s))
      else
        for (final m in order.members ?? const <OrderModel>[]) (name: m.vendorName, status: m.status, items: _items(m, null)),
    ];
    // The whole order is cancelled as soon as one part is: show every row that way.
    final cancelled = order.status == OrderProgressStatus.cancelled;
    return KCard(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Your ${order.group!.size} restaurants', style: KraveoType.titleLg.copyWith(color: k.ink)),
        const SizedBox(height: 4),
        Text('One rider brings everything, with one OTP and one payment.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        const SizedBox(height: 10),
        for (var i = 0; i < rows.length; i++) ...[
          if (i > 0) Divider(height: 1, color: k.line),
          Builder(builder: (context) {
            final r = rows[i];
            final status = cancelled ? OrderProgressStatus.cancelled : r.status;
            final label = order.awaitsPayment ? 'Unpaid' : status.pillLabel;
            return Semantics(
              container: true,
              label: '${r.name}: $label${r.items.isEmpty ? '' : '. ${r.items}'}',
              child: ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.store, size: 16, color: k.brand)),
                      const SizedBox(width: 8),
                      Expanded(child: Text(r.name, maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink))),
                      const SizedBox(width: 10),
                      KStatusPill(status: status.kStatus, label: label, compact: true),
                    ]),
                    if (r.items.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Padding(padding: const EdgeInsets.only(left: 24), child: Text(r.items, maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                    ],
                  ]),
                ),
              ),
            );
          }),
        ],
      ]),
    );
  }
}

/// PLACED but not paid: pay (again) on the same order, see the deadline, or cancel.
class _PaymentCard extends StatelessWidget {
  const _PaymentCard({
    required this.order,
    required this.confirming,
    required this.unconfirmed,
    required this.paying,
    required this.cancelling,
    required this.onPay,
    required this.onCancel,
  });

  final OrderModel order;
  final bool confirming;
  final bool unconfirmed;
  final bool paying;
  final bool cancelling;
  final VoidCallback onPay;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    if (confirming) {
      return KCard(
        child: Row(children: [
          const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.6)),
          const SizedBox(width: 14),
          Expanded(child: Text('Confirming your payment of ${rupee(order.totalAmount)}. Please don’t pay again.', style: KraveoType.body.copyWith(color: k.ink))),
        ]),
      );
    }
    return KCard(
      borderColor: KStatus.placed.color,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Payment not completed', style: KraveoType.titleLg.copyWith(color: k.ink)),
        const SizedBox(height: 6),
        Text(
          'Pay by ${clockLabel(order.paymentDeadline)} to send this order to ${order.isGroup ? 'the restaurants' : 'the restaurant'}. Unpaid orders are cancelled automatically after 15 minutes.',
          style: KraveoType.bodySm.copyWith(color: k.inkMuted),
        ),
        if (unconfirmed) ...[
          const SizedBox(height: 8),
          Text(
            'If money already left your account for this order, wait a few minutes before paying again: Kraveo confirms late payments automatically.',
            style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600),
          ),
        ],
        const SizedBox(height: 14),
        KButton(label: 'Try payment again · ${rupee(order.totalAmount)}', icon: LucideIcons.lock, loading: paying, onPressed: paying || cancelling ? null : onPay),
        const SizedBox(height: 8),
        KButton(label: 'Cancel order', kind: KButtonKind.ghost, loading: cancelling, onPressed: paying || cancelling ? null : onCancel),
        if (order.isGroup) ...[
          const SizedBox(height: 6),
          Text('This cancels your whole order, from all ${order.group!.size} restaurants.', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12)),
        ],
      ]),
    );
  }
}

/// The server's gate OTP (only at ARRIVED_AT_GATE).
class _OtpCard extends StatelessWidget {
  const _OtpCard({required this.order});

  final OrderModel order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final code = order.otpCode;
    return KCard(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
      borderColor: order.status.kStatus.color,
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
                order.isGroup ? 'Your rider is here with all your food. One code for all ${order.group!.size} restaurants: tell it to them.' : 'Your rider is here. Tell them this code to get your food.',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted),
              ),
            ]),
          ),
        ]),
        const SizedBox(height: 18),
        if (code == null)
          Row(children: [
            const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4)),
            const SizedBox(width: 12),
            Expanded(child: Text('Getting your code from Kraveo…', style: KraveoType.body.copyWith(color: k.inkMuted))),
          ])
        else ...[
          FittedBox(fit: BoxFit.scaleDown, child: KOtpDisplay(code: code)),
          const SizedBox(height: 14),
          KButton(
            label: 'Copy code',
            icon: LucideIcons.copy,
            kind: KButtonKind.tonal,
            onPressed: () {
              Clipboard.setData(ClipboardData(text: code));
              showKSnack(context, 'Gate OTP copied.', icon: LucideIcons.copyCheck, duration: const Duration(seconds: 2));
            },
          ),
        ],
      ]),
    );
  }
}

/// Cancelled / refunded, with the reason (contract 1.3) and refund wording only when refunded.
class _CancelledCard extends StatelessWidget {
  const _CancelledCard({required this.order, required this.onAgain});

  final OrderModel order;
  final VoidCallback onAgain;

  String get _why {
    final reason = order.cancelReason;
    if (reason == kReasonPaymentNotCompleted) return 'Payment not completed. The order was cancelled because it wasn’t paid within 15 minutes.';
    if (reason == kReasonRestaurantNoResponse) return 'Restaurant did not respond. The kitchen didn’t accept your order in time.';
    switch (order.cancelledBy) {
      case CancelledBy.customer:
        return 'You cancelled this order.';
      case CancelledBy.vendor:
        if (order.isGroup) {
          final who = order.cancelTriggerName ?? 'A restaurant';
          return reason == null ? '$who couldn’t take its part, so your whole order was cancelled.' : '$who couldn’t take its part, so your whole order was cancelled: $reason';
        }
        return reason == null ? 'The restaurant couldn’t take your order.' : 'The restaurant couldn’t take your order: $reason';
      case CancelledBy.admin:
        return reason == null ? 'Kraveo support cancelled this order.' : 'Kraveo support cancelled this order: $reason';
      case CancelledBy.system:
      case null:
        return reason ?? 'This order was cancelled.';
    }
  }

  String get _money {
    if (order.paymentStatus == PaymentStatus.refunded) {
      return 'Your refund of ${rupee(order.totalAmount)} has been issued. It will reach your account in 5–7 working days.';
    }
    if (order.paymentStatus == PaymentStatus.paid) {
      return order.refundStatus == RefundStatus.failed
          ? 'Your refund of ${rupee(order.totalAmount)} is taking longer than usual. Kraveo retries it automatically and support has been alerted.'
          : 'You paid ${rupee(order.totalAmount)} for this order. Your refund is being processed.';
    }
    return 'No payment was taken for this order.';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(LucideIcons.circleX, size: 20, color: kDangerInk),
          const SizedBox(width: 10),
          Expanded(child: Text(order.paymentStatus == PaymentStatus.refunded ? 'Cancelled and refunded' : 'This order was cancelled', style: KraveoType.titleLg.copyWith(color: k.ink))),
        ]),
        const SizedBox(height: 8),
        Text(_why, style: KraveoType.body.copyWith(color: k.ink)),
        const SizedBox(height: 6),
        Text(_money, style: KraveoType.body.copyWith(color: k.inkMuted)),
        // A paid order that is not refunded yet (or whose refund failed), or one Kraveo cancelled:
        // tell the student how to reach a person.
        if (order.isPaid || order.refundStatus == RefundStatus.failed || order.cancelledBy == CancelledBy.admin)
          SupportEmailLine(subject: 'Order ${orderRef(order.id)}'),
        const SizedBox(height: 14),
        KButton(label: 'Order again', icon: LucideIcons.utensils, kind: KButtonKind.tonal, expand: false, onPressed: onAgain),
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
  _TimelineStep(OrderProgressStatus.placed, LucideIcons.receipt, 'Order placed', 'Paid and sent to the kitchen'),
  _TimelineStep(OrderProgressStatus.accepted, LucideIcons.thumbsUp, 'Accepted', 'The restaurant confirmed your order'),
  _TimelineStep(OrderProgressStatus.preparing, LucideIcons.chefHat, 'Preparing', 'Your food is being cooked fresh'),
  _TimelineStep(OrderProgressStatus.readyForPickup, LucideIcons.package, 'Ready', 'Packed and waiting for your rider'),
  _TimelineStep(OrderProgressStatus.pickedUp, LucideIcons.bike, 'On the way', 'Your rider is heading to campus'),
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
  const _RunnerCard({required this.rider});

  final OrderRider rider;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final phone = rider.phone;
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
            Text(rider.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
            if (phone != null) Text(phone, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
        if (phone != null) ...[
          const SizedBox(width: 10),
          KIconButton(
            icon: LucideIcons.phone,
            semanticLabel: 'Call ${rider.name}',
            color: k.onBrand,
            background: k.brand,
            bordered: false,
            size: 48,
            // Opens the phone's dialer with the number filled in; if that is not possible the number
            // is copied instead and the student is told.
            onTap: () => callNumber(context, name: rider.name, phone: phone),
          ),
        ],
      ]),
    );
  }
}
