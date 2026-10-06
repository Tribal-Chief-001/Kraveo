import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import 'ui/format.dart';

/// Coupon entry: an applied "ticket" when a code is active, otherwise a code field with a one-tap suggestion.
class CouponBox extends StatefulWidget {
  const CouponBox({super.key});

  @override
  State<CouponBox> createState() => _CouponBoxState();
}

class _CouponBoxState extends State<CouponBox> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final cart = Provider.of<CartProvider>(context);

    return AnimatedSwitcher(
      duration: KMotion.base,
      switchInCurve: KMotion.emphasized,
      transitionBuilder: (child, anim) => FadeTransition(opacity: anim, child: SizeTransition(sizeFactor: anim, alignment: Alignment.topCenter, child: child)),
      child: cart.appliedCouponCode != null ? _applied(context, cart, k) : _entry(context, cart, k),
    );
  }

  Widget _applied(BuildContext context, CartProvider cart, KraveoTokens k) {
    return Container(
      key: const ValueKey('coupon-applied'),
      padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
      decoration: BoxDecoration(
        color: k.brandSoft,
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: k.brand.withValues(alpha: 0.4), width: 1.2),
      ),
      child: Row(children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: k.brand, shape: BoxShape.circle),
          child: Icon(LucideIcons.ticketCheck, size: 20, color: k.onBrand),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${cart.appliedCouponCode} applied', style: KraveoType.titleMd.copyWith(color: k.brand)),
            Text('You save ${rupee(cart.couponDiscountAmount)} on this order.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
        KPressable(
          semanticLabel: 'Remove coupon ${cart.appliedCouponCode}',
          onTap: () {
            cart.removeCoupon();
            _controller.clear();
          },
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Text('Remove', style: KraveoType.label.copyWith(color: kDangerInk, fontSize: 13)),
          ),
        ),
      ]),
    );
  }

  Widget _entry(BuildContext context, CartProvider cart, KraveoTokens k) {
    return Column(
      key: const ValueKey('coupon-entry'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          Icon(LucideIcons.ticket, size: 18, color: k.brand),
          const SizedBox(width: 8),
          Text('Have a coupon?', style: KraveoType.titleMd.copyWith(color: k.ink)),
        ]),
        const SizedBox(height: 10),
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(
            child: TextField(
              controller: _controller,
              textCapitalization: TextCapitalization.characters,
              textInputAction: TextInputAction.done,
              onSubmitted: cart.applyCoupon,
              decoration: const InputDecoration(hintText: 'Enter code'),
            ),
          ),
          const SizedBox(width: 10),
          KButton(label: 'Apply', kind: KButtonKind.tonal, expand: false, onPressed: () => cart.applyCoupon(_controller.text)),
        ]),
        if (cart.couponError != null) ...[
          const SizedBox(height: 8),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 15, color: kDangerInk)),
            const SizedBox(width: 6),
            Expanded(child: Text(cart.couponError!, style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600))),
          ]),
        ],
        if (context.select<OrderProvider, bool>((o) => o.isFirstTimeCustomer)) ...[
        const SizedBox(height: 10),
        KPressable(
          semanticLabel: 'Apply coupon VITFIRST',
          onTap: () {
            _controller.text = 'VITFIRST';
            cart.applyCoupon('VITFIRST');
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.pill)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(LucideIcons.sparkles, size: 15, color: k.brand),
              const SizedBox(width: 6),
              Flexible(
                child: Text('Try VITFIRST: 20% off your first order', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.ink, fontSize: 12.5)),
              ),
            ]),
          ),
        ),
        ],
      ],
    );
  }
}
