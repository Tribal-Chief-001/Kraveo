import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';

void main() {
  testWidgets('Driver App launches successfully', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const KraveoDriverApp());
    expect(find.byType(KraveoDriverApp), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
