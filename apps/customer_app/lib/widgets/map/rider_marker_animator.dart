import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import '../../models/geo.dart';
import '../../models/order.dart';

/// Moves the rider marker smoothly from one GPS fix to the next instead of jumping.
///
/// Each new fix starts a linear glide from wherever the marker is now to the new point, taking
/// about as long as the gap between the two fixes (clamped to [minGlide]..[maxGlide]) so the
/// marker keeps moving at a steady pace until the next fix arrives. [position] is throttled to
/// [minTick] so a map is told to move the marker ~12 times a second, not 60.
class RiderMarkerAnimator {
  RiderMarkerAnimator({
    required TickerProvider vsync,
    this.minTick = const Duration(milliseconds: 80),
    this.minGlide = const Duration(seconds: 1),
    this.maxGlide = const Duration(seconds: 8),
    this.snapDistanceMeters = 1500,
  }) {
    _ticker = vsync.createTicker(_onTick);
  }

  final Duration minTick;
  final Duration minGlide;
  final Duration maxGlide;

  /// A fix further than this from the marker (rider came back online far away) teleports.
  final double snapDistanceMeters;

  late final Ticker _ticker;
  final ValueNotifier<GeoPoint?> position = ValueNotifier<GeoPoint?>(null);

  GeoPoint? _from;
  GeoPoint? _to;
  Duration _glide = Duration.zero;
  Duration _lastEmit = Duration.zero;
  DateTime? _lastFixAt;
  bool _disposed = false;

  /// Feed the newest fix. Older or identical fixes are ignored.
  void pushFix(RiderLocation fix) {
    if (_disposed) return;
    final target = GeoPoint(fix.lat, fix.lng);
    final previousAt = _lastFixAt;
    if (previousAt != null && fix.receivedAt.isBefore(previousAt)) return;
    final current = position.value;
    if (current == null || _to == null || distanceMeters(current, target) > snapDistanceMeters) {
      _ticker.stop();
      _from = _to = target;
      _lastFixAt = fix.receivedAt;
      position.value = target;
      return;
    }
    if (target == _to) {
      _lastFixAt = fix.receivedAt;
      return;
    }
    var gap = previousAt == null ? minGlide : fix.receivedAt.difference(previousAt);
    if (gap < minGlide) gap = minGlide;
    if (gap > maxGlide) gap = maxGlide;
    _lastFixAt = fix.receivedAt;
    _from = current;
    _to = target;
    _glide = gap;
    _lastEmit = Duration.zero;
    _ticker.stop();
    _ticker.start();
  }

  void _onTick(Duration elapsed) {
    final from = _from;
    final to = _to;
    if (from == null || to == null) return;
    final t = (elapsed.inMicroseconds / _glide.inMicroseconds).clamp(0.0, 1.0);
    if (t < 1 && elapsed - _lastEmit < minTick) return;
    _lastEmit = elapsed;
    position.value = t >= 1 ? to : GeoPoint(from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t);
    if (t >= 1) _ticker.stop();
  }

  /// Hides the marker (rider no longer shared / order not in a tracking phase).
  void clear() {
    _ticker.stop();
    _from = _to = null;
    _lastFixAt = null;
    position.value = null;
  }

  void dispose() {
    _disposed = true;
    _ticker.dispose();
    position.dispose();
  }
}
