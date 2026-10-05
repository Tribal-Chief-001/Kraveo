import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/services/location/location_capture.dart';
import 'package:vendor_app/widgets/location_sheet.dart';
import 'support/location_fakes.dart';

/// The "Detect my location" sheet: every state, driven by a scripted capture.
void main() {
  late FakeCapture capture;
  late List<Uri> opened;
  LocationFix? result;
  var closed = false;
  final saved = <LocationFix>[];
  var saveAnswers = <String?>[];

  setUp(() {
    opened = [];
    result = null;
    closed = false;
    saved.clear();
    saveAnswers = [];
  });

  CaptureResult fixOf(double acc, {double lat = kKitchenLat, double lng = kKitchenLng}) => CaptureResult.fix(LocationFix(lat, lng, acc), weak: acc > 40);

  Future<void> open(
    WidgetTester tester,
    FakeCapture cap, {
    bool withSave = false,
    bool confirm = false,
    bool opens = true,
    Size size = const Size(412, 915),
    double textScale = 1.0,
  }) async {
    capture = cap;
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: KraveoTheme.vendor(),
      builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: ElevatedButton(
              key: const ValueKey('open'),
              onPressed: () async {
                result = await showLocationDetectSheet(
                  context,
                  services: fakeServices(cap, opened: opened, opens: opens),
                  title: 'Set your restaurant location',
                  hindiTitle: 'लोकेशन डालें',
                  skipLabel: 'Not now',
                  skipSublabel: 'अभी नहीं',
                  onSave: withSave
                      ? (fix) async {
                          saved.add(fix);
                          return saveAnswers.isNotEmpty ? saveAnswers.removeAt(0) : null;
                        }
                      : null,
                  confirmBeforeSave: confirm,
                );
                closed = true;
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> tapKey(WidgetTester tester, Key key) async {
    final f = find.byKey(key);
    expect(f, findsOneWidget, reason: '$key');
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> tapLabel(WidgetTester tester, String label) async {
    final f = find.widgetWithText(KButton, label);
    expect(f, findsOneWidget, reason: label);
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('first it explains why, in English and Hindi, and nothing is read yet', (tester) async {
    await open(tester, FakeCapture.fix());
    expect(find.text('Set your restaurant location'), findsOneWidget);
    expect(find.text('Riders use this to find your kitchen. We only read your location when you tap Detect.'), findsOneWidget);
    expect(find.textContaining('राइडर इससे'), findsOneWidget);
    expect(find.byKey(kLocationDetectKey), findsOneWidget);
    expect(find.byKey(kLocationSkipKey), findsOneWidget);
    expect(capture.detects, 0, reason: 'no GPS read before the owner taps Detect');
  });

  testWidgets('good fix: coordinates, accuracy and a Maps link are shown BEFORE anything is saved', (tester) async {
    await open(tester, FakeCapture.fix(accuracy: 12));
    await tapKey(tester, kLocationDetectKey);
    expect(capture.detects, 1);
    expect(tester.widget<Text>(find.byKey(kLocationCoordsKey)).data, '23.074100, 76.856700');
    expect(tester.widget<Text>(find.byKey(kLocationAccuracyKey)).data, contains('about 12 m'));
    expect(find.byKey(kLocationWeakKey), findsNothing);
    expect(find.byKey(kLocationMapLinkKey), findsOneWidget);
    expect(find.text('Use this location'), findsOneWidget, reason: 'pick-only mode (create-account form)');
    expect(closed, isFalse);
    await tapKey(tester, kLocationAcceptKey);
    expect(closed, isTrue);
    expect(result?.lat, kKitchenLat);
    expect(result?.accuracyM, 12);
  });

  testWidgets('while looking for GPS it shows progress and Cancel goes back (and stops the GPS)', (tester) async {
    final cap = FakeCapture.fix();
    cap.gate = Completer<void>();
    cap.progress = [60, 25];
    await open(tester, cap);
    await tapKey(tester, kLocationDetectKey);
    expect(find.text('Looking for your location…'), findsOneWidget);
    expect(find.textContaining('Best so far: about 25 m'), findsOneWidget);
    await tapKey(tester, kLocationCancelKey);
    expect(cap.cancels, 1);
    expect(find.byKey(kLocationDetectKey), findsOneWidget);
    cap.gate!.complete();
    await tester.pump();
    expect(find.byKey(kLocationCoordsKey), findsNothing, reason: 'a cancelled read must not show a result later');
  });

  testWidgets('closing the sheet while looking for GPS cancels the read', (tester) async {
    final cap = FakeCapture.fix();
    cap.gate = Completer<void>();
    await open(tester, cap);
    await tapKey(tester, kLocationDetectKey);
    await tester.tapAt(const Offset(200, 40)); // the dimmed area above the sheet
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(closed, isTrue);
    expect(result, isNull);
    expect(cap.cancels, 1);
    cap.gate!.complete();
    await tester.pump();
  });

  testWidgets('weak fix: clear warning, Retry is the main button, accepting needs a confirm', (tester) async {
    await open(tester, FakeCapture([fixOf(85), fixOf(20)]), withSave: true);
    await tapKey(tester, kLocationDetectKey);
    expect(find.byKey(kLocationWeakKey), findsOneWidget);
    expect(find.text('GPS is weak - step outside and try again'), findsOneWidget);
    expect(find.byKey(kLocationAcceptKey), findsNothing);
    expect(find.byKey(kLocationRetryKey), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(kLocationAccuracyKey)).data, contains('about 85 m'));

    // "Save anyway" -> confirm; "Go back" keeps everything as it was.
    await tapKey(tester, kLocationAcceptWeakKey);
    expect(find.text('Save a rough location?'), findsOneWidget);
    await tapLabel(tester, 'Go back');
    expect(saved, isEmpty);
    expect(find.byKey(kLocationWeakKey), findsOneWidget);

    // Retry finds a good fix.
    await tapKey(tester, kLocationRetryKey);
    expect(capture.detects, 2);
    expect(find.byKey(kLocationWeakKey), findsNothing);
    expect(find.byKey(kLocationAcceptKey), findsOneWidget);
  });

  testWidgets('weak fix accepted after the confirm is saved', (tester) async {
    await open(tester, FakeCapture([fixOf(85)]), withSave: true);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationAcceptWeakKey);
    await tapLabel(tester, 'Yes, save it');
    expect(saved.single.accuracyM, 85);
    expect(closed, isTrue);
    expect(result?.accuracyM, 85);
  });

  group('problems', () {
    Future<void> detectWith(WidgetTester tester, LocationProblem p, {List<CaptureResult>? then}) async {
      await open(tester, FakeCapture([CaptureResult.problem(p), ...?then]));
      await tapKey(tester, kLocationDetectKey);
    }

    testWidgets('permission denied: explains, "Allow location" asks again and carries on', (tester) async {
      await detectWith(tester, LocationProblem.permissionDenied, then: [fixOf(10)]);
      expect(find.text('Allow location to continue'), findsOneWidget);
      expect(find.byKey(kLocationSettingsKey), findsNothing);
      await tapLabel(tester, 'Allow location');
      expect(capture.detects, 2);
      expect(find.byKey(kLocationCoordsKey), findsOneWidget);
    });

    testWidgets('denied for good: offers the app settings (and Try again), never a dead end', (tester) async {
      await detectWith(tester, LocationProblem.permissionDeniedForever);
      expect(find.text('Location is blocked for Kraveo'), findsOneWidget);
      await tapKey(tester, kLocationSettingsKey);
      expect(capture.settingsOpened, [LocationProblem.permissionDeniedForever]);
      expect(find.byKey(kLocationRetryKey), findsOneWidget);
      expect(find.byKey(kLocationSkipKey), findsOneWidget);
    });

    testWidgets('GPS switched off: offers the location settings', (tester) async {
      await detectWith(tester, LocationProblem.serviceOff, then: [fixOf(10)]);
      expect(find.text('Location is switched off'), findsOneWidget);
      await tapKey(tester, kLocationSettingsKey);
      expect(capture.settingsOpened, [LocationProblem.serviceOff]);
      await tapKey(tester, kLocationRetryKey);
      expect(find.byKey(kLocationCoordsKey), findsOneWidget);
    });

    testWidgets('timeout: "No GPS signal" with a hint and Try again', (tester) async {
      await detectWith(tester, LocationProblem.timeout, then: [fixOf(10)]);
      expect(find.text('No GPS signal'), findsOneWidget);
      expect(find.textContaining('20 seconds'), findsOneWidget);
      await tapKey(tester, kLocationRetryKey);
      expect(find.byKey(kLocationCoordsKey), findsOneWidget);
    });

    testWidgets('other failure: plain wording', (tester) async {
      await detectWith(tester, LocationProblem.unavailable);
      expect(find.text('Could not read your location'), findsOneWidget);
    });

    testWidgets('the skip button leaves without a location', (tester) async {
      await detectWith(tester, LocationProblem.timeout);
      await tapKey(tester, kLocationSkipKey);
      expect(closed, isTrue);
      expect(result, isNull);
    });
  });

  testWidgets('outside the campus: says so, shows the spot, does NOT offer to save, nothing is saved', (tester) async {
    await open(tester, FakeCapture([fixOf(8, lat: 23.2599, lng: 77.4126), fixOf(8)]), withSave: true);
    await tapKey(tester, kLocationDetectKey);
    expect(find.byKey(kLocationOutsideKey), findsOneWidget);
    expect(find.text('This is not near the campus'), findsOneWidget);
    expect(find.textContaining('km from the campus'), findsOneWidget);
    expect(find.byKey(kLocationAcceptKey), findsNothing);
    expect(find.byKey(kLocationAcceptWeakKey), findsNothing);
    expect(saved, isEmpty);
    await tapKey(tester, kLocationRetryKey);
    expect(find.byKey(kLocationAcceptKey), findsOneWidget);
  });

  testWidgets('"Open in Google Maps to check" opens a plain https link; a failure is explained inline', (tester) async {
    await open(tester, FakeCapture.fix(accuracy: 12));
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationMapLinkKey);
    expect(opened.single.toString(), 'https://www.google.com/maps/search/?api=1&query=23.074100,76.856700');
    expect(find.textContaining('Could not open Maps'), findsNothing);
  });

  testWidgets('Maps link that cannot open: the owner is told, the sheet stays usable', (tester) async {
    await open(tester, FakeCapture.fix(accuracy: 12), opens: false);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationMapLinkKey);
    expect(find.textContaining('Could not open Maps'), findsOneWidget);
    expect(find.byKey(kLocationAcceptKey), findsOneWidget);
  });

  testWidgets('save mode: success closes the sheet; a server failure keeps it open with the message and a retry', (tester) async {
    saveAnswers = ['The location must be within 3 km of the campus.', null];
    await open(tester, FakeCapture.fix(accuracy: 12), withSave: true);
    await tapKey(tester, kLocationDetectKey);
    expect(find.text('Save location'), findsOneWidget);
    await tapKey(tester, kLocationAcceptKey);
    expect(saved, hasLength(1));
    expect(closed, isFalse);
    expect(tester.widget<Text>(find.descendant(of: find.byKey(kLocationSaveErrorKey), matching: find.byType(Text)).first).data, 'The location must be within 3 km of the campus.');
    expect(find.text('Try saving again'), findsOneWidget);
    await tapKey(tester, kLocationAcceptKey);
    expect(saved, hasLength(2));
    expect(closed, isTrue);
    expect(result?.lat, kKitchenLat);
  });

  testWidgets('changing an existing location asks first; "Go back" saves nothing', (tester) async {
    await open(tester, FakeCapture.fix(accuracy: 12), withSave: true, confirm: true);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationAcceptKey);
    expect(find.text('Change your restaurant location?'), findsOneWidget);
    expect(find.textContaining('Riders will go to this new spot'), findsOneWidget);
    await tapLabel(tester, 'Go back');
    expect(saved, isEmpty);
    expect(closed, isFalse);
    await tapKey(tester, kLocationAcceptKey);
    await tapLabel(tester, 'Yes, change it');
    expect(saved, hasLength(1));
    expect(closed, isTrue);
  });

  group('no overflow at 360x640 with 1.3x text', () {
    Future<void> check(WidgetTester tester, FakeCapture cap, {List<Key> through = const [kLocationDetectKey], bool withSave = true}) async {
      await open(tester, cap, size: const Size(360, 640), textScale: 1.3, withSave: withSave);
      expect(tester.takeException(), isNull, reason: 'intro');
      for (final k in through) {
        await tapKey(tester, k);
        expect(tester.takeException(), isNull, reason: '$k');
      }
    }

    testWidgets('intro, detecting, good result, weak result with a save error', (tester) async {
      final cap = FakeCapture([fixOf(12), fixOf(90)]);
      cap.gate = Completer<void>();
      await check(tester, cap);
      expect(find.text('Looking for your location…'), findsOneWidget);
      cap.gate!.complete();
      await tester.pump();
      expect(tester.takeException(), isNull, reason: 'good result');
      await tapKey(tester, kLocationRetryKey); // second script entry: weak
      expect(tester.takeException(), isNull, reason: 'weak result');
      saveAnswers = ['Kraveo is slow to answer. Try again.  ·  जवाब नहीं आया, फिर कोशिश करें'];
      await tapKey(tester, kLocationAcceptWeakKey);
      await tapLabel(tester, 'Yes, save it');
      expect(find.byKey(kLocationSaveErrorKey), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'weak result + save error');
    });

    for (final p in [LocationProblem.serviceOff, LocationProblem.permissionDenied, LocationProblem.permissionDeniedForever, LocationProblem.timeout, LocationProblem.unavailable]) {
      testWidgets('problem $p', (tester) async {
        await check(tester, FakeCapture([CaptureResult.problem(p)]));
        expect(find.byKey(kLocationProblemTitleKey), findsOneWidget);
      });
    }

    testWidgets('outside the campus', (tester) async {
      await check(tester, FakeCapture([fixOf(8, lat: 23.2599, lng: 77.4126)]));
      expect(find.byKey(kLocationOutsideKey), findsOneWidget);
    });

    testWidgets('the confirm sheets', (tester) async {
      await open(tester, FakeCapture([fixOf(90)]), size: const Size(360, 640), textScale: 1.3, withSave: true, confirm: true);
      await tapKey(tester, kLocationDetectKey);
      await tapKey(tester, kLocationAcceptWeakKey);
      expect(find.byType(KButton), findsWidgets);
      expect(find.text('Change your restaurant location?'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
