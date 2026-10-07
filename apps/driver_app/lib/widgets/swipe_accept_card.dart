import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_view.dart';

/// One real order from the pool (`GET /orders/available` / socket `order_available`).
///
/// Shows only what the pool view carries: restaurant, drop point, delivery fee, order size and how
/// long ago it was placed. Never a customer name or phone (the server hides them until a rider is
/// assigned). The card does not decide anything: [onAccepted] asks the server, and the parent shows
/// the job only once the server confirmed the claim.
class OfferCard extends StatelessWidget {
  final OrderView order;
  final VoidCallback onAccepted;
  final VoidCallback? onDeclined;

  /// This offer's claim request is in flight.
  final bool claiming;

  /// Another offer is being claimed: this one cannot be taken at the same time.
  final bool disabled;
  final DateTime now;

  const OfferCard({
    super.key,
    required this.order,
    required this.onAccepted,
    required this.now,
    this.onDeclined,
    this.claiming = false,
    this.disabled = false,
  });

  static String ago(DateTime? t, DateTime now) {
    if (t == null) return 'just now';
    final d = now.difference(t);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) return '${d.inHours} h ago';
    return '${d.inDays} d ago';
  }

  static String rupees(double? v) {
    if (v == null) return '–';
    return v == v.roundToDouble() ? '₹${v.toInt()}' : '₹${v.toStringAsFixed(2)}';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final group = order.group;
    final stops = group?.stops ?? const <GroupStopView>[];
    final isCombined = group != null;
    // A combined order is ready only when every kitchen is (the pool entry itself is just the first restaurant's order).
    final ready = isCombined && stops.isNotEmpty ? stops.every((s) => s.status == OrderStatus.readyForPickup) : order.status == OrderStatus.readyForPickup;
    // The pool entry of a combined order carries only the first restaurant's share of the money: show stops, not money.
    final fee = isCombined ? '${group.size} restaurants' : rupees(order.deliveryFee);
    final items = isCombined && stops.isNotEmpty ? stops.fold<int>(0, (n, s) => n + s.itemCount) : order.itemCount;
    return KCard(
      padding: const EdgeInsets.all(20),
      borderColor: k.brand.withValues(alpha: 0.55),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (isCombined) ...[
                      Text('ONE RIDER · ONE DROP', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.1)),
                      Text(order.headlineName, key: const ValueKey('combined-title'), maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.headline.copyWith(color: k.ink)),
                    ] else ...[
                      Text('DELIVERY FEE', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.1)),
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(fee, style: KraveoType.displayLg.copyWith(fontSize: 56, height: 1.05, color: k.ink)),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              _Chip(icon: ready ? LucideIcons.packageCheck : LucideIcons.chefHat, text: ready ? 'Ready' : 'Preparing'),
              if (onDeclined != null) ...[
                const SizedBox(width: 8),
                KPressable(
                  semanticLabel: 'Hide this order',
                  onTap: claiming ? null : onDeclined,
                  child: Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(color: k.surfaceAlt, shape: BoxShape.circle, border: Border.all(color: k.line)),
                    child: ExcludeSemantics(child: Icon(LucideIcons.x, size: 22, color: k.inkMuted)),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text(
            isCombined
                ? '${items > 0 ? '$items item${items == 1 ? '' : 's'} · ' : ''}Prepaid · ${ago(order.offeredAt, now)}'
                : '${items > 0 ? '$items item${items == 1 ? '' : 's'} · ' : ''}Order ${rupees(order.totalAmount)} prepaid · ${ago(order.offeredAt, now)}',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: KraveoType.bodySm.copyWith(color: k.inkMuted),
          ),
          const SizedBox(height: 16),
          if (isCombined && stops.isNotEmpty)
            for (var i = 0; i < stops.length; i++) ...[
              _Stop(
                key: ValueKey('offer-stop-${stops[i].orderId}'),
                icon: LucideIcons.store,
                color: k.brand,
                title: stops[i].name,
                note: stops[i].address ?? '',
                label: 'PICKUP ${i + 1}',
              ),
              Padding(
                padding: const EdgeInsets.only(left: 19),
                child: Container(width: 2, height: 16, color: k.line),
              ),
            ]
          else ...[
            _Stop(icon: LucideIcons.store, color: k.brand, title: order.restaurantName, note: order.vendor?.address ?? '', label: 'PICKUP'),
            Padding(
              padding: const EdgeInsets.only(left: 19),
              child: Container(width: 2, height: 16, color: k.line),
            ),
          ],
          _Stop(icon: LucideIcons.mapPin, color: KStatus.atGate.color, title: order.dropLabel, note: order.dropoffNotes ?? '', label: 'DROP'),
          const SizedBox(height: 20),
          if (claiming)
            Container(
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: k.brand.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(KRadius.pill)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: k.brand)),
                const SizedBox(width: 12),
                Flexible(child: Text('Accepting…', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.brand))),
              ]),
            )
          else if (disabled)
            const KButton(label: 'Accept with one tap', kind: KButtonKind.ghost, icon: LucideIcons.hand, onPressed: null)
          else ...[
            Semantics(
              label: isCombined ? 'Slide to accept combined order, ${group.size} restaurants' : 'Slide to accept order, delivery fee $fee',
              button: true,
              excludeSemantics: true,
              onTap: onAccepted,
              child: KSlideToConfirm(key: ValueKey('slide-${order.id}'), label: 'Slide to accept', icon: LucideIcons.arrowRight, onConfirmed: onAccepted),
            ),
            const SizedBox(height: 10),
            KButton(key: ValueKey('accept-${order.id}'), label: 'Accept with one tap', kind: KButtonKind.ghost, icon: LucideIcons.hand, onPressed: onAccepted),
          ],
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.pill), border: Border.all(color: k.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 16, color: k.inkMuted),
        const SizedBox(width: 6),
        Text(text, maxLines: 1, style: KraveoType.label.copyWith(color: k.ink, fontSize: 14)),
      ]),
    );
  }
}

class _Stop extends StatelessWidget {
  const _Stop({super.key, required this.icon, required this.color, required this.title, required this.note, required this.label});
  final IconData icon;
  final Color color;
  final String title, note, label;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
          child: Icon(icon, size: 20, color: color),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 1.2)),
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
              if (note.isNotEmpty) Text(note, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ],
          ),
        ),
      ],
    );
  }
}
