import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:vendor_app/models/partner_session.dart';
import 'package:vendor_app/screens/signup_screen.dart';
import 'package:vendor_app/services/location/location_capture.dart';
import 'package:vendor_app/services/location/location_scope.dart';
import 'package:vendor_app/services/partner_auth_service.dart';
import 'package:vendor_app/widgets/location_sheet.dart';
import 'support/location_fakes.dart';

/// "Use my current location" on the create-account form.
void main() {
  late FakeCapture capture;
  late List<PartnerSignupForm> sent;
  SignupResult Function(PartnerSignupForm) answer = (_) => const SignupResult.failure(SignupFailure.server);

  setUp(() {
    sent = [];
    answer = (_) => const SignupResult.failure(SignupFailure.server);
  });

  Future<void> pump(WidgetTester tester, FakeCapture cap, {Size size = const Size(412, 915), double textScale = 1.0, PartnerSession? existing}) async {
    capture = cap;
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(LocationScope(
      services: fakeServices(cap),
      child: MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
        home: SignupScreen(
          existing: existing,
          onSubmit: (form) async {
            sent.add(form);
            return answer(form);
          },
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 600));
  }

  Future<void> tapKey(WidgetTester tester, Key key) async {
    final f = find.byKey(key);
    expect(f, findsOneWidget, reason: '$key');
    await tester.ensureVisible(f);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> fill(WidgetTester tester) async {
    Future<void> type(String key, String text) async {
      final f = find.byKey(ValueKey(key));
      await tester.ensureVisible(f);
      await tester.pump();
      await tester.enterText(f, text);
      await tester.pump();
    }

    await type('restaurant-field', 'Shiv Shakti Dhaba');
    await type('address-field', 'Ashta road, near Gate 2');
    await type('owner-field', 'Ramesh Kumar');
    await type('phone-field', '9811100001');
    await type('password-field', 'Passw0rd!x');
  }

  const button = ValueKey('signup-location-button');
  const chip = ValueKey('signup-location-chip');
  const change = ValueKey('signup-location-change');

  testWidgets('a "Use my current location" button sits under the address, with a bilingual optional hint', (tester) async {
    await pump(tester, FakeCapture.fix());
    expect(find.byKey(button), findsOneWidget);
    expect(find.text('Use my current location'), findsOneWidget);
    expect(find.byKey(chip), findsNothing);
    expect(find.textContaining('Optional: riders use it'), findsOneWidget);
    final addressY = tester.getTopLeft(find.byKey(const ValueKey('address-field'))).dy;
    final buttonY = tester.getTopLeft(find.byKey(button)).dy;
    expect(buttonY, greaterThan(addressY));
    expect(capture.detects, 0, reason: 'location is read only when the owner taps');
  });

  testWidgets('detect -> check -> "Use this location": a chip "Location captured (about 12 m)" with Change; the signup carries lat/lng/accuracy', (tester) async {
    await pump(tester, FakeCapture.fix(accuracy: 12.4));
    await tapKey(tester, button);
    expect(find.textContaining('We only read your location when you tap Detect'), findsOneWidget);
    await tapKey(tester, kLocationDetectKey);
    expect(find.byKey(kLocationCoordsKey), findsOneWidget);
    await tapKey(tester, kLocationAcceptKey);

    expect(find.byKey(chip), findsOneWidget);
    expect(find.text('Location captured (about 12 m)'), findsOneWidget);
    expect(find.byKey(button), findsNothing);
    expect(find.byKey(change), findsOneWidget);

    await fill(tester);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(sent, hasLength(1));
    final json = sent.single.toSignupJson();
    expect(json['lat'], kKitchenLat);
    expect(json['lng'], kKitchenLng);
    expect(json['locationAccuracyM'], 12.4);
    expect(json['role'], 'VENDOR');
  });

  testWidgets('without a location the form works as before and sends no location keys', (tester) async {
    await pump(tester, FakeCapture.fix());
    await fill(tester);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(sent, hasLength(1));
    final json = sent.single.toSignupJson();
    expect(json.containsKey('lat'), isFalse);
    expect(json.containsKey('lng'), isFalse);
    expect(json.containsKey('locationAccuracyM'), isFalse);
    expect(sent.single.hasLocation, isFalse);
  });

  testWidgets('Change detects again and replaces the spot', (tester) async {
    await pump(tester, FakeCapture([
      const CaptureResult.fix(LocationFix(kKitchenLat, kKitchenLng, 30), weak: false),
      const CaptureResult.fix(LocationFix(23.0750, 76.8570, 9), weak: false),
    ]));
    await tapKey(tester, button);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationAcceptKey);
    expect(find.text('Location captured (about 30 m)'), findsOneWidget);
    await tapKey(tester, change);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationAcceptKey);
    expect(find.text('Location captured (about 9 m)'), findsOneWidget);
    await fill(tester);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(sent.single.lat, 23.0750);
  });

  testWidgets('detection fails: the reason is explained and "Continue without" leaves the form as it was', (tester) async {
    await pump(tester, FakeCapture([const CaptureResult.problem(LocationProblem.permissionDeniedForever)]));
    await tapKey(tester, button);
    await tapKey(tester, kLocationDetectKey);
    expect(find.text('Location is blocked for Kraveo'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    await tapKey(tester, kLocationSkipKey);
    expect(find.text('Continue without'), findsNothing, reason: 'the sheet is closed');
    expect(find.byKey(chip), findsNothing);
    expect(find.byKey(button), findsOneWidget);
    await fill(tester);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(sent.single.hasLocation, isFalse);
  });

  testWidgets('the sheet offers "Continue without" wording on the form', (tester) async {
    await pump(tester, FakeCapture.fix());
    await tapKey(tester, button);
    expect(find.text('Continue without'), findsOneWidget);
    expect(find.text('बिना लोकेशन के आगे बढ़ें'), findsOneWidget);
  });

  testWidgets('a spot outside the campus is shown but not taken', (tester) async {
    await pump(tester, FakeCapture.fix(accuracy: 8, lat: 23.2599, lng: 77.4126));
    await tapKey(tester, button);
    await tapKey(tester, kLocationDetectKey);
    expect(find.byKey(kLocationOutsideKey), findsOneWidget);
    expect(find.byKey(kLocationAcceptKey), findsNothing);
    await tapKey(tester, kLocationSkipKey);
    expect(find.byKey(chip), findsNothing);
  });

  testWidgets('the server refuses the location (400 field location): the chip is removed and the reason is shown; the account can be created without it', (tester) async {
    answer = (f) => f.hasLocation
        ? const SignupResult.failure(SignupFailure.invalid, field: 'location', message: 'The location must be within 3 km of the campus.')
        : const SignupResult.success(token: 'jwt', session: PartnerSession(userId: 'u1', name: 'A', approval: PartnerApproval.pending));
    await pump(tester, FakeCapture.fix());
    await tapKey(tester, button);
    await tapKey(tester, kLocationDetectKey);
    await tapKey(tester, kLocationAcceptKey);
    await fill(tester);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(find.byKey(const ValueKey('signup-problem')), findsOneWidget);
    expect(find.textContaining('The location must be within 3 km of the campus.'), findsOneWidget);
    expect(find.byKey(chip), findsNothing);
    expect(find.byKey(button), findsOneWidget);
    await tapKey(tester, const ValueKey('signup-button'));
    expect(sent, hasLength(2));
    expect(sent.last.hasLocation, isFalse);
  });

  testWidgets('editing an existing application does not show the button (the status screen handles location)', (tester) async {
    await pump(tester, FakeCapture.fix(), existing: restaurant(approval: PartnerApproval.pending));
    expect(find.byKey(button), findsNothing);
    expect(find.byKey(chip), findsNothing);
  });

  test('half a location is never sent', () {
    const onlyLat = PartnerSignupForm(ownerName: 'A B', phone: '9811100001', password: 'x', restaurantName: 'R S', address: 'A', lat: 23.07);
    expect(onlyLat.toSignupJson().containsKey('lat'), isFalse);
    const both = PartnerSignupForm(ownerName: 'A B', phone: '9811100001', password: 'x', restaurantName: 'R S', address: 'A', lat: 23.07, lng: 76.85);
    expect(both.toSignupJson()['lat'], 23.07);
    expect(both.toSignupJson().containsKey('locationAccuracyM'), isFalse);
    expect(both.toUpdateJson().containsKey('lat'), isFalse, reason: 'PUT /partner/application does not take a location');
  });

  testWidgets('no overflow at 360x640 with 1.3x text: form with the button, with the chip, and the sheet over it', (tester) async {
    await pump(tester, FakeCapture.fix(accuracy: 12), size: const Size(360, 640), textScale: 1.3);
    expect(tester.takeException(), isNull);
    await tapKey(tester, button);
    expect(tester.takeException(), isNull);
    await tapKey(tester, kLocationDetectKey);
    expect(tester.takeException(), isNull);
    await tapKey(tester, kLocationAcceptKey);
    expect(find.byKey(chip), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
