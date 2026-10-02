import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../providers/cart_provider.dart';

/// Kraveo Coins balance. Read-only: the order API has no way to redeem coins yet, so offering a
/// coin discount here would show a total that the server never charges.
class CoinsBalance extends StatelessWidget {
  const CoinsBalance({super.key, required this.cart});

  final CartProvider cart;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: k.line, width: 1.2),
      ),
      child: Row(children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
          child: Icon(LucideIcons.coins, size: 20, color: k.brand),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Kraveo Coins · ${cart.userKraveoCoins}', style: KraveoType.titleMd.copyWith(color: k.ink)),
            const SizedBox(height: 2),
            Text('Paying with coins is coming soon. Rate delivered orders to collect more.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
      ]),
    );
  }
}
