import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../services/vendor_api_service.dart';
import 'ui/ui.dart';

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

  String _mmss(Duration d) {
    final mins = d.inMinutes.toString().padLeft(2, '0');
    final secs = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$mins:$secs';
  }

  /// green -> amber -> red as the promised time drains away.
  Color _urgencyColor(double progress, bool late) {
    if (late || progress < 0.15) return KraveoPalette.danger;
    if (progress < 0.4) return KraveoPalette.warning;
    return KraveoPalette.success;
  }

  void _markReady() {
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
  }

  Future<void> _handOver() async {
    final ok = await showConfirmSheet(
      context,
      icon: LucideIcons.bike,
      title: 'Hand over to runner?',
      hindiTitle: 'क्या रनर को दे दिया?',
      message: 'Order ${widget.order.id} will move to History.',
      safeLabel: 'Not yet',
      safeSublabel: 'अभी नहीं',
      confirmLabel: 'Yes, handed over',
      confirmSublabel: 'हाँ, दे दिया',
      destructive: false,
    );
    if (!ok || !mounted) return;
    setState(() {
      widget.order.status = OrderStatus.pickedUp;
    });
    VendorApiService.updateOrderStatus(
      widget.order.id.replaceAll('#', ''),
      'PICKED_UP',
    );
    widget.onStatusChanged();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final order = widget.order;
    final isPreparing = order.status == OrderStatus.preparing;
    final isReady = order.status == OrderStatus.readyForPickup;
    final isPickedUp = order.status == OrderStatus.pickedUp || order.status == OrderStatus.delivered;

    final isLate = _remaining.isNegative && isPreparing;
    final totalSecs = (order.prepTimeMinutes * 60).clamp(1, 1 << 30);
    final progress = (_remaining.inSeconds / totalSecs).clamp(0.0, 1.0);
    final urgency = _urgencyColor(progress, isLate);

    final ringColor = isPreparing ? urgency : (isReady ? KStatus.ready.color : k.line);
    final borderColor = isPreparing ? urgency : (isReady ? KStatus.ready.color : k.line);

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: KRadius.card,
        border: Border.all(color: borderColor, width: isPickedUp ? 1.5 : 2.5),
        boxShadow: KShadow.soft(k.shadowTint),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header: countdown ring + order number + who/where + status
          Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            Semantics(
              label: isPreparing
                  ? (isLate ? 'Late' : '${_remaining.inMinutes} minutes left')
                  : isReady
                      ? 'Ready for pickup'
                      : 'Picked up',
              excludeSemantics: true,
              child: VCountdownRing(
                size: 98,
                progress: isPreparing ? progress : (isReady ? 1 : 0),
                color: ringColor,
                child: _ringCenter(k, isPreparing: isPreparing, isReady: isReady, isLate: isLate),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(order.id, style: KraveoType.headline.copyWith(color: k.ink)),
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
                  KStatusPill(
                    status: isPreparing ? KStatus.preparing : (isReady ? KStatus.ready : KStatus.pickedUp),
                    label: isPreparing ? 'Cooking' : (isReady ? 'Ready' : 'Picked up'),
                  ),
                  Text(isPreparing ? 'बन रहा है' : (isReady ? 'तैयार' : 'सुपुर्द'), style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
                  Text(formatRupees(order.totalAmount), style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
                ]),
              ]),
            ),
          ]),

          const SizedBox(height: 16),

          // Items: big rows, tap to tick off
          for (final item in order.items)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _ItemRow(
                item: item,
                enabled: !isPickedUp,
                onTap: () {
                  setState(() {
                    item.isPrepared = !item.isPrepared;
                  });
                  widget.onItemToggle();
                },
              ),
            ),

          if (order.customerNote != null && order.customerNote!.isNotEmpty) ...[
            const SizedBox(height: 4),
            VNoteCallout(note: order.customerNote!, compact: true),
          ],

          const SizedBox(height: 14),

          // ONE obvious action for this state
          if (isPreparing)
            KButton(
              label: 'Mark ready',
              sublabel: 'तैयार है',
              icon: LucideIcons.circleCheck,
              large: true,
              onPressed: _markReady,
            )
          else if (isReady)
            KButton(
              label: 'Hand over to runner',
              sublabel: 'सुपुर्द किया',
              icon: LucideIcons.bike,
              large: true,
              onPressed: _handOver,
            )
          else
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(minHeight: 64),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.check, size: 22, color: k.inkMuted),
                const SizedBox(width: 10),
                Flexible(
                  child: Text('Picked up by runner · सुपुर्द हो चुका है', textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
                ),
              ]),
            ),
        ],
      ),
    );
  }

  Widget _ringCenter(KraveoTokens k, {required bool isPreparing, required bool isReady, required bool isLate}) {
    if (isPreparing && isLate) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        FittedBox(fit: BoxFit.scaleDown, child: Text('LATE', style: KraveoType.headlineSm.copyWith(color: kDangerDeep, fontSize: 20))),
        FittedBox(fit: BoxFit.scaleDown, child: Text('देर', style: KraveoType.caption.copyWith(color: kDangerDeep, fontSize: 13))),
      ]);
    }
    if (isPreparing) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        FittedBox(fit: BoxFit.scaleDown, child: Text(_mmss(_remaining), style: KraveoType.headlineSm.copyWith(color: k.ink, fontSize: 22))),
        FittedBox(fit: BoxFit.scaleDown, child: Text('min left', style: KraveoType.caption.copyWith(color: k.inkMuted, fontSize: 11))),
      ]);
    }
    return Icon(isReady ? LucideIcons.bellRing : LucideIcons.check, size: 34, color: isReady ? k.brand : k.inkFaint);
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({required this.item, required this.enabled, required this.onTap});
  final OrderItem item;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final done = item.isPrepared;
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
