import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/main.dart';

void main() {
  testWidgets('Driver App launches successfully', (WidgetTester tester) async {
    await tester.pumpWidget(const KraveoDriverApp());
    expect(find.byType(KraveoDriverApp), findsOneWidget);
  });
}
