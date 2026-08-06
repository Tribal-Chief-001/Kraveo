import 'package:flutter_test/flutter_test.dart';
import 'package:customer_app/main.dart';

void main() {
  testWidgets('Customer App launches successfully', (WidgetTester tester) async {
    await tester.pumpWidget(const KraveoCustomerApp());
    expect(find.byType(KraveoCustomerApp), findsOneWidget);
  });
}
