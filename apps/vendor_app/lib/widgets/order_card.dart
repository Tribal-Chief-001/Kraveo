import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../services/failure_messages.dart';
import '../services/order_queue_controller.dart';
import 'ui/ui.dart';

/// One order in the kitchen list or the history. Shows only what the restaurant may see (customer first
/// name, drop point, note, items, paid amount, runner once assigned) and ONE obvious action for the state:
/// Start cooking (ACCEPTED), Mark ready (PREPARING). Pickup and delivery belong to the runner, so a ready
/// order shows who is coming instead of a button.
class OrderCard extends StatefulWidget {
  const OrderCard({super.key, required this.order, required this.controller, this.onOpenIncoming});

  final OrderModel order;
  final OrderQueueController controller;

  /// Re-opens the full-screen accept / reject takeover for a waiting order.
  final VoidCallback? onOpenIncoming;

  @override
  State<OrderCard> createState() => _OrderCardState();
}

class _OrderCardState extends State<OrderCard> {
  Timer? _countdownTimer;

  OrderModel get order => widget.order;
  OrderQueueController get _c => widget.controller;

  bool get _ticking => order.status == OrderStatus.placed || order.status == OrderStatus.accepted || order.status == OrderStatus.preparing;

  @override
  void initState() {
    super.initState();
    _syncTimer();
  }

  @override
  void didUpdateWidget(OrderCard old) {
    super.didUpdateWidget(old);
    _syncTimer();
  }

  void _syncTimer() {
    if (_ticking && _countdownTimer == null) {
      _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!_ticking) {
      _countdownTimer?.cancel();
      _countdownTimer = null;
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    super.dispose();
  }

  /// green -> amber -> red as the promised time drains away.
  Color _urgencyColor(double progress, bool late) {
    if (late || progress < 0.15) return KraveoPalette.danger;
    if (progress < 0.4) return KraveoPalette.warning;
    return KraveoPalette.success;
  }

  Future<void> _run(Future<ActionOutcome> Function() action, String doneMessage) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final out = await action();
    if (out.ignored) return;
    messenger?.hideCurrentSnackBar();
    if (out.ok) {
      messenger?.showSnackBar(SnackBar(content: Text(doneMessage), duration: const Duration(seconds: 2)));
      return;
    }
    final text = failureText(out.failure!, serverMessage: out.message, code: out.code);
    final now = out.current;
    final extra = now == null
        ? ''
        : now.status == OrderStatus.cancelled
            ? '\nThis order was cancelled.  ·  ऑर्डर रद्द हो गया'
            : '';
    messenger?.showSnackBar(SnackBar(
      content: Text('${text.both}$extra'),
      backgroundColor: kDangerDeep,
      duration: const Duration(seconds: 5),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = order.status;
    final isIncoming = order.isIncoming;
    final isAccepted = status == OrderStatus.accepted;
    final isPreparing = status == OrderStatus.preparing;
    final isReady = status == OrderStatus.readyForPickup;
    final inKitchen = status.isKitchen;
    final isDone = !inKitchen && !isIncoming;
    final busy = _c.isBusy(order.id);

    final now = _c.now();
    final Duration remaining;
    final int totalSecs;
    if (isIncoming) {
      remaining = order.acceptDeadline.difference(now);
      totalSecs = OrderModel.acceptWindow.inSeconds;
    } else {
      remaining = _c.prepDeadlineFor(order).difference(now);
      totalSecs = (_c.prepMinutesFor(order.id) * 60).clamp(1, 1 << 30);
    }
    final timed = isIncoming || isAccepted || isPreparing;
    final isLate = timed && remaining.isNegative;
    final progress = (remaining.inSeconds / totalSecs).clamp(0.0, 1.0);
    final urgency = _urgencyColor(progress, isLate);

    final pill = _pillFor(order);
    final ringColor = timed ? urgency : (isReady ? KStatus.ready.color : k.line);
    final borderColor = isIncoming ? KStatus.placed.color : (timed ? urgency : (isReady ? KStatus.ready.color : k.line));

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: KRadius.card,
        border: Border.all(color: borderColor, width: isDone ? 1.5 : 2.5),
        boxShadow: KShadow.soft(k.shadowTint),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header: countdown ring + order number + who/where + status
          Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            Semantics(
              label: isIncoming
                  ? (isLate ? 'Answer time is over' : '${remaining.inMinutes} minutes left to answer')
                  : timed
                      ? (isLate ? 'Late' : '${remaining.inMinutes} minutes left')
                      : pill.$2,
              excludeSemantics: true,
              child: VCountdownRing(
                size: 98,
                progress: timed ? progress : (isReady ? 1 : 0),
                color: ringColor,
                child: _ringCenter(k, timed: timed, isIncoming: isIncoming, isLate: isLate, remaining: remaining, isReady: isReady),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(order.shortCode, style: KraveoType.headline.copyWith(color: k.ink)),
                ),
                const SizedBox(height: 2),
                Text(
                  '${order.studentName} · ${order.studentLocation}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: KraveoType.body.copyWith(color: k.inkMuted),
                ),
                const SizedBox(height: 8),
                Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  // FittedBox: a longer label ("Preparing") at 360 px and large text shrinks a little instead of overflowing.
                  FittedBox(fit: BoxFit.scaleDown, child: KStatusPill(status: pill.$1, label: pill.$2)),
                  Text(pill.$3, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
                ]),
                const SizedBox(height: 6),
                Text.rich(
                  TextSpan(children: [
                    TextSpan(text: 'Food ${formatRupees(order.foodValue)}', style: KraveoType.titleMd.copyWith(color: k.inkMuted, fontWeight: FontWeight.w700)),
                    TextSpan(text: '  ·  ', style: KraveoType.titleMd.copyWith(color: k.inkFaint)),
                    TextSpan(text: 'Customer pays ${formatRupees(order.totalAmount)}', style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
                  ]),
                ),
              ]),
            ),
          ]),

          const SizedBox(height: 10),
          _MetaLine(order: order),
          const SizedBox(height: 12),

          // Items: big rows, tap to tick off while cooking
          for (var i = 0; i < order.items.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _ItemRow(
                item: order.items[i],
                done: _c.isItemTicked(order.id, i) || isReady,
                enabled: isAccepted || isPreparing,
                onTap: () => _c.toggleItem(order.id, i),
              ),
            ),

          if (order.customerNote != null) ...[
            const SizedBox(height: 4),
            VNoteCallout(note: order.customerNote!, compact: true),
          ],

          if (inKitchen || order.rider != null) ...[
            const SizedBox(height: 12),
            _RiderBlock(order: order),
          ],

          if (status == OrderStatus.cancelled) ...[
            const SizedBox(height: 12),
            _CancelBlock(order: order),
          ],

          const SizedBox(height: 14),

          // ONE obvious action for this state
          if (isIncoming)
            KButton(
              key: ValueKey('respond-${order.id}'),
              label: 'See order · Accept or decline',
              sublabel: 'ऑर्डर देखें',
              icon: LucideIcons.bellRing,
              large: true,
              onPressed: widget.onOpenIncoming,
            )
          else if (isAccepted)
            KButton(
              key: ValueKey('start-${order.id}'),
              label: 'Start cooking',
              sublabel: 'बनाना शुरू करें',
              icon: LucideIcons.flame,
              large: true,
              loading: busy,
              onPressed: busy ? null : () => _run(() => _c.startCooking(order.id), 'Order ${order.shortCode}: preparing  ·  बन रहा है'),
            )
          else if (isPreparing)
            KButton(
              key: ValueKey('ready-${order.id}'),
              label: 'Mark ready',
              sublabel: 'तैयार है',
              icon: LucideIcons.circleCheck,
              large: true,
              loading: busy,
              onPressed: busy ? null : () => _run(() => _c.markReady(order.id), 'Order ${order.shortCode} is ready. The runner will collect it.  ·  तैयार'),
            )
          else
            _StatusFooter(text: pill.$4),
        ],
      ),
    );
  }

  /// (pill status, English pill label, Hindi, footer line)
  (KStatus, String, String, String) _pillFor(OrderModel o) => switch (o.status) {
        OrderStatus.placed => (KStatus.placed, 'New', 'नया', 'Waiting for your answer · जवाब दें'),
        OrderStatus.accepted => (KStatus.accepted, 'Accepted', 'स्वीकार', ''),
        OrderStatus.preparing => (KStatus.preparing, 'Preparing', 'बन रहा है', ''),
        OrderStatus.readyForPickup => (
            KStatus.ready,
            'Ready',
            'तैयार',
            o.rider == null ? 'Ready. Waiting for a runner · रनर का इंतज़ार' : 'Ready. ${o.rider!.name} will collect it · रनर आ रहा है'
          ),
        OrderStatus.pickedUp => (KStatus.pickedUp, 'Picked up', 'सुपुर्द', 'Picked up by runner · सुपुर्द हो चुका है'),
        OrderStatus.arrivedAtGate => (KStatus.atGate, 'At gate', 'गेट पर', 'Runner is at the gate · रनर गेट पर है'),
        OrderStatus.delivered => (KStatus.delivered, 'Delivered', 'पहुँच गया', 'Delivered to the customer · ग्राहक को मिल गया'),
        OrderStatus.cancelled => (KStatus.cancelled, 'Cancelled', 'रद्द', 'Cancelled · रद्द'),
        OrderStatus.unknown => (KStatus.placed, 'Updating', 'अपडेट', 'Status updating · अपडेट हो रहा है'),
      };

  Widget _ringCenter(KraveoTokens k, {required bool timed, required bool isIncoming, required bool isLate, required Duration remaining, required bool isReady}) {
    if (timed && isLate) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        FittedBox(fit: BoxFit.scaleDown, child: Text(isIncoming ? 'TIME UP' : 'LATE', style: KraveoType.headlineSm.copyWith(color: kDangerDeep, fontSize: 20))),
        FittedBox(fit: BoxFit.scaleDown, child: Text(isIncoming ? 'समय खत्म' : 'देर', style: KraveoType.caption.copyWith(color: kDangerDeep, fontSize: 13))),
      ]);
    }
    if (timed) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        FittedBox(fit: BoxFit.scaleDown, child: Text(formatMmSs(remaining), style: KraveoType.headlineSm.copyWith(color: k.ink, fontSize: 22))),
        FittedBox(fit: BoxFit.scaleDown, child: Text(isIncoming ? 'to answer' : 'min left', style: KraveoType.caption.copyWith(color: k.inkMuted, fontSize: 11))),
      ]);
    }
    final icon = switch (order.status) {
      OrderStatus.readyForPickup => LucideIcons.bellRing,
      OrderStatus.cancelled => LucideIcons.x,
      _ => LucideIcons.check,
    };
    return Icon(icon, size: 34, color: isReady ? k.brand : k.inkFaint);
  }
}

/// "Paid online · placed 7:42 PM · accepted 7:44 PM".
class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.order});
  final OrderModel order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final pay = switch (order.paymentStatus) {
      PaymentStatus.paid => 'Paid online',
      PaymentStatus.refunded => 'Refunded to customer',
      _ => 'Payment: ${order.paymentStatus.name}',
    };
    final parts = <String>[
      pay,
      'placed ${formatClock(order.createdAt)}',
      if (order.acceptedAt != null) 'accepted ${formatClock(order.acceptedAt!)}',
      if (order.pickedUpAt != null) 'picked up ${formatClock(order.pickedUpAt!)}',
      if (order.deliveredAt != null) 'delivered ${formatClock(order.deliveredAt!)}',
      if (order.cancelledAt != null) 'cancelled ${formatClock(order.cancelledAt!)}',
    ];
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(order.paymentStatus == PaymentStatus.paid ? LucideIcons.badgeCheck : LucideIcons.receipt, size: 18, color: order.paymentStatus == PaymentStatus.paid ? k.brand : k.inkMuted),
      const SizedBox(width: 6),
      Expanded(child: Text(parts.join(' · '), style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14))),
    ]);
  }
}

/// Who is coming to collect the food. Phone shown only once a runner has claimed the order.
class _RiderBlock extends StatelessWidget {
  const _RiderBlock({required this.order});
  final OrderModel order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final rider = order.rider;
    if (rider == null) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
        child: Row(children: [
          Icon(LucideIcons.bike, size: 24, color: k.inkMuted),
          const SizedBox(width: 10),
          Expanded(child: Text('Looking for a runner · रनर ढूंढ रहे हैं', style: KraveoType.titleMd.copyWith(color: k.inkMuted, fontSize: 16))),
        ]),
      );
    }
    final phone = rider.phone;
    return Container(
      key: ValueKey('rider-${order.id}'),
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
      constraints: const BoxConstraints(minHeight: 64),
      decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.lg)),
      child: Row(children: [
        Icon(LucideIcons.bike, size: 26, color: k.brand),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('Runner · रनर', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
            Text(rider.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 18)),
            if (phone != null) Text(phone, maxLines: 1, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16)),
          ]),
        ),
        if (phone != null)
          Semantics(
            button: true,
            label: 'Copy runner phone number',
            excludeSemantics: true,
            child: KPressable(
              onTap: () {
                Clipboard.setData(ClipboardData(text: phone));
                ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Phone number copied  ·  नंबर कॉपी हो गया'), duration: Duration(seconds: 2)));
              },
              child: Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(color: k.surface, shape: BoxShape.circle),
                child: Icon(LucideIcons.copy, size: 22, color: k.brand),
              ),
            ),
          ),
      ]),
    );
  }
}

class _CancelBlock extends StatelessWidget {
  const _CancelBlock({required this.order});
  final OrderModel order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final who = switch (order.cancelledBy) {
      CancelledBy.customer => 'Cancelled by the customer · ग्राहक ने रद्द किया',
      CancelledBy.vendor => 'Declined by you · आपने मना किया',
      CancelledBy.admin => 'Cancelled by Kraveo · Kraveo ने रद्द किया',
      CancelledBy.system => order.cancelReason == 'Restaurant did not respond'
          ? 'Not accepted in 10 minutes · समय पर जवाब नहीं'
          : 'Cancelled automatically · अपने आप रद्द',
      _ => 'Cancelled · रद्द',
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.08), k.surface),
        borderRadius: BorderRadius.circular(KRadius.lg),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(who, style: KraveoType.titleMd.copyWith(color: kDangerDeep, fontWeight: FontWeight.w800, fontSize: 16)),
        if (order.cancelReason != null) Text('Reason: ${order.cancelReason}', style: KraveoType.body.copyWith(color: k.ink, fontSize: 15)),
        if (order.paymentStatus == PaymentStatus.refunded) Text('Customer refunded · पैसे वापस', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
      ]),
    );
  }
}

class _StatusFooter extends StatelessWidget {
  const _StatusFooter({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 64),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(LucideIcons.info, size: 22, color: k.inkMuted),
        const SizedBox(width: 10),
        Flexible(child: Text(text, textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted))),
      ]),
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.item, required this.done, required this.enabled, required this.onTap});
  final OrderItem item;
  final bool done;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      checked: done,
      label: '${item.quantity} ${item.name}',
      excludeSemantics: true,
      onTap: enabled ? onTap : null,
      child: KPressable(
        onTap: enabled ? onTap : null,
        scale: 0.985,
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
          decoration: BoxDecoration(
            color: done ? k.brandSoft : k.surfaceAlt,
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: done ? k.brand.withValues(alpha: 0.5) : Colors.transparent, width: 1.5),
          ),
          child: Row(children: [
            SizedBox(
              width: 52,
              child: Text('${item.quantity}×', style: KraveoType.headline.copyWith(fontSize: 28, color: done ? k.brand : k.ink)),
            ),
            Expanded(
              child: Text(
                item.name,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: KraveoType.titleLg.copyWith(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: done ? k.inkMuted : k.ink,
                  decoration: done ? TextDecoration.lineThrough : null,
                ),
              ),
            ),
            const SizedBox(width: 10),
            AnimatedContainer(
              duration: KMotion.base,
              curve: KMotion.spring,
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: done ? k.brand : Colors.transparent,
                shape: BoxShape.circle,
                border: Border.all(color: done ? k.brand : k.inkFaint, width: 2.5),
              ),
              child: done ? Icon(LucideIcons.check, size: 24, color: k.onBrand) : null,
            ),
          ]),
        ),
      ),
    );
  }
}
