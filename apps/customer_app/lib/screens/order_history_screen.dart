import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/dhaba_provider.dart';
import '../providers/order_provider.dart';
import '../widgets/cart_sheet.dart';
import '../widgets/review_modal.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/scroll_empty.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/status_map.dart';
import 'dhaba_menu_screen.dart';

class OrderHistoryScreen extends StatelessWidget {
  const OrderHistoryScreen({
    super.key,
    this.selectedHostel,
    this.onTrackOrder,
    this.onExplore,
  });

  /// Drop-off used when a reorder opens the cart. Falls back to the past order's hostel.
  final String? selectedHostel;

  /// Switches to the tracking tab for an order that is still in progress.
  final VoidCallback? onTrackOrder;

  /// Switches to the home tab from the empty state.
  final VoidCallback? onExplore;

  static const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  static String _when(DateTime d) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final diff = today.difference(day).inDays;
    final hour = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final time = '$hour:${d.minute.toString().padLeft(2, '0')} ${d.hour >= 12 ? 'PM' : 'AM'}';
    if (diff == 0) return 'Today, $time';
    if (diff == 1) return 'Yesterday, $time';
    return '${d.day} ${_months[d.month - 1]}, $time';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final orderProvider = Provider.of<OrderProvider>(context);
    final cart = Provider.of<CartProvider>(context, listen: false);
    final dhabaProvider = Provider.of<DhabaProvider>(context, listen: false);
    final history = orderProvider.orderHistory;
    final bottomInset = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        toolbarHeight: 68,
        titleSpacing: KSpace.gutter,
        title: const Text('Your orders'),
      ),
      body: history.isEmpty
          ? KEmptyScroll(
              bottomInset: bottomInset,
              child: KEmptyState(
                icon: LucideIcons.receipt,
                title: 'No orders yet',
                message: 'Your first order will show up here, ready to reorder in one tap.',
                action: onExplore == null ? null : KButton(label: 'Find something tasty', icon: LucideIcons.utensils, kind: KButtonKind.tonal, expand: false, onPressed: onExplore),
              ),
            )
          : ListView.builder(
              padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, bottomInset + 24),
              itemCount: history.length,
              itemBuilder: (context, index) {
                final order = history[index];
                return KReveal(
                  key: ValueKey(order.id),
                  index: index,
                  child: _OrderCard(
                    order: order,
                    whenLabel: _when(order.createdAt),
                    onTrack: onTrackOrder,
                    onReorder: () => _reorder(context, order, orderProvider, cart, dhabaProvider),
                    onRate: () => ReviewModal.show(
                      context,
                      orderId: order.id,
                      dhabaName: order.dhabaName,
                      driverName: order.riderName,
                      dishNames: order.items.map((i) => i.item.name).toList(),
                      onReviewSubmitted: (coins) => cart.addKraveoCoins(coins),
                    ),
                  ),
                );
              },
            ),
    );
  }

  void _reorder(BuildContext context, OrderModel order, OrderProvider orderProvider, CartProvider cart, DhabaProvider dhabaProvider) {
    orderProvider.reorder(order, cart, dhabaProvider);
    final hostel = selectedHostel ?? order.hostel;
    if (cart.items.isNotEmpty) {
      // Items were rebuilt: go straight to the cart so the next tap is Checkout.
      CartSheet.show(context, selectedHostel: hostel);
      return;
    }
    // Older orders do not carry their dishes; open the kitchen so the user can pick again.
    final kitchens = dhabaProvider.dhabas.where((d) => d.id == order.dhabaId);
    if (kitchens.isNotEmpty) {
      showKSnack(context, 'Pick your dishes from ${order.dhabaName} again.', icon: LucideIcons.utensils);
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => DhabaMenuScreen(dhaba: kitchens.first, selectedHostel: hostel)),
      );
    } else {
      showKSnack(context, 'We could not rebuild this order. Open ${order.dhabaName} from Home to order again.', error: true);
    }
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.order,
    required this.whenLabel,
    required this.onTrack,
    required this.onReorder,
    required this.onRate,
  });

  final OrderModel order;
  final String whenLabel;
  final VoidCallback? onTrack;
  final VoidCallback onReorder;
  final VoidCallback onRate;

  String get _summary {
    if (order.items.isEmpty) {
      return 'Items ${rupee(order.subtotal)} · Delivery ${rupee(order.deliveryFee)} · Packaging ${rupee(order.taxAndPackaging)}';
    }
    final parts = order.items.map((i) => '${i.quantity} × ${i.item.name}').toList();
    if (parts.length <= 2) return parts.join(', ');
    return '${parts.take(2).join(', ')} +${parts.length - 2} more';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = order.status;
    final delivered = status == OrderProgressStatus.delivered;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: KCard(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(order.dhabaName, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
              ),
            ),
            const SizedBox(width: 10),
            KStatusPill(status: status.kStatus, label: status.pillLabel, compact: true),
          ]),
          const SizedBox(height: 4),
          Text('$whenLabel · ${order.hostel}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 12),
          Text(_summary, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 14)),
          const SizedBox(height: 14),
          Divider(height: 1, color: k.line),
          const SizedBox(height: 14),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(delivered ? 'PAID' : 'TOTAL', style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
                Text(rupee(order.totalAmount), style: KraveoType.numericSm.copyWith(color: k.ink)),
              ]),
            ),
            Text('#${order.id}', style: KraveoType.caption.copyWith(color: k.inkFaint)),
          ]),
          const SizedBox(height: 14),
          if (status.isLive)
            KButton(label: 'Track this order', icon: LucideIcons.bike, onPressed: onTrack)
          else
            Row(children: [
              if (delivered) ...[
                Expanded(flex: 2, child: KButton(label: 'Rate', kind: KButtonKind.ghost, onPressed: onRate)),
                const SizedBox(width: 10),
              ],
              Expanded(flex: 3, child: KButton(label: 'Reorder', icon: LucideIcons.rotateCcw, kind: KButtonKind.tonal, onPressed: onReorder)),
            ]),
          if (delivered)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.coins, size: 14, color: k.brand),
                const SizedBox(width: 6),
                Flexible(child: Text('Rate this order to earn 10 Kraveo Coins', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkMuted))),
              ]),
            ),
        ]),
      ),
    );
  }
}
