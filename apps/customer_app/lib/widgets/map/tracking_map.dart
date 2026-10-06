import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../models/geo.dart';
import '../../models/drop_point.dart';
import '../../models/order.dart';
import '../animated_rider_map.dart';
import '../ui/status_map.dart';
import 'google_map_factory.dart';
import 'map_view.dart';
import 'rider_marker_animator.dart';

/// How long the real map gets to report `onMapCreated` before the stylised map takes over.
const Duration kMapReadyTimeout = Duration(seconds: 6);

/// A rider fix older than this is not used for "about N min".
const Duration kStaleFix = Duration(minutes: 2);

/// How often an old rider fix is noticed even when no new fix arrives (the staleness rule would
/// otherwise only run when something else rebuilds the map).
const Duration kStaleCheckInterval = Duration(seconds: 15);

const double kTrackingMapHeight = 220;

/// The tracking picture: a real Google map with the restaurant pin (only if it has a real
/// location), the delivery pin and the rider moving smoothly, or the stylised
/// [AnimatedRiderMap] whenever the real map is unavailable or fails for any reason (no key, no
/// Play services, plugin error, `onMapCreated` never firing). It never crashes and is never a
/// blank box: the stylised map stays visible until the real one reports it is drawing.
///
/// A rider fix repaints only the marker and the small "about N min" line; the screen around it
/// is not rebuilt.
class TrackingMap extends StatefulWidget {
  const TrackingMap({
    super.key,
    required this.order,
    required this.rider,
    this.factory,
    this.readyTimeout = kMapReadyTimeout,
    this.clock = DateTime.now,
    this.staleCheckInterval = kStaleCheckInterval,
  });

  final OrderModel order;

  /// Latest rider fix for this order (see `OrderProvider.riderLocationListenable`).
  final ValueListenable<RiderLocation?> rider;

  /// Test seam; production uses [GoogleMapViewFactory].
  final MapViewFactory? factory;
  final Duration readyTimeout;
  final DateTime Function() clock;

  /// How often the age of the last rider fix is re-checked while nothing new arrives.
  final Duration staleCheckInterval;

  @override
  State<TrackingMap> createState() => _TrackingMapState();
}

enum _Mode { checking, loading, ready, fallback }

class _TrackingMapState extends State<TrackingMap> with SingleTickerProviderStateMixin {
  late final RiderMarkerAnimator _animator = RiderMarkerAnimator(vsync: this);
  _Mode _mode = _Mode.checking;
  Timer? _timeout;
  MapViewSpec? _spec;

  /// Bumped by the age check; only the small widgets that read the fix's age listen to it.
  final ValueNotifier<int> _tick = ValueNotifier<int>(0);

  /// The rider has not reported for [kStaleFix]: the marker is shown as "last known".
  final ValueNotifier<bool> _stale = ValueNotifier<bool>(false);
  Timer? _staleTimer;
  GeoPoint? _specDropoff;
  GeoPoint? _specRestaurant;

  MapViewFactory get _factory => widget.factory ?? const GoogleMapViewFactory();

  /// The rider marker is only shown while the rider is carrying the food to the student.
  bool get _riderPhase => widget.order.status == OrderProgressStatus.pickedUp || widget.order.status == OrderProgressStatus.arrivedAtGate;

  GeoPoint? get _dropoff {
    final p = widget.order.dropoffPlace;
    return p == null ? null : GeoPoint(p.lat, p.lng);
  }

  GeoPoint? get _restaurant {
    final p = widget.order.vendorPlace;
    return p == null ? null : GeoPoint(p.lat, p.lng);
  }

  @override
  void initState() {
    super.initState();
    widget.rider.addListener(_onFix);
    _onFix();
    if (_dropoff == null || widget.order.isTerminal) {
      _mode = _Mode.fallback; // nothing to draw, or the trip is over: the plain strip is enough
    } else {
      unawaited(_probe());
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

  void _onFix() {
    final fix = widget.rider.value;
    if (fix != null && _riderPhase) {
      _animator.pushFix(fix);
    } else if (fix == null || !_riderPhase) {
      _animator.clear();
    }
    _recheckAge();
  }

  bool _isStale(RiderLocation? loc) => loc != null && widget.clock().difference(loc.receivedAt) > kStaleFix;

  /// Re-evaluates how old the last fix is (on a new fix, a status change and every
  /// [TrackingMap.staleCheckInterval]) and repaints only the ETA line, the strip's GPS chip and
  /// the marker style. The timer only runs while a rider position is on screen.
  void _recheckAge() {
    final loc = widget.rider.value;
    _stale.value = _riderPhase && _isStale(loc);
    _tick.value++;
    final needed = _riderPhase && loc != null;
    if (needed && _staleTimer == null) {
      _staleTimer = Timer.periodic(widget.staleCheckInterval, (_) => _recheckAge());
    } else if (!needed) {
      _staleTimer?.cancel();
      _staleTimer = null;
    }
  }

  @override
  void didUpdateWidget(covariant TrackingMap old) {
    super.didUpdateWidget(old);
    if (!identical(old.rider, widget.rider)) {
      old.rider.removeListener(_onFix);
      widget.rider.addListener(_onFix);
    }
    if (old.order.status != widget.order.status || !identical(old.rider, widget.rider)) _onFix();
    if (widget.order.isTerminal && _mode != _Mode.fallback) _fail('Order finished.');
  }

  @override
  void dispose() {
    _timeout?.cancel();
    _staleTimer?.cancel();
    widget.rider.removeListener(_onFix);
    _animator.dispose();
    _tick.dispose();
    _stale.dispose();
    super.dispose();
  }

  /// A spec that stays identical while the pins do not change, so the map is not told to refit.
  MapViewSpec _specFor(GeoPoint dropoff) {
    final restaurant = _restaurant;
    final cached = _spec;
    if (cached != null && _specDropoff == dropoff && _specRestaurant == restaurant) return cached;
    _specDropoff = dropoff;
    _specRestaurant = restaurant;
    return _spec = MapViewSpec(
      dropoff: dropoff,
      dropoffName: widget.order.dropoffPlace?.name.isNotEmpty == true ? widget.order.dropoffPlace!.name : widget.order.dropoffHostel,
      restaurant: restaurant,
      restaurantName: widget.order.vendorName,
      rider: _animator.position,
      riderStale: _stale,
      onReady: _ready,
      onError: _fail,
    );
  }

  Widget _stylised() => ListenableBuilder(
        listenable: Listenable.merge([widget.rider, _tick]),
        builder: (context, _) => AnimatedRiderMap(
          status: widget.order.status,
          hostel: widget.order.dropoffHostel.isEmpty ? 'Campus gate' : displayDropPoint(widget.order.dropoffHostel),
          dhabaName: widget.order.vendorName,
          // The GPS chip only makes sense while the rider carries the food to the student.
          liveLocation: _riderPhase ? widget.rider.value : null,
          clock: widget.clock,
        ),
      );

  /// The real map widget, or null when building it threw (then the fallback takes over).
  Widget? _realMap(BuildContext context) {
    final dropoff = _dropoff;
    if (dropoff == null) return null;
    try {
      return _factory.build(context, _specFor(dropoff));
    } catch (error) {
      scheduleMicrotask(() => _fail(error));
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final Widget area;
    switch (_mode) {
      case _Mode.checking:
      case _Mode.fallback:
        area = _stylised();
      case _Mode.loading:
      case _Mode.ready:
        final map = _realMap(context);
        if (map == null) {
          area = _stylised();
        } else {
          area = SizedBox(
            height: kTrackingMapHeight,
            width: double.infinity,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(KRadius.xl),
              child: Stack(children: [
                // Visible until the real map reports it is drawing, so there is never a blank box.
                if (_mode == _Mode.loading) Positioned(top: 0, left: 0, right: 0, child: _stylised()),
                Positioned.fill(child: map),
                if (_mode == _Mode.ready)
                  Positioned(
                    top: 12,
                    left: 12,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                      decoration: BoxDecoration(color: k.surface.withValues(alpha: 0.94), borderRadius: BorderRadius.circular(KRadius.pill), boxShadow: KShadow.soft(k.shadowTint)),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(LucideIcons.navigation, size: 14, color: widget.order.status.kStatus.color),
                        const SizedBox(width: 6),
                        Text(widget.order.status.pillLabel, style: KraveoType.label.copyWith(color: k.ink, fontSize: 12.5)),
                      ]),
                    ),
                  ),
              ]),
            ),
          );
        }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      area,
      ListenableBuilder(
        listenable: Listenable.merge([widget.rider, _tick]),
        builder: (context, _) {
          final loc = widget.rider.value;
          final minutes = _etaMinutes(loc);
          if (minutes != null) return Padding(padding: const EdgeInsets.only(top: 10), child: EtaLine(minutes: minutes));
          if (loc != null && widget.order.status == OrderProgressStatus.pickedUp && _isStale(loc)) {
            return const Padding(padding: EdgeInsets.only(top: 10), child: StaleRiderLine());
          }
          return const SizedBox.shrink();
        },
      ),
    ]);
  }

  /// "About N min" while the rider carries the food to the drop point, from a recent fix and
  /// the straight-line distance at a fixed speed. Null when it cannot be computed honestly.
  int? _etaMinutes(RiderLocation? loc) {
    if (loc == null || widget.order.status != OrderProgressStatus.pickedUp) return null;
    if (widget.clock().difference(loc.receivedAt) > kStaleFix) return null;
    return approxMinutes(GeoPoint(loc.lat, loc.lng), _dropoff);
  }
}

/// Shown instead of the ETA when the rider's phone has not reported for a while.
class StaleRiderLine extends StatelessWidget {
  const StaleRiderLine({super.key});

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.lg)),
        child: Row(children: [
          Icon(LucideIcons.clock, size: 18, color: k.inkMuted),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Rider\'s location isn\'t updating', style: KraveoType.titleMd.copyWith(color: k.ink)),
              Text('The map shows where they were last seen. Your order is still on its way.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// "Rider is about 5 min away", labelled as a rough estimate.
class EtaLine extends StatelessWidget {
  const EtaLine({super.key, required this.minutes});

  final int minutes;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.lg)),
        child: Row(children: [
          Icon(LucideIcons.clock, size: 18, color: k.brand),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Rider is about $minutes min away', style: KraveoType.titleMd.copyWith(color: k.ink)),
              Text('Rough estimate from the straight-line distance', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ]),
          ),
        ]),
      ),
    );
  }
}
