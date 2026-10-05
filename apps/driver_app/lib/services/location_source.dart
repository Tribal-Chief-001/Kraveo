import 'dart:async';
import 'package:flutter/foundation.dart';
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

/// How often the phone is asked for a position while the rider is ON DUTY. The controller also
/// never posts more often than about this (see `RiderServices.minPostGap`).
const Duration kLocationInterval = Duration(seconds: 10);

/// The text of the Android foreground-service notification shown for as long as the rider is
/// on duty (Docs/19 section 4).
const String kDutyNotificationTitle = 'Kraveo - you are on duty';
const String kDutyNotificationText = 'Sharing your location with Kraveo';

/// Android notification channel of the duty notification. The plugin creates a channel with this
/// id as "importance none" (an invisible notification); MainActivity creates it first with low
/// importance so the rider can see why the phone says Kraveo is using location.
const String kDutyNotificationChannelName = 'On duty - location sharing';

/// Position settings while on duty: a foreground service (so updates continue with the screen
/// off or the app in the background), one fix per [kLocationInterval], balanced for battery:
/// high accuracy is requested from the fused provider only at that pace, no wake lock is held.
/// Returns null off Android (no foreground service there: the controller polls instead).
@visibleForTesting
LocationSettings? dutyLocationSettings({TargetPlatform? platform}) {
  if (kIsWeb || (platform ?? defaultTargetPlatform) != TargetPlatform.android) return null;
  return AndroidSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 0, // a standing rider still reports (the dashboard marks silent riders "stale")
    intervalDuration: kLocationInterval,
    foregroundNotificationConfig: const ForegroundNotificationConfig(
      notificationTitle: kDutyNotificationTitle,
      notificationText: kDutyNotificationText,
      notificationChannelName: kDutyNotificationChannelName,
      notificationIcon: AndroidResource(name: 'ic_stat_kraveo', defType: 'drawable'),
      setOngoing: true,
      enableWakeLock: false,
      enableWifiLock: false,
    ),
  );
}

/// Reads the phone's real position. Tests use a fake.
abstract class LocationSource {
  Future<LocationReading> read();

  /// A continuous stream of positions for as long as someone listens (Android: backed by a
  /// foreground service with a visible notification). Cancelling the subscription stops the
  /// updates AND removes the notification. Problems arrive in the stream as
  /// [LocationReading.problem] values, never as errors. Returns null when this source cannot
  /// stream (then the caller polls [read] on a timer, the original behaviour).
  Stream<LocationReading>? track();

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
  Stream<LocationReading>? track() {
    final settings = dutyLocationSettings();
    if (settings == null) return null;
    StreamSubscription<Position>? sub;
    late final StreamController<LocationReading> out;
    out = StreamController<LocationReading>(
      onListen: () {
        try {
          sub = Geolocator.getPositionStream(locationSettings: settings).listen(
            (p) => out.add(LocationReading.fix(p.latitude, p.longitude, heading: p.heading.isFinite ? p.heading : 0)),
            onError: (Object e) => out.add(LocationReading.problem(_problemFor(e))),
          );
        } catch (_) {
          out.add(const LocationReading.problem(LocationProblem.unavailable));
        }
      },
      onCancel: () async {
        final s = sub;
        sub = null;
        await s?.cancel(); // the plugin stops the foreground service and removes its notification
      },
    );
    return out.stream;
  }

  static LocationProblem _problemFor(Object e) {
    if (e is LocationServiceDisabledException) return LocationProblem.serviceOff;
    if (e is PermissionDeniedException) return LocationProblem.permissionDenied;
    return LocationProblem.unavailable;
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
