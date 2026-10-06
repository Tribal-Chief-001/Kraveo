import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../models/order.dart';
import '../../providers/cart_provider.dart';
import 'format.dart';
import 'money_text.dart';

/// Transparent bill: every line that moves the total, then a bold "To pay".
/// Built either from the server's order ([BillBreakdown.order], authoritative) or from the cart
/// ([BillBreakdown.cart], an estimate before the order exists).
class BillBreakdown extends StatelessWidget {
  const BillBreakdown({
    super.key,
    required this.subtotal,
    required this.deliveryFee,
    required this.taxAndPackaging,
    required this.discount,
    required this.total,
    this.couponCode,
    this.estimate = false,
  });

  factory BillBreakdown.cart({Key? key, required CartProvider cart}) => BillBreakdown(
        key: key,
        subtotal: cart.subtotal,
        deliveryFee: cart.deliveryFee,
        taxAndPackaging: cart.taxAndPackaging,
        discount: cart.appliedCouponCode != null ? cart.couponDiscountAmount : 0,
        couponCode: cart.appliedCouponCode,
        total: cart.grandTotal,
        estimate: true,
      );

  factory BillBreakdown.order({Key? key, required OrderModel order, String? couponCode}) => BillBreakdown(
        key: key,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        taxAndPackaging: order.taxAndPackaging,
        discount: order.discount,
        couponCode: couponCode,
        total: order.totalAmount,
      );

  final double subtotal;
  final double deliveryFee;
  final double taxAndPackaging;
  final double discount;
  final double total;
  final String? couponCode;

  /// True for the local cart estimate (labelled as such).
  final bool estimate;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
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
        _Row('Items subtotal', rupee(subtotal)),
        // One all-in line (older orders may still carry a separate packaging amount: it is folded in, never hidden).
        _Row('Delivery & service fee', rupee(deliveryFee + taxAndPackaging)),
        if (discount > 0) _Row(couponCode != null ? 'Coupon ($couponCode)' : 'Discount', '-${rupee(discount)}', discount: true),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Divider(height: 1, color: k.line),
        ),
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(child: Text('To pay', style: KraveoType.titleLg.copyWith(color: k.ink))),
          KMoneyText(value: total, style: KraveoType.numeric.copyWith(color: k.ink, fontSize: 30)),
        ]),
        if (estimate) ...[
          const SizedBox(height: 6),
          Text('Estimate. Kraveo confirms the final amount when you place the order.', style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12)),
        ],
        if (discount > 0) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.sm)),
            child: Row(children: [
              Icon(LucideIcons.sparkles, size: 16, color: k.brand),
              const SizedBox(width: 8),
              Expanded(child: Text('You are saving ${rupee(discount)} on this order', style: KraveoType.bodySm.copyWith(color: k.brand, fontWeight: FontWeight.w700))),
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
