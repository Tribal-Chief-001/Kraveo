import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

/// One GPS reading: where, and how sure the phone is (radius in metres; smaller is better).
class LocationFix {
  const LocationFix(this.lat, this.lng, this.accuracyM);
  final double lat;
  final double lng;
  final double accuracyM;

  @override
  String toString() => 'LocationFix($lat, $lng, ${accuracyM.toStringAsFixed(0)} m)';
}

/// Why there is no usable fix. The app never invents coordinates for any of these.
enum LocationProblem {
  /// The phone's location (GPS) switch is off: offer the location settings.
  serviceOff,

  /// "Don't allow" was tapped: can be asked again.
  permissionDenied,

  /// "Don't ask again": only the app settings can fix it.
  permissionDeniedForever,

  /// No fix at all inside the time window (indoors, no signal).
  timeout,

  /// The plugin / phone failed in some other way.
  unavailable,

  /// The caller gave up (sheet closed). Never shown to the user.
  cancelled,
}

/// Result of one "Detect my location": either the most accurate fix found, or the reason there is none.
class CaptureResult {
  const CaptureResult.fix(LocationFix this.fix, {required this.weak}) : problem = null;
  const CaptureResult.problem(LocationProblem this.problem)
      : fix = null,
        weak = false;

  final LocationFix? fix;
  final LocationProblem? problem;

  /// The best fix is still rougher than [BestFixCapture.goodEnoughM]: the owner should step outside and retry
  /// (and may still accept it, with a confirm).
  final bool weak;

  bool get hasFix => fix != null;
}

/// Reads the phone's location when asked (never in the background). Tests use a fake.
abstract class LocationCapture {
  /// Explains nothing itself (the UI does, first), then asks for permission if needed and collects fixes for up to
  /// about 20 seconds, keeping the MOST ACCURATE one. [onProgress] reports each new best fix and the time spent.
  Future<CaptureResult> detect({void Function(LocationFix best, Duration elapsed)? onProgress});

  /// Stops an unfinished [detect] (its future then completes with [LocationProblem.cancelled]).
  void cancel();

  /// Opens the screen that fixes [problem] (the location switch or this app's settings).
  Future<void> openSettingsFor(LocationProblem problem);
}

enum SensorPermission { granted, denied, deniedForever }

/// The thin platform layer under [BestFixCapture], so the best-fix logic is testable without a phone.
abstract class LocationSensor {
  Future<bool> serviceEnabled();
  Future<SensorPermission> permission();
  Future<SensorPermission> requestPermission();

  /// Positions for as long as someone listens. Foreground only: no notification, no background service.
  /// Errors on the stream are mapped to a [LocationProblem] by [BestFixCapture].
  Stream<LocationFix> fixes();
  Future<void> openLocationSettings();
  Future<void> openAppSettings();
}

/// Collect fixes for up to [window], keep the most accurate. Stops early once a fix is [excellentM] or better, or
/// after [settleAfter] when the best fix is already within [goodEnoughM]. A fix rougher than [goodEnoughM] is returned
/// as `weak`.
class BestFixCapture implements LocationCapture {
  BestFixCapture({
    required this.sensor,
    this.window = const Duration(seconds: 20),
    this.settleAfter = const Duration(seconds: 8),
    this.goodEnoughM = 40,
    this.excellentM = 15,
  });

  final LocationSensor sensor;
  final Duration window;
  final Duration settleAfter;
  final double goodEnoughM;
  final double excellentM;

  void Function(CaptureResult)? _finishCurrent;
  int _run = 0;

  @override
  void cancel() => _finishCurrent?.call(const CaptureResult.problem(LocationProblem.cancelled));

  static LocationProblem _problemFor(Object e) {
    if (e is LocationServiceDisabledException) return LocationProblem.serviceOff;
    if (e is PermissionDeniedException) return LocationProblem.permissionDenied;
    return LocationProblem.unavailable;
  }

  @override
  Future<CaptureResult> detect({void Function(LocationFix best, Duration elapsed)? onProgress}) async {
    // A second tap while one is running replaces it.
    cancel();
    try {
      if (!await sensor.serviceEnabled()) return const CaptureResult.problem(LocationProblem.serviceOff);
      var permission = await sensor.permission();
      if (permission == SensorPermission.denied) permission = await sensor.requestPermission();
      if (permission == SensorPermission.deniedForever) return const CaptureResult.problem(LocationProblem.permissionDeniedForever);
      if (permission != SensorPermission.granted) return const CaptureResult.problem(LocationProblem.permissionDenied);
    } catch (_) {
      return const CaptureResult.problem(LocationProblem.unavailable);
    }

    final runId = ++_run;
    final done = Completer<CaptureResult>();
    final watch = Stopwatch()..start();
    LocationFix? best;
    LocationProblem? lastProblem;
    StreamSubscription<LocationFix>? sub;
    Timer? windowTimer;
    Timer? settleTimer;

    void finish(CaptureResult result) {
      if (done.isCompleted) return;
      windowTimer?.cancel();
      settleTimer?.cancel();
      unawaited(sub?.cancel());
      if (_run == runId) _finishCurrent = null;
      done.complete(result);
    }

    CaptureResult bestOrProblem() {
      final b = best;
      if (b != null) return CaptureResult.fix(b, weak: b.accuracyM > goodEnoughM);
      return CaptureResult.problem(lastProblem ?? LocationProblem.timeout);
    }

    _finishCurrent = finish;
    windowTimer = Timer(window, () => finish(bestOrProblem()));
    settleTimer = Timer(settleAfter, () {
      final b = best;
      if (b != null && b.accuracyM <= goodEnoughM) finish(bestOrProblem());
    });
    try {
      sub = sensor.fixes().listen(
        (f) {
          if (done.isCompleted || !f.lat.isFinite || !f.lng.isFinite) return;
          final acc = f.accuracyM.isFinite && f.accuracyM >= 0 ? f.accuracyM : 9999.0;
          final fix = LocationFix(f.lat, f.lng, acc);
          if (best == null || fix.accuracyM < best!.accuracyM) {
            best = fix;
            onProgress?.call(fix, watch.elapsed);
          }
          if (fix.accuracyM <= excellentM) finish(bestOrProblem());
        },
        onError: (Object e) {
          final problem = _problemFor(e);
          lastProblem = problem;
          // Switch turned off / permission taken away mid-read: no point waiting for the clock.
          if (best == null && (problem == LocationProblem.serviceOff || problem == LocationProblem.permissionDenied)) {
            finish(CaptureResult.problem(problem));
          }
        },
      );
    } catch (_) {
      finish(const CaptureResult.problem(LocationProblem.unavailable));
    }
    return done.future;
  }

  @override
  Future<void> openSettingsFor(LocationProblem problem) async {
    try {
      if (problem == LocationProblem.serviceOff) {
        await sensor.openLocationSettings();
      } else {
        await sensor.openAppSettings();
      }
    } catch (_) {}
  }
}

/// The real phone sensor (geolocator). Foreground, high accuracy, one position a second while collecting; no
/// foreground-service notification is configured, so nothing keeps running once the listener is cancelled.
class GeolocatorSensor implements LocationSensor {
  const GeolocatorSensor();

  static SensorPermission _map(LocationPermission p) => switch (p) {
        LocationPermission.always || LocationPermission.whileInUse => SensorPermission.granted,
        LocationPermission.deniedForever => SensorPermission.deniedForever,
        _ => SensorPermission.denied,
      };

  @override
  Future<bool> serviceEnabled() => Geolocator.isLocationServiceEnabled();

  @override
  Future<SensorPermission> permission() async => _map(await Geolocator.checkPermission());

  @override
  Future<SensorPermission> requestPermission() async => _map(await Geolocator.requestPermission());

  @override
  Stream<LocationFix> fixes() {
    final LocationSettings settings = defaultTargetPlatform == TargetPlatform.android
        ? AndroidSettings(accuracy: LocationAccuracy.best, distanceFilter: 0, intervalDuration: const Duration(seconds: 1))
        : const LocationSettings(accuracy: LocationAccuracy.best, distanceFilter: 0);
    return Geolocator.getPositionStream(locationSettings: settings).map((p) => LocationFix(p.latitude, p.longitude, p.accuracy));
  }

  @override
  Future<void> openLocationSettings() async {
    await Geolocator.openLocationSettings();
  }

  @override
  Future<void> openAppSettings() async {
    await Geolocator.openAppSettings();
  }
}
