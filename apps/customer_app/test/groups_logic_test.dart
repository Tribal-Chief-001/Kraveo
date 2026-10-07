import 'dart:async';

import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/models/order_group.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/providers/quote_controller.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/services/payment_gateway.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/order_fakes.dart';

MenuItemModel dish(String id, {double price = 90, String vendor = 'gx-ven-1'}) =>
    MenuItemModel(id: id, vendorId: vendor, name: 'Dish $id', price: price, category: 'x', description: 'd', imageUrl: '', isAvailable: true);

Future<void> flush() async {
  for (var i = 0; i < 6; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

CheckoutDraft groupDraft({String hostel = 'BH2', String notes = 'Room 214', String? coupon = 'KRAVEO50', bool swap = false}) {
  const a = RestaurantCart(vendorId: 'gx-ven-1', items: [(itemId: 'm-thali', quantity: 1), (itemId: 'm-paratha', quantity: 1)]);
  const b = RestaurantCart(vendorId: 'gx-ven-2', items: [(itemId: 'm-roll', quantity: 1)]);
  final first = swap ? b : a;
  final second = swap ? a : b;
  return CheckoutDraft(vendorId: first.vendorId, items: first.items, dropoffHostel: hostel, dropoffNotes: notes, couponCode: coupon, extraRestaurants: [second]);
}

void main() {
  setUp(() => FakeRealtime.created.clear());

  group('OrderModel.group (Docs/22 10.4)', () {
    test('a single-restaurant order has no group; a child parses its group, stops included', () {
      expect(OrderModel.tryParse(orderJson())!.group, isNull);
      expect(OrderModel.tryParse(orderJson())!.isGroup, isFalse);
      final child = OrderModel.tryParse(groupChildrenJson(statuses: const ['ACCEPTED', 'PREPARING'])[1])!;
      expect(child.isGroup, isTrue);
      expect(child.group!.id, 'grp-1');
      expect(child.group!.index, 1);
      expect(child.group!.size, 2);
      expect(child.group!.primary, isFalse);
      expect(child.group!.stops.map((s) => s.vendorName), ['Kitchen 1', 'Kitchen 2']);
      expect(child.group!.stops.map((s) => s.status), [OrderProgressStatus.accepted, OrderProgressStatus.preparing]);
      expect(child.group!.stops.first.itemCount, 2);
    });

    test('never crashes on odd or restaurant-shaped group values', () {
      for (final bad in <Object?>[null, 'x', 5, <String, dynamic>{}, {'size': 2, 'allAccepted': false}, {'id': 7}, {'id': 'g', 'stops': 'nope'}, {'id': 'g', 'stops': [1, null, {'orderId': 'a'}]}]) {
        final o = OrderModel.tryParse({...orderJson(), 'group': bad, 'brandNewField': 1});
        expect(o, isNotNull, reason: '$bad');
      }
      expect(OrderModel.tryParse({...orderJson(), 'group': {'size': 2, 'allAccepted': false}})!.group, isNull, reason: 'a restaurant copy has no group id');
      final lenient = OrderModel.tryParse({...orderJson(), 'group': {'id': 'g', 'stops': [1, null, {'orderId': 'a'}]}})!;
      expect(lenient.group!.id, 'g');
      expect(lenient.group!.stops, isEmpty);
    });
  });

  group('quote and group responses', () {
    test('the real quote shape (Docs/22 10.2) parses', () {
      final q = OrderQuote.tryParse(quoteJson())!;
      expect(q.restaurantCount, 2);
      expect(q.subtotal, 270);
      expect(q.baseFee, 25);
      expect(q.extraRestaurants, 1);
      expect(q.extraRestaurantFee, 15);
      expect(q.extraTotal, 15);
      expect(q.feeTotal, 40);
      expect(q.discount, 50);
      expect(q.couponCode, 'KRAVEO50');
      expect(q.total, 260);
      expect(q.totalPaise, 26000);
      expect(q.perRestaurant.map((l) => l.vendorName), ['Kitchen 1', 'Kitchen 2']);
      expect(q.perRestaurant.last.fee, 15);
      expect(q.maxRestaurants, 3);
    });

    test('a quote without the essentials is rejected; a missing max falls back to 3', () {
      expect(OrderQuote.tryParse(null), isNull);
      expect(OrderQuote.tryParse({'subtotal': 1}), isNull);
      expect(OrderQuote.tryParse({'subtotal': 100, 'total': 125, 'fees': {'base': 25}})!.maxRestaurants, 3);
    });

    test('GroupView: children in order, payOrderId is the primary; junk is refused', () {
      final g = OrderGroupView.tryParse(groupViewJson())!;
      expect(g.id, 'grp-1');
      expect(g.payOrderId, 'gx-order-1');
      expect(g.total, 260);
      expect(g.orders.map((o) => o.id), ['gx-order-1', 'gx-order-2']);
      expect(OrderGroupView.tryParse({'id': 'x', 'orders': []}), isNull);
      expect(OrderGroupView.tryParse('nope'), isNull);
      expect(OrderGroupView.tryParse({...groupViewJson(), 'payOrderId': null})!.payOrderId, 'gx-order-1');
    });

    test('the requests carry the real fields', () {
      final r = CreateGroupRequest(
        restaurants: groupDraft().restaurants,
        dropoffHostel: 'BH2',
        dropoffNotes: 'Room 214',
        couponCode: 'KRAVEO50',
        clientRequestId: 'abcdefgh-1',
      ).toJson();
      expect(r['clientRequestId'], 'abcdefgh-1');
      expect(r['dropoffHostel'], 'BH2');
      expect(r['couponCode'], 'KRAVEO50');
      expect((r['restaurants'] as List).first, {'vendorId': 'gx-ven-1', 'items': [{'itemId': 'm-paratha', 'quantity': 1}, {'itemId': 'm-thali', 'quantity': 1}]});
      expect(QuoteRequest(restaurants: groupDraft().restaurants).toJson().containsKey('couponCode'), isFalse);
    });

    test('error bodies carry vendorId and maxRestaurants', () {
      final e = HttpOrderApi.errorFor(400, {'success': false, 'code': 'TOO_MANY_RESTAURANTS', 'message': 'You can order from at most 2 restaurants at once.', 'maxRestaurants': 2});
      expect(e.maxRestaurants, 2);
      expect(e.kind, OrderErrorKind.rejected);
      expect(HttpOrderApi.errorFor(400, {'code': 'VENDOR_CLOSED', 'vendorId': 'gx-ven-2'}).vendorId, 'gx-ven-2');
    });
  });

  group('composite order (what screens show for a combined order)', () {
    test('money adds up to the group total, id is the primary, names are joined', () {
      final c = OrderModel.composite(groupChildren());
      expect(c.id, 'gx-order-1');
      expect(c.totalAmount, 260);
      expect(c.subtotal, 270);
      expect(c.deliveryFee, 40);
      expect(c.discount, 50);
      expect(c.totalPaise, 26000);
      expect(c.vendorName, 'Kitchen 1 + Kitchen 2');
      expect(c.title, '2 restaurants');
      expect(c.itemCount, 3);
      expect(c.members, hasLength(2));
      // the primary child is found even when the list is shuffled
      expect(OrderModel.composite(groupChildren().reversed.toList()).id, 'gx-order-1');
    });

    test('status is the least advanced restaurant; one cancelled restaurant cancels the whole order', () {
      expect(OrderModel.composite(groupChildren(statuses: const ['PREPARING', 'ACCEPTED'], paymentStatus: 'PAID')).status, OrderProgressStatus.accepted);
      expect(OrderModel.composite(groupChildren(statuses: const ['PICKED_UP', 'PICKED_UP'], paymentStatus: 'PAID')).status, OrderProgressStatus.pickedUp);
      expect(OrderModel.composite(groupChildren(statuses: const ['DELIVERED', 'DELIVERED'], paymentStatus: 'PAID')).status, OrderProgressStatus.delivered);
      expect(OrderModel.composite(groupChildren(statuses: const ['PLACED', 'CANCELLED'], paymentStatus: 'PAID')).status, OrderProgressStatus.cancelled);
      expect(deriveGroupProgress(const []), OrderProgressStatus.placed);
    });

    test('canCancel only while EVERY restaurant is still placed', () {
      expect(OrderModel.composite(groupChildren(paymentStatus: 'PAID')).canCancel, isTrue);
      expect(OrderModel.composite(groupChildren(statuses: const ['ACCEPTED', 'PLACED'], paymentStatus: 'PAID')).canCancel, isFalse);
      expect(orderModel(paymentStatus: 'PAID').canCancel, isTrue, reason: 'single orders: unchanged');
    });

    test('cancelled: the triggering restaurant\'s reason is used, not the generic sibling text; refund is the primary\'s', () {
      final kids = groupChildren(
        statuses: const ['CANCELLED', 'CANCELLED'],
        paymentStatus: 'PAID',
        refundStatus: 'PENDING',
        cancelledBy: const ['SYSTEM', 'VENDOR'],
        cancelReasons: const ['Another restaurant in your order could not take it', 'Out of paneer'],
      );
      final c = OrderModel.composite(kids);
      expect(c.cancelReason, 'Out of paneer');
      expect(c.cancelledBy, CancelledBy.vendor);
      expect(c.cancelTriggerName, 'Kitchen 2');
      expect(c.isRefundInProgress, isTrue);
      final unpaid = OrderModel.composite(groupChildren(
        statuses: const ['CANCELLED', 'CANCELLED'],
        cancelledBy: const ['SYSTEM', 'SYSTEM'],
        cancelReasons: const ['Payment not completed', 'Another restaurant in your order could not take it'],
      ));
      expect(unpaid.isPaymentNotCompletedCancel, isTrue);
    });

    test('while some restaurants are not loaded the group total stands in for the sum, and the stops name the rest', () {
      final onlyFirst = [groupChildren().first];
      final c = OrderModel.composite(onlyFirst, groupTotal: 260);
      expect(c.totalAmount, 260);
      expect(c.vendorName, 'Kitchen 1 + Kitchen 2');
      expect(c.members, hasLength(1));
    });

    test('the OTP is shared by the children (only parsed at the gate)', () {
      final c = OrderModel.composite(groupChildren(statuses: const ['ARRIVED_AT_GATE', 'ARRIVED_AT_GATE'], paymentStatus: 'PAID', otpCode: '4821'));
      expect(c.status, OrderProgressStatus.arrivedAtGate);
      expect(c.otpCode, '4821');
      expect(OrderModel.composite(groupChildren(statuses: const ['PICKED_UP', 'PICKED_UP'], paymentStatus: 'PAID', otpCode: '4821')).otpCode, isNull);
    });
  });

  group('CartProvider: several restaurants', () {
    late CartProvider cart;
    setUp(() => cart = CartProvider());

    bool add(String id, String vendor, {double price = 90}) => cart.addItem(item: dish(id, price: price, vendor: vendor), dhabaId: vendor, dhabaName: 'Kitchen $vendor');

    test('adding from another restaurant keeps the cart; lines are grouped per restaurant with subtotals', () {
      add('a', 'v1', price: 100);
      add('a', 'v1', price: 100);
      add('b', 'v2', price: 60);
      expect(cart.restaurantCount, 2);
      expect(cart.isMultiRestaurant, isTrue);
      expect(cart.dhabaId, 'v1');
      expect(cart.restaurants.map((r) => (r.id, r.itemCount, r.subtotal)), [('v1', 2, 200.0), ('v2', 1, 60.0)]);
      expect(cart.subtotal, 260);
      expect(cart.itemCount, 3);
    });

    test('estimate = subtotal + 25 + 15 per extra restaurant - coupon (fallback only)', () {
      add('a', 'v1', price: 100);
      expect(cart.grandTotal, 125);
      add('b', 'v2', price: 100);
      expect(cart.baseDeliveryFee, 25);
      expect(cart.extraRestaurantFees, 15);
      expect(cart.deliveryFee, 40);
      expect(cart.grandTotal, 240);
      add('c', 'v3', price: 100);
      expect(cart.grandTotal, 300 + 25 + 30);
      expect(cart.applyCoupon('KRAVEO50'), isTrue);
      expect(cart.grandTotal, 355 - 50);
    });

    test('the limit refuses another restaurant (nothing changes) but not more of a restaurant already in the cart', () {
      add('a', 'v1');
      add('b', 'v2');
      add('c', 'v3');
      expect(cart.canAddRestaurant('v4'), isFalse);
      expect(add('d', 'v4'), isFalse);
      expect(cart.restaurantCount, 3);
      expect(cart.itemCount, 3);
      expect(add('a2', 'v2'), isTrue);
      expect(cart.maxRestaurantsMessage, contains('at most 3 restaurants'));
      cart.setMaxRestaurants(2);
      expect(cart.canAddRestaurant('v1'), isTrue);
      expect(cart.canAddRestaurant('v9'), isFalse);
      expect(cart.maxRestaurants, 2);
    });

    test('assumes 3 before the first quote; 1 = feature off = the old "replace the cart" behaviour', () {
      expect(cart.maxRestaurants, 3);
      cart.setMaxRestaurants(1);
      add('a', 'v1');
      expect(cart.wouldReplaceCart('v2'), isTrue);
      expect(cart.canAddRestaurant('v2'), isFalse);
      add('b', 'v2');
      expect(cart.restaurantCount, 1);
      expect(cart.dhabaId, 'v2');
      cart.setMaxRestaurants(0);
      expect(cart.maxRestaurants, 1, reason: 'never below 1');
    });

    test('remove one restaurant, decrement a restaurant\'s last dish, clear all; the primary moves on', () {
      add('a', 'v1');
      add('b', 'v2');
      add('c', 'v3');
      cart.removeRestaurant('v1');
      expect(cart.restaurants.map((r) => r.id), ['v2', 'v3']);
      expect(cart.dhabaId, 'v2');
      cart.decrementItem(cart.restaurants.first.items.single.cartItemId);
      expect(cart.restaurants.map((r) => r.id), ['v3']);
      expect(cart.isMultiRestaurant, isFalse);
      cart.removeRestaurant('v3');
      expect(cart.items, isEmpty);
      expect(cart.dhabaId, isNull);
      add('a', 'v1');
      add('b', 'v2');
      cart.clearCart();
      expect(cart.restaurantCount, 0);
      expect(cart.grandTotal, 0);
    });

    test('max quantity per dish still applies across the cart; the same dish at two restaurants is two lines', () {
      for (var i = 0; i < CartProvider.maxQuantityPerDish; i++) {
        expect(add('a', 'v1'), isTrue);
      }
      expect(add('a', 'v1'), isFalse);
      expect(cart.getItemQuantityInCart('a'), 20);
      expect(add('z', 'v2'), isTrue);
      expect(cart.restaurantCount, 2);
    });

    test('an old cart keeps working when the limit drops below its size (checkout explains)', () {
      add('a', 'v1');
      add('b', 'v2');
      add('c', 'v3');
      cart.setMaxRestaurants(2);
      expect(cart.restaurantCount, 3);
      expect(add('d', 'v1'), isTrue);
    });
  });

  group('QuoteController', () {
    QuoteRequest req(int n, {String? coupon}) => QuoteRequest(restaurants: [for (var i = 0; i < n; i++) RestaurantCart(vendorId: 'gx-ven-${i + 1}', items: [(itemId: 'm$i', quantity: 1)])], couponCode: coupon);

    test('a burst of changes sends ONE request (debounce) and ends ready', () async {
      final api = FakeOrderApi()..onQuote = (r) async => OrderResult.ok(OrderQuote.tryParse(quoteJson())!);
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 30));
      q.request(req(1));
      q.request(req(2));
      q.request(req(2, coupon: 'KRAVEO50'));
      expect(q.isLoading, isTrue);
      expect(q.quote, isNull, reason: 'no stale price while loading');
      await Future<void>.delayed(const Duration(milliseconds: 90));
      expect(api.quotes, hasLength(1));
      expect(api.quotes.single.couponCode, 'KRAVEO50');
      expect(q.status, QuoteStatus.ready);
      expect(q.quote!.total, 260);
      q.dispose();
    });

    test('the same cart and coupon never asks twice; a changed one asks again', () async {
      final api = FakeOrderApi()..onQuote = (r) async => OrderResult.ok(OrderQuote.tryParse(quoteJson())!);
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 5));
      q.request(req(2));
      await Future<void>.delayed(const Duration(milliseconds: 40));
      q.request(req(2));
      q.request(req(2));
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(api.quotes, hasLength(1));
      q.request(req(3));
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(api.quotes, hasLength(2));
      q.dispose();
    });

    test('a stale answer (older cart finishing late) is ignored', () async {
      final slow = Completer<OrderResult<OrderQuote>>();
      final api = FakeOrderApi();
      api.onQuote = (r) => r.restaurants.length == 1 ? slow.future : Future.value(OrderResult.ok(OrderQuote.tryParse(quoteJson(count: 2, total: 260))!));
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 5));
      q.request(req(1));
      await Future<void>.delayed(const Duration(milliseconds: 30)); // request 1 is in flight
      q.request(req(2));
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(q.quote!.restaurantCount, 2);
      slow.complete(OrderResult.ok(OrderQuote.tryParse(quoteJson(count: 1, total: 105))!));
      await flush();
      expect(q.quote!.total, 260, reason: 'the late answer about the older cart must not replace it');
      q.dispose();
    });

    test('an answer after dispose or after the cart was emptied changes nothing', () async {
      final late = Completer<OrderResult<OrderQuote>>();
      final api = FakeOrderApi()..onQuote = (r) => late.future;
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 5));
      var notified = 0;
      q.addListener(() => notified++);
      q.request(req(2));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      q.request(null);
      expect(q.status, QuoteStatus.idle);
      late.complete(OrderResult.ok(OrderQuote.tryParse(quoteJson())!));
      await flush();
      expect(q.status, QuoteStatus.idle);
      expect(q.quote, isNull);
      final n = notified;
      q.dispose();
      expect(notified, n);
    });

    test('maxRestaurants of the quote reaches the cart; old server (404) and MULTI_DISABLED mean 1; TOO_MANY reports its limit', () async {
      final seen = <int>[];
      final api = FakeOrderApi();
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 2), onMaxRestaurants: seen.add);
      api.onQuote = (r) async => OrderResult.ok(OrderQuote.tryParse(quoteJson(max: 2))!);
      q.request(req(1));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(seen, [2]);
      api.onQuote = null; // FakeOrderApi default = 404 like an old server
      q.request(req(2));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(q.unsupported, isTrue);
      expect(q.problem, isNull, reason: 'no scary text for an old server: just the estimate');
      expect(seen.last, 1);
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'TOO_MANY_RESTAURANTS', message: 'You can order from at most 2 restaurants at once.', maxRestaurants: 2));
      q.request(req(3));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(seen.last, 2);
      expect(q.blocksCheckout, isTrue);
      expect(q.problem, 'You can order from at most 2 restaurants at once.');
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'MULTI_DISABLED', message: 'Ordering from several restaurants at once is switched off right now.'));
      q.request(req(2, coupon: 'X'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(seen.last, 1);
      q.dispose();
    });

    test('quote errors: the server message is shown for refusals; offline / timeout / 5xx fall back silently; retry asks again', () async {
      final api = FakeOrderApi();
      final q = QuoteController(api: api, debounce: const Duration(milliseconds: 2));
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'COUPON_NOT_APPLICABLE', message: 'KRAVEO50 needs a food subtotal of at least Rs 150.'));
      q.request(req(2, coupon: 'KRAVEO50'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(q.problem, 'KRAVEO50 needs a food subtotal of at least Rs 150.');
      expect(q.blocksCheckout, isFalse, reason: 'the order can still be placed (the coupon is dropped then)');
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rejected, statusCode: 400, code: 'VENDOR_CLOSED', message: 'This Dhaba is currently CLOSED for new orders.', vendorId: 'gx-ven-2'));
      q.request(req(3));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(q.problem, isNotNull);
      api.onQuote = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      q.request(req(4));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(q.status, QuoteStatus.failed);
      expect(q.problem, isNull);
      expect(q.quote, isNull);
      api.onQuote = (r) async => OrderResult.ok(OrderQuote.tryParse(quoteJson())!);
      q.retry();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(q.status, QuoteStatus.ready);
      q.dispose();
    });
  });

  group('OrderProvider: combined orders', () {
    test('placing: ONE POST /order-groups with a clientRequestId; the same cart + drop point reuses it (no second request)', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final a = await orders.placeOrder(groupDraft());
      expect(a.ok, isTrue);
      expect(api.creates, isEmpty, reason: 'the single-order endpoint is not used');
      expect(api.groupCreates, hasLength(1));
      expect(api.groupCreates.single.clientRequestId, hasLength(36));
      expect(a.value!.id, 'gx-order-1', reason: 'the id to pay is the primary part');
      expect(a.value!.isGroup, isTrue);
      expect(a.value!.totalAmount, 260);
      final b = await orders.placeOrder(groupDraft());
      expect(b.value!.id, a.value!.id);
      expect(api.groupCreates, hasLength(1));
      expect(orders.openCheckoutOrder(groupDraft())?.id, 'gx-order-1');
      expect(orders.activeOrders, hasLength(1), reason: 'one entry for the whole combined order');
      expect(orders.liveOrders.single.members, hasLength(2));
    });

    test('the key is the same for the same cart in any restaurant order, new for another drop point (before an order exists) and after the order is finished', () async {
      final api = FakeOrderApi();
      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.offline));
      final orders = fakeOrders(api);
      await orders.placeOrder(groupDraft());
      await orders.placeOrder(groupDraft(swap: true));
      expect(api.groupCreates[1].clientRequestId, api.groupCreates[0].clientRequestId, reason: 'retry after a network failure: same key, same order');
      await orders.placeOrder(groupDraft(hostel: 'BH5'));
      expect(api.groupCreates[2].clientRequestId, isNot(api.groupCreates[0].clientRequestId), reason: 'a different drop point is a different request');
      expect(groupDraft().cartKey, groupDraft(swap: true).cartKey);
      expect(groupDraft().cartKey, isNot(groupDraft(coupon: null).cartKey));
      // a single-restaurant draft keeps its old key format
      expect(CheckoutDraft(vendorId: 'v', items: const [(itemId: 'a', quantity: 2)], dropoffHostel: 'BH2', dropoffNotes: '').cartKey, 'v|ax2|');
    });

    test('CLIENT_REQUEST_MISMATCH re-keys once, like a single order', () async {
      final api = FakeOrderApi();
      var n = 0;
      api.onCreateGroup = (r) async => n++ == 0 ? const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'CLIENT_REQUEST_MISMATCH')) : OrderResult.ok(OrderGroupView.tryParse(groupViewJson())!);
      final orders = fakeOrders(api);
      final r = await orders.placeOrder(groupDraft());
      expect(r.ok, isTrue);
      expect(api.groupCreates, hasLength(2));
      expect(api.groupCreates[1].clientRequestId, isNot(api.groupCreates[0].clientRequestId));
    });

    test('a single-restaurant draft still uses POST /orders exactly as before', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final r = await orders.placeOrder(CheckoutDraft(vendorId: 'v-real-1', items: const [(itemId: 'm-thali', quantity: 1)], dropoffHostel: 'BH2', dropoffNotes: ''));
      expect(r.ok, isTrue);
      expect(api.creates, hasLength(1));
      expect(api.groupCreates, isEmpty);
      expect(r.value!.isGroup, isFalse);
    });

    test('errors from /order-groups reach the caller untouched (old server 404, too many unpaid)', () async {
      final api = FakeOrderApi();
      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.notFound, statusCode: 404));
      final orders = fakeOrders(api);
      expect((await orders.placeOrder(groupDraft())).error!.kind, OrderErrorKind.notFound);
      api.onCreateGroup = (r) async => const OrderResult.fail(OrderApiError(OrderErrorKind.rateLimited, statusCode: 429, code: 'TOO_MANY_UNPAID_ORDERS'));
      expect((await orders.placeOrder(groupDraft())).error!.code, 'TOO_MANY_UNPAID_ORDERS');
      expect(orders.activeOrders, isEmpty);
    });

    test('payment opens Razorpay for the PRIMARY order id with the GROUP total', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway();
      final orders = fakeOrders(api, gateway: gateway);
      final placed = (await orders.placeOrder(groupDraft())).value!;
      api.onVerify = (p) async {
        api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(paymentStatus: 'PAID', orders: groupChildrenJson(paymentStatus: 'PAID')))!;
        return const OrderResult.ok(null);
      };
      final outcome = await orders.payForOrder(placed.id);
      expect(api.paymentStarts, ['gx-order-1']);
      expect(gateway.opened.single.amountPaise, 26000);
      expect(gateway.opened.single.orderId, 'gx-order-1');
      expect(outcome.kind, PaymentOutcomeKind.paid);
      expect(outcome.order!.isPaid, isTrue);
      expect(orders.orderById('gx-order-2')!.id, 'gx-order-1', reason: 'any part opens the one combined order');
      expect(orders.orderById('gx-order-2')!.members!.every((m) => m.isPaid), isTrue);
    });

    test('payment cancelled / failed keep the order and allow the same retry; expiry closes the whole order', () async {
      final api = FakeOrderApi();
      final gateway = FakeGateway()..next = const GatewayResult.cancelled();
      final orders = fakeOrders(api, gateway: gateway);
      final placed = (await orders.placeOrder(groupDraft())).value!;
      expect((await orders.payForOrder(placed.id)).kind, PaymentOutcomeKind.cancelled);
      gateway.next = const GatewayResult.failed();
      expect((await orders.payForOrder(placed.id)).kind, PaymentOutcomeKind.failed);
      expect(api.groupCreates, hasLength(1));
      expect(api.paymentStarts, ['gx-order-1', 'gx-order-1']);
      // expiry on the server: every part is cancelled
      api.onCreatePayment = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'PAYMENT_WINDOW_EXPIRED'));
      api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(orders: groupChildrenJson(statuses: const ['CANCELLED', 'CANCELLED'], cancelledBy: const ['SYSTEM', 'SYSTEM'], cancelReasons: const ['Payment not completed', 'Another restaurant in your order could not take it'], updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 3)))))!;
      final closed = await orders.payForOrder(placed.id);
      expect(closed.kind, PaymentOutcomeKind.orderClosed);
      await flush(); // the order is reloaded in the background
      expect(orders.orderById('gx-order-1')!.status, OrderProgressStatus.cancelled);
      expect(orders.orderById('gx-order-1')!.isPaymentNotCompletedCancel, isTrue);
    });

    test('a payment amount that is not the group total is refused before the sheet opens', () async {
      final api = FakeOrderApi();
      api.onCreatePayment = (id) async => OrderResult.ok(PaymentSession(orderId: id, keyId: 'k', razorpayOrderId: 'r', amountPaise: 19000)); // only the primary child's share
      final gateway = FakeGateway();
      final orders = fakeOrders(api, gateway: gateway);
      final placed = (await orders.placeOrder(groupDraft())).value!;
      final o = await orders.payForOrder(placed.id);
      expect(o.kind, PaymentOutcomeKind.failed);
      expect(gateway.opened, isEmpty);
    });

    test('cancelling (any part) cancels the whole combined order and reloads it', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final placed = (await orders.placeOrder(groupDraft())).value!;
      final later = DateTime.now().toUtc().add(const Duration(seconds: 5));
      api.onCancel = (id) async {
        final kids = groupChildrenJson(statuses: const ['CANCELLED', 'CANCELLED'], cancelledBy: const ['CUSTOMER', 'SYSTEM'], cancelReasons: const ['Cancelled by customer', 'Another restaurant in your order could not take it'], updatedAt: later);
        api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(orders: kids))!;
        return OrderResult.ok(OrderModel.tryParse(kids.first)!);
      };
      final r = await orders.cancelOrder(placed.id, reason: 'Cancelled at checkout');
      await flush();
      expect(r.ok, isTrue);
      expect(api.cancels, ['gx-order-1']);
      expect(api.fetchedGroups, contains('grp-1'));
      final c = orders.orderById('gx-order-1')!;
      expect(c.status, OrderProgressStatus.cancelled);
      expect(c.members!.every((m) => m.status == OrderProgressStatus.cancelled), isTrue);
      expect(orders.activeOrders.single.status, OrderProgressStatus.cancelled);
    });

    test('CANNOT_CANCEL from the server is returned as is (and the latest state is loaded)', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api);
      final placed = (await orders.placeOrder(groupDraft())).value!;
      api.onCancel = (id) async => const OrderResult.fail(OrderApiError(OrderErrorKind.conflict, statusCode: 409, code: 'CANNOT_CANCEL', message: 'A restaurant already accepted.'));
      final r = await orders.cancelOrder(placed.id);
      expect(r.error!.code, 'CANNOT_CANCEL');
      expect(r.error!.message, 'A restaurant already accepted.');
    });

    test('lists: children of one group merge into ONE active entry and ONE history entry; single orders are untouched', () async {
      final api = FakeOrderApi();
      final single = orderJson(id: 's-1', status: 'PREPARING', paymentStatus: 'PAID');
      api.onFetchList = (scope, cursor) async {
        if (scope == 'active') {
          return OrderResult.ok(OrdersPage([OrderModel.tryParse(single)!, ...groupChildren(statuses: const ['PREPARING', 'ACCEPTED'], paymentStatus: 'PAID')], null));
        }
        final past = DateTime.now().toUtc().subtract(const Duration(days: 2));
        return OrderResult.ok(OrdersPage([
          ...[for (final j in groupChildrenJson(groupId: 'old', statuses: const ['DELIVERED', 'DELIVERED'], paymentStatus: 'PAID', ids: const ['o-1', 'o-2'], updatedAt: past)) OrderModel.tryParse(j)!],
          OrderModel.tryParse(orderJson(id: 'lone', status: 'DELIVERED', paymentStatus: 'PAID', updatedAt: past, createdAt: past))!,
        ], null));
      };
      final orders = fakeOrders(api);
      orders.beginSession('u1');
      await flush();
      expect(orders.liveOrders.map((o) => o.id).toSet(), {'s-1', 'gx-order-1'});
      expect(orders.liveOrders.where((o) => o.isGroup), hasLength(1));
      expect(orders.liveOrders.firstWhere((o) => o.isGroup).status, OrderProgressStatus.accepted);
      expect(orders.history.map((o) => o.id), ['o-1', 'lone']);
      expect(orders.history.first.members, hasLength(2));
      expect(orders.history.first.totalAmount, 260);
      expect(orders.history.last.isGroup, isFalse);
    });

    test('a list page with only some parts of a group fetches the rest once', () async {
      final api = FakeOrderApi();
      api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(paymentStatus: 'PAID', orders: groupChildrenJson(paymentStatus: 'PAID')))!;
      api.onFetchList = (scope, cursor) async => OrderResult.ok(OrdersPage(scope == 'active' ? [groupChildren(paymentStatus: 'PAID')[1]] : [], null));
      final orders = fakeOrders(api)..beginSession('u1');
      await flush();
      expect(api.fetchedGroups, ['grp-1']);
      expect(orders.liveOrders.single.members, hasLength(2));
      expect(orders.liveOrders.single.id, 'gx-order-1');
    });

    test('watching a combined order polls ONE group request and joins every restaurant\'s room; order_updated moves it', () async {
      final api = FakeOrderApi();
      api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(paymentStatus: 'PAID', orders: groupChildrenJson(paymentStatus: 'PAID')))!;
      for (final o in api.groupServer['grp-1']!.orders) {
        api.server[o.id] = o;
      }
      final orders = fakeOrders(api)..beginSession('u1');
      await flush();
      orders.watch('gx-order-2'); // opened through a sibling (e.g. a push for the second restaurant)
      await flush();
      expect(api.fetchedIds, ['gx-order-2'], reason: 'first load of an unknown id');
      expect(api.fetchedGroups, contains('grp-1'), reason: 'the other restaurants are loaded');
      final socket = FakeRealtime.created.last..simulateConnect();
      await flush();
      expect(orders.joinedRooms, containsAll(['gx-order-1', 'gx-order-2']));
      api.fetchedGroups.clear();
      api.fetchedIds.clear();
      await orders.pollOnce();
      expect(api.fetchedGroups, ['grp-1']);
      expect(api.fetchedIds, isEmpty, reason: 'no per-part requests');
      expect(orders.isWatching('gx-order-1'), isTrue, reason: 'a push for the primary is already on screen');

      socket.emitOrder(groupChildrenJson(statuses: const ['ACCEPTED', 'PLACED'], paymentStatus: 'PAID', updatedAt: DateTime.now().toUtc().add(const Duration(seconds: 10)))[0]);
      await flush();
      final c = orders.orderById('gx-order-1')!;
      expect(c.members!.map((m) => m.status), [OrderProgressStatus.accepted, OrderProgressStatus.placed]);
      expect(c.status, OrderProgressStatus.placed, reason: 'least advanced restaurant leads');
      orders.unwatch('gx-order-2');
    });

    test('rider position for any part reaches the primary id (the group\'s map)', () async {
      final api = FakeOrderApi();
      final kids = groupChildrenJson(statuses: const ['PICKED_UP', 'PICKED_UP'], paymentStatus: 'PAID', driver: {'id': 'd1', 'name': 'Vikram', 'phone': '+91 98765 43210'});
      api.groupServer['grp-1'] = OrderGroupView.tryParse(groupViewJson(orders: kids, paymentStatus: 'PAID'))!;
      for (final o in api.groupServer['grp-1']!.orders) {
        api.server[o.id] = o;
      }
      final orders = fakeOrders(api)..beginSession('u1');
      orders.watch('gx-order-1');
      await flush();
      final socket = FakeRealtime.created.last..simulateConnect();
      final fixes = <RiderLocation?>[];
      orders.riderLocationListenable('gx-order-1').addListener(() => fixes.add(orders.riderLocation('gx-order-1')));
      socket.emitRider({'orderId': 'gx-order-2', 'driverId': 'd1', 'lat': 23.07, 'lng': 76.85, 'heading': 0, 'at': DateTime.now().toUtc().toIso8601String()});
      expect(fixes.last?.lat, 23.07);
      expect(orders.orderById('gx-order-1')!.rider!.name, 'Vikram');
      orders.unwatch('gx-order-1');
    });

    test('logout drops the combined orders', () async {
      final api = FakeOrderApi();
      final orders = fakeOrders(api)..beginSession('u1');
      await orders.placeOrder(groupDraft());
      expect(orders.activeOrders, isNotEmpty);
      orders.resetForLogout();
      expect(orders.activeOrders, isEmpty);
      expect(orders.orderById('gx-order-1'), isNull);
    });
  });
}
