import 'dart:async';
import 'dart:convert';

import 'package:customer_app/models/order.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/order_fakes.dart';

CheckoutDraft draft({int qty = 1, String? coupon, String notes = 'Call me'}) => CheckoutDraft(
      vendorId: 'v-real-1',
      items: [(itemId: 'm-thali', quantity: qty), (itemId: 'm-paratha', quantity: 1)],
      dropoffHostel: 'Block 2',
      dropoffNotes: notes,
      couponCode: coupon,
    );

/// Lets fire-and-forget futures (unawaited refreshes, socket sync) run.
Future<void> flush() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  setUp(() => FakeRealtime.created.clear());

  group('OrderModel (contract 2.1)', () {
    test('parses a full OrderView', () {
      final o = OrderModel.tryParse(orderJson(status: 'PICKED_UP', paymentStatus: 'PAID', discount: 20, driver: {'id': 'd1', 'name': 'Vikram', 'phone': '+91 98765 43210'}))!;
      expect(o.status, OrderProgressStatus.pickedUp);
      expect(o.paymentStatus, PaymentStatus.paid);
      expect(o.totalAmount, 225);
      expect(o.discount, 20);
      expect(o.items, hasLength(2));
      expect(o.items.first.menuItemId, 'm-thali');
      expect(o.vendorName, 'Sharma Highway Dhaba');
      expect(o.rider?.phone, '+91 98765 43210');
      expect(o.totalPaise, 22500);
    });

    test('the OTP is only kept at ARRIVED_AT_GATE and must look like a code', () {
      expect(OrderModel.tryParse(orderJson(status: 'PICKED_UP', otpCode: '4821'))!.otpCode, isNull);
      expect(OrderModel.tryParse(orderJson(status: 'ARRIVED_AT_GATE', otpCode: '4821'))!.otpCode, '4821');
      expect(OrderModel.tryParse(orderJson(status: 'ARRIVED_AT_GATE', otpCode: 'abcd'))!.otpCode, isNull);
      expect(OrderModel.tryParse(orderJson(status: 'ARRIVED_AT_GATE'))!.otpCode, isNull);
    });

    test('rejects payloads that are not orders and accepts {data: OrderView}', () {
      expect(OrderModel.tryParse({'id': 'x', 'status': 'IN_TRANSIT'}), isNull);
      expect(OrderModel.tryParse({'status': 'PLACED'}), isNull);
      expect(OrderModel.tryParse('nope'), isNull);
      expect(OrderModel.tryParse({'data': orderJson()})?.id, isNotNull);
    });

    test('unpaid / cancel rules and the 15-minute payment deadline', () {
      final created = DateTime.utc(2026, 10, 1, 21, 0);
      final unpaid = orderModel(createdAt: created);
      expect(unpaid.awaitsPayment, isTrue);
      expect(unpaid.canCancel, isTrue);
      expect(unpaid.paymentDeadline, DateTime.utc(2026, 10, 1, 21, 15));
      expect(orderModel(paymentStatus: 'FAILED').awaitsPayment, isTrue);
      expect(orderModel(paymentStatus: 'PAID').awaitsPayment, isFalse);
      expect(orderModel(status: 'ACCEPTED', paymentStatus: 'PAID').canCancel, isFalse);
    });

    test('merge rule: newer updatedAt wins; equal timestamps never move backwards', () {
      final t = DateTime.utc(2026, 10, 1, 21, 0);
      final placed = orderModel(updatedAt: t, paymentStatus: 'PAID');
      final accepted = orderModel(status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: t.add(const Duration(seconds: 5)));
      expect(accepted.isNewerThan(placed), isTrue);
      expect(placed.isNewerThan(accepted), isFalse);
      final acceptedSameTime = orderModel(status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: t);
      expect(placed.isNewerThan(acceptedSameTime), isFalse);
      final cancelledSameTime = orderModel(status: 'CANCELLED', updatedAt: t);
      expect(cancelledSameTime.isNewerThan(placed), isTrue);
      expect(placed.isNewerThan(cancelledSameTime), isFalse);
      expect(orderModel(updatedAt: t).isNewerThan(placed), isFalse, reason: 'never un-pay an order at the same timestamp');
    });

    test('rider_location payloads ({orderId, driverId, lat, lng, heading, at})', () {
      expect(RiderLocation.fromJson({'orderId': 'o', 'lat': 23.1, 'lng': 76.8})?.lat, 23.1);
      expect(RiderLocation.fromJson({'lat': 23.1, 'lng': 76.8}), isNull, reason: 'no orderId');
      expect(RiderLocation.fromJson({'orderId': 'o', 'lat': 123, 'lng': 0}), isNull);
      expect(RiderLocation.fromJson({'foo': 1}), isNull);
    });
  });

  group('checkout idempotency (clientRequestId)', () {
    test('an unchanged cart reuses its unpaid order: one POST, same order', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final a = await orders.placeOrder(draft());
      final b = await orders.placeOrder(draft());
      expect(a.value!.id, b.value!.id);
      expect(api.creates, hasLength(1));
      expect(orders.openCheckoutOrder(draft())?.id, a.value!.id, reason: 'back-navigation into checkout finds it again');
      expect(orders.activeOrders.map((o) => o.id), [a.value!.id]);
    });

    test('a double tap while the POST is in flight sends one request', () async {
      final api = FakeOrderApi();
      final gate = Completer<void>();
      api.onCreate = (r) async {
        await gate.future;
        return OrderResult.ok(orderModel(id: 'once'));
      };
      final orders = fakeOrders(api);
      final f1 = orders.placeOrder(draft());
      final f2 = orders.placeOrder(draft());
      expect(orders.isPlacingOrder, isTrue);
      gate.complete();
      expect((await f1).value!.id, 'once');
      expect((await f2).value!.id, 'once');
      expect(api.creates, hasLength(1));
      expect(orders.isPlacingOrder, isFalse);
    });

    test('a retry after a timeout sends the SAME key; a changed cart gets a new key', () async {
      final api = FakeOrderApi();
      var fail = true;
      api.onCreate = (r) async {
        if (fail) return const OrderResult.fail(OrderApiError(OrderErrorKind.timeout));
        return OrderResult.ok(orderModel(id: 'o-${r.clientRequestId}'));
      };
      final orders = fakeOrders(api);
      final first = await orders.placeOrder(draft());
      expect(first.error?.kind, OrderErrorKind.timeout);
      fail = false;
      await orders.placeOrder(draft());
      expect(api.creates[1].clientRequestId, api.creates[0].clientRequestId);

      await orders.placeOrder(draft(qty: 2));
      expect(api.creates[2].clientRequestId, isNot(api.creates[0].clientRequestId));
      expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$').hasMatch(api.creates[0].clientRequestId), isTrue);
    });

    test('the request body follows contract 2.2 (dishes summed, coupon, key)', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      await orders.placeOrder(CheckoutDraft(
        vendorId: 'v1',
        items: [(itemId: 'b', quantity: 1), (itemId: 'a', quantity: 2), (itemId: 'b', quantity: 1)],
        dropoffHostel: 'Block 3',
        dropoffNotes: '',
        couponCode: 'VITFIRST',
      ));
      final body = api.creates.single.toJson();
      expect(body['items'], [
        {'itemId': 'a', 'quantity': 2},
        {'itemId': 'b', 'quantity': 2},
      ]);
      expect(body['couponCode'], 'VITFIRST');
      expect(body['dropoffHostel'], 'Block 3');
      expect(body.containsKey('dropoffNotes'), isFalse);
      expect(body['clientRequestId'], isA<String>());
    });

    test('once the cart\'s order is cancelled/expired, the next checkout creates a new one', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final first = (await orders.placeOrder(draft())).value!;
      await orders.cancelOrder(first.id);
      expect(orders.orderById(first.id)!.status, OrderProgressStatus.cancelled);
      final second = (await orders.placeOrder(draft())).value!;
      expect(second.id, isNot(first.id));
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
    });
  });

  group('payment', () {
    test('success: create-order -> sheet -> verify -> server copy is PAID', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway();
      final orders = fakeOrders(api, gateway: gateway);
      final order = (await orders.placeOrder(draft())).value!;
      api.onVerify = (p) async {
        api.server[order.id] = orderModel(id: order.id, paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 2)));
        return const OrderResult.ok(null);
      };
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.paid);
      expect(gateway.opened.single.amountPaise, order.totalPaise);
      expect(api.verifies.single.razorpayPaymentId, 'pay_1');
      expect(orders.orderById(order.id)!.isPaid, isTrue);
    });

    test('cancelled sheet keeps the order PENDING; retry pays the SAME order (no new POST)', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final orders = fakeOrders(api, gateway: gateway);
      final order = (await orders.placeOrder(draft())).value!;

      final first = await orders.payForOrder(order.id);
      expect(first.kind, PaymentOutcomeKind.cancelled);
      expect(first.message, contains('Payment not completed'));
      expect(orders.orderById(order.id)!.awaitsPayment, isTrue);
      expect(api.verifies, isEmpty);

      gateway.next = const GatewayResult.failed(networkProblem: true);
      final second = await orders.payForOrder(order.id);
      expect(second.kind, PaymentOutcomeKind.failed);
      expect(second.message, contains('connection'));

      expect(api.paymentStarts, [order.id, order.id]);
      expect(api.creates, hasLength(1));
      // Re-entering checkout with the same cart still points at this order.
      expect((await orders.placeOrder(draft())).value!.id, order.id);
      expect(api.creates, hasLength(1));
    });

    test('a double tap on Pay opens one payment sheet', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway()..gate = Completer<void>();
      final orders = fakeOrders(api, gateway: gateway);
      final order = (await orders.placeOrder(draft())).value!;
      final a = orders.payForOrder(order.id);
      final b = orders.payForOrder(order.id);
      expect(orders.isPaying(order.id), isTrue);
      gateway.gate!.complete();
      await a;
      await b;
      expect(gateway.opened, hasLength(1));
      expect(api.paymentStarts, hasLength(1));
      expect(orders.isPaying(order.id), isFalse);
    });

    test('verify fails on the network after Razorpay success: "confirming", never "pay again"', () async {
      final api = FakeOrderApi()..onVerify = (p) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      var now = DateTime.utc(2026, 10, 1, 21, 0);
      final orders = fakeOrders(api, clock: () => now);
      final order = (await orders.placeOrder(draft())).value!;
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.confirming);
      expect(orders.isConfirmingPayment(order.id), isTrue);
      now = now.add(const Duration(minutes: 4));
      expect(orders.isConfirmingPayment(order.id), isFalse);
      expect(orders.paymentUnconfirmed(order.id), isTrue);
    });

    test('server answers PENDING_CONFIRMATION (success but still unpaid): "confirming", then paid when the order flips', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final order = (await orders.placeOrder(draft())).value!;
      // verify-signature: success:true with the still-unpaid order (Razorpay has not confirmed the capture yet).
      api.onVerify = (p) async => OrderResult.ok(api.server[order.id]);
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.confirming);
      expect(orders.isConfirmingPayment(order.id), isTrue);
      expect(orders.orderById(order.id)!.isPaid, isFalse);
      // The webhook/reconciliation marks it paid; the next refresh shows it.
      api.server[order.id] = orderModel(id: order.id, paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 3)));
      await orders.refreshOrder(order.id);
      expect(orders.orderById(order.id)!.isPaid, isTrue);
    });

    test('create-order refused because the webhook already marked it paid -> paid', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final order = (await orders.placeOrder(draft())).value!;
      api.server[order.id] = orderModel(id: order.id, paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 3)));
      api.onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.forbidden, statusCode: 403));
      expect((await orders.payForOrder(order.id)).kind, PaymentOutcomeKind.paid);
    });

    test('create-order refused because the order expired -> orderClosed with the reason', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final order = (await orders.placeOrder(draft())).value!;
      api.server[order.id] = orderModel(id: order.id, status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: kReasonPaymentNotCompleted, updatedAt: DateTime.now().toUtc().add(const Duration(minutes: 16)));
      api.onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409));
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.orderClosed);
      expect(outcome.message, contains('15 minutes'));
    });

    test('the sheet is never opened for an amount different from the order total', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway();
      final orders = fakeOrders(api, gateway: gateway);
      final order = (await orders.placeOrder(draft())).value!;
      api.onCreatePayment = (id) async => OrderResult.ok(PaymentSession(orderId: id, keyId: 'k', razorpayOrderId: 'r', amountPaise: order.totalPaise + 100));
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.failed);
      expect(gateway.opened, isEmpty);
    });

    test('external wallets are refused with a plain message', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api, gateway: FakeGateway()..next = const GatewayResult.externalWallet());
      final order = (await orders.placeOrder(draft())).value!;
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.failed);
      expect(outcome.message, contains('not supported'));
    });
  });

  group('polling, socket and merging', () {
    test('watching a live order polls it; older answers never overwrite newer ones; finished orders stop polling', () async {
      final api = FakeOrderApi();
      final t0 = DateTime.now().toUtc();
      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID', updatedAt: t0);
      final orders = fakeOrders(api);
      orders.beginSession('u1');
      orders.watch('o1');
      await flush();
      expect(orders.isPolling, isTrue);
      expect(orders.orderById('o1')!.status, OrderProgressStatus.placed);

      api.server['o1'] = orderModel(id: 'o1', status: 'PREPARING', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(seconds: 30)));
      await orders.pollOnce();
      expect(orders.orderById('o1')!.status, OrderProgressStatus.preparing);

      // A stale copy (e.g. a cached response) is ignored.
      api.server['o1'] = orderModel(id: 'o1', status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(seconds: 10)));
      await orders.pollOnce();
      expect(orders.orderById('o1')!.status, OrderProgressStatus.preparing);

      api.server['o1'] = orderModel(id: 'o1', status: 'DELIVERED', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(minutes: 1)));
      await orders.pollOnce();
      expect(orders.orderById('o1')!.status, OrderProgressStatus.delivered);
      expect(orders.isPolling, isFalse, reason: 'nothing left to poll');
      orders.unwatch('o1');
      orders.dispose();
    });

    test('unwatching stops the timer', () async {
      final api = FakeOrderApi();
      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID');
      final orders = fakeOrders(api)..beginSession('u1');
      orders.watch('o1');
      await flush();
      expect(orders.isPolling, isTrue);
      orders.unwatch('o1');
      expect(orders.isPolling, isFalse);
    });

    test('the socket gets the JWT, joins order_<id> on connect, and a late REST answer loses to a newer socket event', () async {
      final api = FakeOrderApi();
      final t0 = DateTime.now().toUtc();
      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID', updatedAt: t0);
      final orders = fakeOrders(api, token: 'jwt-abc')..beginSession('u1');
      orders.watch('o1');
      await flush();
      final socket = FakeRealtime.created.single;
      expect(socket.token, 'jwt-abc');
      socket.simulateConnect();
      expect(socket.joined, contains('o1'));

      // REST request in flight while the socket reports ACCEPTED.
      final slow = Completer<OrderResult<OrderModel>>();
      api.onFetch = (_) => slow.future;
      final refresh = orders.refreshOrder('o1');
      socket.emitOrder(orderJson(id: 'o1', status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: t0.add(const Duration(seconds: 20))));
      expect(orders.orderById('o1')!.status, OrderProgressStatus.accepted);
      slow.complete(OrderResult.ok(orderModel(id: 'o1', paymentStatus: 'PAID', updatedAt: t0)));
      await refresh;
      expect(orders.orderById('o1')!.status, OrderProgressStatus.accepted);

      // Unknown orders on the socket are ignored.
      socket.emitOrder(orderJson(id: 'someone-else', status: 'ACCEPTED'));
      expect(orders.orderById('someone-else'), isNull);
      orders.unwatch('o1');
      orders.dispose();
    });

    test('rider_location is kept only for an assigned, live order', () async {
      final api = FakeOrderApi();
      api.server['o1'] = orderModel(id: 'o1', status: 'PICKED_UP', paymentStatus: 'PAID', driver: {'id': 'd1', 'name': 'Vikram'});
      final orders = fakeOrders(api)..beginSession('u1');
      orders.watch('o1');
      await flush();
      final socket = FakeRealtime.created.single..simulateConnect();
      socket.emitRider({'orderId': 'o1', 'lat': 23.08, 'lng': 76.86});
      expect(orders.riderLocation('o1')?.lat, 23.08);
      socket.emitRider({'orderId': 'nope', 'lat': 1, 'lng': 1});
      expect(orders.riderLocation('nope'), isNull);
      orders.unwatch('o1');
      orders.dispose();
    });

    test('no token -> no socket (REST polling still works)', () async {
      final api = FakeOrderApi();
      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID');
      final orders = fakeOrders(api, token: null)..beginSession('u1');
      orders.watch('o1');
      await flush();
      expect(FakeRealtime.created, isEmpty);
      expect(orders.orderById('o1'), isNotNull);
      orders.unwatch('o1');
    });
  });

  group('session: restore, history paging, logout, account switch', () {
    test('sign-in restores active orders and the first history page; more pages use the cursor', () async {
      final api = FakeOrderApi();
      api.onFetchList = (scope, cursor) async {
        if (scope == 'active') return OrderResult.ok(OrdersPage([orderModel(id: 'live', paymentStatus: 'PAID')], null));
        if (cursor == null) return OrderResult.ok(OrdersPage([orderModel(id: 'h1', status: 'DELIVERED', paymentStatus: 'PAID')], 'c1'));
        return OrderResult.ok(OrdersPage([orderModel(id: 'h2', status: 'CANCELLED', paymentStatus: 'REFUNDED')], null));
      };
      final orders = fakeOrders(api)..beginSession('u1');
      await flush();
      expect(orders.activeOrder?.id, 'live');
      expect(orders.history.map((o) => o.id), ['h1']);
      expect(orders.historyHasMore, isTrue);
      await orders.loadMoreHistory();
      expect(api.fetchCursors.last, 'c1');
      expect(orders.history.map((o) => o.id), ['h1', 'h2']);
      expect(orders.historyHasMore, isFalse);
    });

    test('an old backend that ignores scope cannot resurrect long-finished orders as "current"', () async {
      final api = FakeOrderApi();
      final old = DateTime.now().toUtc().subtract(const Duration(days: 2));
      api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage([orderModel(id: 'old', status: 'DELIVERED', paymentStatus: 'PAID', createdAt: old)], null));
      final orders = fakeOrders(api)..beginSession('u1');
      await flush();
      expect(orders.currentOrder, isNull);
    });

    test('an order created while the active list was loading is not dropped by it', () async {
      final api = FakeOrderApi();
      final slow = Completer<OrderResult<OrdersPage>>();
      api.onFetchList = (scope, cursor) => scope == 'active' ? slow.future : Future.value(const OrderResult.ok(OrdersPage([], null)));
      final orders = fakeOrders(api)..beginSession('u1');
      final created = (await orders.placeOrder(draft())).value!;
      slow.complete(const OrderResult.ok(OrdersPage([], null)));
      await flush();
      expect(orders.activeOrders.map((o) => o.id), [created.id]);
    });

    test('logout wipes everything and ignores answers that arrive afterwards', () async {
      final api = FakeOrderApi();
      final slow = Completer<OrderResult<OrdersPage>>();
      api.onFetchList = (scope, cursor) => slow.future;
      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID');
      final orders = fakeOrders(api)..beginSession('u1');
      orders.watch('o1');
      await flush();
      final socket = FakeRealtime.created.single;
      orders.resetForLogout();
      expect(socket.disposed, isTrue);
      expect(orders.isPolling, isFalse);
      slow.complete(OrderResult.ok(OrdersPage([orderModel(id: 'leak', paymentStatus: 'PAID')], null)));
      await flush();
      expect(orders.activeOrders, isEmpty);
      expect(orders.history, isEmpty);
      expect(orders.orderById('o1'), isNull);
      expect(orders.orderById('leak'), isNull);
    });

    test('switching account clears the previous student\'s orders and checkout key', () async {
      final api = FakeOrderApi();
      api.onFetchList = (scope, cursor) async => const OrderResult.ok(OrdersPage([], null));
      final orders = fakeOrders(api)..beginSession('u1');
      final mine = (await orders.placeOrder(draft())).value!;
      orders.beginSession('u2');
      expect(orders.orderById(mine.id), isNull);
      expect(orders.openCheckoutOrder(draft()), isNull);
      await orders.placeOrder(draft());
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
    });
  });

  group('cancel and review', () {
    test('cancel refused (already accepted) loads the latest copy', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final order = (await orders.placeOrder(draft())).value!;
      api.server[order.id] = orderModel(id: order.id, status: 'ACCEPTED', paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(minutes: 1)));
      api.onCancel = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, message: 'Already accepted.'));
      final r = await orders.cancelOrder(order.id);
      expect(r.error?.message, 'Already accepted.');
      await flush();
      expect(orders.orderById(order.id)!.status, OrderProgressStatus.accepted);
    });

    test('a review is marked done only when the server accepts it (or says it already has it)', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      api.onReview = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      expect((await orders.submitReview(const ReviewRequest(orderId: 'd1', driverRating: 5, dishRatings: {'m': 4}))).ok, isFalse);
      expect(orders.hasReviewed('d1'), isFalse);
      api.onReview = null;
      final ok = await orders.submitReview(const ReviewRequest(orderId: 'd1', driverRating: 5, dishRatings: {'m': 4}));
      expect(ok.value!.totalCoins, 130);
      expect(orders.hasReviewed('d1'), isTrue);
      expect(api.reviews.last.toJson()['dishReviews'], [
        {'dishId': 'm', 'rating': 4}
      ]);
      api.onReview = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, message: 'This order has already been reviewed.'));
      await orders.submitReview(const ReviewRequest(orderId: 'd2', driverRating: null, dishRatings: {}));
      expect(orders.hasReviewed('d2'), isTrue);
    });
  });

  group('real backend codes (backend/src/services/orderFlow.ts, routes/orders.ts)', () {
    Future<(FakeOrderApi, OrderProvider, OrderModel)> placed() async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final order = (await orders.placeOrder(draft())).value!;
      return (api, orders, order);
    }

    test('PAYMENT_WINDOW_EXPIRED: order closed, and the next checkout uses a new key even before the job cancels it', () async {
      final (api, orders, order) = await placed();
      api.onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'PAYMENT_WINDOW_EXPIRED'));
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.orderClosed);
      expect(outcome.message, contains('15 minutes'));
      await orders.placeOrder(draft());
      expect(api.creates, hasLength(2));
      expect(api.creates[1].clientRequestId, isNot(api.creates[0].clientRequestId));
    });

    test('verify ORDER_CANCELLED: shows the automatic refund, takes the server copy from the error body', () async {
      final (api, orders, order) = await placed();
      final cancelled = orderModel(id: order.id, status: 'CANCELLED', paymentStatus: 'PAID', cancelledBy: 'SYSTEM', cancelReason: kReasonPaymentNotCompleted, updatedAt: DateTime.now().toUtc().add(const Duration(minutes: 1)));
      api.onVerify = (p) async => OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'ORDER_CANCELLED', order: cancelled));
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.orderClosed);
      expect(outcome.message, contains('refunded'));
      expect(orders.orderById(order.id)!.status, OrderProgressStatus.cancelled);
      expect(orders.isConfirmingPayment(order.id), isFalse);
    });

    test('verify DUPLICATE_PAYMENT counts as paid; PAYMENT_AMOUNT_MISMATCH fails without an endless "confirming"', () async {
      var (api, orders, order) = await placed();
      api.onVerify = (p) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'DUPLICATE_PAYMENT'));
      expect((await orders.payForOrder(order.id)).kind, PaymentOutcomeKind.paid);

      (api, orders, order) = await placed();
      api.onVerify = (p) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'PAYMENT_AMOUNT_MISMATCH'));
      final outcome = await orders.payForOrder(order.id);
      expect(outcome.kind, PaymentOutcomeKind.failed);
      expect(outcome.message, contains('support'));
      expect(orders.isConfirmingPayment(order.id), isFalse);
    });

    test('ALREADY_PAID on create-order: reload and treat as paid', () async {
      final (api, orders, order) = await placed();
      api.server[order.id] = orderModel(id: order.id, paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 3)));
      api.onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'ALREADY_PAID'));
      expect((await orders.payForOrder(order.id)).kind, PaymentOutcomeKind.paid);
    });

    test('codes map to customer wording', () {
      for (final code in ['TOO_MANY_UNPAID_ORDERS', 'CANNOT_CANCEL', 'ORDER_CLOSED', 'ROLE_NOT_ALLOWED', 'PARTNER_NOT_APPROVED', 'BAD_SIGNATURE', 'PROVIDER_UNAVAILABLE']) {
        final m = orderErrorMessage(OrderApiError(OrderErrorKind.conflict, code: code, message: 'raw $code'));
        expect(m, isNot(contains('raw')), reason: code);
      }
      expect(orderErrorMessage(const OrderApiError(OrderErrorKind.rejected, code: 'INVALID_ITEMS', message: "Item 'Lassi' is currently SOLD OUT.")), contains('SOLD OUT'));
    });

    test('isReviewed from the server hides the review; a refused join_room is retried', () async {
      final api = FakeOrderApi()..server['d1'] = OrderModel.tryParse(orderJson(id: 'd1', status: 'DELIVERED', paymentStatus: 'PAID', isReviewed: true))!;
      final orders = fakeOrders(api)..beginSession('u1');
      await orders.refreshOrder('d1');
      expect(orders.hasReviewed('d1'), isTrue);

      api.server['o1'] = orderModel(id: 'o1', paymentStatus: 'PAID');
      orders.watch('o1');
      await flush();
      final socket = FakeRealtime.created.single..ackOk = false;
      socket.simulateConnect();
      expect(orders.joinedRooms, isNot(contains('o1')));
      orders.unwatch('o1');
      orders.dispose();
    });

    test('rider_location from a rider who is not assigned to the order is ignored', () async {
      final api = FakeOrderApi()..server['o1'] = orderModel(id: 'o1', status: 'PICKED_UP', paymentStatus: 'PAID', driver: {'id': 'usr-4', 'name': 'Vikram'});
      final orders = fakeOrders(api)..beginSession('u1');
      orders.watch('o1');
      await flush();
      final socket = FakeRealtime.created.single..simulateConnect();
      socket.emitRider({'orderId': 'o1', 'driverId': 'usr-9', 'lat': 23.0, 'lng': 76.0, 'heading': 0, 'at': '2026-10-01T16:49:17.136Z'});
      expect(orders.riderLocation('o1'), isNull);
      socket.emitRider({'orderId': 'o1', 'driverId': 'usr-4', 'lat': 23.0771, 'lng': 76.8519, 'heading': 45, 'at': '2026-10-01T16:49:17.136Z'});
      expect(orders.riderLocation('o1')?.heading, 45);
      orders.unwatch('o1');
      orders.dispose();
    });
  });

  group('HttpOrderApi over HTTP (error mapping, query, body)', () {
    late List<http.Request> sent;
    late http.Response Function(http.Request) respond;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await CustomerApiService.saveToken('jwt-http');
      sent = [];
      CustomerApiService.httpClientOverride = MockClient((req) async {
        sent.add(req);
        return respond(req);
      });
    });
    tearDown(() async {
      CustomerApiService.httpClientOverride = null;
      CustomerApiService.onUnauthorized = null;
      await CustomerApiService.clearToken();
    });

    http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

    test('POST /orders sends the contract body with the Bearer token and parses 201 {data}', () async {
      respond = (_) => json(201, {'success': true, 'data': orderJson(id: 'srv-1')});
      final r = await const HttpOrderApi().createOrder(const CreateOrderRequest(vendorId: 'v', items: [(itemId: 'm', quantity: 2)], dropoffHostel: 'Block 1', dropoffNotes: 'hi', clientRequestId: 'key-1'));
      expect(r.value!.id, 'srv-1');
      expect(sent.single.headers['Authorization'], 'Bearer jwt-http');
      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      expect(body['clientRequestId'], 'key-1');
      expect(body['items'], [
        {'itemId': 'm', 'quantity': 2}
      ]);
    });

    test('GET /orders sends scope/limit/cursor and reads nextCursor', () async {
      respond = (_) => json(200, {'success': true, 'nextCursor': 'abc', 'data': [orderJson(id: 'a'), {'junk': true}]});
      final r = await const HttpOrderApi().fetchOrders(scope: 'history', limit: 20, cursor: 'c0');
      expect(sent.single.url.path, endsWith('/orders'));
      expect(sent.single.url.queryParameters, {'scope': 'history', 'limit': '20', 'cursor': 'c0'});
      expect(r.value!.orders.map((o) => o.id), ['a']);
      expect(r.value!.nextCursor, 'abc');
    });

    test('status codes map to error kinds with the server message', () async {
      final cases = {400: OrderErrorKind.rejected, 403: OrderErrorKind.forbidden, 404: OrderErrorKind.notFound, 409: OrderErrorKind.conflict, 429: OrderErrorKind.rateLimited, 500: OrderErrorKind.server, 503: OrderErrorKind.server};
      for (final e in cases.entries) {
        respond = (_) => json(e.key, {'success': false, 'message': 'msg ${e.key}', 'code': 'C${e.key}'});
        final r = await const HttpOrderApi().fetchOrder('x');
        expect(r.error!.kind, e.value, reason: '${e.key}');
        expect(r.error!.statusCode, e.key);
        expect(r.error!.code, 'C${e.key}');
      }
      respond = (_) => json(429, {'success': false, 'message': 'You have 3 unpaid orders.'});
      expect(orderErrorMessage((await const HttpOrderApi().createPayment('x')).error!), 'You have 3 unpaid orders.');
      respond = (_) => json(500, {'success': false, 'message': 'TypeError: secret stack'});
      expect(orderErrorMessage((await const HttpOrderApi().fetchOrder('x')).error!), isNot(contains('TypeError')), reason: '5xx text is never shown');
    });

    test('offline, garbage 200 and 401 are classified', () async {
      respond = (_) => throw http.ClientException('offline');
      expect((await const HttpOrderApi().fetchOrder('x')).error!.kind, OrderErrorKind.offline);
      expect(orderErrorMessage(const OrderApiError(OrderErrorKind.offline)), contains('No internet'));
      respond = (_) => http.Response('<html>', 200);
      expect((await const HttpOrderApi().fetchOrder('x')).error!.kind, OrderErrorKind.badResponse);
      var fired = 0;
      CustomerApiService.onUnauthorized = () => fired++;
      respond = (_) => json(401, {'success': false});
      expect((await const HttpOrderApi().fetchOrders(scope: 'active')).error!.kind, OrderErrorKind.unauthorized);
      expect(fired, 1);
    });

    test('create-order: Razorpay params parsed; an amount under ₹1 or missing key is refused', () async {
      respond = (_) => json(200, {'success': true, 'key_id': 'rzp_test_1', 'order_id': 'order_X', 'amount': 24500, 'currency': 'INR'});
      final s = (await const HttpOrderApi().createPayment('o1')).value!;
      expect([s.keyId, s.razorpayOrderId, s.amountPaise], ['rzp_test_1', 'order_X', 24500]);
      respond = (_) => json(200, {'success': true, 'key_id': 'rzp_test_1', 'order_id': 'order_X', 'amount': 50});
      expect((await const HttpOrderApi().createPayment('o1')).error!.kind, OrderErrorKind.badResponse);
    });

    test('verify-signature succeeds with or without an order in the body', () async {
      respond = (_) => json(200, {'success': true, 'message': 'ok'});
      const proof = PaymentProof(razorpayOrderId: 'a', razorpayPaymentId: 'b', razorpaySignature: 'c');
      final r = await const HttpOrderApi().verifyPayment(proof);
      expect(r.ok, isTrue);
      expect(r.value, isNull);
      respond = (_) => json(200, {'success': true, 'data': orderJson(id: 'p', paymentStatus: 'PAID')});
      expect((await const HttpOrderApi().verifyPayment(proof)).value!.isPaid, isTrue);
      respond = (_) => json(400, {'success': false, 'message': 'Invalid payment signature.'});
      expect((await const HttpOrderApi().verifyPayment(proof)).error!.kind, OrderErrorKind.rejected);
    });
  });
}
