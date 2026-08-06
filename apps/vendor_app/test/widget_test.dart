import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/main.dart';

void main() {
  testWidgets('Vendor App launches successfully', (WidgetTester tester) async {
    await tester.pumpWidget(const KraveoVendorApp());
    expect(find.byType(KraveoVendorApp), findsOneWidget);
  });
}
