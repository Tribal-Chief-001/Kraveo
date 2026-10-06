import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_model.dart';
import 'ui/ui.dart';

/// "Order #ABC123 was cancelled by Kraveo. Stop cooking." The kitchen was already working on this order; the cook must
/// not miss that it will not be collected. One big button; shown until the cook taps it.
Future<void> showKitchenOrderCancelledNotice(BuildContext context, OrderModel order) {
  return showKSheet<void>(
    context,
    builder: (ctx) {
      final k = ctx.k;
      return SingleChildScrollView(
        key: ValueKey('cancelled-notice-${order.id}'),
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 76,
            height: 76,
            decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.12), shape: BoxShape.circle),
            child: Icon(LucideIcons.octagonX, size: 38, color: kDangerDeep),
          ),
          const SizedBox(height: 16),
          Text('Order ${order.shortCode} was cancelled by Kraveo. Stop cooking.', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          const SizedBox(height: 6),
          Text('ऑर्डर ${order.shortCode} Kraveo ने रद्द कर दिया। बनाना बंद करें।', textAlign: TextAlign.center, style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
          if (order.cancelReason != null && order.cancelReason!.trim().isNotEmpty) ...[
            const SizedBox(height: 10),
            Text('Reason: ${order.cancelReason}', textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
          ],
          const SizedBox(height: 24),
          KButton(
            key: const ValueKey('cancelled-notice-ok'),
            label: 'OK, stopped',
            sublabel: 'ठीक है, बंद किया',
            icon: LucideIcons.check,
            large: true,
            onPressed: () => Navigator.of(ctx).pop(),
          ),
        ]),
      );
    },
  );
}
