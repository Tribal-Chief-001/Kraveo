// Regression tests for the 6 Oct 2026 pre-demo bug hunt (Docs/bughunt CU1 / CU2): providers,
// formatting and services. The screens are covered in bughunt_screens_test.dart.
import 'dart:convert';

import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/session_provider.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/external_links.dart';
import 'package:customer_app/services/google_auth_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/widgets/ui/format.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';

class _NoGoogle implements GoogleAuthService {
  @override
  Future<GoogleAuthResult> signIn() async => const GoogleAuthResult.failed(GoogleAuthFailure.cancelled);
  @override
  Future<void> signOut() async {}
}

http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _vendor(String id, String name, {bool open = true, List<Map<String, dynamic>> menu = const []}) => {
      'id': id,
      'name': name,
      'category': 'North Indian • Campus Dhaba',
      'rating': 4.5,
      'eta': '20-25 min',
      'bannerImage': '',
      'isAcceptingOrders': open,
      'address': 'Kothri',
      'menuItems': menu,
    };

Map<String, dynamic> _dish(String id, String vendorId, String name, String category, {bool available = true}) =>
    {'id': id, 'vendorId': vendorId, 'name': name, 'price': 100, 'category': category, 'description': 'd', 'imageUrl': '', 'isAvailable': available, 'isVeg': true};

OrderModel _order(String id, {String status = 'PLACED', String paymentStatus = 'PAID', String refundStatus = 'NONE', DateTime? updatedAt}) =>
    OrderModel.tryParse(orderJson(id: id, status: status, paymentStatus: paymentStatus, refundStatus: refundStatus, updatedAt: updatedAt))!;

/// An order provider that is disposed when the test ends (it may still hold a polling timer).
OrderProvider mk(FakeOrderApi api, {DateTime Function()? clock}) {
  final o = fakeOrders(api, clock: clock);
  addTearDown(o.dispose);
  return o;
}

void main() {
  setUp(() {
    FakeRealtime.created.clear();
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() {
    CustomerApiService.httpClientOverride = null;
    ExternalLinks.launcher = (uri) async => false;
  });

  group('CU1-07 / CU1-27 money formatting', () {
    test('whole rupees print without decimals, paise print both digits, thousands are grouped', () {
      expect(rupee(190), '₹190');
      expect(rupee(190.4), '₹190.40');
      expect(rupee(190.40000000000003), '₹190.40');
      expect(rupee(99.5), '₹99.50');
      expect(rupee(0.05), '₹0.05');
      expect(rupee(0), '₹0');
      expect(rupee(999), '₹999');
      expect(rupee(1234), '₹1,234');
      expect(rupee(12345.5), '₹12,345.50');
      expect(rupee(123456), '₹1,23,456');
      expect(rupee(1234567), '₹12,34,567');
      expect(rupee(-37.6), '-₹37.60');
    });

    test('the VITFIRST example from the report: ₹188 + 25 - 37.60 = ₹175.40, shown the same everywhere', () {
      const total = 188 + 25 - 37.6;
      expect(rupee(total), '₹175.40');
      expect(rupee(37.6), '₹37.60');
      expect(OrderModel.tryParse(orderJson(totalAmount: 190.4))!.totalPaise, 19040);
    });
  });

  group('CU1-04 session restore only signs out for 401 / 403 / 404', () {
    Future<(SessionStatus, String?)> restoreWith(http.Response Function() respond) async {
      await CustomerApiService.saveToken('jwt-live');
      CustomerApiService.httpClientOverride = MockClient((req) async => respond());
      final session = SessionProvider(googleAuth: _NoGoogle());
      await session.restore();
      return (session.status, await CustomerApiService.getSavedToken());
    }

    test('429, 500, 502, 503 and an HTML error page keep the token and offer a retry', () async {
      for (final r in [
        () => _json(429, {'success': false, 'message': 'Too many requests'}),
        () => _json(500, {'success': false}),
        () => http.Response('<html><body>502 Bad Gateway</body></html>', 502),
        () => http.Response('', 503),
        () => http.Response('<html>proxy</html>', 200), // 200 with an unparseable body
        () => _json(200, {'success': true}), // no user in it
      ]) {
        final (status, token) = await restoreWith(r);
        expect(status, SessionStatus.unreachable);
        expect(token, 'jwt-live', reason: 'the saved token must survive a backend hiccup');
      }
    });

    test('401, 403 and 404 mean the token / account is no good: token cleared, signed out', () async {
      for (final code in [401, 403, 404]) {
        final (status, token) = await restoreWith(() => _json(code, {'success': false, 'message': 'no'}));
        expect(status, SessionStatus.signedOut, reason: '$code');
        expect(token, isNull, reason: '$code');
      }
    });

    test('a retry from the unreachable screen signs in once the backend answers', () async {
      await CustomerApiService.saveToken('jwt-live');
      var up = false;
      CustomerApiService.httpClientOverride = MockClient((req) async => up
          ? _json(200, {'success': true, 'needsProfile': false, 'user': {'id': 'u1', 'name': 'Aarav', 'role': 'STUDENT', 'isStudent': true, 'hostelBlock': 'BH2', 'avatarId': 1}})
          : _json(502, {'success': false}));
      final session = SessionProvider(googleAuth: _NoGoogle());
      await session.restore();
      expect(session.status, SessionStatus.unreachable);
      up = true;
      await session.retryRestore();
      expect(session.status, SessionStatus.signedIn);
    });
  });

  group('CU1-02 / CU1-03 / CU1-09 the catalog is only what the server returns', () {
    test('first load fails -> failed (with retry); success -> ready; an empty answer is "no kitchens", not an error', () async {
      var step = 0;
      CustomerApiService.httpClientOverride = MockClient((req) async {
        switch (step) {
          case 0:
            return _json(500, {'message': 'down'});
          case 1:
            return _json(200, {'data': []});
          default:
            return _json(200, {
              'data': [
                _vendor('v1', 'Real Dhaba', menu: [_dish('d1', 'v1', 'Thali', 'Thalis')])
              ]
            });
        }
      });
      final p = DhabaProvider();
      expect(p.allDhabas, isEmpty, reason: 'no built-in kitchens');
      expect(p.isCatalogLoading, isTrue);

      expect(await p.loadCatalog(), isFalse);
      expect(p.hasCatalogFailed, isTrue);
      expect(p.allDhabas, isEmpty);

      step = 1;
      expect(await p.loadCatalog(), isTrue);
      expect(p.hasCatalogFailed, isFalse);
      expect(p.catalogStatus, CatalogStatus.ready);
      expect(p.allDhabas, isEmpty);

      step = 2;
      await p.loadCatalog();
      expect(p.allDhabas.map((d) => d.name), ['Real Dhaba']);
      expect(p.isLiveVendor('v1'), isTrue);
      expect(p.isLiveVendor('ven-1'), isFalse, reason: 'ids that are not on the server are never live');
    });

    test('a failed refresh keeps what is on screen; a successful one replaces open / sold-out state', () async {
      var open = true;
      var fail = false;
      CustomerApiService.httpClientOverride = MockClient((req) async {
        if (fail) return http.Response('<html>502</html>', 502);
        return _json(200, {
          'data': [
            _vendor('v1', 'Real Dhaba', open: open, menu: [_dish('d1', 'v1', 'Thali', 'Thalis', available: open)])
          ]
        });
      });
      final p = DhabaProvider();
      await p.loadCatalog();
      expect(p.byId('v1')!.isAcceptingOrders, isTrue);

      fail = true;
      expect(await p.loadCatalog(), isFalse);
      expect(p.catalogStatus, CatalogStatus.ready, reason: 'not an error screen: the old list is still right enough');
      expect(p.allDhabas, hasLength(1));

      fail = false;
      open = false;
      await p.loadCatalog();
      expect(p.byId('v1')!.isAcceptingOrders, isFalse, reason: 'a reload picks up the closed kitchen');
      expect(p.getMenuItemsForDhaba('v1').single.isAvailable, isFalse);
    });

    test('concurrent loads share one request', () async {
      var calls = 0;
      CustomerApiService.httpClientOverride = MockClient((req) async {
        calls++;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return _json(200, {'data': []});
      });
      final p = DhabaProvider();
      await Future.wait([p.loadCatalog(), p.loadCatalog(), p.loadCatalog()]);
      expect(calls, 1);
    });

    test('category chips come from the live menus and every chip matches at least one kitchen', () async {
      CustomerApiService.httpClientOverride = MockClient((req) async => _json(200, {
            'data': [
              _vendor('v1', 'Alpha', menu: [_dish('a1', 'v1', 'Thali', 'Thalis'), _dish('a2', 'v1', 'Lassi', 'Beverages')]),
              _vendor('v2', 'Beta', menu: [_dish('b1', 'v2', 'Cola', 'beverages'), _dish('b2', 'v2', 'Roll', 'Rolls')]),
              _vendor('v3', 'Gamma'), // no menu yet
            ]
          }));
      final p = DhabaProvider();
      expect(p.categories, ['All'], reason: 'nothing loaded: no chips to choose between');
      await p.loadCatalog();

      final chips = p.categories;
      expect(chips.first, 'All');
      expect(chips, containsAll(['Thalis', 'Beverages', 'Rolls']));
      expect(chips, isNot(contains('Night Mess')), reason: 'the old hard-coded chips are gone');
      expect(chips.where((c) => c.toLowerCase() == 'beverages'), hasLength(1), reason: 'spelling variants are merged');
      expect(chips[1], 'Beverages', reason: 'most common first');

      for (var i = 0; i < chips.length; i++) {
        p.setSelectedCategoryIndex(i);
        expect(p.selectedCategoryIndex, i);
        expect(p.dhabas, isNotEmpty, reason: 'chip "${chips[i]}" must never lead to "No kitchens match"');
      }
      p.setSelectedCategoryIndex(chips.indexOf('Thalis'));
      expect(p.dhabas.map((d) => d.name), ['Alpha']);
      expect(p.allDhabas, hasLength(3), reason: 'allDhabas ignores Home filters (used by reorder)');
      expect(p.byId('v2')?.name, 'Beta');
    });

    test('a selected chip that disappears after a reload falls back to All', () async {
      var withThalis = true;
      CustomerApiService.httpClientOverride = MockClient((req) async => _json(200, {
            'data': [
              _vendor('v1', 'Alpha', menu: [if (withThalis) _dish('a1', 'v1', 'Thali', 'Thalis'), _dish('a2', 'v1', 'Lassi', 'Beverages')]),
            ]
          }));
      final p = DhabaProvider();
      await p.loadCatalog();
      p.setSelectedCategoryIndex(p.categories.indexOf('Thalis'));
      expect(p.dhabas, hasLength(1));
      withThalis = false;
      await p.loadCatalog();
      expect(p.selectedCategoryIndex, 0);
      expect(p.dhabas, hasLength(1));
    });
  });

  group('CU2-01 a cancelled order whose refund is pending stays watched', () {
    OrderModel cancelledPaid(String id, DateTime at, {String refund = 'PENDING'}) => OrderModel.tryParse(orderJson(
          id: id,
          status: 'CANCELLED',
          paymentStatus: 'PAID',
          refundStatus: refund,
          cancelledBy: 'VENDOR',
          cancelReason: 'Out of stock',
          updatedAt: at,
        ))!;

    test('the model: refund in progress = cancelled + paid + refund not failed/done', () {
      final now = DateTime.now().toUtc();
      expect(cancelledPaid('a', now).isRefundInProgress, isTrue);
      expect(cancelledPaid('a', now, refund: 'NONE').isRefundInProgress, isTrue);
      expect(cancelledPaid('a', now, refund: 'FAILED').isRefundInProgress, isFalse);
      expect(cancelledPaid('a', now, refund: 'DONE').isRefundInProgress, isFalse);
      expect(_order('d', status: 'DELIVERED').isRefundInProgress, isFalse, reason: 'a delivered paid order is not a refund');
      expect(_order('p', status: 'PLACED').isRefundInProgress, isFalse);
      expect(_order('c', status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE').isRefundInProgress, isFalse);
    });

    test('cancel event (PAID, refund PENDING) then the REFUNDED event: still polled and joined in between, and the second event is applied', () async {
      var now = DateTime.now().toUtc();
      final api = FakeOrderApi()..server['r1'] = _order('r1', updatedAt: now);
      final orders = mk(api, clock: () => now)..beginSession('u1');
      await pumpEventQueue();
      orders.watch('r1');
      await pumpEventQueue();
      final socket = FakeRealtime.created.single..simulateConnect();
      expect(socket.joined, contains('r1'));
      expect(orders.isPolling, isTrue);

      // Event 1: the restaurant rejected the order; the refund is only started.
      now = now.add(const Duration(seconds: 2));
      socket.emitOrder(orderJson(id: 'r1', status: 'CANCELLED', paymentStatus: 'PAID', refundStatus: 'PENDING', cancelledBy: 'VENDOR', updatedAt: now));
      await pumpEventQueue();
      expect(orders.orderById('r1')!.status, OrderProgressStatus.cancelled);
      expect(orders.orderById('r1')!.paymentStatus, PaymentStatus.paid);
      expect(orders.isPolling, isTrue, reason: 'the refund result has not arrived: keep polling');
      expect(socket.disposed, isFalse, reason: 'and keep the socket open');
      expect(orders.joinedRooms, contains('r1'));

      // Event 2, a moment later: the refund went through.
      now = now.add(const Duration(seconds: 2));
      socket.emitOrder(orderJson(id: 'r1', status: 'CANCELLED', paymentStatus: 'REFUNDED', refundStatus: 'DONE', cancelledBy: 'VENDOR', updatedAt: now));
      await pumpEventQueue();
      expect(orders.orderById('r1')!.paymentStatus, PaymentStatus.refunded);
      expect(orders.orderById('r1')!.refundStatus, RefundStatus.done);
      expect(orders.isPolling, isFalse, reason: 'nothing left to wait for');
      expect(socket.disposed, isTrue);
    });

    test('polling finds the refund result even when the socket is not connected', () async {
      var now = DateTime.now().toUtc();
      final api = FakeOrderApi()..server['r1'] = _order('r1', updatedAt: now);
      final orders = mk(api, clock: () => now)..beginSession('u1');
      await pumpEventQueue();
      orders.watch('r1');
      await pumpEventQueue();
      now = now.add(const Duration(seconds: 2));
      api.server['r1'] = cancelledPaid('r1', now);
      await orders.pollOnce();
      expect(orders.orderById('r1')!.isRefundInProgress, isTrue);
      expect(orders.isPolling, isTrue);

      now = now.add(const Duration(seconds: 2));
      api.server['r1'] = cancelledPaid('r1', now, refund: 'DONE');
      await orders.pollOnce();
      expect(orders.orderById('r1')!.refundStatus, RefundStatus.done);
      expect(orders.isPolling, isFalse);
    });

    test('the watch is bounded: about 10 minutes after the last update it stops, a failed refund stops at once', () async {
      var now = DateTime.now().toUtc();
      final api = FakeOrderApi()..server['r1'] = cancelledPaid('r1', now);
      final orders = mk(api, clock: () => now)..beginSession('u1');
      await pumpEventQueue();
      orders.watch('r1');
      await pumpEventQueue();
      expect(orders.orderById('r1')!.isRefundInProgress, isTrue);
      expect(orders.isPolling, isTrue);

      now = now.add(OrderProvider.refundWatchWindow + const Duration(minutes: 1));
      await orders.pollOnce(); // runs the check; the order is too old to keep waiting for
      expect(orders.isPolling, isFalse);

      final failed = FakeOrderApi()..server['f1'] = cancelledPaid('f1', DateTime.now().toUtc(), refund: 'FAILED');
      final o2 = mk(failed)..beginSession('u1');
      await pumpEventQueue();
      o2.watch('f1');
      await pumpEventQueue();
      expect(o2.isPolling, isFalse, reason: 'refund failed: support takes over, polling will not change it');
    });

    test('a delivered order and a plain cancelled (unpaid) order are not polled', () async {
      final api = FakeOrderApi()
        ..server['d1'] = _order('d1', status: 'DELIVERED')
        ..server['c1'] = _order('c1', status: 'CANCELLED', paymentStatus: 'PENDING');
      final orders = mk(api)..beginSession('u1');
      await pumpEventQueue();
      orders.watch('d1');
      orders.watch('c1');
      await pumpEventQueue();
      expect(orders.isPolling, isFalse);
    });
  });

  group('CU2-03 an order that cannot be loaded', () {
    test('404 / 403: the error is remembered and polling stops; Retry works once the order exists', () async {
      final api = FakeOrderApi();
      final orders = mk(api)..beginSession('u1');
      await pumpEventQueue();
      expect(orders.loadErrorFor('x'), isNull);
      orders.watch('x');
      await pumpEventQueue();
      expect(orders.loadErrorFor('x')?.kind, OrderErrorKind.notFound);
      expect(orders.isPolling, isFalse, reason: 'a missing order is not polled forever');
      final fetches = api.fetchedIds.length;
      await orders.pollOnce();
      expect(api.fetchedIds.length, fetches);

      api.server['x'] = _order('x');
      await orders.refreshOrder('x');
      expect(orders.loadErrorFor('x'), isNull);
      expect(orders.orderById('x'), isNotNull);
      expect(orders.isPolling, isTrue);
    });

    test('offline: the error is shown (Retry) and polling continues so it recovers by itself', () async {
      final api = FakeOrderApi()..onFetch = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      final orders = mk(api)..beginSession('u1');
      await pumpEventQueue();
      orders.watch('y');
      await pumpEventQueue();
      expect(orders.loadErrorFor('y')?.kind, OrderErrorKind.offline);
      expect(orders.isPolling, isTrue);
    });
  });

  group('CU2-20 the socket can start after a failed token read', () {
    test('tokenProvider throws once: no socket, but the next sync tries again (the "connecting" flag is not stuck)', () async {
      var calls = 0;
      final api = FakeOrderApi()..server['x'] = _order('x');
      final orders = OrderProvider(
        api: api,
        gateway: FakeGateway(),
        realtimeFactory: FakeRealtime.new,
        tokenProvider: () async {
          calls++;
          if (calls == 1) throw StateError('SharedPreferences failed');
          return 'jwt';
        },
      )..beginSession('u1');
      addTearDown(orders.dispose);
      await pumpEventQueue();
      orders.watch('x');
      await pumpEventQueue();
      expect(calls, greaterThanOrEqualTo(1));
      expect(FakeRealtime.created, isEmpty);
      expect(orders.isSocketOpen, isFalse);

      orders.onAppResumed();
      await pumpEventQueue();
      expect(FakeRealtime.created, hasLength(1), reason: 'the second attempt opened the socket');
      expect(FakeRealtime.created.single.token, 'jwt');
    });
  });

  group('CU1-12 checkout note changes', () {
    CheckoutDraft draft(String note) => CheckoutDraft(vendorId: 'v1', items: const [(itemId: 'a', quantity: 1)], dropoffHostel: 'BH2', dropoffNotes: note);

    test('a retry with the same note reuses the key; an edited note (no order exists yet) gets a new key', () async {
      final api = FakeOrderApi()..onCreate = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.timeout));
      final orders = mk(api);
      await orders.placeOrder(draft('call me'));
      await orders.placeOrder(draft('call me'));
      await orders.placeOrder(draft('wait at gate 2'));
      expect(api.creates, hasLength(3));
      expect(api.creates[1].clientRequestId, api.creates[0].clientRequestId);
      expect(api.creates[2].clientRequestId, isNot(api.creates[0].clientRequestId));
      expect(api.creates[2].dropoffNotes, 'wait at gate 2');
    });

    test('409 CLIENT_REQUEST_MISMATCH starts a fresh checkout id and retries once', () async {
      var n = 0;
      final api = FakeOrderApi();
      api.onCreate = (r) async {
        n++;
        if (n == 1) return const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'CLIENT_REQUEST_MISMATCH', message: 'raw'));
        final o = orderModel(id: 'o-new');
        api.server[o.id] = o;
        return OrderResult.ok(o);
      };
      final orders = mk(api);
      final r = await orders.placeOrder(draft('note'));
      expect(r.ok, isTrue);
      expect(api.creates, hasLength(2));
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
    });

    test('the code also has customer wording if it ever reaches the screen', () {
      final m = orderErrorMessage(const OrderApiError(OrderErrorKind.conflict, code: 'CLIENT_REQUEST_MISMATCH', message: 'This checkout id was already used'));
      expect(m, isNot(contains('checkout id')));
    });
  });

  group('CU1-01 first-order coupon is only offered when the student has no earlier order', () {
    Future<OrderProvider> withOrders({List<OrderModel> history = const [], List<OrderModel> active = const [], bool historyHasMore = false, bool failHistory = false}) async {
      final api = FakeOrderApi()
        ..onFetchList = (scope, cursor) async {
          if (scope == 'history') {
            if (failHistory) return const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
            return OrderResult.ok(OrdersPage(history, historyHasMore ? 'next' : null));
          }
          return OrderResult.ok(OrdersPage(active, null));
        };
      final orders = mk(api);
      expect(orders.isFirstTimeCustomer, isFalse, reason: 'unknown until loaded');
      orders.beginSession('u1');
      await pumpEventQueue();
      return orders;
    }

    test('no orders at all -> yes; unknown (history failed) -> no', () async {
      expect((await withOrders()).isFirstTimeCustomer, isTrue);
      expect((await withOrders(failHistory: true)).isFirstTimeCustomer, isFalse);
    });

    test('a delivered order, a live order, or more history pages -> no; only cancelled orders -> yes (the server releases the code)', () async {
      expect((await withOrders(history: [_order('d1', status: 'DELIVERED')])).isFirstTimeCustomer, isFalse);
      expect((await withOrders(active: [_order('a1', status: 'ACCEPTED')])).isFirstTimeCustomer, isFalse);
      expect((await withOrders(history: [_order('c1', status: 'CANCELLED', paymentStatus: 'PENDING')])).isFirstTimeCustomer, isTrue);
      expect((await withOrders(history: [_order('c1', status: 'CANCELLED', paymentStatus: 'PENDING')], historyHasMore: true)).isFirstTimeCustomer, isFalse);
    });

    test('logging out forgets it', () async {
      final orders = await withOrders();
      expect(orders.isFirstTimeCustomer, isTrue);
      orders.resetForLogout();
      expect(orders.isFirstTimeCustomer, isFalse);
    });
  });

  group('CU1-11 INVALID_ITEMS wording (no raw ids)', () {
    test('quantity, unknown dish and sold-out messages become plain text', () {
      const id = '9f3c2d1e-0000-4000-8000-000000000001';
      expect(invalidItemsMessage("Invalid quantity '21' for item $id."), allOf(isNot(contains(id)), contains('at most 20')));
      expect(invalidItemsMessage("Item '$id' is not available at this dhaba."), allOf(isNot(contains(id)), contains('no longer available')));
      expect(invalidItemsMessage("Item 'Paneer Thali' is currently SOLD OUT."), allOf(contains('Paneer Thali'), contains('SOLD OUT')));
      expect(invalidItemsMessage("Item '$id' is currently SOLD OUT."), isNot(contains(id)));
      expect(invalidItemsMessage(null), isNotEmpty);
      final viaCode = orderErrorMessage(const OrderApiError(OrderErrorKind.rejected, code: 'INVALID_ITEMS', message: "Invalid quantity '21' for item $id."));
      expect(viaCode, isNot(contains(id)));
    });
  });

  group('CU2-05 / CU2-06 phone and e-mail links', () {
    test('dialable numbers keep digits and a leading plus', () {
      expect(ExternalLinks.dialableNumber('+91 98765 43210'), '+919876543210');
      expect(ExternalLinks.dialableNumber('98765-43210'), '9876543210');
      expect(ExternalLinks.dialableNumber('  '), '');
      expect(ExternalLinks.dialableNumber('abc'), '');
    });

    test('dial opens tel: with the cleaned number; support opens mailto: to the support address; failures answer false', () async {
      final opened = <Uri>[];
      ExternalLinks.launcher = (uri) async {
        opened.add(uri);
        return true;
      };
      expect(await ExternalLinks.dial('+91 98765 43210'), isTrue);
      expect(opened.single.toString(), 'tel:+919876543210');
      expect(await ExternalLinks.emailSupport(subject: 'Order #ABC'), isTrue);
      expect(opened.last.scheme, 'mailto');
      expect(opened.last.path, kSupportEmail);
      expect(kSupportEmail, 'kraveo.contact@gmail.com');
      expect(opened.last.queryParameters['subject'], 'Order #ABC');

      expect(await ExternalLinks.dial(''), isFalse);
      ExternalLinks.launcher = (uri) async => throw StateError('no activity');
      expect(await ExternalLinks.dial('9876543210'), isFalse, reason: 'never throws');
    });

    test('messages that tell the student to contact support carry the address', () {
      for (final code in ['CANNOT_CANCEL', 'PAYMENT_AMOUNT_MISMATCH', 'DUPLICATE_PAYMENT']) {
        expect(orderErrorMessage(OrderApiError(OrderErrorKind.conflict, code: code)), contains(kSupportEmail), reason: code);
      }
      expect(googleFailureMessage(GoogleAuthFailure.notConfigured), contains(kSupportEmail));
    });
  });
}
