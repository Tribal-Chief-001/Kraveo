import 'dart:math' as math;

/// A plain latitude/longitude pair. Kept free of any map plugin so the logic can be tested (and
/// the screen can fall back to a plain card) without Google Maps. Same shape as the customer app.
class GeoPoint {
  const GeoPoint(this.lat, this.lng);

  final double lat;
  final double lng;

  /// True when both numbers are finite and inside the valid latitude/longitude ranges.
  bool get isValid => lat.isFinite && lng.isFinite && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

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

/// "under 10 m", "85 m", "1.2 km". Rounded for reading, not for navigation; null or a
/// non-finite number gives null.
String? formatDistance(double? meters) {
  if (meters == null || meters.isNaN || meters.isInfinite || meters < 0) return null;
  if (meters < 10) return 'under 10 m';
  final tens = (meters / 10).round() * 10;
  if (tens < 1000) return '$tens m';
  return '${(meters / 1000).toStringAsFixed(1)} km';
}
