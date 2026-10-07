import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../models/drop_point.dart';
import '../widgets/reorder.dart';
import '../widgets/review_modal.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/scroll_empty.dart';
import '../services/order_api.dart';
import '../widgets/ui/status_map.dart';
import 'live_tracking_screen.dart';

class OrderHistoryScreen extends StatelessWidget {
  const OrderHistoryScreen({
    super.key,
    this.selectedHostel,
    this.onTrackOrder,
    this.onExplore,
  });

  /// Drop-off used when a reorder opens the cart. Falls back to the past order's hostel.
  final String? selectedHostel;

  /// Kept for callers; tracking now opens the tapped order directly.
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
    final live = orderProvider.liveOrders;
    final liveIds = live.map((o) => o.id).toSet();
    final history = orderProvider.history.where((o) => !liveIds.contains(o.id)).toList();
    final all = [...live, ...history];
    final bottomInset = MediaQuery.paddingOf(context).bottom;

    Future<void> refresh() => Future.wait([orderProvider.refreshActive(), orderProvider.loadHistory(refresh: true)]);

    final Widget body;
    if (all.isEmpty && !orderProvider.hasLoadedHistory && orderProvider.historyError == null) {
      body = ListView(
        padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, bottomInset + 24),
        children: [
          for (var i = 0; i < 3; i++) const Padding(padding: EdgeInsets.only(bottom: 14), child: KSkeleton(height: 150, radius: KRadius.xl)),
        ],
      );
    } else if (all.isEmpty && orderProvider.historyError != null) {
      body = RefreshIndicator(
        onRefresh: refresh,
        child: KEmptyScroll(
          bottomInset: bottomInset,
          child: KEmptyState(
            icon: LucideIcons.wifiOff,
            title: 'Couldn\'t load your orders',
            message: orderErrorMessage(orderProvider.historyError!, action: 'load your orders'),
            action: KButton(label: 'Try again', icon: LucideIcons.rotateCcw, kind: KButtonKind.tonal, expand: false, onPressed: refresh),
          ),
        ),
      );
    } else if (all.isEmpty) {
      body = RefreshIndicator(
        onRefresh: refresh,
        child: KEmptyScroll(
          bottomInset: bottomInset,
          child: KEmptyState(
            icon: LucideIcons.receipt,
            title: 'No orders yet',
            message: 'Your first order will show up here, ready to reorder in one tap.',
            action: onExplore == null ? null : KButton(label: 'Find something tasty', icon: LucideIcons.utensils, kind: KButtonKind.tonal, expand: false, onPressed: onExplore),
          ),
        ),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: refresh,
        child: NotificationListener<ScrollNotification>(
          onNotification: (n) {
            if (n.metrics.extentAfter < 400 && orderProvider.historyHasMore && !orderProvider.isLoadingMoreHistory && orderProvider.historyError == null) {
              orderProvider.loadMoreHistory();
            }
            return false;
          },
          child: ListView.builder(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, bottomInset + 24),
            itemCount: all.length + 1,
            itemBuilder: (context, index) {
              if (index == all.length) return _ListFooter(orders: orderProvider);
              final order = all[index];
              return KReveal(
                key: ValueKey(order.id),
                index: index < 6 ? index : 0,
                child: _OrderCard(
                  order: order,
                  whenLabel: _when(order.createdAt.toLocal()),
                  reviewed: orderProvider.hasReviewed(order.id),
                  onTrack: () => Navigator.push(context, MaterialPageRoute(builder: (_) => LiveTrackingScreen(orderId: order.id))),
                  onReorder: () => reorderOrder(context, order, selectedHostel: selectedHostel),
                  onRate: () => ReviewModal.show(context, order: order, onReviewed: (r) {
                    if (r.totalCoins != null) cart.setKraveoCoins(r.totalCoins!);
                  }),
                ),
              );
            },
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        toolbarHeight: 68,
        titleSpacing: KSpace.gutter,
        title: const Text('Your orders'),
      ),
      body: body,
    );
  }
}

class _ListFooter extends StatelessWidget {
  const _ListFooter({required this.orders});

  final OrderProvider orders;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    if (orders.isLoadingMoreHistory) {
      return const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.6))));
    }
    if (orders.historyError != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Column(children: [
          Text(orderErrorMessage(orders.historyError!, action: 'load more orders'), textAlign: TextAlign.center, style: KraveoType.bodySm.copyWith(color: kDangerInk)),
          const SizedBox(height: 8),
          KButton(label: 'Try again', kind: KButtonKind.tonal, expand: false, onPressed: () => orders.loadHistory(refresh: !orders.hasLoadedHistory)),
        ]),
      );
    }
    if (orders.historyHasMore) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(child: KButton(label: 'Load more', kind: KButtonKind.ghost, expand: false, onPressed: orders.loadMoreHistory)),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Text('That\'s all your orders.', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkFaint)),
    );
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.order,
    required this.whenLabel,
    required this.reviewed,
    required this.onTrack,
    required this.onReorder,
    required this.onRate,
  });

  final OrderModel order;
  final String whenLabel;
  final bool reviewed;
  final VoidCallback? onTrack;
  final VoidCallback onReorder;
  final VoidCallback onRate;

  String get _summary {
    if (order.items.isEmpty) {
      return 'Items ${rupee(order.subtotal)} · Fees ${rupee(order.deliveryFee + order.taxAndPackaging)}';
    }
    final parts = order.items.map((i) => '${i.quantity} × ${i.name}').toList();
    if (parts.length <= 2) return parts.join(', ');
    return '${parts.take(2).join(', ')} +${parts.length - 2} more';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = order.status;
    final delivered = status == OrderProgressStatus.delivered;
    // Ratings are per restaurant order; a combined order has none (yet).
    final canRate = delivered && !reviewed && !order.isGroup;
    final pillLabel = order.awaitsPayment ? 'Unpaid' : (status == OrderProgressStatus.cancelled && order.paymentStatus == PaymentStatus.refunded ? 'Refunded' : status.pillLabel);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: KCard(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(order.vendorName, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
              ),
            ),
            const SizedBox(width: 10),
            KStatusPill(status: status.kStatus, label: pillLabel, compact: true),
          ]),
          const SizedBox(height: 4),
          Text('$whenLabel · ${displayDropPoint(order.dropoffHostel)}${order.isGroup ? ' · ${order.group!.size} restaurants' : ''}', maxLines: order.isGroup ? 2 : 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 12),
          Text(_summary, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 14)),
          const SizedBox(height: 14),
          Divider(height: 1, color: k.line),
          const SizedBox(height: 14),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(order.isPaid || delivered ? 'PAID' : 'TOTAL', style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
                Text(rupee(order.totalAmount), style: KraveoType.numericSm.copyWith(color: k.ink)),
              ]),
            ),
            Text(orderRef(order.id), style: KraveoType.caption.copyWith(color: k.inkFaint)),
          ]),
          const SizedBox(height: 14),
          if (status.isLive)
            KButton(label: order.awaitsPayment ? 'Pay or cancel' : 'Track this order', icon: LucideIcons.bike, onPressed: onTrack)
          else
            Row(children: [
              if (canRate) ...[
                Expanded(flex: 2, child: KButton(label: 'Rate', kind: KButtonKind.ghost, onPressed: onRate)),
                const SizedBox(width: 10),
              ],
              Expanded(flex: 3, child: KButton(label: 'Reorder', icon: LucideIcons.rotateCcw, kind: KButtonKind.tonal, onPressed: onReorder)),
            ]),
          if (canRate)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.star, size: 14, color: k.brand),
                const SizedBox(width: 6),
                Flexible(child: Text('Tell us how this order went', textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: k.inkMuted))),
              ]),
            ),
        ]),
      ),
    );
  }
}
