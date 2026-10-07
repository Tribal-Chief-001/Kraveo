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
import 'ui/k_icon_button.dart';
import 'ui/sheet_chrome.dart';
import 'ui/snack.dart';
import 'ui/veg_mark.dart';

class CartSheet extends StatelessWidget {
  /// Saved drop-off point; null when the student has not chosen one (checkout asks).
  final String? selectedHostel;

  const CartSheet({
    super.key,
    required this.selectedHostel,
  });

  static Future<void> show(BuildContext context, {required String? selectedHostel}) {
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

    final multi = cart.isMultiRestaurant;
    return KSheetFrame(
      title: multi ? 'Your cart' : (cart.dhabaName ?? 'Your cart'),
      subtitle: Row(children: [
        Icon(LucideIcons.mapPin, size: 14, color: k.brand),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            multi
                ? '${cart.restaurantCount} restaurants · ${selectedHostel == null ? 'drop-off at checkout' : 'to $selectedHostel'}'
                : (selectedHostel == null ? 'Choose your drop-off point at checkout' : 'Delivering to $selectedHostel'),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: KraveoType.bodySm.copyWith(color: k.inkMuted),
          ),
        ),
      ]),
      children: [
        if (multi) ...[
          Text('One rider brings everything to the gate, with one OTP. Each extra restaurant adds a small fee.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 14),
          for (final r in cart.restaurants) ...[
            _RestaurantHeader(restaurant: r, cart: cart),
            for (final cartItem in r.items) _CartLine(cartItem: cartItem, cart: cart),
          ],
          KButton(
            label: 'Clear cart',
            icon: LucideIcons.trash2,
            kind: KButtonKind.ghost,
            onPressed: () => _confirmClear(context, cart),
          ),
        ] else
          for (final cartItem in cart.items) _CartLine(cartItem: cartItem, cart: cart),
        const SizedBox(height: 4),
        const CouponBox(),
        const SizedBox(height: 16),
        CoinsBalance(cart: cart),
        const SizedBox(height: 16),
        BillBreakdown.cart(cart: cart),
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

Future<void> _confirmClear(BuildContext context, CartProvider cart) async {
  final ok = await showKConfirm(
    context,
    title: 'Clear your cart?',
    message: 'This removes the dishes from all ${cart.restaurantCount} restaurants.',
    confirmLabel: 'Clear cart',
    cancelLabel: 'Keep it',
    danger: true,
  );
  if (ok == true) cart.clearCart();
}

/// Restaurant heading inside a combined cart: name, what it adds up to, and a way to drop just
/// this restaurant.
class _RestaurantHeader extends StatelessWidget {
  const _RestaurantHeader({required this.restaurant, required this.cart});

  final CartRestaurant restaurant;
  final CartProvider cart;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
        decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.md)),
        child: Row(children: [
          Icon(LucideIcons.store, size: 18, color: k.brand),
          const SizedBox(width: 10),
          Expanded(
            child: Semantics(
              container: true,
              label: '${restaurant.name}, ${restaurant.itemCount} ${restaurant.itemCount == 1 ? 'item' : 'items'}, ${rupee(restaurant.subtotal)}',
              child: ExcludeSemantics(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(restaurant.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink)),
                  Text('${restaurant.itemCount} ${restaurant.itemCount == 1 ? 'item' : 'items'} · ${rupee(restaurant.subtotal)}', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                ]),
              ),
            ),
          ),
          const SizedBox(width: 6),
          KIconButton(
            icon: LucideIcons.trash2,
            semanticLabel: 'Remove ${restaurant.name} from your cart',
            background: k.surface,
            bordered: false,
            onTap: () async {
              final ok = await showKConfirm(
                context,
                title: 'Remove ${restaurant.name}?',
                message: 'This removes its ${restaurant.itemCount} ${restaurant.itemCount == 1 ? 'item' : 'items'} from your cart. Your other restaurants stay.',
                confirmLabel: 'Remove',
                cancelLabel: 'Keep it',
                danger: true,
              );
              if (ok == true) cart.removeRestaurant(restaurant.id);
            },
          ),
        ]),
      ),
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
            // Visible inside the sheet (a snackbar would sit behind it).
            if (!cart.canAddMore(cartItem.item.id)) ...[
              const SizedBox(height: 4),
              Text('Maximum ${CartProvider.maxQuantityPerDish} of one dish', style: KraveoType.caption.copyWith(color: k.inkMuted)),
            ],
          ]),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 112,
          child: KAddButton(
            quantity: cartItem.quantity,
            itemName: cartItem.item.name,
            onAdd: () {
              if (!cart.incrementItem(cartItem.cartItemId)) showKSnack(context, CartProvider.maxQuantityMessage, icon: LucideIcons.info);
            },
            onRemove: () => cart.decrementItem(cartItem.cartItemId),
          ),
        ),
      ]),
    );
  }
}
