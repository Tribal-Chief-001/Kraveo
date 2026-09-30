import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../providers/cart_provider.dart';
import 'format.dart';

/// Transparent bill: every line that moves the total, then a bold "To pay".
class BillBreakdown extends StatelessWidget {
  const BillBreakdown({super.key, required this.cart});

  final CartProvider cart;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final savings = (cart.appliedCouponCode != null ? cart.couponDiscountAmount : 0) + (cart.isKraveoCoinsRedeemed ? cart.kraveoCoinsDiscountAmount : 0);
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: BorderRadius.circular(KRadius.xl),
        border: Border.all(color: k.line.withValues(alpha: 0.7)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Bill details', style: KraveoType.titleMd.copyWith(color: k.ink)),
        const SizedBox(height: 12),
        _Row('Items subtotal', rupee(cart.subtotal)),
        _Row('Delivery to your gate', rupee(cart.deliveryFee)),
        _Row('Packaging & taxes', rupee(cart.taxAndPackaging)),
        if (cart.appliedCouponCode != null) _Row('Coupon (${cart.appliedCouponCode})', '-${rupee(cart.couponDiscountAmount)}', discount: true),
        if (cart.isKraveoCoinsRedeemed) _Row('Kraveo Coins', '-${rupee(cart.kraveoCoinsDiscountAmount)}', discount: true),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Divider(height: 1, color: k.line),
        ),
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(child: Text('To pay', style: KraveoType.titleLg.copyWith(color: k.ink))),
          KAnimatedNumber(value: cart.grandTotal, prefix: '₹', style: KraveoType.numeric.copyWith(color: k.ink, fontSize: 30)),
        ]),
        if (savings > 0) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.sm)),
            child: Row(children: [
              Icon(LucideIcons.sparkles, size: 16, color: k.brand),
              const SizedBox(width: 8),
              Expanded(child: Text('You are saving ${rupee(savings)} on this order', style: KraveoType.bodySm.copyWith(color: k.brand, fontWeight: FontWeight.w700))),
            ]),
          ),
        ],
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {this.discount = false});

  final String label;
  final String value;
  final bool discount;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final color = discount ? k.brand : k.inkMuted;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Expanded(child: Text(label, style: KraveoType.body.copyWith(color: color, fontSize: 14))),
        const SizedBox(width: 12),
        Text(value, style: KraveoType.body.copyWith(color: discount ? k.brand : k.ink, fontWeight: FontWeight.w700, fontSize: 14)),
      ]),
    );
  }
}
