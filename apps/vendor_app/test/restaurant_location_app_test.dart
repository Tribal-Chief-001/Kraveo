import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/partner_session.dart';
import 'package:vendor_app/screens/application_status_screen.dart';
import 'package:vendor_app/services/location/location_capture.dart';
import 'package:vendor_app/services/location/vendor_location_api.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/services/partner_auth_service.dart';
import 'package:vendor_app/services/push/push_controller.dart';
import 'package:vendor_app/services/push/push_ports.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/session/session_controller.dart';
import 'package:vendor_app/widgets/location_flow.dart';
import 'package:vendor_app/widgets/location_sheet.dart';
import 'package:vendor_app/widgets/push_status_cards.dart';
import 'support/fakes.dart';
import 'support/location_fakes.dart';
import 'support/push_fakes.dart';
import 'support/signed_in.dart';

/// "Set your restaurant location": the once-per-start sheet, the banner, saving, and the account-sheet row,
/// with the whole app wired to fakes (no GPS, no network).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  late LocationAuth auth;
  late FakeCapture capture;
  late FakeLocationApi api;
  late FakeBackend backend;
  late FakePermissions permissions;
  late FakeNotifications notifications;
  late PushController push;
  late List<Uri> opened;

  setUp(() {
    mockSignedInPrefs();
    OrderQueueService.clearQueue();
    auth = LocationAuth(restaurant(hasLocation: false));
    capture = FakeCapture.fix(accuracy: 12);
    api = FakeLocationApi();
    backend = FakeBackend();
    permissions = FakePermissions();
    notifications = FakeNotifications();
    opened = [];
    push = PushController(
      messaging: FakePushMessaging(),
      notifications: notifications,
      permissions: permissions,
      registry: FakeRegistry(),
      appVersion: () async => '1.6.0+11',
      retryDelays: const [],
    );
  });

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> launch(WidgetTester tester, {bool withPush = false, Size size = const Size(412, 915)}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(KraveoVendorApp(
      auth: auth,
      backend: backend,
      push: withPush ? push : null,
      socketFactory: FakeSocket.new,
      alarm: FakeAlarm(),
      locationServices: fakeServices(capture, opened: opened),
      locationApi: api,
    ));
    await settle(tester);
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
    push.dispose();
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

  Future<void> tapLabel(WidgetTester tester, String label) async {
    final f = find.widgetWithText(KButton, label);
    expect(f, findsOneWidget, reason: label);
    await tester.ensureVisible(f);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> openHelp(WidgetTester tester) async {
    await tester.tap(find.byIcon(LucideIcons.headset).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  final promptTitle = find.text('Set your restaurant location');

  group('prompt once per start', () {
    testWidgets('server says hasLocation:false: the sheet opens by itself, once; the banner stays after "Not now"', (tester) async {
      await launch(tester);
      expect(promptTitle, findsOneWidget);
      expect(find.byKey(kLocationDetectKey), findsOneWidget);
      expect(capture.detects, 0, reason: 'nothing is read until the owner taps Detect');

      await tapKey(tester, kLocationSkipKey);
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      expect(find.textContaining('Riders cannot find you until this is done'), findsOneWidget);

      // Something changes in the profile (and the app listens again): the sheet does not come back by itself.
      auth.profile = restaurant(hasLocation: false, lat: 1, lng: 1);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await settle(tester);
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('hasLocation:true: no sheet, no banner', (tester) async {
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await launch(tester);
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('an older server that sends no location fields: nobody is nagged (and there is no settings row)', (tester) async {
      auth.profile = restaurant(); // hasLocation unknown
      await launch(tester);
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      await openHelp(tester);
      expect(find.byKey(kLocationRowKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('a pending application: the sheet and the banner show on the status screen too', (tester) async {
      auth.profile = restaurant(approval: PartnerApproval.pending, hasLocation: false);
      await launch(tester);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(promptTitle, findsOneWidget);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      await tapKey(tester, kLocationBannerActionKey);
      expect(promptTitle, findsOneWidget);
      await tapKey(tester, kLocationSkipKey);
      await unmount(tester);
    });

    testWidgets('rejected or suspended: nothing about location (the server would refuse the save)', (tester) async {
      auth.profile = restaurant(approval: PartnerApproval.rejected, hasLocation: false);
      await launch(tester);
      expect(find.byType(ApplicationStatusScreen), findsOneWidget);
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('the banner is the way back in after "Not now"', (tester) async {
      await launch(tester);
      await tapKey(tester, kLocationSkipKey);
      await tapKey(tester, kLocationBannerActionKey);
      expect(promptTitle, findsOneWidget);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      await unmount(tester);
    });
  });

  group('saving', () {
    testWidgets('Detect -> check the result -> Save: PUT with lat/lng/accuracy, the profile is refreshed, the banner goes', (tester) async {
      await launch(tester);
      final before = auth.profileCalls;
      await tapKey(tester, kLocationDetectKey);
      expect(find.byKey(kLocationCoordsKey), findsOneWidget);
      expect(api.calls, isEmpty, reason: 'nothing is saved before the owner confirms');
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await tapKey(tester, kLocationAcceptKey);
      await settle(tester);

      expect(api.calls.single, (lat: kKitchenLat, lng: kKitchenLng, accuracyM: 12.0));
      expect(auth.profileCalls, greaterThan(before), reason: 'the profile is re-read after saving');
      expect(promptTitle, findsNothing);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      expect(find.textContaining('Restaurant location saved'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('the pin shows in the app at once even if the profile re-read cannot reach Kraveo', (tester) async {
      await launch(tester);
      await tapKey(tester, kLocationDetectKey);
      auth.unreachable = true;
      await tapKey(tester, kLocationAcceptKey);
      await settle(tester);
      expect(api.calls, hasLength(1));
      expect(find.byKey(kLocationBannerKey), findsNothing);
      expect(promptTitle, findsNothing);
      await unmount(tester);
    });

    testWidgets('the server refuses (400 with a message): the message is shown, nothing changes, the banner stays', (tester) async {
      api.answers.add(const ApiResult.failure(ApiFailure.invalid, message: 'The location must be within 3 km of the campus.', statusCode: 400));
      await launch(tester);
      await tapKey(tester, kLocationDetectKey);
      await tapKey(tester, kLocationAcceptKey);
      expect(find.textContaining('The location must be within 3 km of the campus.'), findsOneWidget);
      expect(find.byKey(kLocationSaveErrorKey), findsOneWidget, reason: 'the sheet stays so the owner can retry');
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      expect(find.textContaining('Restaurant location saved'), findsNothing);
      await unmount(tester);
    });

    testWidgets('no network: a plain bilingual message, then a retry saves', (tester) async {
      api.answers.add(const ApiResult.failure(ApiFailure.offline));
      await launch(tester);
      await tapKey(tester, kLocationDetectKey);
      await tapKey(tester, kLocationAcceptKey);
      expect(find.textContaining('No internet'), findsOneWidget);
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await tapKey(tester, kLocationAcceptKey);
      await settle(tester);
      expect(api.calls, hasLength(2));
      expect(find.byKey(kLocationBannerKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('a spot outside the campus is never sent to the server', (tester) async {
      capture = FakeCapture.fix(accuracy: 8, lat: 23.2599, lng: 77.4126);
      await launch(tester);
      await tapKey(tester, kLocationDetectKey);
      expect(find.byKey(kLocationOutsideKey), findsOneWidget);
      expect(api.calls, isEmpty);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      await unmount(tester);
    });
  });

  group('account sheet', () {
    testWidgets('with a location: "Update restaurant location" asks to confirm before it changes where riders go', (tester) async {
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await launch(tester);
      await openHelp(tester);
      expect(find.text('Update restaurant location'), findsOneWidget);
      await tapKey(tester, kLocationRowKey);
      expect(find.text('Update restaurant location'), findsOneWidget, reason: 'the sheet title');
      await tapKey(tester, kLocationDetectKey);
      await tapKey(tester, kLocationAcceptKey);
      expect(find.text('Change your restaurant location?'), findsOneWidget);
      expect(api.calls, isEmpty);
      await tapLabel(tester, 'Go back');
      expect(api.calls, isEmpty);
      await tapKey(tester, kLocationAcceptKey);
      await tapLabel(tester, 'Yes, change it');
      await settle(tester);
      expect(api.calls, hasLength(1));
      expect(find.textContaining('Restaurant location saved'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('without a location the same row reads "Set restaurant location"', (tester) async {
      await launch(tester);
      await tapKey(tester, kLocationSkipKey);
      await openHelp(tester);
      expect(find.text('Set restaurant location'), findsOneWidget);
      expect(find.text('Update restaurant location'), findsNothing);
      await unmount(tester);
    });
  });

  group('one notice at a time (with push)', () {
    testWidgets('notifications blocked: the notification banner keeps the slot, the location banner waits', (tester) async {
      permissions.access = NotificationAccess.blocked;
      await launch(tester, withPush: true);
      expect(find.text('Hear every new order'), findsNothing, reason: 'blocked: no explainer, the banner is shown instead');
      expect(promptTitle, findsOneWidget, reason: 'the once-per-start sheet is modal and does not take banner space');
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kNotificationBannerKey), findsOneWidget);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('notifications fine: the location banner replaces the one-time battery hint until the pin exists', (tester) async {
      await launch(tester, withPush: true);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      expect(find.byKey(kBatteryCardKey), findsNothing);
      expect(find.byKey(kNotificationBannerKey), findsNothing);

      await tapKey(tester, kLocationBannerActionKey);
      await tapKey(tester, kLocationDetectKey);
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await tapKey(tester, kLocationAcceptKey);
      await settle(tester);
      expect(find.byKey(kLocationBannerKey), findsNothing);
      expect(find.byKey(kBatteryCardKey), findsOneWidget, reason: 'the battery hint is next in line');
      await unmount(tester);
    });

    testWidgets('never asked about notifications: the explanation comes first, the location sheet only after it', (tester) async {
      permissions.access = NotificationAccess.denied;
      permissions.afterRequest = NotificationAccess.granted;
      await launch(tester, withPush: true);
      expect(find.text('Hear every new order'), findsOneWidget);
      expect(promptTitle, findsNothing, reason: 'one sheet at a time');
      await tapLabel(tester, 'Allow notifications');
      await settle(tester);
      expect(find.text('Hear every new order'), findsNothing);
      expect(promptTitle, findsOneWidget);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kLocationBannerKey), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('"Not now" on the notification explanation still leads to the location sheet', (tester) async {
      permissions.access = NotificationAccess.denied;
      await launch(tester, withPush: true);
      await tapLabel(tester, 'Not now');
      await settle(tester);
      expect(promptTitle, findsOneWidget);
      await tapKey(tester, kLocationSkipKey);
      expect(find.byKey(kNotificationBannerKey), findsOneWidget, reason: 'notification banner has the slot');
      await unmount(tester);
    });
  });

  testWidgets('home and sheets do not overflow at 360x640 with 1.3x text', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await launch(tester, withPush: true, size: const Size(360, 640));
    expect(tester.takeException(), isNull);
    await tapKey(tester, kLocationSkipKey);
    expect(find.byKey(kLocationBannerKey), findsOneWidget);
    expect(tester.takeException(), isNull);
    await openHelp(tester);
    expect(tester.takeException(), isNull);
    await unmount(tester);
  });

  group('session controller', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('the prompt flag: login asks again, sign-up does not pop a sheet right away, logout clears it', () async {
      final c = SessionController(auth: auth, locationApi: api);
      expect(c.locationPromptShown, isFalse);
      await c.login('9811100001', 'x');
      c.locationPromptShown = true;
      await c.login('9811100001', 'x');
      expect(c.locationPromptShown, isFalse, reason: 'a new login is asked once more');
      await c.signUp(const PartnerSignupForm(ownerName: 'A B', phone: '9811100001', password: 'Passw0rd!x', restaurantName: 'X Y', address: 'Gate 2'));
      expect(c.locationPromptShown, isTrue);
      await c.logout();
      expect(c.locationPromptShown, isFalse);
      c.dispose();
    });

    test('saveRestaurantLocation: success shows the pin locally and re-reads the profile; failure changes nothing', () async {
      final c = SessionController(auth: auth, locationApi: api);
      await c.login('9811100001', 'x');
      expect(c.session!.needsLocation, isTrue);
      api.answers.add(const ApiResult.failure(ApiFailure.invalid, message: 'nope', statusCode: 400));
      final bad = await c.saveRestaurantLocation(const LocationFix(kKitchenLat, kKitchenLng, 12));
      expect(bad.ok, isFalse);
      expect(c.session!.needsLocation, isTrue);

      // Even if the re-read says "still none" (stale server), a re-read is attempted and the server's word wins.
      final calls = auth.profileCalls;
      final ok = await c.saveRestaurantLocation(const LocationFix(kKitchenLat, kKitchenLng, 12));
      expect(ok.ok, isTrue);
      expect(auth.profileCalls, calls + 1);
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      await c.refreshApproval();
      expect(c.session!.hasLocation, isTrue);
      expect(c.session!.lat, kKitchenLat);
      c.dispose();
    });

    test('a refresh that only changes the location notifies listeners (so the banner updates)', () async {
      final c = SessionController(auth: auth, locationApi: api);
      await c.login('9811100001', 'x');
      var notified = 0;
      c.addListener(() => notified++);
      auth.profile = restaurant(hasLocation: true, lat: kKitchenLat, lng: kKitchenLng);
      expect(await c.refreshApproval(), isTrue);
      expect(notified, 1);
      c.dispose();
    });
  });

  group('PartnerSession location fields', () {
    test('parsed from /partner/me, kept across a stored round trip', () {
      final s = PartnerSession.fromMeJson({
        'user': {'id': 'u1', 'name': 'Owner'},
        'vendor': {
          'id': 'v1',
          'name': 'Dhaba',
          'hasLocation': true,
          'lat': 23.0741,
          'lng': 76.8567,
          'locationSource': 'DEVICE',
          'locationSetAt': '2026-10-05T10:00:00.000Z',
          'locationAccuracyM': 12.5,
        },
      })!;
      expect(s.hasLocation, isTrue);
      expect(s.needsLocation, isFalse);
      expect(s.lat, 23.0741);
      expect(s.locationSource, 'DEVICE');
      expect(s.locationSetAt, DateTime.utc(2026, 10, 5, 10));
      expect(s.locationAccuracyM, 12.5);
      final back = PartnerSession.fromStoredJson(jsonDecode(jsonEncode(s.toJson())))!;
      expect(back.hasLocation, isTrue);
      expect(back.lng, 76.8567);
      expect(back.locationSetAt, s.locationSetAt);
    });

    test('an old server without the fields: hasLocation stays unknown (null), never "false"', () {
      final s = PartnerSession.fromMeJson({
        'user': {'id': 'u1', 'name': 'Owner'},
        'vendor': {'id': 'v1', 'name': 'Dhaba', 'lat': 23.0768, 'lng': 76.8524},
      })!;
      expect(s.hasLocation, isNull);
      expect(s.needsLocation, isFalse);
    });

    test('hasLocation:false is "needs location"; a non-boolean is ignored', () {
      expect(PartnerSession.fromMeJson({'user': {'id': 'u1'}, 'vendor': {'id': 'v', 'hasLocation': false}})!.needsLocation, isTrue);
      expect(PartnerSession.fromMeJson({'user': {'id': 'u1'}, 'vendor': {'id': 'v', 'hasLocation': 'false'}})!.hasLocation, isNull);
    });

    test('a session stored by an older app version (no location keys) restores with unknown location', () {
      final s = PartnerSession.fromStoredJson({'userId': 'u1', 'name': 'A', 'vendorId': 'v1', 'approval': 'approved'})!;
      expect(s.hasLocation, isNull);
    });
  });

  group('PUT /partner/vendor/location', () {
    setUp(() async {
      await VendorApiService.saveToken('jwt-1');
    });

    Future<ApiResult<SavedLocation>> save(MockClientHandler handler) =>
        HttpVendorLocationApi(client: MockClient(handler)).save(lat: kKitchenLat, lng: kKitchenLng, accuracyM: 12.34);

    test('sends the caller\'s coordinates with the JWT and no restaurant id, and reads the answer', () async {
      late http.Request seen;
      final r = await save((req) async {
        seen = req;
        return http.Response(
            jsonEncode({
              'success': true,
              'data': {'lat': kKitchenLat, 'lng': kKitchenLng, 'hasLocation': true, 'locationSource': 'DEVICE', 'locationSetAt': '2026-10-05T10:00:00.000Z', 'locationAccuracyM': 12.3}
            }),
            200);
      });
      expect(seen.method, 'PUT');
      expect(seen.url.path, endsWith('/partner/vendor/location'));
      expect(seen.headers['Authorization'], 'Bearer jwt-1');
      expect(jsonDecode(seen.body), {'lat': kKitchenLat, 'lng': kKitchenLng, 'accuracyM': 12.3});
      expect(r.ok, isTrue);
      expect(r.data!.source, 'DEVICE');
      expect(r.data!.accuracyM, 12.3);
      expect(r.data!.setAt, DateTime.utc(2026, 10, 5, 10));
    });

    test('400 carries the server message; the wording shown is that message', () async {
      final r = await save((_) async => http.Response(jsonEncode({'success': false, 'message': 'The location must be within 3 km of the campus.', 'field': 'location'}), 400));
      expect(r.failure, ApiFailure.invalid);
      expect(locationSaveFailureText(r), 'The location must be within 3 km of the campus.');
    });

    test('403 (not allowed), 429 (rate limit), 404 (old server), 500 and no network all give plain wording', () async {
      var r = await save((_) async => http.Response(jsonEncode({'message': 'Forbidden', 'code': 'PARTNER_NOT_APPROVED'}), 403));
      expect(r.failure, ApiFailure.notApproved);
      expect(locationSaveFailureText(r), contains('Forbidden'));
      r = await save((_) async => http.Response(jsonEncode({'message': 'Too many location updates. Try again in an hour.'}), 429));
      expect(r.failure, ApiFailure.rateLimited);
      expect(locationSaveFailureText(r), contains('Too many'));
      r = await save((_) async => http.Response('Not found', 404));
      expect(r.failure, ApiFailure.notFound);
      expect(locationSaveFailureText(r), contains('cannot save a location yet'));
      r = await save((_) async => http.Response('oops', 500));
      expect(r.failure, ApiFailure.server);
      expect(locationSaveFailureText(r), contains('Kraveo had a problem'));
      r = await save((_) async => throw http.ClientException('down'));
      expect(r.failure, ApiFailure.offline);
      expect(locationSaveFailureText(r), contains('No internet'));
    });

    test('401 sends the app to the login screen like every other call', () async {
      var expired = 0;
      VendorApiService.onUnauthorized = () => expired++;
      addTearDown(() => VendorApiService.onUnauthorized = null);
      final r = await save((_) async => http.Response('{}', 401));
      expect(r.failure, ApiFailure.unauthorized);
      expect(expired, 1);
    });

    test('a 200 without readable data still counts as saved, with what was sent', () async {
      final r = await save((_) async => http.Response('{}', 200));
      expect(r.ok, isTrue);
      expect(r.data!.lat, kKitchenLat);
    });
  });
}
