import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/trip_model.dart';
import '../widgets/ui/screen_header.dart';

class TripLogsScreen extends StatefulWidget {
  /// Optional trip source. When null the screen shows its built-in placeholder history.
  final List<TripModel>? trips;

  const TripLogsScreen({super.key, this.trips});

  @override
  State<TripLogsScreen> createState() => _TripLogsScreenState();
}

class _TripLogsScreenState extends State<TripLogsScreen> {
  String selectedFilter = 'All';

  final List<TripModel> dummyTrips = [
    TripModel(
      id: '#ord-8492',
      pickupName: 'FC Night Mess',
      pickupAddress: 'VIT Bhopal Entry Gate 1',
      dropoffName: 'Boys Hostel Block 1',
      dropoffAddress: 'Gate 2 Handshake',
      distanceKm: 1.8,
      payout: 40.0,
      estimatedMinutes: '12 mins',
      customerName: 'Aman Sharma',
      customerPhone: '+91 98765 43210',
      otpCode: '4829',
      timestamp: DateTime.now().subtract(const Duration(minutes: 45)),
    ),
    TripModel(
      id: '#ord-8488',
      pickupName: 'Underdoggs Campus Cafe',
      pickupAddress: 'Academic Block 2 Canteen',
      dropoffName: 'Girls Hostel Block 2',
      dropoffAddress: 'Security Counter Handshake',
      distanceKm: 2.3,
      payout: 45.0,
      estimatedMinutes: '15 mins',
      customerName: 'Priya Verma',
      customerPhone: '+91 98123 45678',
      otpCode: '9102',
      timestamp: DateTime.now().subtract(const Duration(hours: 2, minutes: 15)),
    ),
    TripModel(
      id: '#ord-8451',
      pickupName: 'Southern Spice Dhaba',
      pickupAddress: 'Kothri Kalan Highway Side',
      dropoffName: 'Boys Hostel Block 4',
      dropoffAddress: 'Main Entrance Gate 1',
      distanceKm: 3.1,
      payout: 55.0,
      estimatedMinutes: '18 mins',
      customerName: 'Rahul Nair',
      customerPhone: '+91 97654 32109',
      otpCode: '3341',
      timestamp: DateTime.now().subtract(const Duration(hours: 5)),
    ),
    TripModel(
      id: '#ord-8410',
      pickupName: 'Amul Ice Cream Parlour',
      pickupAddress: 'Student Activity Center',
      dropoffName: 'Faculty Quarter B3',
      dropoffAddress: 'Ground Floor Lobby',
      distanceKm: 1.2,
      payout: 35.0,
      estimatedMinutes: '8 mins',
      customerName: 'Dr. Suresh Mehta',
      customerPhone: '+91 99001 12233',
      otpCode: '7789',
      timestamp: DateTime.now().subtract(const Duration(days: 1, hours: 2)),
    ),
  ];

  List<TripModel> get _allTrips => widget.trips ?? dummyTrips;

  List<TripModel> get _filtered {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
    return _allTrips.where((t) {
      switch (selectedFilter) {
        case 'Today':
          return sameDay(t.timestamp, today);
        case 'Yesterday':
          return sameDay(t.timestamp, today.subtract(const Duration(days: 1)));
        case 'This Week':
          return t.timestamp.isAfter(today.subtract(const Duration(days: 6)));
        default:
          return true;
      }
    }).toList();
  }

  static const _filters = ['All', 'Today', 'Yesterday', 'This Week'];

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final trips = _filtered;
    final bottomInset = MediaQuery.paddingOf(context).bottom;

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
            Expanded(
              child: trips.isEmpty
                  ? Padding(
                      padding: EdgeInsets.only(bottom: bottomInset),
                      child: KEmptyState(
                        icon: LucideIcons.history,
                        title: 'No trips here yet',
                        message: selectedFilter == 'All' ? 'Finished deliveries show up here.' : 'No deliveries in this period. Try another filter.',
                      ),
                    )
                  : ListView.builder(
                      padding: EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, bottomInset + 24),
                      itemCount: trips.length,
                      itemBuilder: (context, index) {
                        final trip = trips[index];
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
                                    Expanded(child: Text(trip.id, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.inkMuted))),
                                    const KStatusPill(status: KStatus.delivered, compact: true),
                                  ]),
                                  const SizedBox(height: 12),
                                  Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                                    Expanded(
                                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                        _RouteLine(icon: LucideIcons.store, color: k.brand, text: trip.pickupName),
                                        Padding(
                                          padding: const EdgeInsets.only(left: 9),
                                          child: Container(width: 2, height: 12, color: k.line),
                                        ),
                                        _RouteLine(icon: LucideIcons.mapPin, color: KStatus.atGate.color, text: trip.dropoffName),
                                      ]),
                                    ),
                                    const SizedBox(width: 12),
                                    Text('₹${trip.payout.toInt()}', style: KraveoType.numeric.copyWith(color: k.ink, fontSize: 34)),
                                  ]),
                                  const SizedBox(height: 12),
                                  Text('${trip.distanceKm} km · ${trip.estimatedMinutes} · ${_ago(trip.timestamp)}', style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  static String _ago(DateTime t) {
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 60) return '${d.inMinutes.clamp(1, 59)} min ago';
    if (d.inHours < 24) return '${d.inHours} h ago';
    return '${d.inDays} d ago';
  }

  void _showTripDetails(BuildContext context, TripModel trip) {
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
                Expanded(child: Text(trip.id, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink))),
                Text('₹${trip.payout.toInt()}', style: KraveoType.numeric.copyWith(color: k.brand)),
              ]),
              const SizedBox(height: 6),
              const KStatusPill(status: KStatus.delivered, compact: true),
              const SizedBox(height: 20),
              _SheetStop(icon: LucideIcons.store, color: k.brand, label: 'PICKUP', title: trip.pickupName, note: trip.pickupAddress),
              const SizedBox(height: 14),
              _SheetStop(icon: LucideIcons.mapPin, color: KStatus.atGate.color, label: 'DROP', title: trip.dropoffName, note: trip.dropoffAddress),
              const SizedBox(height: 16),
              Divider(color: k.line),
              const SizedBox(height: 8),
              Row(children: [
                Icon(LucideIcons.user, size: 18, color: k.inkFaint),
                const SizedBox(width: 10),
                Text('Customer', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                const Spacer(),
                Flexible(child: Text(trip.customerName, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink))),
              ]),
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
          Text(note, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        ]),
      ),
    ]);
  }
}
