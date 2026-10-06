import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'support/fakes.dart';

void main() {
  group('OrderView parsing', () {
    test('a full vendor view parses every field', () {
      final o = OrderModel.fromJson(orderJson(
        id: 'abc-123-def456',
        driver: {'id': 'd1', 'name': 'Ramesh Kumar', 'phone': '+91 9876500000'},
        customerName: 'Ananya Verma',
      ))!;
      expect(o.status, OrderStatus.placed);
      expect(o.paymentStatus, PaymentStatus.paid);
      expect(o.isIncoming, isTrue);
      expect(o.totalAmount, 245);
      expect(o.subtotal, 205);
      expect(o.items.length, 2);
      expect(o.items[1].totalPrice, 25);
      expect(o.dropoffHostel, 'BH1');
      expect(o.customerNote, 'No onions please');
      expect(o.rider!.name, 'Ramesh Kumar');
      expect(o.rider!.phone, '+91 9876500000');
      expect(o.shortCode, '#DEF456');
      expect(o.acceptDeadline, o.paidAt!.add(const Duration(minutes: 10)));
    });

    test('customer: first name only, even if a server sends a full name; never a phone', () {
      final j = orderJson(customerName: 'Ananya  Verma Singh');
      (j['customer'] as Map)['phone'] = '+91 9000000000';
      final o = OrderModel.fromJson(j)!;
      expect(o.studentName, 'Ananya');
      // There is no field that could carry the customer phone into the UI.
      expect(o.toString().contains('9000000000'), isFalse);
    });

    test('every status string maps, unknown stays unknown, and the wire value round-trips', () {
      for (final s in OrderStatus.values.where((s) => s != OrderStatus.unknown)) {
        expect(OrderStatus.parse(s.wire), s);
      }
      expect(OrderStatus.parse('TELEPORTED'), OrderStatus.unknown);
      expect(OrderStatus.parse(null), OrderStatus.unknown);
    });

    test('unpaid orders are not visible to the restaurant; cancelled-after-paid ones are', () {
      expect(order(paymentStatus: 'PENDING').isVisibleToVendor, isFalse);
      expect(order(paymentStatus: 'FAILED').isVisibleToVendor, isFalse);
      expect(order(paymentStatus: 'PAID').isVisibleToVendor, isTrue);
      expect(order(status: 'CANCELLED', paymentStatus: 'REFUNDED').isVisibleToVendor, isTrue);
    });

    test('malformed payloads return null instead of throwing', () {
      expect(OrderModel.fromJson(null), isNull);
      expect(OrderModel.fromJson('x'), isNull);
      expect(OrderModel.fromJson({'id': ''}), isNull);
      expect(OrderModel.fromJson({'id': 'a', 'createdAt': 'not a date'}), isNull);
      final o = OrderModel.fromJson({'id': 'a', 'status': 'PREPARING', 'paymentStatus': 'PAID', 'createdAt': '2026-10-02T10:00:00Z', 'items': [null, 3, {'name': '', 'quantity': 1}, {'name': 'Tea', 'quantity': '2', 'price': '10'}]})!;
      expect(o.items.single.name, 'Tea');
      expect(o.items.single.quantity, 2);
      expect(o.totalAmount, 0);
    });

    test('merge rule: newer updatedAt wins, older loses, terminal never reopens, equal time never goes back', () {
      final t = DateTime.utc(2026, 10, 2, 10);
      OrderModel at(String status, DateTime u) => OrderModel.fromJson(orderJson(id: 'x', status: status, createdAt: t, updatedAt: u))!;
      final accepted = at('ACCEPTED', t.add(const Duration(minutes: 1)));
      expect(accepted.isSupersededBy(at('PREPARING', t.add(const Duration(minutes: 2)))), isTrue);
      expect(accepted.isSupersededBy(at('PLACED', t)), isFalse);
      expect(accepted.isSupersededBy(at('PLACED', t.add(const Duration(minutes: 1)))), isFalse);
      final cancelled = at('CANCELLED', t.add(const Duration(minutes: 3)));
      expect(cancelled.isSupersededBy(at('PREPARING', t.add(const Duration(minutes: 9)))), isFalse);
    });

    test('menu items parse from GET /menus/:vendorId', () {
      final d = DishModel.fromJson({'id': 'm1', 'name': 'Veg Thali', 'price': 90, 'category': 'Main Course', 'isAvailable': false, 'imageUrl': ''})!;
      expect(d.inStock, isFalse);
      expect(d.imageUrl, isNull);
      expect(DishModel.fromJson({'id': '', 'name': 'x'}), isNull);
    });
  });

  group('fixtures', () {
    test('contract-derived vendor samples (test/fixtures/vendor_order_samples.json) parse', () {
      final json = jsonDecode(File('test/fixtures/vendor_order_samples.json').readAsStringSync());
      final samples = (json['vendor'] as Map).cast<String, dynamic>();
      final newOrder = OrderModel.fromJson(samples['new_paid_order'])!;
      expect(newOrder.isIncoming, isTrue);
      expect(newOrder.items.length, 2);
      final ready = OrderModel.fromJson(samples['ready_with_rider'])!;
      expect(ready.status, OrderStatus.readyForPickup);
      expect(ready.rider!.phone, isNotNull);
      final cancelled = OrderModel.fromJson(samples['cancelled_by_system'])!;
      expect(cancelled.cancelledBy, CancelledBy.system);
      expect(cancelled.paymentStatus, PaymentStatus.refunded);
      expect(cancelled.customerNote, isNull);
    });

    // Real responses captured by the backend's e2e test (backend/test/e2e/order_flow_v1.test.ts).
    final shared = File('../../Docs/fixtures/order_flow_samples.json');
    Map<String, dynamic> real() => (jsonDecode(shared.readAsStringSync()) as Map).cast<String, dynamic>();
    final missing = shared.existsSync() ? false : 'Docs/fixtures/order_flow_samples.json not published';

    test('every vendor-facing sample (REST + socket) parses and respects the vendor visibility rules', () {
      final samples = real();
      final vendorKeys = samples.keys.where((k) => k.startsWith('vendor_view') || k.endsWith('_vendor')).toList();
      expect(vendorKeys, containsAll(['vendor_view_new_paid_order', 'socket_new_order_alert_vendor']));
      for (final key in vendorKeys) {
        final raw = samples[key] as Map;
        final o = OrderModel.fromJson(raw);
        expect(o, isNotNull, reason: key);
        // What the server sends the restaurant
        expect(raw['otpCode'], isNull, reason: '$key: no OTP for the restaurant');
        expect((raw['customer'] as Map)['phone'], isNull, reason: '$key: no customer phone');
        expect(((raw['customer'] as Map)['name'] as String).trim().contains(' '), isFalse, reason: '$key: first name only');
        for (final adminOnly in const ['payments', 'refundError', 'razorpayOrderId', 'razorpayPaymentId', 'customerId', 'otpAttempts']) {
          expect(raw.containsKey(adminOnly), isFalse, reason: '$key must not carry $adminOnly');
        }
        // What the app makes of it
        expect(o!.isVisibleToVendor, isTrue);
        expect(o.isIncoming, isTrue, reason: '$key is a new paid order');
        expect(o.vendorId, raw['vendorId']);
        expect(o.acceptBy, DateTime.parse(raw['acceptBy'] as String).toLocal());
        expect(o.acceptDeadline, o.acceptBy, reason: 'the countdown uses the server deadline');
        expect(o.shortCode, '#${(raw['id'] as String).substring((raw['id'] as String).length - 6).toUpperCase()}');
        expect(o.items, isNotEmpty);
        expect(o.items.first.name, isNotEmpty);
        expect(o.rider, isNull);
      }
    }, skip: missing);

    test('other roles\' samples parse without crashing; unpaid ones are never shown to the kitchen', () {
      final samples = real();
      for (final entry in samples.entries) {
        final v = entry.value;
        if (v is Map && v['id'] != null && v['status'] != null) {
          expect(OrderModel.fromJson(v), isNotNull, reason: entry.key);
        }
      }
      expect(OrderModel.fromJson(samples['customer_view_PLACED_unpaid'])!.isVisibleToVendor, isFalse);
      final refunded = OrderModel.fromJson(samples['customer_view_CANCELLED_REFUNDED'])!;
      expect(refunded.status, OrderStatus.cancelled);
      expect(refunded.paymentStatus, PaymentStatus.refunded);
      expect(refunded.refundStatus, isNotNull);
      // Rider info as the server sends it once a rider is assigned (driver object: name + phone).
      final claimed = OrderModel.fromJson(samples['rider_assigned_view_after_claim'])!;
      expect(claimed.rider, isNotNull);
      expect(claimed.rider!.name, isNotEmpty);
    }, skip: missing);

    test('socket sample shapes: new_order_alert is a full OrderView; order_unavailable is just {id}', () {
      final samples = real();
      expect(OrderModel.fromJson(samples['socket_new_order_alert_vendor'])!.isIncoming, isTrue);
      expect(OrderModel.fromJson(samples['socket_order_unavailable']), isNull); // not an order: ignored, then REST decides
    }, skip: missing);
  });
}
