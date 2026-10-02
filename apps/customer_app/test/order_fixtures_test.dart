import 'dart:convert';
import 'dart:io';

import 'package:customer_app/models/order.dart';
import 'package:customer_app/services/order_api.dart';
import 'package:customer_app/widgets/ui/format.dart';
import 'package:flutter_test/flutter_test.dart';

/// Parses the REAL payloads captured by the backend tests (Docs/fixtures/order_flow_samples.json,
/// written by backend/test/e2e/order_flow_v1.test.ts) so the app cannot drift from the server.
void main() {
  final file = File('../../Docs/fixtures/order_flow_samples.json');
  final Map<String, dynamic> samples = file.existsSync() ? jsonDecode(file.readAsStringSync()) as Map<String, dynamic> : {};

  bool isOrderView(Object? v) => v is Map && v.containsKey('id') && v.containsKey('status') && v.containsKey('paymentStatus');

  test('the fixtures file exists', () => expect(file.existsSync(), isTrue, reason: 'run the backend order flow tests with WRITE_ORDER_FIXTURES=1'));

  test('every OrderView sample (all viewers, REST and socket) parses', () {
    var count = 0;
    void visit(Object? v, String path) {
      if (isOrderView(v)) {
        final o = OrderModel.tryParse(v);
        expect(o, isNotNull, reason: path);
        expect(o!.id, (v as Map)['id'], reason: path);
        expect(o.status.wire, v['status'], reason: path);
        expect(o.items.length, (v['items'] as List).length, reason: path);
        expect(o.totalPaise, ((v['totalAmount'] as num) * 100).round(), reason: path);
        expect(o.vendorId, isNotEmpty, reason: path);
        count++;
      } else if (v is Map) {
        v.forEach((k, child) => visit(child, '$path.$k'));
      } else if (v is List) {
        for (var i = 0; i < v.length; i++) {
          visit(v[i], '$path[$i]');
        }
      }
    }

    visit(samples, r'$');
    expect(count, greaterThanOrEqualTo(10));
  });

  group('customer views: visibility facts', () {
    final customerKeys = samples.keys.where((k) => k.startsWith('customer_view_')).toList();

    test('there are customer samples for unpaid, paid, at-gate and refunded', () {
      expect(customerKeys, containsAll(['customer_view_PLACED_unpaid', 'customer_view_PAID', 'customer_view_ARRIVED_AT_GATE', 'customer_view_CANCELLED_REFUNDED']));
    });

    test('OTP only at ARRIVED_AT_GATE; rider (and phone) only once assigned; no raw columns', () {
      const forbidden = ['customerId', 'driverId', 'otpAttempts', 'otpLocked', 'payments', 'refundError', 'refundAttempts', 'password', 'passwordHash', 'pushToken', 'razorpayOrderId', 'razorpayPaymentId'];
      for (final key in customerKeys) {
        final raw = samples[key] as Map<String, dynamic>;
        final o = OrderModel.tryParse(raw)!;
        final atGate = raw['status'] == 'ARRIVED_AT_GATE';
        expect(raw['otpCode'] != null, atGate, reason: '$key: server OTP visibility');
        expect(o.otpCode != null, atGate, reason: '$key: app OTP visibility');
        if (atGate) expect(o.otpCode, matches(RegExp(r'^\d{4}$')));
        for (final f in forbidden) {
          expect(raw.containsKey(f), isFalse, reason: '$key must not expose $f');
        }
        final customer = raw['customer'] as Map;
        expect(customer.keys.toSet().difference({'id', 'name', 'phone', 'hostelBlock'}), isEmpty, reason: '$key customer object');
        final driver = raw['driver'];
        if (driver == null) {
          expect(o.rider, isNull, reason: key);
        } else {
          expect((driver as Map).keys.toSet().difference({'id', 'name', 'phone'}), isEmpty, reason: '$key driver object');
          expect(o.rider!.phone, isNotNull, reason: '$key: the owner sees the assigned rider\'s phone');
        }
      }
    });

    test('unpaid -> payBy deadline from the server; paid & placed -> acceptBy; refunded -> refund wording data', () {
      final unpaid = OrderModel.tryParse(samples['customer_view_PLACED_unpaid'])!;
      expect(unpaid.awaitsPayment, isTrue);
      expect(unpaid.payBy, isNotNull);
      expect(unpaid.paymentDeadline, unpaid.payBy);
      expect(unpaid.rider, isNull);

      final paid = OrderModel.tryParse(samples['customer_view_PAID'])!;
      expect(paid.isPaid && paid.canCancel, isTrue);
      expect(paid.acceptBy, isNotNull);
      expect(paid.payBy, isNull);

      final refunded = OrderModel.tryParse(samples['customer_view_CANCELLED_REFUNDED'])!;
      expect(refunded.status, OrderProgressStatus.cancelled);
      expect(refunded.paymentStatus, PaymentStatus.refunded);
      expect(refunded.refundStatus, RefundStatus.done);
      expect(refunded.cancelledBy, isNotNull);

      final gate = OrderModel.tryParse(samples['customer_view_ARRIVED_AT_GATE'])!;
      expect(gate.isReviewed, isFalse);
    });

    test('display code is # + last 6 chars, uppercased', () {
      final id = samples['customer_view_PAID']['id'] as String;
      expect(orderRef(id), '#${id.substring(id.length - 6).toUpperCase()}');
    });
  });

  test('rider_location parses exactly as the backend emits it', () {
    final raw = samples['socket_rider_location'] as Map<String, dynamic>;
    final loc = RiderLocation.fromJson(raw)!;
    expect(loc.orderId, raw['orderId']);
    expect(loc.driverId, raw['driverId']);
    expect(loc.lat, raw['lat']);
    expect(loc.lng, raw['lng']);
    expect(loc.heading, (raw['heading'] as num).toDouble());
    expect(loc.at, DateTime.parse(raw['at'] as String));
    final gate = OrderModel.tryParse(samples['customer_view_ARRIVED_AT_GATE'])!;
    expect(loc.driverId, gate.rider!.id, reason: 'the event names the rider assigned in the OrderView');
  });

  test('error samples map to error kinds and keep the server code', () {
    for (final key in samples.keys.where((k) => k.startsWith('error_'))) {
      final status = int.parse(RegExp(r'^error_(\d{3})_').firstMatch(key)!.group(1)!);
      final body = samples[key] as Map<String, dynamic>;
      final e = HttpOrderApi.errorFor(status, body);
      expect(e.code, body['code'], reason: key);
      expect(e.message, body['message'], reason: key);
      expect(orderErrorMessage(e), isNotEmpty, reason: key);
    }
  });
}
