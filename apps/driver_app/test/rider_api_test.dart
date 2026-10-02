import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/models/order_view.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'package:driver_app/services/rider_socket.dart';
import 'support/fake_rider.dart';

/// The HTTP layer of the rider order flow, against a mocked server (contract section 2.4 shapes).
void main() {
  final seen = <http.Request>[];

  Future<T> withServer<T>(Future<T> Function() body, http.Response Function(http.Request) handler) {
    return http.runWithClient(body, () => MockClient((r) async {
          seen.add(r);
          return handler(r);
        }));
  }

  http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  setUp(() async {
    seen.clear();
    SharedPreferences.setMockInitialValues({});
    await DriverApiService.saveToken('jwt-rider');
    DriverApiService.onUnauthorized = null;
    DriverApiService.onNotApproved = null;
  });

  test('pool, active and history use the contract endpoints with the JWT', () async {
    final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api');
    await withServer(() async {
      final pool = await api.fetchAvailable();
      expect(pool.ok, isTrue);
      expect(pool.value!.single.customer, isNull);
      final active = await api.fetchActive();
      expect(active.value!.single.status, OrderStatus.pickedUp);
      final page = await api.fetchHistory(cursor: 'c1');
      expect(page.value!.nextCursor, 'c2');
    }, (r) {
      if (r.url.path.endsWith('/orders/available')) return json({'success': true, 'data': [orderJson(pool: true)]});
      if (r.url.queryParameters['scope'] == 'active') return json({'success': true, 'data': [orderJson(status: 'PICKED_UP')]});
      return json({'success': true, 'nextCursor': 'c2', 'data': [orderJson(status: 'DELIVERED')]});
    });
    expect(seen.map((r) => '${r.method} ${r.url.path}?${r.url.query}'), [
      'GET /api/orders/available?',
      'GET /api/orders?scope=active&limit=20',
      'GET /api/orders?scope=history&limit=30&cursor=c1',
    ]);
    expect(seen.every((r) => r.headers['Authorization'] == 'Bearer jwt-rider'), isTrue);
  });

  test('claim, release, status and OTP send the right method and body', () async {
    final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api');
    await withServer(() async {
      expect((await api.claim('o1')).value?.id, 'ord-1');
      expect((await api.release('o1')).ok, isTrue);
      expect((await api.updateStatus('o1', OrderStatus.pickedUp)).ok, isTrue);
      expect((await api.verifyGateOtp('o1', ' 4821 ')).ok, isTrue);
      expect((await api.setDuty(true)).value, 'ONLINE');
      expect((await api.postLocation(23.1, 76.9, heading: 90)).ok, isTrue);
    }, (r) => r.url.path.endsWith('duty-status') ? json({'success': true, 'dutyStatus': 'ONLINE'}) : json({'success': true, 'data': orderJson()}));
    expect(seen.map((r) => '${r.method} ${r.url.path} ${r.body}'), [
      'POST /api/orders/o1/accept-driver ',
      'POST /api/orders/o1/release ',
      'PATCH /api/orders/o1/status {"status":"PICKED_UP"}',
      'POST /api/orders/o1/verify-gate-otp {"otpCode":"4821"}',
      'POST /api/drivers/duty-status {"isOnline":true}',
      'POST /api/drivers/location {"lat":23.1,"lng":76.9,"heading":90.0}',
    ]);
  });

  test('error mapping: 409 ALREADY_TAKEN, 400 wrong code with tries left, 423 locked, 429, 5xx', () async {
    final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api');
    var next = json({}, 200);
    await withServer(() async {
      next = json({'success': false, 'code': 'ALREADY_TAKEN', 'message': 'Taken'}, 409);
      final taken = await api.claim('o1');
      expect((taken.failure, taken.code), (ApiFailure.conflict, 'ALREADY_TAKEN'));

      next = json({'success': false, 'code': 'OTP_INVALID', 'error': 'Invalid Gate OTP', 'attemptsLeft': 2}, 400);
      final wrong = await api.verifyGateOtp('o1', '1111');
      expect((wrong.failure, wrong.attemptsLeft), (ApiFailure.badRequest, 2));

      next = json({'success': false, 'code': 'OTP_LOCKED'}, 423);
      expect((await api.verifyGateOtp('o1', '1111')).failure, ApiFailure.locked);

      next = json({'success': false}, 429);
      expect((await api.claim('o1')).failure, ApiFailure.rateLimited);

      next = http.Response('<html>bad gateway</html>', 502);
      expect((await api.fetchAvailable()).failure, ApiFailure.server);

      next = json({'success': true, 'data': 'not a list'});
      expect((await api.fetchAvailable()).failure, ApiFailure.badResponse);
    }, (_) => next);
  });

  test('401 and 403 PARTNER_NOT_APPROVED reach the session hooks', () async {
    var unauthorized = 0, notApproved = 0;
    DriverApiService.onUnauthorized = () => unauthorized++;
    DriverApiService.onNotApproved = () => notApproved++;
    final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api');
    var next = json({}, 401);
    await withServer(() async {
      expect((await api.fetchActive()).failure, ApiFailure.unauthorized);
      next = json({'success': false, 'message': 'Forbidden. You are not assigned to this order.'}, 403);
      expect((await api.claim('o1')).failure, ApiFailure.forbidden);
      next = json({'success': false, 'code': 'PARTNER_NOT_APPROVED', 'approvalStatus': 'SUSPENDED'}, 403);
      expect((await api.claim('o1')).failure, ApiFailure.notApproved);
    }, (_) => next);
    expect(unauthorized, 1);
    expect(notApproved, 1);
  });

  test('offline and timeout are told apart, and never hang', () async {
    final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api', timeout: const Duration(milliseconds: 50));
    final offline = await http.runWithClient(() => api.fetchAvailable(), () => MockClient((_) async => throw const SocketException('no route')));
    expect(offline.failure, ApiFailure.offline);
    final slow = await http.runWithClient(
      () => api.verifyGateOtp('o1', '4821'),
      () => MockClient((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 300));
        return http.Response('{}', 200);
      }),
    );
    expect(slow.failure, ApiFailure.timeout);
    expect(slow.isNetwork, isTrue);
  });

  group('real backend fixtures (Docs/fixtures/order_flow_samples.json)', () {
    final file = File('../../Docs/fixtures/order_flow_samples.json');
    late Map<String, dynamic> fx;
    setUpAll(() {
      expect(file.existsSync(), isTrue, reason: 'fixture file missing: ${file.absolute.path}');
      fx = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    });

    // Keys a rider must never receive anywhere in an order: OTP attempts/lock, payment and refund
    // internals, raw foreign keys and user columns.
    const forbidden = {
      'payments', 'razorpayOrderId', 'razorpayPaymentId', 'razorpayRefundId', 'razorpaySignature',
      'otpAttempts', 'otpLocked', 'refundStatus', 'refundError', 'refundAttempts', 'capturedAmountPaise',
      'customerId', 'driverId', 'password', 'passwordHash', 'fcmToken', 'pushToken', 'email', 'googleId', 'kraveoCoins', 'role',
    };

    void noLeaks(Object? node, String path) {
      if (node is Map) {
        for (final e in node.entries) {
          expect(forbidden.contains(e.key), isFalse, reason: 'rider payload leaks "$path/${e.key}"');
          if (e.key == 'otpCode') expect(e.value, isNull, reason: 'rider payload carries an OTP at $path');
          noLeaks(e.value, '$path/${e.key}');
        }
      } else if (node is List) {
        for (final v in node) {
          noLeaks(v, path);
        }
      }
    }

    const riderOrderSamples = ['rider_pool_view', 'socket_order_available', 'rider_assigned_view_after_claim', 'rider_assigned_view_ARRIVED_AT_GATE'];

    test('every rider order sample parses and leaks nothing', () {
      for (final key in riderOrderSamples) {
        expect(fx.containsKey(key), isTrue, reason: 'missing sample $key');
        noLeaks(fx[key], key);
        final o = OrderView.tryParse(fx[key]);
        expect(o, isNotNull, reason: key);
        expect(o!.status, isNot(OrderStatus.unknown), reason: key);
        expect(o.paymentStatus, 'PAID', reason: key);
        expect(o.deliveryFee, isNotNull, reason: key);
        expect(o.vendor?.name, isNotEmpty, reason: key);
        expect(o.dropLabel, isNot('Drop point not set'), reason: key);
        expect(o.shortRef, '#${(fx[key]['id'] as String).substring((fx[key]['id'] as String).length - 6).toUpperCase()}');
      }
    });

    test('pool view and order_available: no customer, no driver, no notes', () {
      for (final key in ['rider_pool_view', 'socket_order_available']) {
        final raw = fx[key] as Map;
        expect(raw['customer'], isNull, reason: key);
        expect(raw['driver'], isNull, reason: key);
        expect(raw['dropoffNotes'], isNull, reason: key);
        final e = parseRiderSocketEvent('order_available', raw);
        expect(e, isA<OfferAvailable>(), reason: key);
        expect((e as OfferAvailable).order.customer, isNull);
      }
    });

    test('assigned views carry this rider as driver and the customer phone; never the OTP', () {
      for (final key in ['rider_assigned_view_after_claim', 'rider_assigned_view_ARRIVED_AT_GATE']) {
        final o = OrderView.tryParse(fx[key])!;
        expect(o.driver?.id, isNotEmpty, reason: key);
        expect(o.customer?.phone, isNotEmpty, reason: key);
      }
      final atGate = fx['rider_assigned_view_ARRIVED_AT_GATE'] as Map;
      expect(atGate.containsKey('otpCode') ? atGate['otpCode'] : null, isNull);
      expect(OrderView.tryParse(atGate)!.status, OrderStatus.arrivedAtGate);
    });

    test('socket order_unavailable {id} parses', () {
      final e = parseRiderSocketEvent('order_unavailable', fx['socket_order_unavailable']);
      expect((e as OfferUnavailable).id, (fx['socket_order_unavailable'] as Map)['id']);
    });

    test('real error bodies map to the right failure and code', () async {
      final api = HttpRiderOrdersApi(baseUrl: 'https://x.test/api');
      const cases = {
        'error_409_ALREADY_TAKEN': (409, ApiFailure.conflict, 'ALREADY_TAKEN'),
        'error_423_OTP_LOCKED': (423, ApiFailure.locked, 'OTP_LOCKED'),
        'error_403_PARTNER_NOT_APPROVED': (403, ApiFailure.notApproved, 'PARTNER_NOT_APPROVED'),
      };
      for (final e in cases.entries) {
        final r = await withServer(() => api.claim('o1'), (_) => json(fx[e.key] as Object, e.value.$1));
        expect((r.failure, r.code), (e.value.$2, e.value.$3), reason: e.key);
        expect(r.message, isNotEmpty);
      }
    });
  });
}
