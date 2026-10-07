/// Multi-restaurant orders (Docs/22): the group response, the price quote and their requests.
/// Shapes are the real ones of Docs/22 section 10 (`POST /order-groups`, `GET /order-groups/:id`,
/// `POST /orders/quote`). Parsing is defensive: unknown fields are ignored, a body without the
/// essentials is rejected (null) rather than half-trusted.
library;

import 'order.dart';

double _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? 0;
  return 0;
}

String? _str(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

/// What the app assumes for the maximum number of restaurants before the first quote answered.
const int kDefaultMaxRestaurants = 3;

/// Local fallback used only when the server's quote is not available (estimate marked as such):
/// the base fee and the fee each extra restaurant adds (admin settings, Docs/21/22 defaults).
const double kEstimateBaseFee = 25;
const double kEstimateExtraRestaurantFee = 15;

/// One restaurant of a quote or group request: `{vendorId, items:[{itemId, quantity}]}`.
class RestaurantCart {
  const RestaurantCart({required this.vendorId, required this.items});

  final String vendorId;
  final List<({String itemId, int quantity})> items;

  Map<String, dynamic> toJson() => {
        'vendorId': vendorId,
        'items': [for (final i in items) {'itemId': i.itemId, 'quantity': i.quantity}],
      };
}

/// The body of `POST /orders/quote`.
class QuoteRequest {
  const QuoteRequest({required this.restaurants, this.couponCode});

  final List<RestaurantCart> restaurants;
  final String? couponCode;

  Map<String, dynamic> toJson() => {
        'restaurants': [for (final r in restaurants) r.toJson()],
        if (couponCode != null && couponCode!.isNotEmpty) 'couponCode': couponCode,
      };

  /// Same cart + same coupon = same key (used to skip a repeat request and to drop stale answers).
  String get key => [
        for (final r in restaurants) '${r.vendorId}:${[for (final i in r.items) '${i.itemId}x${i.quantity}'].join(',')}',
        (couponCode ?? '').toUpperCase(),
      ].join('|');
}

/// The body of `POST /order-groups` (Docs/22 10.3).
class CreateGroupRequest {
  const CreateGroupRequest({
    required this.restaurants,
    required this.dropoffHostel,
    required this.dropoffNotes,
    required this.clientRequestId,
    this.couponCode,
  });

  /// First = the primary child (carries the base fee, the coupon and the payment).
  final List<RestaurantCart> restaurants;
  final String dropoffHostel;
  final String dropoffNotes;
  final String? couponCode;
  final String clientRequestId;

  Map<String, dynamic> toJson() => {
        'restaurants': [for (final r in restaurants) r.toJson()],
        'dropoffHostel': dropoffHostel,
        if (dropoffNotes.isNotEmpty) 'dropoffNotes': dropoffNotes,
        if (couponCode != null && couponCode!.isNotEmpty) 'couponCode': couponCode,
        'clientRequestId': clientRequestId,
      };
}

/// One restaurant's share of a quote.
class QuoteLine {
  const QuoteLine({required this.vendorId, required this.vendorName, required this.subtotal, required this.fee});

  final String vendorId;
  final String vendorName;
  final double subtotal;
  final double fee;
}

/// `POST /orders/quote` -> `data`: what placing the same cart would charge.
class OrderQuote {
  const OrderQuote({
    required this.restaurantCount,
    required this.subtotal,
    required this.baseFee,
    required this.extraRestaurants,
    required this.extraRestaurantFee,
    required this.extraTotal,
    required this.feeTotal,
    required this.discount,
    required this.couponCode,
    required this.total,
    required this.perRestaurant,
    required this.maxRestaurants,
  });

  final int restaurantCount;
  final double subtotal;

  /// The "Delivery & service fee" line.
  final double baseFee;
  final int extraRestaurants;

  /// What EACH extra restaurant adds (the setting, also reported for one restaurant).
  final double extraRestaurantFee;
  final double extraTotal;
  final double feeTotal;
  final double discount;
  final String? couponCode;
  final double total;
  final List<QuoteLine> perRestaurant;
  final int maxRestaurants;

  int get totalPaise => (total * 100).round();

  static OrderQuote? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final json = Map<String, dynamic>.from(raw);
    final total = json['total'];
    final subtotal = json['subtotal'];
    if (total is! num || subtotal is! num) return null;
    final fees = json['fees'] is Map ? Map<String, dynamic>.from(json['fees'] as Map) : const <String, dynamic>{};
    final lines = <QuoteLine>[];
    final rawLines = json['perRestaurant'];
    if (rawLines is List) {
      for (final l in rawLines) {
        if (l is! Map) continue;
        final vendorId = _str(l['vendorId']);
        if (vendorId == null) continue;
        lines.add(QuoteLine(vendorId: vendorId, vendorName: _str(l['vendorName']) ?? 'Restaurant', subtotal: _num(l['subtotal']), fee: _num(l['fee'])));
      }
    }
    final count = json['restaurantCount'];
    final max = json['maxRestaurants'];
    final extras = fees['extraRestaurants'];
    final feeTotal = fees['total'] is num ? (fees['total'] as num).toDouble() : _num(fees['base']) + _num(fees['extraTotal']);
    return OrderQuote(
      restaurantCount: count is num ? count.toInt() : (lines.isEmpty ? 1 : lines.length),
      subtotal: subtotal.toDouble(),
      baseFee: _num(fees['base']),
      extraRestaurants: extras is num ? extras.toInt() : 0,
      extraRestaurantFee: _num(fees['extraRestaurantFee']),
      extraTotal: _num(fees['extraTotal']),
      feeTotal: feeTotal,
      discount: _num(json['discount']),
      couponCode: _str(json['couponCode']),
      total: total.toDouble(),
      perRestaurant: List.unmodifiable(lines),
      maxRestaurants: max is num && max >= 1 ? max.toInt() : kDefaultMaxRestaurants,
    );
  }
}

/// `GroupView` of Docs/22 10.3: a combined order with all its children (`orders`, ordered by
/// `groupIndex`, each an `OrderView` carrying its own `group`).
class OrderGroupView {
  const OrderGroupView({
    required this.id,
    required this.total,
    required this.subtotal,
    required this.feeTotal,
    required this.discount,
    required this.couponCode,
    required this.restaurantCount,
    required this.payOrderId,
    required this.orders,
    this.replay = false,
    this.cancelReason,
  });

  final String id;
  final double total;
  final double subtotal;
  final double feeTotal;
  final double discount;
  final String? couponCode;
  final int restaurantCount;

  /// The PRIMARY child: the id to pay (`POST /payments/create-order`) and to cancel.
  final String payOrderId;
  final List<OrderModel> orders;

  /// The real reason of a fully cancelled group (the triggering restaurant's); null otherwise.
  final String? cancelReason;

  /// The server answered an earlier identical request (200, `idempotentReplay`).
  final bool replay;

  /// Null when the body is not a group (no id / pay id / children).
  static OrderGroupView? tryParse(Object? raw, {bool replay = false}) {
    if (raw is! Map) return null;
    final json = Map<String, dynamic>.from(raw);
    final id = _str(json['id']);
    final children = json['orders'] is List ? (json['orders'] as List).map(OrderModel.tryParse).whereType<OrderModel>().toList() : <OrderModel>[];
    if (id == null || children.isEmpty) return null;
    final count = json['restaurantCount'];
    return OrderGroupView(
      id: id,
      total: _num(json['total']),
      subtotal: _num(json['subtotal']),
      feeTotal: _num(json['feeTotal']),
      discount: _num(json['discount']),
      couponCode: _str(json['couponCode']),
      restaurantCount: count is num ? count.toInt() : children.length,
      payOrderId: _str(json['payOrderId']) ?? children.first.id,
      orders: List.unmodifiable(children),
      replay: replay,
      cancelReason: _str(json['cancelReason']),
    );
  }
}
