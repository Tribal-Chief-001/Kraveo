import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/config/api_config.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/services/failure_messages.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'support/fakes.dart';

/// The real HTTP layer against the contract's endpoints, with a mocked transport.
void main() {
  late List<http.Request> sent;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await VendorApiService.saveToken('jwt-abc');
    sent = [];
  });

  tearDown(() async {
    VendorApiService.onNotApproved = null;
    VendorApiService.onUnauthorized = null;
    await VendorApiService.clearToken();
  });

  Future<T> withServer<T>(Future<T> Function() body, http.Response Function(http.Request) handler) =>
      http.runWithClient(body, () => MockClient((r) async {
            sent.add(r);
            return handler(r);
          }));

  const backend = HttpVendorBackend();

  test('GET /orders?scope=active with the JWT; reads data + nextCursor and the server clock', () async {
    final res = await withServer(
      () => backend.fetchOrders(OrderScope.active),
      (_) => http.Response(jsonEncode({'success': true, 'nextCursor': 'c2', 'data': [orderJson(id: 'o1'), {'broken': true}]}), 200,
          headers: {'date': 'Fri, 02 Oct 2026 10:00:00 GMT'}),
    );
    expect(sent.single.method, 'GET');
    expect(sent.single.url.toString(), '${ApiConfig.baseUrl}/orders?scope=active&limit=50');
    expect(sent.single.headers['Authorization'], 'Bearer jwt-abc');
    expect(res.ok, isTrue);
    expect(res.data!.orders.single.id, 'o1');
    expect(res.data!.skipped, 1);
    expect(res.data!.nextCursor, 'c2');
    expect(res.serverTime, DateTime.utc(2026, 10, 2, 10));
  });

  test('history scope passes the cursor', () async {
    await withServer(() => backend.fetchOrders(OrderScope.history, cursor: 'abc', limit: 30), (_) => http.Response('{"data":[]}', 200));
    expect(sent.single.url.query, 'scope=history&limit=30&cursor=abc');
  });

  test('PATCH /orders/:id/status and POST /orders/:id/reject send the contract bodies', () async {
    final accepted = await withServer(
      () => backend.updateStatus('o1', OrderStatus.accepted),
      (_) => http.Response(jsonEncode({'success': true, 'data': orderJson(id: 'o1', status: 'ACCEPTED')}), 200),
    );
    expect(sent.last.method, 'PATCH');
    expect(sent.last.url.path, endsWith('/orders/o1/status'));
    expect(jsonDecode(sent.last.body), {'status': 'ACCEPTED'});
    expect(accepted.data!.status, OrderStatus.accepted);

    final rejected = await withServer(
      () => backend.reject('o1', 'Item out of stock'),
      (_) => http.Response(jsonEncode({'success': true, 'data': orderJson(id: 'o1', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'VENDOR')}), 200),
    );
    expect(sent.last.method, 'POST');
    expect(sent.last.url.path, endsWith('/orders/o1/reject'));
    expect(jsonDecode(sent.last.body), {'reason': 'Item out of stock'});
    expect(rejected.data!.cancelledBy, CancelledBy.vendor);
  });

  test('error mapping: 400, 403 PARTNER_NOT_APPROVED (hook fires), 403, 404, 409 with code, 429 retryAfter, 500', () async {
    var notApproved = 0;
    var unauthorized = 0;
    VendorApiService.onNotApproved = () => notApproved++;
    VendorApiService.onUnauthorized = () => unauthorized++;
    Future<ApiResult<OrderModel>> answer(int status, Map<String, dynamic> body, {Map<String, String> headers = const {}}) =>
        withServer(() => backend.updateStatus('o1', OrderStatus.preparing), (_) => http.Response(jsonEncode(body), status, headers: headers));

    expect((await answer(400, {'message': 'Invalid transition'})).failure, ApiFailure.invalid);
    expect((await answer(400, {'message': 'Invalid transition'})).message, 'Invalid transition');
    expect((await answer(401, {})).failure, ApiFailure.unauthorized);
    expect(unauthorized, 1);
    expect((await answer(403, {'code': 'PARTNER_NOT_APPROVED', 'approvalStatus': 'SUSPENDED'})).failure, ApiFailure.notApproved);
    expect(notApproved, 1);
    expect((await answer(403, {'message': 'Forbidden'})).failure, ApiFailure.forbidden);
    expect(notApproved, 1);
    expect((await answer(404, {})).failure, ApiFailure.notFound);
    final conflict = await answer(409, {'code': 'ORDER_CANCELLED', 'message': 'Order was cancelled'});
    expect(conflict.failure, ApiFailure.conflict);
    expect(conflict.code, 'ORDER_CANCELLED');
    expect((await answer(429, {'retryAfterSeconds': 42})).retryAfterSeconds, 42);
    expect((await answer(429, {}, headers: {'retry-after': '7'})).retryAfterSeconds, 7);
    expect((await answer(500, {})).failure, ApiFailure.server);
  });

  test('a dead network is "offline", a slow one is "timeout"; a 200 without a readable order still succeeds', () async {
    final offline = await http.runWithClient(() => backend.updateStatus('o1', OrderStatus.accepted), () => MockClient((_) async => throw http.ClientException('no route')));
    expect(offline.failure, ApiFailure.offline);

    const slow = HttpVendorBackend(timeout: Duration(milliseconds: 20));
    final timedOut = await http.runWithClient(
      () => slow.updateStatus('o1', OrderStatus.accepted),
      () => MockClient((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        return http.Response('{}', 200);
      }),
    );
    expect(timedOut.failure, ApiFailure.timeout);

    final bare = await withServer(() => backend.updateStatus('o1', OrderStatus.accepted), (_) => http.Response('{"success":true}', 200));
    expect(bare.ok, isTrue);
    expect(bare.data, isNull);
  });

  test('store status and menu use the real vendor id in the path', () async {
    final open = await withServer(() => backend.setStoreOpen('ven-42', false), (_) => http.Response('{"success":true,"isAcceptingOrders":false}', 200));
    expect(sent.last.url.path, endsWith('/vendors/ven-42/status'));
    expect(jsonDecode(sent.last.body), {'isAcceptingOrders': false});
    expect(open.data, isFalse);

    final fetched = await withServer(() => backend.fetchStoreOpen('ven-42'), (_) => http.Response('{"success":true,"data":{"id":"ven-42","isAcceptingOrders":true}}', 200));
    expect(fetched.data, isTrue);

    final menu = await withServer(
      () => backend.fetchMenu('ven-42'),
      (_) => http.Response(jsonEncode({'data': [{'id': 'm1', 'name': 'Thali', 'price': 90, 'category': 'Main Course', 'isAvailable': true}]}), 200),
    );
    expect(sent.last.url.path, endsWith('/menus/ven-42'));
    expect(sent.last.headers['Authorization'], 'Bearer jwt-abc'); // so an owner can see their own menu while pending
    expect(menu.data!.single.name, 'Thali');

    await withServer(() => backend.addDish('ven-42', name: 'Lassi', category: 'Beverages', price: 40), (_) => http.Response('{"data":{"id":"m2","name":"Lassi","price":40,"isAvailable":true}}', 201));
    expect(sent.last.url.path, endsWith('/vendors/ven-42/items'));
    await withServer(() => backend.updateDish('m2', isAvailable: false), (_) => http.Response('{"item":{"id":"m2","name":"Lassi","price":40,"isAvailable":false}}', 200));
    expect(sent.last.url.path, endsWith('/vendors/items/m2'));
    expect(jsonDecode(sent.last.body), {'isAvailable': false});
  });

  test('real error bodies from Docs/fixtures map to the right failure + code + message', () async {
    final samples = (jsonDecode(File('../../Docs/fixtures/order_flow_samples.json').readAsStringSync()) as Map).cast<String, dynamic>();
    var notApproved = 0;
    VendorApiService.onNotApproved = () => notApproved++;
    for (final (key, status, failure) in const [
      ('error_403_PARTNER_NOT_APPROVED', 403, ApiFailure.notApproved),
      ('error_409_ALREADY_TAKEN', 409, ApiFailure.conflict),
      ('error_423_OTP_LOCKED', 423, ApiFailure.conflict),
    ]) {
      final body = samples[key] as Map;
      final res = await withServer(() => backend.updateStatus('o1', OrderStatus.accepted), (_) => http.Response(jsonEncode(body), status));
      expect(res.failure, failure, reason: key);
      expect(res.code, body['code']);
      expect(res.message, body['message']);
    }
    expect(notApproved, 1);
  }, skip: File('../../Docs/fixtures/order_flow_samples.json').existsSync() ? false : 'fixtures not published');

  test('backend codes for restaurant actions get their own clear wording', () async {
    for (final (code, status) in const [
      ('INVALID_TRANSITION', 409),
      ('PAYMENT_NOT_CONFIRMED', 409),
      ('CANNOT_REJECT', 409),
      ('ORDER_CLOSED', 409),
      ('ROLE_NOT_ALLOWED', 403),
      ('NOT_FOUND', 404),
    ]) {
      final res = await withServer(() => backend.reject('o1', 'Item out of stock'), (_) => http.Response(jsonEncode({'success': false, 'code': code, 'message': 'x'}), status));
      expect(res.code, code);
      final text = failureText(res.failure!, serverMessage: res.message, code: res.code);
      expect(text.english, isNot(contains('(x)')), reason: '$code has its own message');
      expect(text.hindi, isNotEmpty);
    }
  });
}
