import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../models/order.dart';
import '../../models/order_group.dart';
import '../../providers/cart_provider.dart';
import 'format.dart';
import 'money_text.dart';

/// Transparent bill: every line that moves the total, then a bold "To pay".
/// Built from the server's order ([BillBreakdown.order], authoritative), from the server's price
/// quote ([BillBreakdown.quote], what placing the cart will charge) or from the cart
/// ([BillBreakdown.cart], a local estimate shown while there is no quote).
///
/// A combined order (Docs/22) adds an "Extra restaurant fee (x N)" line after the delivery fee.
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
    this.extraRestaurantFee = 0,
    this.extraRestaurants = 0,
    this.loading = false,
    this.problem,
    this.onRetry,
  });

  /// The local estimate. [loading] says the server's price is on its way, [problem] is the
  /// server's reason when it refused the cart, [onRetry] asks again after a failure.
  factory BillBreakdown.cart({Key? key, required CartProvider cart, bool loading = false, String? problem, VoidCallback? onRetry}) => BillBreakdown(
        key: key,
        subtotal: cart.subtotal,
        deliveryFee: cart.baseDeliveryFee,
        taxAndPackaging: cart.taxAndPackaging,
        extraRestaurantFee: cart.extraRestaurantFees,
        extraRestaurants: cart.restaurantCount > 1 ? cart.restaurantCount - 1 : 0,
        discount: cart.appliedCouponCode != null ? cart.couponDiscountAmount : 0,
        couponCode: cart.appliedCouponCode,
        total: cart.grandTotal,
        estimate: true,
        loading: loading,
        problem: problem,
        onRetry: onRetry,
      );

  /// The server's price for the cart (`POST /orders/quote`).
  factory BillBreakdown.quote({Key? key, required OrderQuote quote}) => BillBreakdown(
        key: key,
        subtotal: quote.subtotal,
        deliveryFee: quote.baseFee,
        taxAndPackaging: 0,
        extraRestaurantFee: quote.extraTotal,
        extraRestaurants: quote.extraRestaurants,
        discount: quote.discount,
        couponCode: quote.couponCode,
        total: quote.total,
      );

  /// The server's order. A combined order is the composite of its parts: the primary part carries
  /// the base fee, every other part the flat extra-restaurant fee.
  factory BillBreakdown.order({Key? key, required OrderModel order, String? couponCode}) {
    final parts = order.members;
    final combined = parts != null && parts.length > 1;
    final base = combined ? parts.first.deliveryFee + parts.first.taxAndPackaging : order.deliveryFee;
    final extra = combined ? order.deliveryFee + order.taxAndPackaging - base : 0.0;
    return BillBreakdown(
      key: key,
      subtotal: order.subtotal,
      deliveryFee: combined ? base : order.deliveryFee,
      taxAndPackaging: combined ? 0 : order.taxAndPackaging,
      extraRestaurantFee: extra,
      extraRestaurants: combined ? parts.length - 1 : 0,
      discount: order.discount,
      couponCode: couponCode,
      total: order.totalAmount,
    );
  }

  final double subtotal;
  final double deliveryFee;
  final double taxAndPackaging;
  final double discount;
  final double total;
  final String? couponCode;

  /// True for the local cart estimate (labelled as such).
  final bool estimate;

  /// All extra restaurants' fees together, and how many there are (0 = one restaurant: no line).
  final double extraRestaurantFee;
  final int extraRestaurants;

  /// The server's price is being fetched (the estimate is shown meanwhile).
  final bool loading;

  /// The server's reason why it could not price this cart.
  final String? problem;
  final VoidCallback? onRetry;

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
        if (extraRestaurants > 0) _Row('Extra restaurant fee (x $extraRestaurants)', rupee(extraRestaurantFee)),
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
          Text(
            loading ? 'Estimate. Kraveo is working out the exact price...' : 'Estimate. Kraveo confirms the final amount when you place the order.',
            style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12),
          ),
          if (onRetry != null && !loading) ...[
            const SizedBox(height: 4),
            KPressable(
              onTap: onRetry,
              semanticLabel: 'Get the exact price again',
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text('Get the exact price', style: KraveoType.label.copyWith(color: k.brand, fontSize: 13))),
            ),
          ],
        ],
        if (problem != null) ...[
          const SizedBox(height: 10),
          Semantics(
            liveRegion: true,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(LucideIcons.circleAlert, size: 16, color: kDangerInk),
              const SizedBox(width: 8),
              Expanded(child: Text(problem!, style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600))),
            ]),
          ),
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
