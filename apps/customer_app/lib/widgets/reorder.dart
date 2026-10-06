import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';
import '../screens/dhaba_menu_screen.dart';
import 'cart_sheet.dart';
import 'ui/sheet_chrome.dart';
import 'ui/snack.dart';

/// "Reorder" / "Order again": rebuilds the cart from the dishes of [order] that are still on the
/// kitchen's live menu (by menu item id) and opens it. Dishes that are gone or sold out are
/// skipped and the student is told.
///
/// The kitchen is looked up in the full catalog (never in Home's filtered list), and a cart that
/// already holds something is only replaced after the student confirms.
/// [selectedHostel] is the drop-off the cart sheet shows; it falls back to the old order's.
Future<void> reorderOrder(BuildContext context, OrderModel order, {String? selectedHostel}) async {
  final cart = context.read<CartProvider>();
  final dhabas = context.read<DhabaProvider>();
  final kitchen = dhabas.byId(order.vendorId);
  final menu = {for (final m in dhabas.getMenuItemsForDhaba(order.vendorId)) m.id: m};
  final hostel = selectedHostel ?? order.dropoffHostel;
  if (kitchen == null || !dhabas.isLiveVendor(order.vendorId)) {
    showKSnack(context, '${order.vendorName} isn\'t taking orders in the app right now.', error: true);
    return;
  }
  if (cart.items.isNotEmpty) {
    final replace = await showKConfirm(
      context,
      title: 'Replace your cart?',
      message: 'Your cart has ${cart.itemCount} ${cart.itemCount == 1 ? 'item' : 'items'} from ${cart.dhabaName ?? 'another kitchen'}. Reordering replaces them with the dishes from this order.',
      confirmLabel: 'Replace cart',
      cancelLabel: 'Keep my cart',
    );
    if (replace != true || !context.mounted) return;
  }
  var added = 0;
  var skipped = 0;
  cart.clearCart();
  for (final line in order.items) {
    final item = menu[line.menuItemId];
    if (item == null || !item.isAvailable) {
      skipped++;
      continue;
    }
    for (var i = 0; i < line.quantity; i++) {
      if (!cart.addItem(item: item, dhabaId: order.vendorId, dhabaName: kitchen.name)) break;
    }
    added++;
  }
  if (added > 0) {
    if (skipped > 0) showKSnack(context, '$skipped ${skipped == 1 ? 'dish is' : 'dishes are'} no longer available and ${skipped == 1 ? 'was' : 'were'} left out.', icon: LucideIcons.info);
    CartSheet.show(context, selectedHostel: hostel);
    return;
  }
  showKSnack(context, 'These dishes aren\'t available now. Pick something from ${order.vendorName}.', icon: LucideIcons.utensils);
  Navigator.push(context, MaterialPageRoute(builder: (_) => DhabaMenuScreen(dhaba: kitchen, selectedHostel: hostel)));
}
