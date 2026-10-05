import 'dart:math' as math;

/// The campus pins (mirror of `backend/src/config/campus.ts` DROP_POINTS, distinct pins only: several hostel names
/// share one pin on purpose). Used to tell a restaurant "this spot is not near the campus" before it tries to save;
/// the server re-checks everything.
const List<(double, double)> kCampusPins = [
  (23.074861, 76.859889), // BH1
  (23.073556, 76.859861), // BH2, BH3
  (23.073361, 76.858389), // BH4, BH5, Special Block
  (23.07275, 76.86), // BH6
  (23.072889, 76.859222), // BH7, BH8
  (23.074778, 76.851972), // GH1
  (23.074917, 76.853194), // GH2
];

/// Mean of the distinct pins, like the server's `CAMPUS_CENTER`.
final (double, double) kCampusCenter = (
  kCampusPins.fold<double>(0, (s, p) => s + p.$1) / kCampusPins.length,
  kCampusPins.fold<double>(0, (s, p) => s + p.$2) / kCampusPins.length,
);

/// Restaurants further than this from the campus centre are rejected by the server.
const double kNearCampusKm = 3;

double _rad(double deg) => deg * math.pi / 180;

/// Great-circle distance in kilometres (haversine).
double distanceKm(double lat1, double lng1, double lat2, double lng2) {
  final dLat = _rad(lat2 - lat1);
  final dLng = _rad(lng2 - lng1);
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(_rad(lat1)) * math.cos(_rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
  return 2 * 6371.0088 * math.asin(math.min(1, math.sqrt(h.toDouble())));
}

double distanceToCampusKm(double lat, double lng) => distanceKm(kCampusCenter.$1, kCampusCenter.$2, lat, lng);

/// A valid coordinate within [kNearCampusKm] of the campus centre.
bool isNearCampus(double lat, double lng) {
  if (!lat.isFinite || !lng.isFinite || lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return distanceToCampusKm(lat, lng) <= kNearCampusKm;
}
