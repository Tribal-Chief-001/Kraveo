import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/config/support_config.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/screens/driver_home.dart';
import 'package:driver_app/screens/login_screen.dart';
import 'package:driver_app/services/navigation.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'package:driver_app/widgets/support_sheet.dart';
import 'support/fake_rider.dart';

/// Widget tests for the pre-demo bug-hunt fixes of the rider app (support/contact, calls, OTP lock, keypad,
/// duty confirmation, earnings placeholder).

class _FakeLauncher extends NavigationLauncher {
  bool result = true;
  final opened = <Uri>[];

  @override
  Future<bool> open(Uri uri) async {
    opened.add(uri);
    return result;
  }
}

Future<void> _smallPhone(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Widget _app(Widget home) => MaterialApp(theme: KraveoTheme.driver(), home: home);

Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

Future<void> _tapVisible(WidgetTester tester, Finder f) async {
  if (f.evaluate().isEmpty) await tester.scrollUntilVisible(f, 150, scrollable: find.byType(Scrollable).first);
  await tester.ensureVisible(f);
  await tester.pump(const Duration(milliseconds: 400));
  await tester.tap(f);
  await tester.pump();
}

Future<RiderController> _rider(FakeRider f, {List<OrderView> active = const []}) async {
  f.api.active = ApiResult.ok(active);
  final c = RiderController(f.services, myIds: {'u-rider'});
  await c.start();
  return c;
}

/// Records what the app copies to the clipboard.
List<String> _mockClipboard(WidgetTester tester) {
  final copied = <String>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  return copied;
}

late _FakeLauncher _launcher;

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    _launcher = _FakeLauncher();
    contactLauncher = _launcher;
  });
  tearDown(() => contactLauncher = const UrlNavigationLauncher());

  Future<FakeRider> pumpHome(WidgetTester tester, {void Function(FakeRider f)? setup}) async {
    final f = FakeRider();
    setup?.call(f);
    await tester.pumpWidget(_app(DriverHomeScreen(services: f.services)));
    await tester.pump();
    await _settle(tester);
    return f;
  }

  group('support and contact (DR-03, DR-04)', () {
    test('the placeholder phone number is gone; support is by email and 112 is for emergencies', () {
      expect(SupportConfig.email, 'kraveo.contact@gmail.com');
      expect(SupportConfig.emergencyNumber, '112');
      expect(telUri('+91 98765 00000').toString(), 'tel:+919876500000');
      expect(supportMailUri().toString(), 'mailto:kraveo.contact@gmail.com?subject=Kraveo%20rider%20support');
    });

    testWidgets('the red siren opens the support sheet: email address, an email button, and a separate "call 112"', (tester) async {
      await _smallPhone(tester);
      await pumpHome(tester);
      await tester.tap(find.bySemanticsLabel('Contact Kraveo support'));
      await tester.pumpAndSettle();
      expect(find.text('Kraveo support'), findsOneWidget);
      expect(find.text(SupportConfig.email), findsOneWidget);
      expect(find.text('Email Kraveo support'), findsOneWidget);
      expect(find.text('Emergency: call 112'), findsOneWidget);
      expect(find.textContaining('98765 43214'), findsNothing);
      expect(find.textContaining('+91'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(find.byKey(const ValueKey('emergency-112-button')));
      await tester.pumpAndSettle();
      expect(_launcher.opened.map((u) => u.toString()), ['tel:112']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('"Email Kraveo support" opens a mail; with no mail app the address is copied and the rider is told', (tester) async {
      await _smallPhone(tester);
      final copied = _mockClipboard(tester);
      await pumpHome(tester);
      await tester.tap(find.bySemanticsLabel('Contact Kraveo support'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('email-support-button')));
      await tester.pumpAndSettle();
      expect(_launcher.opened.single.scheme, 'mailto');
      expect(_launcher.opened.single.path, SupportConfig.email);
      expect(find.textContaining('No email app found'), findsNothing);

      _launcher
        ..result = false
        ..opened.clear();
      await tester.tap(find.bySemanticsLabel('Contact Kraveo support'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('email-support-button')));
      await tester.pumpAndSettle();
      expect(copied, [SupportConfig.email]);
      expect(find.textContaining('No email app found'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the customer "Call" button dials; with no dialer the number is copied with a snackbar', (tester) async {
      await _smallPhone(tester);
      final copied = _mockClipboard(tester);
      final f = FakeRider();
      final c = await _rider(f, active: [order(status: 'PICKED_UP', phone: '+91 9876500000')]);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));

      await _tapVisible(tester, find.byKey(const ValueKey('call-customer-button')));
      await tester.pump();
      expect(_launcher.opened.map((u) => u.toString()), ['tel:+919876500000']);
      expect(find.textContaining('Number copied'), findsNothing);

      _launcher.result = false;
      await tester.tap(find.byKey(const ValueKey('call-customer-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(copied, ['+91 9876500000']);
      expect(find.text('Could not open the phone app. Number copied: +91 9876500000'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('a locked delivery and a cancelled order offer email, not a phone call', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.locked, statusCode: 423, code: 'OTP_LOCKED');
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]);
      await c.verifyOtp('0000');
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.scrollUntilVisible(find.byKey(const ValueKey('locked-support-button')), 150, scrollable: find.byType(Scrollable).first);
      expect(find.text('Email Kraveo support'), findsOneWidget);
      expect(find.text('Call Kraveo support'), findsNothing);
      await _tapVisible(tester, find.byKey(const ValueKey('locked-support-button')));
      await tester.pumpAndSettle();
      expect(find.text(SupportConfig.email), findsOneWidget);
      expect(find.text('Emergency: call 112'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('the login screen shows the support email and opens a mail on tap', (tester) async {
      await tester.pumpWidget(_app(LoginScreen(onSubmit: (_, __) async => throw UnimplementedError())));
      await tester.pump(const Duration(seconds: 2));
      expect(find.textContaining('Forgot password? Ask Kraveo support'), findsOneWidget);
      expect(find.text('Email ${SupportConfig.email}'), findsOneWidget);
      await _tapVisible(tester, find.byKey(const ValueKey('login-support-card')));
      await tester.pump();
      expect(_launcher.opened.single.scheme, 'mailto');
    });
  });

  test('the manifest does not allow Android backups of the sign-in token (DR-19)', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(manifest, contains('android:allowBackup="false"'));
    expect(manifest, contains('android:dataExtractionRules="@xml/data_extraction_rules"'));
    final rules = File('android/app/src/main/res/xml/data_extraction_rules.xml').readAsStringSync();
    expect(rules, contains('<exclude domain="sharedpref"/>'));
    expect(rules, contains('<cloud-backup>'));
    expect(rules, contains('<device-transfer>'));
  });

  group('OTP lock and keypad (DR-01, DR-21)', () {
    testWidgets('locked: "Try the code again" opens an unlocked keypad; a newer copy brings back the normal button', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.locked, statusCode: 423, code: 'OTP_LOCKED');
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]);
      await c.verifyOtp('0000');
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byKey(const ValueKey('enter-code-button')), findsNothing);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('retry-code-button')), 150, scrollable: find.byType(Scrollable).first);
      expect(find.byKey(const ValueKey('retry-code-button')), findsOneWidget);

      await _tapVisible(tester, find.byKey(const ValueKey('retry-code-button')));
      await tester.pumpAndSettle();
      expect(find.text('Verify & deliver'), findsOneWidget, reason: 'a 423 is free, so the keypad is offered');
      expect(find.text('This delivery is locked after too many wrong codes.'), findsNothing);
      await tester.tap(find.byIcon(LucideIcons.x).first);
      await tester.pumpAndSettle();

      // Baseline copy (the 5th wrong code bumped updatedAt), then the admin's reset.
      f.socket.emit(OrderUpdated(order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000', updatedAt: testNow.subtract(const Duration(minutes: 3)))));
      await tester.pump();
      expect(c.activeLocked, isTrue, reason: 'the first copy after the lock is only the baseline');
      f.socket.emit(OrderUpdated(order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000', updatedAt: testNow.subtract(const Duration(minutes: 1)))));
      await tester.pump(const Duration(milliseconds: 400));
      expect(c.activeLocked, isFalse);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 3000));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.scrollUntilVisible(find.byKey(const ValueKey('enter-code-button')), 150, scrollable: find.byType(Scrollable).first);
      expect(find.byKey(const ValueKey('enter-code-button')), findsOneWidget);
      expect(find.byKey(const ValueKey('retry-code-button')), findsNothing);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('the keypad closes when the order is cancelled under it', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await _tapVisible(tester, find.byKey(const ValueKey('enter-code-button')));
      await tester.pumpAndSettle();
      expect(find.text('Customer code'), findsOneWidget);

      f.socket.emit(OrderUpdated(order(status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'CUSTOMER', updatedAt: testNow)));
      await tester.pumpAndSettle();
      expect(find.text('Customer code'), findsNothing);
      expect(find.text('Stop – this order was cancelled'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('the keypad closes when the order is moved away from the rider', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await _tapVisible(tester, find.byKey(const ValueKey('enter-code-button')));
      await tester.pumpAndSettle();
      expect(find.text('Customer code'), findsOneWidget);

      // Missing from the rider's own list and 404 on the order: reassigned.
      f.api.active = const ApiResult.ok([]);
      await c.pollNow();
      await tester.pumpAndSettle();
      expect(find.text('Customer code'), findsNothing);
      expect(find.text('This delivery was moved'), findsOneWidget);
      c.dispose();
    });
  });

  group('duty with an order in hand (DR-06)', () {
    testWidgets('switching off asks first; "Stay on duty" keeps it; going off anyway keeps the location line', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) => f.api.active = ApiResult.ok([order(status: 'ACCEPTED')]));
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);
      expect(find.text('ON DUTY'), findsOneWidget);

      await tester.tap(find.text('ON DUTY'));
      await tester.pumpAndSettle();
      expect(find.text('Stay on duty?'), findsOneWidget);
      expect(find.textContaining('You are carrying an order.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('stay-on-duty-button')));
      await tester.pumpAndSettle();
      expect(find.text('ON DUTY'), findsOneWidget);
      expect(f.api.calls, isNot(contains('duty:false')));

      await tester.tap(find.text('ON DUTY'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const ValueKey('go-off-duty-anyway-button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('go-off-duty-anyway-button')));
      await _settle(tester);
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(f.api.calls, contains('duty:false'));
      expect(find.byKey(const ValueKey('location-line')), findsOneWidget, reason: 'still sharing with the customer');
      expect(find.text('Live location is being shared'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('with no order in hand, switching off needs no question', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester);
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);
      await tester.tap(find.text('ON DUTY'));
      await _settle(tester);
      expect(find.text('Stay on duty?'), findsNothing);
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(f.api.calls, contains('duty:false'));
      expect(find.byKey(const ValueKey('location-line')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('Home earnings (DR-20)', () {
    testWidgets('a failed history call shows "—" with a retry hint, not "₹0"; retry loads it', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) => f.api.onHistory = (_) => const ApiResult.fail(ApiFailure.offline));
      expect(find.byKey(const ValueKey('earnings-unavailable')), findsOneWidget);
      expect(find.text('Could not load. Tap to retry'), findsOneWidget);
      expect(find.text('₹0'), findsNothing);

      f.api.onHistory = (_) => ApiResult.ok(OrderPage([order(id: 'd1', status: 'DELIVERED', updatedAt: testNow, deliveredAt: testNow)], null));
      await tester.tap(find.byKey(const ValueKey('earnings-retry')));
      await _settle(tester);
      expect(find.byKey(const ValueKey('earnings-unavailable')), findsNothing);
      expect(find.text('Could not load. Tap to retry'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a loaded history with no deliveries is a real zero', (tester) async {
      await _smallPhone(tester);
      await pumpHome(tester);
      expect(find.byKey(const ValueKey('earnings-unavailable')), findsNothing);
      expect(find.text('Could not load. Tap to retry'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
