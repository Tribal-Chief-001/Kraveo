import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/screens/driver_home.dart';
import 'package:driver_app/screens/earnings_history.dart';
import 'package:driver_app/screens/runner_id_card_screen.dart';
import 'package:driver_app/screens/trip_logs.dart';
import 'package:driver_app/services/location_source.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'package:driver_app/state/rider_controller.dart';
import 'package:driver_app/widgets/gate_otp_dialog.dart';
import 'package:driver_app/widgets/pipeline_stepper.dart';
import 'package:driver_app/widgets/swipe_accept_card.dart';
import 'support/fake_rider.dart';

/// Small phone (360x640) at 1.3x text scale: the worst case drivers will hit.
Future<void> _smallPhone(WidgetTester tester, {double textScale = 1.3}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

Widget _app(Widget home) => MaterialApp(theme: KraveoTheme.driver(), home: home);

Future<void> _tapKey(WidgetTester tester, String d) async {
  await tester.tap(find.byKey(ValueKey('otp-key-$d')));
  await tester.pump();
}

Future<void> _enterPin(WidgetTester tester, String pin) async {
  for (final d in pin.split('')) {
    await _tapKey(tester, d);
  }
}

/// Real fonts, so text metrics match a device (the default test font is far wider).
Future<void> _loadFonts() async {
  Future<void> load(String family, String asset) async {
    final loader = FontLoader('packages/kraveo_ui/$family')..addFont(rootBundle.load('packages/kraveo_ui/assets/fonts/$asset'));
    await loader.load();
  }

  await load('Bricolage', 'BricolageGrotesque.ttf');
  await load('Jakarta', 'PlusJakartaSans.ttf');
}

/// Drags the slide-to-confirm thumb the full width in small steps.
Future<void> _slide(WidgetTester tester) async {
  final thumb = find.descendant(of: find.byType(KSlideToConfirm), matching: find.byType(Icon)).first;
  final g = await tester.startGesture(tester.getCenter(thumb));
  for (var i = 0; i < 12; i++) {
    await g.moveBy(const Offset(30, 0));
    await tester.pump(const Duration(milliseconds: 16));
  }
  await g.up();
  await tester.pump();
}

/// KReveal fades content in; taps on half-visible widgets silently miss in tests.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pump(const Duration(seconds: 2));
}

/// Lazily built list rows only exist once scrolled near: scroll until [f] is built.
Future<void> _reveal(WidgetTester tester, Finder f) async {
  if (f.evaluate().isEmpty) {
    await tester.scrollUntilVisible(f, 150, scrollable: find.byType(Scrollable).first);
  }
}

/// Scrolls the main list to its end (to check that something is NOT offered).
Future<void> _scrollToEnd(WidgetTester tester) async {
  await tester.drag(find.byType(Scrollable).first, const Offset(0, -3000));
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _tapVisible(WidgetTester tester, Finder f) async {
  await _reveal(tester, f);
  await tester.ensureVisible(f);
  await tester.pump(const Duration(milliseconds: 400));
  await tester.tap(f);
  await tester.pump();
}

/// A started controller over fakes. The caller must dispose it before the test ends.
Future<RiderController> _rider(FakeRider f, {List<OrderView> active = const []}) async {
  f.api.active = ApiResult.ok(active);
  final c = RiderController(f.services, myIds: {'u-rider'});
  await c.start();
  return c;
}

Future<void> _openDialog(WidgetTester tester, Future<OtpOutcome> Function(String) onSubmit, {bool locked = false, List<bool?>? result}) async {
  await tester.pumpWidget(_app(Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: TextButton(
          onPressed: () async {
            final r = await showDialog<bool>(
              context: context,
              builder: (_) => GateOtpDialog(orderRef: '#A1B2C3', customerName: 'Rahul', gateName: 'Block 2', onSubmit: onSubmit, initiallyLocked: locked),
            );
            result?.add(r);
          },
          child: const Text('open'),
        ),
      ),
    ),
  )));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(_loadFonts);
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('GateOtpDialog (server-verified)', () {
    testWidgets('incomplete, wrong with tries left, offline keeps digits, then delivered', (tester) async {
      await _smallPhone(tester);
      final sent = <String>[];
      final answers = <OtpOutcome>[
        const OtpOutcome(OtpOutcomeKind.wrong, attemptsLeft: 2),
        const OtpOutcome(OtpOutcomeKind.network),
        const OtpOutcome(OtpOutcomeKind.delivered),
      ];
      final results = <bool?>[];
      await _openDialog(tester, (code) async {
        sent.add(code);
        return answers.removeAt(0);
      }, result: results);

      expect(find.text('Customer code'), findsOneWidget);
      expect(find.textContaining('Demo'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      expect(find.text('Enter all 4 digits'), findsOneWidget);
      expect(sent, isEmpty);

      await _enterPin(tester, '9999');
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      expect(find.text('Wrong code. 2 tries left.'), findsOneWidget);

      // Backspace works.
      await _enterPin(tester, '48');
      await tester.tap(find.byKey(const ValueKey('otp-key-backspace')));
      await tester.pump();
      await _enterPin(tester, '821');
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      expect(find.text('No internet – the code was not checked. Try again.'), findsOneWidget);
      expect(find.text('4'), findsWidgets, reason: 'digits are kept for a safe retry');

      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      expect(find.text('Delivered'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(sent, ['9999', '4821', '4821']);
      expect(results, [true]);
      expect(find.text('Customer code'), findsNothing);
    });

    testWidgets('locked: tells the rider to call support and disables the keypad', (tester) async {
      await _smallPhone(tester);
      final sent = <String>[];
      await _openDialog(tester, (code) async {
        sent.add(code);
        return const OtpOutcome(OtpOutcomeKind.locked);
      });
      await _enterPin(tester, '1234');
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text(RiderController.supportMessage), findsOneWidget);
      expect(find.text('Close'), findsOneWidget);
      await _enterPin(tester, '5');
      expect(sent, ['1234']);
      expect(tester.takeException(), isNull);
    });
  });

  group('OfferCard (real pool order)', () {
    testWidgets('shows restaurant, drop, fee and age; never a customer; one tap accepts', (tester) async {
      await _smallPhone(tester);
      var accepted = 0;
      await tester.pumpWidget(_app(Scaffold(
          body: SingleChildScrollView(child: OfferCard(order: offer(), now: testNow, onAccepted: () => accepted++, onDeclined: () {})))));
      expect(find.text('₹30'), findsOneWidget);
      expect(find.text('Underdoggs Cafe'), findsOneWidget);
      expect(find.text('Block 4'), findsOneWidget);
      expect(find.textContaining('9 min ago'), findsOneWidget);
      expect(find.textContaining('Aman'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Accept with one tap'));
      await tester.pump();
      expect(accepted, 1);
    });

    testWidgets('slide-to-accept fires once; claiming shows progress and no accept controls', (tester) async {
      await _smallPhone(tester, textScale: 1.0);
      var accepted = 0;
      await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: OfferCard(order: offer(), now: testNow, onAccepted: () => accepted++)))));
      await _slide(tester);
      expect(accepted, 1);
      await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: OfferCard(order: offer(), now: testNow, claiming: true, onAccepted: () => accepted++)))));
      expect(find.text('Accepting…'), findsOneWidget);
      expect(find.byType(KSlideToConfirm), findsNothing);
    });
  });

  group('PipelineStepper', () {
    testWidgets('shows the four steps; the step comes from the server status', (tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const Scaffold(body: Padding(padding: EdgeInsets.all(20), child: PipelineStepper(currentStep: 1)))));
      for (final label in ['Go to\nrestaurant', 'Ride to\ndrop', 'At drop\npoint', 'Delivered']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
      expect(PipelineStepper.stepFor(OrderStatus.accepted), 0);
      expect(PipelineStepper.stepFor(OrderStatus.readyForPickup), 0);
      expect(PipelineStepper.stepFor(OrderStatus.pickedUp), 1);
      expect(PipelineStepper.stepFor(OrderStatus.arrivedAtGate), 2);
      expect(PipelineStepper.stepFor(OrderStatus.delivered), 3);
    });
  });

  group('ActiveDeliveryScreen at 360x640 and 1.3x text', () {
    for (final status in ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE']) {
      testWidgets('$status renders without overflow and offers only the allowed action', (tester) async {
        await _smallPhone(tester);
        final f = FakeRider();
        final c = await _rider(f, active: [order(status: status, phone: status == 'ARRIVED_AT_GATE' ? '+91 9876500000' : null)]);
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull);
        switch (status) {
          case 'ACCEPTED' || 'PREPARING':
            expect(find.text('Restaurant is still preparing'), findsOneWidget);
            expect(tester.widget<KButton>(find.byKey(const ValueKey('picked-up-disabled'))).onPressed, isNull);
            expect(find.byType(KSlideToConfirm), findsNothing);
            await _reveal(tester, find.byKey(const ValueKey('release-button')));
            expect(find.byKey(const ValueKey('release-button')), findsOneWidget);
          case 'READY_FOR_PICKUP':
            expect(find.text('Food is ready'), findsOneWidget);
            await _slide(tester);
            await tester.pump();
            expect(f.api.calls, contains('status:ord-1:PICKED_UP'));
            await tester.pump(const Duration(milliseconds: 400));
            expect(find.text('Ride to the drop point'), findsOneWidget);
          case 'PICKED_UP':
            expect(find.text('Prepaid order'), findsOneWidget);
            await _scrollToEnd(tester);
            expect(find.byKey(const ValueKey('release-button')), findsNothing);
            expect(find.textContaining('+91'), findsNothing);
          case 'ARRIVED_AT_GATE':
            expect(find.byKey(const ValueKey('enter-code-button')), findsOneWidget);
            await _reveal(tester, find.text('+91 9876500000'));
            expect(find.text('+91 9876500000'), findsOneWidget);
            expect(find.textContaining('4821'), findsNothing);
        }
        expect(tester.takeException(), isNull);
        c.dispose();
      });
    }

    testWidgets('code entry delivers through the server and shows the delivered notice', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE', phone: '+91 9876500000')]);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await _tapVisible(tester, find.byKey(const ValueKey('enter-code-button')));
      await tester.pumpAndSettle();
      await _enterPin(tester, '4821');
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(f.api.calls, contains('otp:ord-1:4821'));
      expect(find.text('Delivered'), findsOneWidget);
      expect(find.textContaining('Delivery fee ₹25'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('locked delivery shows the support message and a support button', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.onOtp = (_, __) => const ApiResult.fail(ApiFailure.locked, statusCode: 423, code: 'OTP_LOCKED');
      final c = await _rider(f, active: [order(status: 'ARRIVED_AT_GATE')]);
      await c.verifyOtp('0000');
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text(RiderController.supportMessage), findsOneWidget);
      expect(find.text('Call Kraveo support'), findsOneWidget);
      expect(find.byKey(const ValueKey('enter-code-button')), findsNothing);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('release asks first, then gives the job back', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      final c = await _rider(f, active: [order(status: 'ACCEPTED')]);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await _tapVisible(tester, find.byKey(const ValueKey('release-button')));
      await tester.pumpAndSettle();
      expect(find.text('Release this job?'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('confirm-release-button')));
      await tester.pumpAndSettle();
      expect(f.api.calls, contains('release:ord-1'));
      expect(find.text('No active delivery'), findsOneWidget);
      c.dispose();
    });

    for (final kind in ['cancelled', 'reassigned']) {
      testWidgets('$kind notice is clear and fits', (tester) async {
        await _smallPhone(tester);
        final f = FakeRider();
        final c = await _rider(f, active: [order(status: 'PICKED_UP')]);
        if (kind == 'cancelled') {
          f.api.active = ApiResult.ok([order(status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', cancelReason: 'Restaurant closed early', pickedUpAt: testNow, updatedAt: testNow)]);
        } else {
          f.api.active = const ApiResult.ok([]);
          f.api.orders['ord-1'] = const ApiResult.fail(ApiFailure.notFound, statusCode: 404, code: 'NOT_FOUND');
        }
        await c.pollNow();
        await tester.pumpWidget(_app(ActiveDeliveryScreen(controller: c, onGoHome: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        if (kind == 'cancelled') {
          expect(find.text('Stop – this order was cancelled'), findsOneWidget);
          expect(find.textContaining('Restaurant closed early'), findsOneWidget);
          expect(find.textContaining('Do not hand over the food'), findsOneWidget);
        } else {
          expect(find.text('This delivery was moved'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await tester.tap(find.byKey(const ValueKey('notice-done')));
        await tester.pump();
        expect(c.notice, isNull);
        c.dispose();
      });
    }
  });

  group('Earnings and trips from real history', () {
    List<OrderView> history() => [
          order(id: 'h1', status: 'DELIVERED', fee: 25, deliveredAt: testNow.subtract(const Duration(hours: 1)), vendorName: 'A very long restaurant name that keeps going'),
          order(id: 'h2', status: 'DELIVERED', fee: 30, deliveredAt: testNow.subtract(const Duration(days: 2))),
          order(id: 'h3', status: 'CANCELLED', fee: 40, cancelReason: 'Customer cancelled'),
        ];

    testWidgets('earnings shows delivery fees (not payouts), today and 7 days, no overflow', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.onHistory = (_) => ApiResult.ok(OrderPage(history(), null));
      final c = await _rider(f);
      await tester.pumpWidget(_app(EarningsHistoryScreen(controller: c)));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.text('DELIVERY FEES · LAST 7 DAYS'), findsOneWidget);
      expect(find.textContaining('Payout #'), findsNothing);
      expect(find.textContaining('Surge'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Today'));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.text('DELIVERY FEES TODAY'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c.dispose();
    });

    testWidgets('trips list real orders; empty and error states', (tester) async {
      await _smallPhone(tester);
      final f = FakeRider();
      f.api.onHistory = (_) => ApiResult.ok(OrderPage(history(), 'next'));
      final c = await _rider(f);
      await tester.pumpWidget(_app(TripLogsScreen(controller: c)));
      await _settle(tester);
      expect(find.text('#H1'), findsOneWidget);
      expect(find.text('Delivered'), findsWidgets);
      expect(find.text('Cancelled'), findsWidgets);
      expect(find.textContaining('#ord-8492'), findsNothing);
      expect(tester.takeException(), isNull);
      c.dispose();

      final empty = FakeRider();
      final c2 = await _rider(empty);
      await tester.pumpWidget(_app(TripLogsScreen(controller: c2)));
      await _settle(tester);
      expect(find.text('No trips here yet'), findsOneWidget);
      c2.dispose();

      final broken = FakeRider();
      broken.api.onHistory = (_) => const ApiResult.fail(ApiFailure.offline);
      final c3 = await _rider(broken);
      await tester.pumpWidget(_app(TripLogsScreen(controller: c3)));
      await _settle(tester);
      expect(find.text('Could not load your trips'), findsOneWidget);
      expect(tester.takeException(), isNull);
      c3.dispose();
    });
  });

  group('RunnerIdCardScreen', () {
    testWidgets('renders pass details', (tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const RunnerIdCardScreen()));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('Vikram Singh'), findsOneWidget);
      expect(find.text('VS'), findsOneWidget);
      expect(find.text('ID verified'), findsOneWidget);
      expect(find.text('RUN-8042'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('DriverHomeScreen with a fake Kraveo', () {
    Future<FakeRider> pumpHome(WidgetTester tester, {void Function(FakeRider f)? setup}) async {
      final f = FakeRider();
      setup?.call(f);
      await tester.pumpWidget(_app(DriverHomeScreen(services: f.services)));
      await tester.pump();
      await _settle(tester);
      return f;
    }

    testWidgets('starts off duty with no offers; a failed "go on duty" rolls back', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) {
        f.api.available = ApiResult.ok([offer()]);
        f.api.onDuty = (_) => const ApiResult.fail(ApiFailure.offline);
      });
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(find.text('You are off duty'), findsOneWidget);
      expect(find.text('Underdoggs Cafe'), findsNothing);

      await tester.tap(find.text('OFF DUTY'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(find.text('Could not go on duty – check internet'), findsOneWidget);
      expect(f.api.calls, isNot(contains('available')));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      expect(f.socket.disposed, isTrue);
    });

    testWidgets('on duty: real offers appear and vanish on order_unavailable; GPS problem is named', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) {
        f.api.available = ApiResult.ok([offer(id: 'a'), offer(id: 'b', vendorName: 'Southern Spice', drop: 'Girls Gate 1')]);
        f.location.reading = const LocationReading.problem(LocationProblem.permissionDenied);
      });
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);
      expect(find.text('ON DUTY'), findsOneWidget);
      expect(find.text('Allow location'), findsOneWidget);
      await _reveal(tester, find.text('NEW ORDERS (2)'));
      await _reveal(tester, find.text('Southern Spice'));
      expect(find.text('Southern Spice'), findsOneWidget);
      expect(find.textContaining('Aman'), findsNothing);
      expect(f.api.locations, isEmpty);
      expect(tester.takeException(), isNull);

      f.socket.emit(const OfferUnavailable('b'));
      await tester.pump();
      expect(find.text('Southern Spice'), findsNothing);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 3000));
      await tester.pump(const Duration(milliseconds: 400));
      await _reveal(tester, find.byKey(const ValueKey('offer-a')));
      expect(find.byKey(const ValueKey('offer-a')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('accept: server-confirmed claim opens the active delivery; ALREADY_TAKEN explains', (tester) async {
      await _smallPhone(tester);
      final f = await pumpHome(tester, setup: (f) {
        f.api.available = ApiResult.ok([offer(id: 'a'), offer(id: 'b')]);
        f.api.onClaim = (id) => id == 'a'
            ? const ApiResult.fail(ApiFailure.conflict, statusCode: 409, code: 'ALREADY_TAKEN')
            : ApiResult.ok(order(id: id, status: 'PREPARING'));
      });
      await tester.tap(find.text('OFF DUTY'));
      await _settle(tester);

      await _tapVisible(tester, find.byKey(const ValueKey('accept-a')));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Another rider took this order.'), findsOneWidget);
      expect(find.byKey(const ValueKey('accept-a')), findsNothing);

      await _tapVisible(tester, find.byKey(const ValueKey('accept-b')));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Go to the restaurant'), findsOneWidget);
      expect(find.text('Restaurant is still preparing'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Every tab still renders.
      for (final tab in [LucideIcons.wallet, LucideIcons.history, LucideIcons.house]) {
        await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(tab)));
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull, reason: 'tab $tab');
      }
      expect(find.text('IN PROGRESS'), findsOneWidget);
      expect(f.api.calls.where((x) => x.startsWith('claim')), ['claim:a', 'claim:b']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('restores a delivery in progress after a restart', (tester) async {
      await _smallPhone(tester);
      await pumpHome(tester, setup: (f) => f.api.active = ApiResult.ok([order(status: 'PICKED_UP')]));
      expect(find.text('IN PROGRESS'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(LucideIcons.bike)));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Ride to the drop point'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
