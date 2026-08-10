import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/widgets/gate_otp_dialog.dart';
import 'package:driver_app/widgets/swipe_accept_card.dart';

void main() {
  group('Driver App - GateOtpDialog Widget Test', () {
    testWidgets('GateOtpDialog validates incorrect PIN and accepts correct PIN', (WidgetTester tester) async {
      bool verified = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GateOtpDialog(
              expectedOtp: '4829',
              orderId: '#ORD-99',
              customerName: 'Rahul',
              onVerified: (otp) {
                verified = true;
              },
            ),
          ),
        ),
      );

      expect(find.text('GATE HANDSHAKE OTP'), findsOneWidget);

      // Tap verify without entering OTP
      await tester.tap(find.text('VERIFY HANDSHAKE & DELIVER'));
      await tester.pump();
      expect(find.text('Please enter complete 4-digit PIN'), findsOneWidget);

      // Enter wrong PIN: 9999
      final textFields = find.byType(TextField);
      expect(textFields, findsNWidgets(4));

      await tester.enterText(textFields.at(0), '9');
      await tester.enterText(textFields.at(1), '9');
      await tester.enterText(textFields.at(2), '9');
      await tester.enterText(textFields.at(3), '9');
      await tester.pump();

      await tester.tap(find.text('VERIFY HANDSHAKE & DELIVER'));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('Invalid OTP PIN. Check with student at gate.'), findsOneWidget);
      expect(verified, isFalse);

      // Enter correct PIN: 4829
      await tester.enterText(textFields.at(0), '4');
      await tester.enterText(textFields.at(1), '8');
      await tester.enterText(textFields.at(2), '2');
      await tester.enterText(textFields.at(3), '9');
      await tester.pump();

      await tester.tap(find.text('VERIFY HANDSHAKE & DELIVER'));
      await tester.pump(const Duration(milliseconds: 700));

      expect(verified, isTrue);
    });
  });

  group('Driver App - SwipeAcceptCard Widget Test', () {
    testWidgets('SwipeAcceptCard renders payout badge and 1-tap accept works', (WidgetTester tester) async {
      bool accepted = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwipeAcceptCard(
              onAccepted: () {
                accepted = true;
              },
            ),
          ),
        ),
      );

      expect(find.text('EARN ₹40'), findsOneWidget);
      expect(find.text('FC Night Mess'), findsOneWidget);
      expect(find.text('Boys Hostel Block 1'), findsOneWidget);
      expect(find.text('SWIPE TO ACCEPT'), findsOneWidget);

      // Tap Glove-friendly 1-Tap Accept
      await tester.tap(find.text('Glove-friendly 1-Tap Accept'));
      await tester.pump();

      expect(accepted, isTrue);
      expect(find.text('JOB ACCEPTED!'), findsOneWidget);
    });
  });
}
