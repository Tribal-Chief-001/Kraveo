import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../models/geo.dart';
import '../../models/order_view.dart';
import 'google_map_factory.dart';
import 'map_view.dart';

/// How long the real map gets to report `onMapCreated` before the plain card takes over.
const Duration kMapReadyTimeout = Duration(seconds: 6);

const double kDeliveryMapHeight = 200;

/// Pickup, drop and the rider's own position: a real Google map when one can be shown, or a
/// plain card (names and straight-line distances) whenever the real map is unavailable or fails
/// for any reason (no key, no Play services, plugin error, `onMapCreated` never firing). It never
/// crashes and is never a blank box: the plain card stays visible until the real map reports it
/// is drawing.
///
/// Shows nothing at all when the order has neither a pickup pin nor a drop pin (then the names
/// on the delivery screen are all there is).
class DeliveryMapCard extends StatefulWidget {
  const DeliveryMapCard({
    super.key,
    required this.order,
    required this.rider,
    this.factory,
    this.readyTimeout = kMapReadyTimeout,
  });

  final OrderView order;

  /// The rider's own latest fix (see `RiderController.myPosition`).
  final ValueListenable<GeoPoint?> rider;

  /// Test seam; production uses [GoogleMapViewFactory].
  final MapViewFactory? factory;
  final Duration readyTimeout;

  @override
  State<DeliveryMapCard> createState() => _DeliveryMapCardState();
}

enum _Mode { checking, loading, ready, fallback }

class _DeliveryMapCardState extends State<DeliveryMapCard> {
  _Mode _mode = _Mode.checking;
  Timer? _timeout;
  MapViewSpec? _spec;
  GeoPoint? _specPickup;
  GeoPoint? _specDrop;

  MapViewFactory get _factory => widget.factory ?? const GoogleMapViewFactory();

  GeoPoint? get _pickup => widget.order.vendor?.point;
  GeoPoint? get _drop => widget.order.dropPlace?.point;
  bool get _hasPins => _pickup != null || _drop != null;

  @override
  void initState() {
    super.initState();
    if (_hasPins) {
      unawaited(_probe());
    } else {
      _mode = _Mode.fallback;
    }
  }

  Future<void> _probe() async {
    bool ok;
    try {
      ok = await _factory.isAvailable();
    } catch (_) {
      ok = false;
    }
    if (!mounted || _mode != _Mode.checking) return;
    if (!ok) {
      setState(() => _mode = _Mode.fallback);
      return;
    }
    setState(() => _mode = _Mode.loading);
    _timeout = Timer(widget.readyTimeout, () => _fail('The map did not start in time.'));
  }

  /// setState is not allowed while the framework is building; a map callback that fires in
  /// that window is applied right after the frame instead.
  void _apply(_Mode mode) {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _apply(mode));
      return;
    }
    setState(() => _mode = mode);
  }

  void _fail(Object error) {
    _timeout?.cancel();
    _timeout = null;
    if (!mounted || _mode == _Mode.fallback) return;
    _apply(_Mode.fallback);
  }

  void _ready() {
    if (!mounted || _mode != _Mode.loading) return;
    _timeout?.cancel();
    _timeout = null;
    _apply(_Mode.ready);
  }

  @override
  void didUpdateWidget(covariant DeliveryMapCard old) {
    super.didUpdateWidget(old);
    // The pins appeared after the first build (the order was refreshed): try the map then.
    if (_mode == _Mode.fallback && _hasPins && old.order.vendor?.point == null && old.order.dropPlace == null) {
      _mode = _Mode.checking;
      unawaited(_probe());
    }
  }

  @override
  void dispose() {
    _timeout?.cancel();
    super.dispose();
  }

  /// A spec that stays identical while the pins do not change, so the map is not told to refit.
  MapViewSpec _specFor() {
    final pickup = _pickup, drop = _drop;
    final cached = _spec;
    if (cached != null && _specPickup == pickup && _specDrop == drop) return cached;
    _specPickup = pickup;
    _specDrop = drop;
    return _spec = MapViewSpec(
      pickup: pickup,
      pickupName: widget.order.restaurantName,
      drop: drop,
      dropName: widget.order.dropPlace?.name ?? widget.order.dropLabel,
      rider: widget.rider,
      onReady: _ready,
      onError: _fail,
    );
  }

  /// The real map widget, or null when building it threw (then the plain card takes over).
  Widget? _realMap(BuildContext context) {
    try {
      return _factory.build(context, _specFor());
    } catch (error) {
      scheduleMicrotask(() => _fail(error));
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_hasPins) return const SizedBox.shrink(key: ValueKey('delivery-map-none'));
    final plain = _PlainMapCard(key: const ValueKey('map-fallback-card'), order: widget.order, rider: widget.rider);
    switch (_mode) {
      case _Mode.checking:
      case _Mode.fallback:
        return plain;
      case _Mode.loading:
      case _Mode.ready:
        final map = _realMap(context);
        if (map == null) return plain;
        return SizedBox(
          key: const ValueKey('delivery-map'),
          height: kDeliveryMapHeight,
          width: double.infinity,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(KRadius.xl),
            child: Stack(children: [
              // Visible until the real map reports it is drawing, so there is never a blank box.
              if (_mode == _Mode.loading) Positioned(top: 0, left: 0, right: 0, child: plain),
              Positioned.fill(child: map),
            ]),
          ),
        );
    }
  }
}

/// Names and straight-line distances, with no map behind them. Used whenever the real map
/// cannot be shown.
class _PlainMapCard extends StatelessWidget {
  const _PlainMapCard({super.key, required this.order, required this.rider});

  final OrderView order;
  final ValueListenable<GeoPoint?> rider;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final pickup = order.vendor?.point;
    final drop = order.dropPlace;
    return KCard(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      child: ValueListenableBuilder<GeoPoint?>(
        valueListenable: rider,
        builder: (context, me, _) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(LucideIcons.map, size: 18, color: k.inkMuted),
            const SizedBox(width: 8),
            Expanded(child: Text('On the map', style: KraveoType.titleMd.copyWith(color: k.ink))),
          ]),
          const SizedBox(height: 10),
          _PlaceRow(
            icon: LucideIcons.store,
            role: 'Pickup',
            name: order.restaurantName,
            distance: pickup == null ? null : _distance(me, pickup),
            note: pickup == null ? 'Location not set' : null,
          ),
          if (drop != null) ...[
            const SizedBox(height: 8),
            _PlaceRow(icon: LucideIcons.mapPin, role: 'Drop', name: drop.name, distance: _distance(me, drop.point)),
          ],
          const SizedBox(height: 10),
          Text(
            me == null ? 'Distances appear once your location is found.' : 'Straight-line distances from you. The map is not available on this phone.',
            style: KraveoType.caption.copyWith(color: k.inkFaint),
          ),
        ]),
      ),
    );
  }

  static String? _distance(GeoPoint? me, GeoPoint to) {
    if (me == null) return null;
    final text = formatDistance(distanceMeters(me, to));
    return text == null ? null : '$text away';
  }
}

class _PlaceRow extends StatelessWidget {
  const _PlaceRow({required this.icon, required this.role, required this.name, this.distance, this.note});

  final IconData icon;
  final String role, name;
  final String? distance, note;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final detail = distance ?? note;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(icon, size: 18, color: k.inkFaint),
      const SizedBox(width: 10),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$role · $name', maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink)),
          if (detail != null) Text(detail, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        ]),
      ),
    ]);
  }
}
