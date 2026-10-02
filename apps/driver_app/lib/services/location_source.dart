import 'package:geolocator/geolocator.dart';

/// Why there is no position right now. The app never invents coordinates for any of these.
enum LocationProblem {
  /// The phone's location (GPS) switch is off.
  serviceOff,

  /// The rider said "Don't allow" (can be asked again).
  permissionDenied,

  /// "Don't ask again": only the app settings can fix it.
  permissionDeniedForever,

  /// GPS is on and allowed but gave no fix in time (indoors, weak signal, plugin error).
  unavailable,
}

class LocationReading {
  const LocationReading.fix(double this.lat, double this.lng, {this.heading = 0}) : problem = null;
  const LocationReading.problem(LocationProblem this.problem)
      : lat = null,
        lng = null,
        heading = 0;

  final double? lat, lng;
  final double heading;
  final LocationProblem? problem;

  bool get hasFix => problem == null && lat != null && lng != null;
}

/// Reads the phone's real position. Tests use a fake.
abstract class LocationSource {
  Future<LocationReading> read();

  /// Shows the system permission prompt (when it can still be shown).
  Future<void> requestPermission();

  /// Opens the screen that fixes [problem] (location settings or this app's settings).
  Future<void> openSettingsFor(LocationProblem problem);
}

class GeolocatorLocationSource implements LocationSource {
  bool _askedThisSession = false;

  @override
  Future<LocationReading> read() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return const LocationReading.problem(LocationProblem.serviceOff);
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied && !_askedThisSession) {
        // Ask once per app session by ourselves; after that the rider uses the "Allow location" button.
        _askedThisSession = true;
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied) return const LocationReading.problem(LocationProblem.permissionDenied);
      if (permission == LocationPermission.deniedForever) return const LocationReading.problem(LocationProblem.permissionDeniedForever);
      final p = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high, timeLimit: const Duration(seconds: 8));
      return LocationReading.fix(p.latitude, p.longitude, heading: p.heading.isFinite ? p.heading : 0);
    } catch (_) {
      return const LocationReading.problem(LocationProblem.unavailable);
    }
  }

  @override
  Future<void> requestPermission() async {
    try {
      await Geolocator.requestPermission();
    } catch (_) {}
  }

  @override
  Future<void> openSettingsFor(LocationProblem problem) async {
    try {
      if (problem == LocationProblem.serviceOff) {
        await Geolocator.openLocationSettings();
      } else {
        await Geolocator.openAppSettings();
      }
    } catch (_) {}
  }
}
