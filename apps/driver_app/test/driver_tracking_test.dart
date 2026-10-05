import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/geo.dart';
import 'package:driver_app/services/location_source.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'support/fake_rider.dart';

/// Docs/19 section 4: while ON duty the rider's position is streamed (a foreground service on
/// Android) and posted about every 10 s; nothing runs when OFFLINE. Against fakes: the real
/// foreground service cannot run in a unit test (see the notes in the final report).
void main() {
  late FakeRider f;
  late RiderController c;
  var booted = false;

  Future<void> boot({bool onDutyPref = false}) async {
    SharedPreferences.setMockInitialValues({if (onDutyPref) RiderController.dutyPrefKey: true});
    c = RiderController(f.services, myIds: const {'u-rider'});
    booted = true;
    await c.start();
  }

  Future<void> flush() => Future<void>.delayed(Duration.zero);
  LocationReading fix(double lat, double lng) => LocationReading.fix(lat, lng);

  setUp(() {
    f = FakeRider(streaming: true);
    booted = false;
  });
  tearDown(() {
    if (booted) c.dispose();
  });

  group('foreground-service stream follows duty', () {
    test('OFFLINE: no stream, no service, no position posts', () async {
      await boot();
      await flush();
      expect(f.location.trackStarts, 0);
      expect(f.location.tracking, isFalse);
      expect(c.isTracking, isFalse);
      expect(f.api.locations, isEmpty);
      expect(c.myPosition.value, isNull);
      f.location.emit(fix(23.1, 76.9)); // nobody is listening: nothing can be posted
      await flush();
      expect(f.api.locations, isEmpty);
    });

    test('going ON: first reading is posted at once, then the stream starts (service on)', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      expect(f.api.locations, [(23.0775, 76.8513)], reason: 'a fix soon after going online');
      expect(f.location.trackStarts, 1);
      expect(f.location.tracking, isTrue);
      expect(c.isTracking, isTrue);
      expect(c.location, LocationState.ok);
      expect(c.myPosition.value, const GeoPoint(23.0775, 76.8513));
    });

    test('the stream is not started until the first reading worked (permission settled)', () async {
      f.location.reading = const LocationReading.problem(LocationProblem.permissionDenied);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.location, LocationState.permissionDenied);
      expect(f.location.trackStarts, 0, reason: 'no foreground service without location permission');
      expect(f.api.locations, isEmpty);
      // The rider allows location with the on-screen button: now the service starts.
      f.location.reading = const LocationReading.fix(23.0733, 76.8584);
      await c.fixLocation();
      await flush();
      expect(f.location.permissionRequests, 1);
      expect(c.location, LocationState.ok);
      expect(f.location.trackStarts, 1);
      expect(f.api.locations, [(23.0733, 76.8584)]);
    });

    test('going OFF cancels the stream (service and notification stop) and clears the position', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      f.location.emit(fix(23.07, 76.86));
      expect(c.myPosition.value, isNotNull);
      await c.setDuty(false);
      await flush();
      expect(f.location.trackStops, 1);
      expect(f.location.tracking, isFalse);
      expect(c.isTracking, isFalse);
      expect(c.location, LocationState.off);
      expect(c.myPosition.value, isNull);
      final posted = f.api.locations.length;
      f.uptime = const Duration(minutes: 5);
      f.location.emit(fix(23.08, 76.87));
      await flush();
      expect(f.api.locations.length, posted, reason: 'nothing is sent after going offline');
    });

    test('logout stops the stream and the posts', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      expect(f.location.tracking, isTrue);
      await c.stopForLogout();
      expect(f.location.trackStops, 1);
      expect(f.location.tracking, isFalse);
      expect(c.onDuty, isFalse);
      f.uptime = const Duration(minutes: 5);
      f.location.emit(fix(23.08, 76.87));
      await flush();
      expect(f.api.locations.length, 1);
    });

    test('closing the screen (dispose) stops the stream', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      c.dispose();
      booted = false;
      await flush();
      expect(f.location.trackStops, 1);
      expect(f.location.tracking, isFalse);
    });

    test('a saved "on duty" restores streaming after the app restarts', () async {
      await boot(onDutyPref: true);
      await flush();
      expect(c.onDuty, isTrue);
      expect(f.location.tracking, isTrue);
    });

    test('duty ON refused by the server: nothing is streamed', () async {
      f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.offline);
      await boot();
      await c.setDuty(true);
      await flush();
      expect(c.onDuty, isFalse);
      expect(f.location.trackStarts, 0);
      expect(f.api.locations, isEmpty);
    });
  });

  group('posting is throttled to about every 10 s', () {
    test('fixes inside the gap are shown on the map but not posted; the next one after it is', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      expect(f.api.locations.length, 1); // uptime 0: the first reading

      f.uptime = const Duration(seconds: 3);
      f.location.emit(fix(23.0001, 76.8001));
      await flush();
      expect(f.api.locations.length, 1, reason: '3 s after the last post: too soon');
      expect(c.myPosition.value, const GeoPoint(23.0001, 76.8001), reason: 'the map still follows the rider');

      f.uptime = const Duration(seconds: 8);
      f.location.emit(fix(23.0002, 76.8002));
      await flush();
      expect(f.api.locations.length, 1, reason: '8 s: still inside the 9 s gap');

      f.uptime = const Duration(seconds: 10);
      f.location.emit(fix(23.0003, 76.8003));
      await flush();
      expect(f.api.locations.length, 2);
      expect(f.api.locations.last, (23.0003, 76.8003), reason: 'the newest position is the one sent');

      f.uptime = const Duration(seconds: 12);
      f.location.emit(fix(23.0004, 76.8004));
      f.uptime = const Duration(seconds: 15);
      f.location.emit(fix(23.0005, 76.8005));
      await flush();
      expect(f.api.locations.length, 2);

      f.uptime = const Duration(seconds: 19, milliseconds: 500);
      f.location.emit(fix(23.0006, 76.8006));
      await flush();
      expect(f.api.locations.length, 3);
    });

    test('at most one post is in flight at a time', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      final gate = Completer<void>();
      var slow = 0;
      f.api.onLocationGate = gate;
      f.uptime = const Duration(seconds: 10);
      f.location.emit(fix(23.01, 76.81));
      slow = f.api.locations.length;
      f.uptime = const Duration(seconds: 25);
      f.location.emit(fix(23.02, 76.82));
      await flush();
      expect(f.api.locations.length, slow, reason: 'the second post waits for the first to finish');
      gate.complete();
      await flush();
      f.api.onLocationGate = null;
      f.uptime = const Duration(seconds: 40);
      f.location.emit(fix(23.03, 76.83));
      await flush();
      expect(f.api.locations.last, (23.03, 76.83));
    });

    test('a failed post is shown and retried with the next fix', () async {
      await boot();
      await c.setDuty(true);
      await flush();
      f.api.location = const ApiResult.fail(ApiFailure.offline);
      f.uptime = const Duration(seconds: 10);
      f.location.emit(fix(23.01, 76.81));
      await flush();
      expect(c.lastLocationPostFailed, isTrue);
      f.api.location = const ApiResult.ok(null);
      f.uptime = const Duration(seconds: 20);
      f.location.emit(fix(23.02, 76.82));
      await flush();
      expect(c.lastLocationPostFailed, isFalse);
    });
  });

  group('problems and fallback to polling', () {
    test('a problem from the stream is named, the stream stops, and the timer takes over', () async {
      f = FakeRider(streaming: true, gps: const Duration(milliseconds: 20));
      await boot();
      await c.setDuty(true);
      await flush();
      expect(f.location.tracking, isTrue);
      f.location.reading = const LocationReading.problem(LocationProblem.serviceOff);
      f.location.emit(const LocationReading.problem(LocationProblem.serviceOff));
      expect(c.location, LocationState.serviceOff);
      expect(f.location.trackStops, 1);
      expect(c.isTracking, isFalse);
      expect(c.myPosition.value, isNull, reason: 'no made-up position');
      // GPS comes back: the next timer reading works and the stream is started again.
      f.location.reading = const LocationReading.fix(23.0733, 76.8584);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(c.location, LocationState.ok);
      expect(f.location.trackStarts, 2);
      expect(f.location.tracking, isTrue);
    });

    test('a stream that keeps failing is given up after 3 tries; polling carries on', () async {
      f = FakeRider(streaming: true, gps: const Duration(milliseconds: 20));
      await boot();
      await c.setDuty(true);
      await flush();
      for (var i = 0; i < 3; i++) {
        expect(f.location.tracking, isTrue, reason: 'stream #${i + 1} running');
        f.location.emit(const LocationReading.problem(LocationProblem.unavailable));
        await Future<void>.delayed(const Duration(milliseconds: 80));
      }
      expect(f.location.trackStarts, 3);
      expect(f.location.tracking, isFalse, reason: 'no fourth attempt');
      final n = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(f.api.locations.length, greaterThan(n), reason: 'the 20 ms timer keeps posting');
      await c.setDuty(false);
      final m = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(f.api.locations.length, m, reason: 'and stops when offline');
    });

    test('a source that cannot stream is polled exactly as before', () async {
      f = FakeRider(gps: const Duration(milliseconds: 20)); // streaming: false
      await boot();
      await c.setDuty(true);
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(f.location.trackStarts, 0);
      expect(f.api.locations.length, greaterThanOrEqualTo(2));
      await c.setDuty(false);
      final n = f.api.locations.length;
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(f.api.locations.length, n);
    });
  });

  group('duty location settings (what the foreground service is started with)', () {
    test('Android: 10 s fused updates, foreground notification, no wake lock', () {
      final s = dutyLocationSettings(platform: TargetPlatform.android);
      expect(s, isA<AndroidSettings>());
      final a = s! as AndroidSettings;
      expect(a.intervalDuration, const Duration(seconds: 10));
      expect(a.accuracy, LocationAccuracy.high);
      expect(a.timeLimit, isNull, reason: 'a time limit would end the stream');
      final n = a.foregroundNotificationConfig!;
      expect(n.notificationTitle, 'Kraveo - you are on duty');
      expect(n.notificationText, 'Sharing your location with Kraveo');
      expect(n.setOngoing, isTrue);
      expect(n.enableWakeLock, isFalse);
      expect(n.enableWifiLock, isFalse);
      expect(n.notificationIcon.name, 'ic_stat_kraveo');
    });

    test('other platforms: no foreground service, the app polls instead', () {
      expect(dutyLocationSettings(platform: TargetPlatform.iOS), isNull);
    });

    test('the controller\'s post gap is a little under the 10 s interval', () {
      final s = RiderServices(api: f.api, socket: f.socket, location: f.location);
      expect(s.locationInterval, const Duration(seconds: 10));
      expect(s.minPostGap, const Duration(seconds: 9));
    });
  });
}
