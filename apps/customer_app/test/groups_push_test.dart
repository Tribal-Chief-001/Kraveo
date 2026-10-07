import 'dart:convert';

import 'package:customer_app/main.dart';
import 'package:customer_app/models/order_group.dart';
import 'package:customer_app/screens/live_tracking_screen.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/push/push_messaging.dart';
import 'package:customer_app/services/push/push_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';
import 'support/push_fakes.dart';

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

const _user = {'id': 'u1', 'name': 'Aarav Sharma', 'email': 'a@x.com', 'phone': '+91 9876543210', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'Block 2', 'avatarId': 3, 'kraveoCoins': 120};

http.Response _json(int status, Map<String, dynamic> body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump(const Duration(milliseconds: 150));
  }
}

/// Docs/22 section 5: a push for ANY restaurant of a combined order opens the one group screen.
void main() {
  late FakePushMessaging fcm;
  late FakeOrderApi orderApi;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await CustomerApiService.clearToken();
    fcm = FakePushMessaging();
    orderApi = FakeOrderApi();
    CustomerApiService.onUnauthorized = null;
    CustomerApiService.httpClientOverride = MockClient((req) async {
      final path = req.url.path.replaceFirst(RegExp(r'^/api'), '');
      switch ('${req.method} $path') {
        case 'GET /auth/profile':
          return _json(200, {'success': true, 'user': _user, 'needsProfile': false});
        case 'POST /devices':
        case 'DELETE /devices':
        case 'POST /auth/logout':
          return _json(200, {'success': true});
        default:
          return _json(500, {'success': false});
      }
    });
    final g = OrderGroupView.tryParse(groupViewJson(paymentStatus: 'PAID', orders: groupChildrenJson(paymentStatus: 'PAID', statuses: const ['ACCEPTED', 'PLACED'])))!;
    orderApi.groupServer[g.id] = g;
    for (final o in g.orders) {
      orderApi.server[o.id] = o;
    }
  });

  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    CustomerApiService.onUnauthorized = null;
  });

  testWidgets('a push for the second restaurant opens the whole combined order; a push for the first does not stack another screen', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await CustomerApiService.saveToken('jwt-1');
    final push = PushService(messaging: fcm, local: FakeLocalNotifier(), settings: FakeSystemSettings(), appVersion: '1.2.3');
    await tester.pumpWidget(KraveoCustomerApp(googleAuth: _NoGoogle(), createOrders: () => fakeOrders(orderApi), push: push));
    await _settle(tester);
    final tabCopies = find.byType(LiveTrackingScreen, skipOffstage: false).evaluate().length;

    fcm.opened.add(PushMessage(messageId: 'a', data: pushData('ORDER_ACCEPTED', orderId: 'gx-order-2')));
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen), findsOneWidget);
    expect(find.text('Your 2 restaurants'), findsOneWidget);
    expect(find.text('Kitchen 1'), findsWidgets);
    expect(find.text('Kitchen 2'), findsWidgets);

    // The same order again through the OTHER part (the primary id the server uses for group pushes).
    fcm.opened.add(PushMessage(messageId: 'b', data: pushData('ORDER_PICKED_UP', orderId: 'gx-order-1')));
    await _settle(tester);
    fcm.opened.add(PushMessage(messageId: 'c', data: pushData('ORDER_ACCEPTED', orderId: 'gx-order-2')));
    await _settle(tester);
    expect(find.byType(LiveTrackingScreen, skipOffstage: false).evaluate().length, tabCopies + 1, reason: 'one tracking route for the whole combined order');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 6));
  });
}
