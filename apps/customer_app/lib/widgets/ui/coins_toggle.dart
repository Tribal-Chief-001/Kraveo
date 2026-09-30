import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../providers/cart_provider.dart';
import 'format.dart';

/// Kraveo Coins redeem row (50 coins = flat discount). Uses the cart provider's existing redeem logic.
class CoinsToggle extends StatelessWidget {
  const CoinsToggle({super.key, required this.cart});

  final CartProvider cart;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final redeemed = cart.isKraveoCoinsRedeemed;
    final canRedeem = cart.userKraveoCoins >= 50;
    final off = redeemed ? cart.kraveoCoinsDiscountAmount : 20;
    return AnimatedContainer(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
      decoration: BoxDecoration(
        color: redeemed ? k.brandSoft : k.surface,
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: redeemed ? k.brand.withValues(alpha: 0.5) : k.line, width: 1.2),
      ),
      child: Row(children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(color: redeemed ? k.brand : k.brandSoft, shape: BoxShape.circle),
          child: Icon(LucideIcons.coins, size: 20, color: redeemed ? k.onBrand : k.brand),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Kraveo Coins · ${cart.userKraveoCoins}', style: KraveoType.titleMd.copyWith(color: k.ink)),
            const SizedBox(height: 2),
            Text(
              canRedeem || redeemed ? 'Use 50 coins to save ${rupee(off)} on this order.' : 'Earn 50 coins to unlock ${rupee(20)} off. Rate an order to get 10.',
              style: KraveoType.bodySm.copyWith(color: k.inkMuted),
            ),
          ]),
        ),
        Semantics(
          label: 'Redeem Kraveo Coins',
          toggled: redeemed,
          child: Switch(
            value: redeemed,
            onChanged: canRedeem || redeemed
                ? (_) {
                    HapticFeedback.selectionClick();
                    cart.toggleKraveoCoinsRedemption();
                  }
                : null,
          ),
        ),
      ]),
    );
  }
}
