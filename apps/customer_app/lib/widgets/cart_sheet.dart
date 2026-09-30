// ignore_for_file: sort_child_properties_last
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/cart_item.dart';
import '../providers/cart_provider.dart';
import '../screens/checkout_screen.dart';
import 'coupon_box.dart';
import 'ui/add_stepper.dart';
import 'ui/bill_breakdown.dart';
import 'ui/coins_toggle.dart';
import 'ui/format.dart';
import 'ui/sheet_chrome.dart';
import 'ui/veg_mark.dart';

class CartSheet extends StatelessWidget {
  final String selectedHostel;

  const CartSheet({
    super.key,
    required this.selectedHostel,
  });

  static Future<void> show(BuildContext context, {required String selectedHostel}) {
    return showKSheet<void>(context, builder: (_) => CartSheet(selectedHostel: selectedHostel));
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final cart = Provider.of<CartProvider>(context);

    if (cart.items.isEmpty) {
      return KSheetFrame(
        title: 'Your cart',
        children: [
          KEmptyState(
            icon: LucideIcons.shoppingBag,
            title: 'Your cart is empty',
            message: 'Add a dish or two from the menu and it will show up here with a full price breakdown.',
            action: KButton(label: 'Browse the menu', kind: KButtonKind.tonal, expand: false, onPressed: () => Navigator.of(context).pop()),
          ),
        ],
      );
    }

    return KSheetFrame(
      title: cart.dhabaName ?? 'Your cart',
      subtitle: Row(children: [
        Icon(LucideIcons.mapPin, size: 14, color: k.brand),
        const SizedBox(width: 4),
        Flexible(child: Text('Delivering to $selectedHostel', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
      ]),
      children: [
        for (final cartItem in cart.items) _CartLine(cartItem: cartItem, cart: cart),
        const SizedBox(height: 4),
        const CouponBox(),
        const SizedBox(height: 16),
        CoinsToggle(cart: cart),
        const SizedBox(height: 16),
        BillBreakdown(cart: cart),
        const SizedBox(height: 4),
      ],
      footer: Column(mainAxisSize: MainAxisSize.min, children: [
        KButton(
          label: 'Checkout · ${rupee(cart.grandTotal)}',
          icon: LucideIcons.arrowRight,
          onPressed: () {
            Navigator.pop(context); // Close cart sheet
            Navigator.push(
              context,
              MaterialPageRoute(
                builder: (context) => CheckoutScreen(selectedHostel: selectedHostel),
              ),
            );
          },
        ),
        const SizedBox(height: 8),
        Text('Next: choose how to pay. You get your gate OTP right after.', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12)),
      ]),
    );
  }
}

class _CartLine extends StatelessWidget {
  const _CartLine({required this.cartItem, required this.cart});

  final CartItem cartItem;
  final CartProvider cart;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 3), child: VegMark(isVeg: cartItem.item.isVeg)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(cartItem.item.name, style: KraveoType.titleMd.copyWith(color: k.ink)),
            if (cartItem.selectedOptions.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(cartItem.customizationSummary, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ],
            if (cartItem.specialInstructions != null) ...[
              const SizedBox(height: 2),
              Text('Note: "${cartItem.specialInstructions}"', style: KraveoType.bodySm.copyWith(color: k.brand, fontStyle: FontStyle.italic)),
            ],
            const SizedBox(height: 4),
            Text(rupee(cartItem.totalPrice), style: KraveoType.numericSm.copyWith(color: k.ink, fontSize: 19)),
          ]),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 112,
          child: KAddButton(
            quantity: cartItem.quantity,
            itemName: cartItem.item.name,
            onAdd: () => cart.incrementItem(cartItem.cartItemId),
            onRemove: () => cart.decrementItem(cartItem.cartItemId),
          ),
        ),
      ]),
    );
  }
}
