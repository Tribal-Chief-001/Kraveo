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
/// A combined order (several restaurants) puts every restaurant's dishes back: restaurants that
/// are closed or not in the app are left out (and named), and so are restaurants beyond the most
/// one order may hold ([CartProvider.maxRestaurants]).
///
/// The kitchen is looked up in the full catalog (never in Home's filtered list), and a cart that
/// already holds something is only replaced after the student confirms.
/// [selectedHostel] is the drop-off the cart sheet shows; it falls back to the old order's.
Future<void> reorderOrder(BuildContext context, OrderModel order, {String? selectedHostel}) async {
  final cart = context.read<CartProvider>();
  final dhabas = context.read<DhabaProvider>();
  final hostel = selectedHostel ?? order.dropoffHostel;
  // Each restaurant's part of the order (a single order is its own only part).
  final parts = order.members != null && order.members!.length > 1 ? order.members! : [order];
  final combined = parts.length > 1;
  final live = [for (final p in parts) if (dhabas.byId(p.vendorId) != null && dhabas.isLiveVendor(p.vendorId)) p];
  if (live.isEmpty) {
    showKSnack(context, combined ? 'None of these restaurants is taking orders in the app right now.' : '${order.vendorName} isn\'t taking orders in the app right now.', error: true);
    return;
  }
  if (cart.items.isNotEmpty) {
    final replace = await showKConfirm(
      context,
      title: 'Replace your cart?',
      message: 'Your cart has ${cart.itemCount} ${cart.itemCount == 1 ? 'item' : 'items'} from ${cart.restaurantCount > 1 ? '${cart.restaurantCount} restaurants' : (cart.dhabaName ?? 'another kitchen')}. Reordering replaces them with the dishes from this order.',
      confirmLabel: 'Replace cart',
      cancelLabel: 'Keep my cart',
    );
    if (replace != true || !context.mounted) return;
  }
  var added = 0;
  var skipped = 0;
  final leftOut = <String>[]; // restaurants that could not be put back
  cart.clearCart();
  for (final part in parts) {
    final kitchen = dhabas.byId(part.vendorId);
    if (kitchen == null || !dhabas.isLiveVendor(part.vendorId)) {
      leftOut.add(part.vendorName);
      continue;
    }
    if (!cart.canAddRestaurant(part.vendorId)) {
      leftOut.add(part.vendorName); // more restaurants than one order may hold
      continue;
    }
    final menu = {for (final m in dhabas.getMenuItemsForDhaba(part.vendorId)) m.id: m};
    var addedHere = 0;
    for (final line in part.items) {
      final item = menu[line.menuItemId];
      if (item == null || !item.isAvailable) {
        skipped++;
        continue;
      }
      for (var i = 0; i < line.quantity; i++) {
        if (!cart.addItem(item: item, dhabaId: part.vendorId, dhabaName: kitchen.name)) break;
      }
      addedHere++;
    }
    if (addedHere == 0) leftOut.add(part.vendorName);
    added += addedHere;
  }
  if (added > 0) {
    if (skipped > 0) showKSnack(context, '$skipped ${skipped == 1 ? 'dish is' : 'dishes are'} no longer available and ${skipped == 1 ? 'was' : 'were'} left out.', icon: LucideIcons.info);
    if (combined && leftOut.isNotEmpty) {
      showKSnack(context, '${leftOut.join(', ')} ${leftOut.length == 1 ? 'was' : 'were'} left out: closed, unavailable or over the limit of ${cart.maxRestaurants} restaurants per order.', icon: LucideIcons.info);
    }
    CartSheet.show(context, selectedHostel: hostel);
    return;
  }
  final kitchen = dhabas.byId(live.first.vendorId);
  showKSnack(context, 'These dishes aren\'t available now. Pick something from ${live.first.vendorName}.', icon: LucideIcons.utensils);
  if (kitchen != null) Navigator.push(context, MaterialPageRoute(builder: (_) => DhabaMenuScreen(dhaba: kitchen, selectedHostel: hostel)));
}
