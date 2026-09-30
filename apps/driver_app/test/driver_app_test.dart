import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/trip_model.dart';
import 'package:driver_app/screens/active_delivery.dart';
import 'package:driver_app/screens/driver_home.dart';
import 'package:driver_app/screens/earnings_history.dart';
import 'package:driver_app/screens/runner_id_card_screen.dart';
import 'package:driver_app/screens/trip_logs.dart';
import 'package:driver_app/widgets/gate_otp_dialog.dart';
import 'package:driver_app/widgets/pipeline_stepper.dart';
import 'package:driver_app/widgets/swipe_accept_card.dart';

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

void main() {
  setUpAll(_loadFonts);
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('Driver App - GateOtpDialog', () {
    testWidgets('keypad flow: incomplete, wrong PIN, then correct PIN', (WidgetTester tester) async {
      await _smallPhone(tester);
      String? verifiedWith;

      await tester.pumpWidget(_app(Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => showDialog(
                context: context,
                builder: (_) => GateOtpDialog(
                  expectedOtp: '4829',
                  orderId: '#ORD-99',
                  customerName: 'Rahul',
                  onVerified: (otp) => verifiedWith = otp,
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      )));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Gate PIN'), findsOneWidget);
      // No demo PIN may ever be rendered.
      expect(find.textContaining('Demo'), findsNothing);
      expect(find.textContaining('4829'), findsNothing);
      expect(tester.takeException(), isNull);

      // Verify with nothing entered.
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump();
      expect(find.text('Please enter complete 4-digit PIN'), findsOneWidget);

      // Wrong PIN 9999.
      await _enterPin(tester, '9999');
      await tester.tap(find.text('Verify & deliver'));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('Invalid OTP PIN. Check with student at gate.'), findsOneWidget);
      expect(verifiedWith, isNull);

      // Backspace works.
      await _enterPin(tester, '48');
      await tester.tap(find.byKey(const ValueKey('otp-key-backspace')));
      await tester.pump();
      await _tapKey(tester, '8');
      await _enterPin(tester, '29');

      await tester.tap(find.text('Verify & deliver'));
      await tester.pump(const Duration(milliseconds: 550));
      expect(find.text('PIN verified'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(verifiedWith, '4829');
      expect(find.text('Gate PIN'), findsNothing);
    });
  });

  group('Driver App - SwipeAcceptCard', () {
    testWidgets('renders offer and 1-tap fallback accepts', (WidgetTester tester) async {
      await _smallPhone(tester);
      var accepted = 0;

      await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: SwipeAcceptCard(onAccepted: () => accepted++)))));

      expect(find.text('₹40'), findsOneWidget);
      expect(find.text('FC Night Mess'), findsOneWidget);
      expect(find.text('Boys Hostel Block 1'), findsOneWidget);
      expect(find.text('Slide to accept'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Accept with one tap'));
      await tester.pump();

      expect(accepted, 1);
      expect(find.text('Order accepted'), findsOneWidget);
    });

    testWidgets('slide-to-accept fires once', (WidgetTester tester) async {
      await _smallPhone(tester, textScale: 1.0);
      var accepted = 0;

      await tester.pumpWidget(_app(Scaffold(body: SingleChildScrollView(child: SwipeAcceptCard(onAccepted: () => accepted++)))));

      await _slide(tester);

      expect(accepted, 1);
    });
  });

  group('Driver App - PipelineStepper', () {
    testWidgets('shows the four steps', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const Scaffold(body: Padding(padding: EdgeInsets.all(20), child: PipelineStepper(currentStep: 1)))));
      for (final label in ['Go to\nrestaurant', 'Picked up', 'Reached\ngate', 'Delivered']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });
  });

  group('Driver App - layout at 360x640 and 1.3x text', () {
    for (var step = 0; step < 4; step++) {
      testWidgets('ActiveDeliveryScreen step $step has no overflow', (WidgetTester tester) async {
        await _smallPhone(tester);
        var changed = -1;
        await tester.pumpWidget(_app(ActiveDeliveryScreen(currentStep: step, onStepChanged: (s) => changed = s, onCompleted: () {})));
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull);
        if (step < 3) {
          expect(find.byType(KSlideToConfirm), findsOneWidget);
          await _slide(tester);
          expect(changed, step + 1);
        } else {
          expect(find.text('Enter gate OTP'), findsOneWidget);
        }
      });
    }

    testWidgets('ActiveDeliveryScreen details expand without overflow', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(ActiveDeliveryScreen(currentStep: 0, onStepChanged: (_) {}, onCompleted: () {})));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.scrollUntilVisible(find.text('Order details'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Order details'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Your payout'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('EarningsHistoryScreen day/week chips work', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const EarningsHistoryScreen()));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('TOTAL THIS WEEK'), findsOneWidget);
      await tester.tap(find.text('Today'));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('TOTAL TODAY'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('TripLogsScreen lists trips and shows empty state', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const TripLogsScreen()));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.text('#ord-8492'), findsOneWidget);
      expect(find.text('Delivered'), findsWidgets);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(_app(const TripLogsScreen(trips: <TripModel>[])));
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.text('No trips here yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('RunnerIdCardScreen renders pass details', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const RunnerIdCardScreen()));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('Vikram Singh'), findsOneWidget);
      expect(find.text('VS'), findsOneWidget);
      expect(find.text('ID verified'), findsOneWidget);
      expect(find.text('RUN-8042'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('DriverHomeScreen: duty toggle, offer, decline -> radar idle, tabs', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const DriverHomeScreen()));
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text('ON DUTY'), findsOneWidget);
      expect(find.text('Slide to accept'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Decline the offer -> idle radar empty state.
      await tester.ensureVisible(find.bySemanticsLabel('Decline this order'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.bySemanticsLabel('Decline this order'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('You\'re online - waiting for orders'), findsOneWidget);

      // Go off duty (scroll back to the hero toggle first).
      await tester.drag(find.byType(ListView).first, const Offset(0, 1200));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text('ON DUTY'));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('OFF DUTY'), findsOneWidget);
      expect(find.text('You are off duty'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Navigate every tab.
      for (final tab in [LucideIcons.wallet, LucideIcons.history, LucideIcons.bike, LucideIcons.house]) {
        await tester.tap(find.descendant(of: find.byType(KGlassNav), matching: find.byIcon(tab)));
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull, reason: 'tab $tab');
      }
      expect(find.text('You are off duty'), findsOneWidget);

      // Dispose timers.
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('DriverHomeScreen: accept offer opens active delivery', (WidgetTester tester) async {
      await _smallPhone(tester);
      await tester.pumpWidget(_app(const DriverHomeScreen()));
      await tester.pump(const Duration(milliseconds: 800));

      await tester.ensureVisible(find.text('Accept with one tap'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('Accept with one tap'));
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Delivery'), findsWidgets);
      expect(find.text('Go to restaurant'), findsWidgets);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
    });
  });
}
