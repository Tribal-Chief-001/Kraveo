import 'dart:math' as math;

/// A plain latitude/longitude pair. Kept free of any map plugin so the tracking logic can be
/// tested (and the screen can fall back to the stylised map) without Google Maps.
class GeoPoint {
  const GeoPoint(this.lat, this.lng);

  final double lat;
  final double lng;

  @override
  bool operator ==(Object other) => other is GeoPoint && other.lat == lat && other.lng == lng;

  @override
  int get hashCode => Object.hash(lat, lng);

  @override
  String toString() => 'GeoPoint($lat, $lng)';
}

/// Great-circle distance in metres (haversine).
double distanceMeters(GeoPoint a, GeoPoint b) {
  const earthRadius = 6371000.0;
  double rad(double d) => d * math.pi / 180;
  final dLat = rad(b.lat - a.lat);
  final dLng = rad(b.lng - a.lng);
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(rad(a.lat)) * math.cos(rad(b.lat)) * math.pow(math.sin(dLng / 2), 2);
  return 2 * earthRadius * math.asin(math.min(1.0, math.sqrt(h)));
}

/// Average rider speed used for the rough "about N min" figure: a bike on a campus road with
/// stops. Deliberately modest; the figure is always shown as approximate.
const double kApproxRiderSpeedKmh = 15;

/// Straight-line "about N minutes" from [from] to [to] at [kApproxRiderSpeedKmh], rounded up and
/// never below 1. Returns null when it cannot be computed honestly (missing point, bad numbers,
/// or further than [maxMeters], which means the fix is not on campus).
int? approxMinutes(GeoPoint? from, GeoPoint? to, {double maxMeters = 8000}) {
  if (from == null || to == null) return null;
  final values = [from.lat, from.lng, to.lat, to.lng];
  if (values.any((v) => v.isNaN || v.isInfinite)) return null;
  final meters = distanceMeters(from, to);
  if (meters.isNaN || meters > maxMeters) return null;
  final minutes = meters / (kApproxRiderSpeedKmh * 1000 / 60);
  return math.max(1, minutes.ceil());
}
