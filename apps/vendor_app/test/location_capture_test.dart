import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:vendor_app/services/location/campus_geo.dart';
import 'package:vendor_app/services/location/location_capture.dart';
import 'package:vendor_app/services/location/location_scope.dart';
import 'support/location_fakes.dart';

/// The best-fix logic under "Detect my location", driven by a fake sensor and fake time (no phone, no GPS).
void main() {
  late FakeSensor sensor;
  late BestFixCapture capture;

  setUp(() {
    sensor = FakeSensor();
    capture = BestFixCapture(sensor: sensor);
  });

  /// Starts a detect, lets it get past the permission checks, and returns the pending result.
  Future<Future<CaptureResult>> start(WidgetTester tester, {void Function(LocationFix, Duration)? onProgress}) async {
    final f = capture.detect(onProgress: onProgress);
    await tester.pump();
    return f;
  }

  Future<void> seconds(WidgetTester tester, int s) async {
    await tester.pump(Duration(seconds: s));
    await tester.pump();
  }

  testWidgets('an excellent fix (15 m or better) is accepted at once', (tester) async {
    final f = await start(tester);
    sensor.emit(12);
    await tester.pump();
    final r = await f;
    expect(r.hasFix, isTrue);
    expect(r.weak, isFalse);
    expect(r.fix!.accuracyM, 12);
    expect(sensor.controller.hasListener, isFalse, reason: 'GPS listening stops as soon as we are done');
  });

  testWidgets('keeps the MOST ACCURATE fix of the window, not the last one', (tester) async {
    final f = await start(tester);
    sensor.emit(80);
    await tester.pump();
    sensor.emit(35, lat: 23.0750, lng: 76.8570);
    await tester.pump();
    sensor.emit(60, lat: 23.0760);
    await seconds(tester, 3);
    sensor.emit(55);
    await seconds(tester, 6); // 9 s in: the best (35 m) is within 40 m, so we settle
    final r = await f;
    expect(r.fix!.accuracyM, 35);
    expect(r.fix!.lat, 23.0750);
    expect(r.weak, isFalse, reason: '35 m is within the 40 m rule');
  });

  testWidgets('a good fix waits a few seconds for a better one, then settles', (tester) async {
    var done = false;
    final f = (await start(tester)).then((r) {
      done = true;
      return r;
    });
    sensor.emit(30);
    await seconds(tester, 5);
    expect(done, isFalse, reason: 'still looking for a better fix');
    await seconds(tester, 4);
    expect(done, isTrue);
    expect((await f).fix!.accuracyM, 30);
  });

  testWidgets('only rough fixes: waits the whole 20 s and returns the best as WEAK', (tester) async {
    var done = false;
    final f = (await start(tester)).then((r) {
      done = true;
      return r;
    });
    sensor.emit(120);
    await tester.pump();
    sensor.emit(85);
    await tester.pump();
    sensor.emit(200);
    await seconds(tester, 19);
    expect(done, isFalse);
    await seconds(tester, 2);
    final r = await f;
    expect(done, isTrue);
    expect(r.fix!.accuracyM, 85);
    expect(r.weak, isTrue);
  });

  testWidgets('exactly 40 m is accepted, 41 m is weak', (tester) async {
    var f = await start(tester);
    sensor.emit(40);
    await seconds(tester, 21);
    expect((await f).weak, isFalse);
    f = await start(tester);
    sensor.emit(41);
    await seconds(tester, 21);
    expect((await f).weak, isTrue);
  });

  testWidgets('reports each new best fix while collecting', (tester) async {
    final seen = <double>[];
    final f = await start(tester, onProgress: (best, _) => seen.add(best.accuracyM));
    sensor.emit(90);
    await tester.pump();
    sensor.emit(95); // worse: not reported
    await tester.pump();
    sensor.emit(50);
    await tester.pump();
    expect(seen, [90, 50]);
    await seconds(tester, 21);
    await f;
  });

  testWidgets('no fix at all in 20 s: timeout', (tester) async {
    final f = await start(tester);
    await seconds(tester, 21);
    final r = await f;
    expect(r.hasFix, isFalse);
    expect(r.problem, LocationProblem.timeout);
    expect(sensor.controller.hasListener, isFalse);
  });

  testWidgets('GPS switched off: reported without waiting, nothing is requested', (tester) async {
    sensor.service = false;
    final r = await capture.detect();
    expect(r.problem, LocationProblem.serviceOff);
    expect(sensor.requests, 0);
  });

  testWidgets('permission denied (system dialog refused): permissionDenied', (tester) async {
    sensor.permissionNow = SensorPermission.denied;
    sensor.afterRequest = SensorPermission.denied;
    final r = await capture.detect();
    expect(r.problem, LocationProblem.permissionDenied);
    expect(sensor.requests, 1, reason: 'asked once, inside the tap');
  });

  testWidgets('permission denied then allowed in the dialog: carries on and finds a fix', (tester) async {
    sensor.permissionNow = SensorPermission.denied;
    sensor.afterRequest = SensorPermission.granted;
    final f = await start(tester);
    expect(sensor.requests, 1);
    sensor.emit(10);
    await tester.pump();
    expect((await f).fix!.accuracyM, 10);
  });

  testWidgets('"don\'t ask again": denied-forever, the system dialog is not shown again', (tester) async {
    sensor.permissionNow = SensorPermission.deniedForever;
    final r = await capture.detect();
    expect(r.problem, LocationProblem.permissionDeniedForever);
    expect(sensor.requests, 0);
  });

  testWidgets('dialog answered "don\'t ask again": denied-forever', (tester) async {
    sensor.permissionNow = SensorPermission.denied;
    sensor.afterRequest = SensorPermission.deniedForever;
    expect((await capture.detect()).problem, LocationProblem.permissionDeniedForever);
  });

  testWidgets('a plugin failure while checking is "unavailable", never a crash', (tester) async {
    sensor.throwOnService = true;
    expect((await capture.detect()).problem, LocationProblem.unavailable);
  });

  testWidgets('GPS switched off while collecting ends at once; other stream errors wait for the clock', (tester) async {
    var f = await start(tester);
    sensor.controller.addError(const LocationServiceDisabledException());
    await tester.pump();
    expect((await f).problem, LocationProblem.serviceOff);

    f = await start(tester);
    sensor.controller.addError(StateError('hiccup'));
    await tester.pump();
    sensor.emit(20);
    await seconds(tester, 9);
    expect((await f).fix!.accuracyM, 20, reason: 'a hiccup before a good fix does not matter');

    f = await start(tester);
    sensor.controller.addError(StateError('hiccup'));
    await seconds(tester, 21);
    expect((await f).problem, LocationProblem.unavailable);
  });

  testWidgets('ignores nonsense positions (NaN) and unknown accuracy counts as very weak', (tester) async {
    final f = await start(tester);
    sensor.controller.add(const LocationFix(double.nan, 76.8, 5));
    await tester.pump();
    sensor.controller.add(const LocationFix(23.07, 76.85, double.nan));
    await seconds(tester, 21);
    final r = await f;
    expect(r.fix!.accuracyM, 9999);
    expect(r.weak, isTrue);
  });

  testWidgets('cancel() ends the read and stops the GPS', (tester) async {
    final f = await start(tester);
    expect(sensor.controller.hasListener, isTrue);
    capture.cancel();
    expect((await f).problem, LocationProblem.cancelled);
    await tester.pump();
    expect(sensor.controller.hasListener, isFalse);
  });

  testWidgets('settings: serviceOff opens location settings, permission problems open app settings', (tester) async {
    await capture.openSettingsFor(LocationProblem.serviceOff);
    await capture.openSettingsFor(LocationProblem.permissionDeniedForever);
    expect(sensor.locationSettings, 1);
    expect(sensor.appSettings, 1);
  });

  group('campus check and helpers', () {
    test('the kitchen test point is on campus, a far city is not, bad numbers are not', () {
      expect(isNearCampus(kKitchenLat, kKitchenLng), isTrue);
      expect(isNearCampus(23.0768, 76.8524), isTrue);
      expect(isNearCampus(23.2599, 77.4126), isFalse); // Bhopal, about 70 km
      expect(isNearCampus(double.nan, 76.8), isFalse);
      expect(isNearCampus(95, 76.8), isFalse);
      expect(distanceToCampusKm(23.2599, 77.4126), greaterThan(50));
    });

    test('accuracy text', () {
      expect(formatAccuracy(12.4), 'about 12 m');
      expect(formatAccuracy(0.2), 'about 1 m');
      expect(formatAccuracy(2500), 'over 1 km');
    });

    test('maps link is a plain https search link (no Maps key)', () {
      final u = googleMapsLink(23.0741, 76.8567);
      expect(u.scheme, 'https');
      expect(u.host, 'www.google.com');
      expect(u.queryParameters['query'], '23.074100,76.856700');
    });
  });
}
