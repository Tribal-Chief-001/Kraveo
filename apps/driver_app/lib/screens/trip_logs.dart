import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_view.dart';
import '../state/rider_controller.dart';
import '../widgets/swipe_accept_card.dart' show OfferCard;
import '../widgets/ui/screen_header.dart';

/// The rider's finished orders from `GET /orders?scope=history` (paginated). No sample data.
class TripLogsScreen extends StatefulWidget {
  const TripLogsScreen({super.key, required this.controller});

  final RiderController controller;

  @override
  State<TripLogsScreen> createState() => _TripLogsScreenState();
}

class _TripLogsScreenState extends State<TripLogsScreen> {
  String selectedFilter = 'All';

  static const _filters = ['All', 'Today', 'Yesterday', 'This Week'];

  List<OrderView> _filtered(RiderController c) {
    final now = c.services.now().toLocal();
    final today = DateTime(now.year, now.month, now.day);
    bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
    return c.history.where((t) {
      final at = t.finishedAt?.toLocal();
      if (selectedFilter == 'All') return true;
      if (at == null) return false;
      switch (selectedFilter) {
        case 'Today':
          return sameDay(at, today);
        case 'Yesterday':
          return sameDay(at, today.subtract(const Duration(days: 1)));
        default:
          return !at.isBefore(today.subtract(const Duration(days: 6)));
      }
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: widget.controller, builder: (context, _) => _build(context));
  }

  Widget _build(BuildContext context) {
    final k = context.k;
    final c = widget.controller;
    final trips = _filtered(c);
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    final now = c.services.now();

    final Widget list;
    if (!c.historyLoaded && c.historyLoading) {
      list = const Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)));
    } else if (!c.historyLoaded && c.historyError) {
      list = KEmptyState(
        icon: LucideIcons.wifiOff,
        title: 'Could not load your trips',
        message: 'Check your internet and try again.',
        action: KButton(label: 'Retry', icon: LucideIcons.rotateCcw, large: true, expand: false, onPressed: c.loadHistory),
      );
    } else if (trips.isEmpty) {
      list = Padding(
        padding: EdgeInsets.only(bottom: bottomInset),
        child: KEmptyState(
          icon: LucideIcons.history,
          title: 'No trips here yet',
          message: selectedFilter == 'All' ? 'Finished deliveries show up here.' : 'No deliveries in this period. Try another filter.',
        ),
      );
    } else {
      list = RefreshIndicator(
        onRefresh: c.loadHistory,
        child: ListView.builder(
          padding: EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, bottomInset + 24),
          itemCount: trips.length + 1,
          itemBuilder: (context, index) {
            if (index == trips.length) {
              if (!c.historyHasMore || selectedFilter != 'All') return const SizedBox(height: 8);
              return KButton(
                key: const ValueKey('load-more-trips'),
                label: c.historyError ? 'Could not load – try again' : 'Load older trips',
                kind: KButtonKind.ghost,
                loading: c.historyLoading,
                onPressed: c.loadMoreHistory,
              );
            }
            final trip = trips[index];
            final delivered = trip.status == OrderStatus.delivered;
            return KReveal(
              index: index,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: KCard(
                  onTap: () => _showTripDetails(context, trip),
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Expanded(child: Text(trip.shortRef, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.inkMuted))),
                        KStatusPill(status: delivered ? KStatus.delivered : KStatus.cancelled, compact: true),
                      ]),
                      const SizedBox(height: 12),
                      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            _RouteLine(icon: LucideIcons.store, color: k.brand, text: trip.restaurantName),
                            Padding(
                              padding: const EdgeInsets.only(left: 9),
                              child: Container(width: 2, height: 12, color: k.line),
                            ),
                            _RouteLine(icon: LucideIcons.mapPin, color: KStatus.atGate.color, text: trip.dropLabel),
                          ]),
                        ),
                        const SizedBox(width: 12),
                        Text(delivered ? OfferCard.rupees(trip.deliveryFee) : '–', style: KraveoType.numeric.copyWith(color: k.ink, fontSize: 34)),
                      ]),
                      const SizedBox(height: 12),
                      Text('${trip.itemCount} items · ${OfferCard.ago(trip.finishedAt, now)}', style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const Align(alignment: Alignment.centerLeft, child: ScreenHeader(title: 'Trips')),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: Row(
                children: [
                  for (final filter in _filters)
                    Padding(
                      padding: const EdgeInsets.only(right: 10),
                      child: KChoiceChip(label: filter, selected: selectedFilter == filter, onTap: () => setState(() => selectedFilter = filter)),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Expanded(child: list),
          ],
        ),
      ),
    );
  }

  void _showTripDetails(BuildContext context, OrderView trip) {
    final delivered = trip.status == OrderStatus.delivered;
    showKSheet(
      context,
      builder: (ctx) {
        final k = ctx.k;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Expanded(child: Text('Order ${trip.shortRef}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink))),
                Text(delivered ? OfferCard.rupees(trip.deliveryFee) : '–', style: KraveoType.numeric.copyWith(color: k.brand)),
              ]),
              const SizedBox(height: 6),
              KStatusPill(status: delivered ? KStatus.delivered : KStatus.cancelled, compact: true),
              const SizedBox(height: 20),
              _SheetStop(icon: LucideIcons.store, color: k.brand, label: 'PICKUP', title: trip.restaurantName, note: trip.vendor?.address ?? ''),
              const SizedBox(height: 14),
              _SheetStop(icon: LucideIcons.mapPin, color: KStatus.atGate.color, label: 'DROP', title: trip.dropLabel, note: trip.dropoffNotes ?? ''),
              const SizedBox(height: 16),
              Divider(color: k.line),
              const SizedBox(height: 8),
              Text(
                delivered
                    ? 'Delivery fee ${OfferCard.rupees(trip.deliveryFee)} · order ${OfferCard.rupees(trip.totalAmount)} (prepaid)'
                    : 'Cancelled${trip.cancelReason != null ? ': ${trip.cancelReason}' : ''}',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted),
              ),
              const SizedBox(height: 20),
              KButton(label: 'Close', kind: KButtonKind.tonal, large: true, onPressed: () => Navigator.of(ctx).pop()),
            ],
          ),
        );
      },
    );
  }
}

class _RouteLine extends StatelessWidget {
  const _RouteLine({required this.icon, required this.color, required this.text});
  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(children: [
      Icon(icon, size: 20, color: color),
      const SizedBox(width: 10),
      Expanded(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink))),
    ]);
  }
}

class _SheetStop extends StatelessWidget {
  const _SheetStop({required this.icon, required this.color, required this.label, required this.title, required this.note});
  final IconData icon;
  final Color color;
  final String label, title, note;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
        child: Icon(icon, size: 20, color: color),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 1.2)),
          Text(title, style: KraveoType.titleLg.copyWith(color: k.ink)),
          if (note.isNotEmpty) Text(note, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        ]),
      ),
    ]);
  }
}
