/// Orders exactly as the server describes them (`OrderView`, Docs/16_order_flow_contract.md 2.1).
///
/// The app never invents an order id, a price, a status or an OTP: every [OrderModel] is parsed
/// from a server response (REST or socket). Parsing is tolerant (missing fields fall back to
/// neutral values) but never fabricates data that would mislead the student.
library;

import 'drop_point.dart';

/// Order status, one value per server status (contract 1.1).
enum OrderProgressStatus {
  placed,
  accepted,
  preparing,
  readyForPickup,
  pickedUp,
  arrivedAtGate,
  delivered,
  cancelled,
}

extension OrderProgressStatusX on OrderProgressStatus {
  /// Server spelling, e.g. `READY_FOR_PICKUP`.
  String get wire => switch (this) {
        OrderProgressStatus.placed => 'PLACED',
        OrderProgressStatus.accepted => 'ACCEPTED',
        OrderProgressStatus.preparing => 'PREPARING',
        OrderProgressStatus.readyForPickup => 'READY_FOR_PICKUP',
        OrderProgressStatus.pickedUp => 'PICKED_UP',
        OrderProgressStatus.arrivedAtGate => 'ARRIVED_AT_GATE',
        OrderProgressStatus.delivered => 'DELIVERED',
        OrderProgressStatus.cancelled => 'CANCELLED',
      };

  static OrderProgressStatus? parse(Object? raw) {
    final s = raw?.toString().trim().toUpperCase();
    for (final v in OrderProgressStatus.values) {
      if (v.wire == s) return v;
    }
    return null;
  }

  bool get isTerminal => this == OrderProgressStatus.delivered || this == OrderProgressStatus.cancelled;

  /// Position on the happy path (cancelled has none).
  int get stage => this == OrderProgressStatus.cancelled ? -1 : index;
}

/// `Order.paymentStatus` (contract 1.2).
enum PaymentStatus { pending, paid, failed, refunded }

PaymentStatus _parsePayment(Object? raw) => switch (raw?.toString().trim().toUpperCase()) {
      'PAID' => PaymentStatus.paid,
      'FAILED' => PaymentStatus.failed,
      'REFUNDED' => PaymentStatus.refunded,
      _ => PaymentStatus.pending,
    };

/// Who cancelled (contract 1.3).
enum CancelledBy { customer, vendor, admin, system }

CancelledBy? _parseCancelledBy(Object? raw) => switch (raw?.toString().trim().toUpperCase()) {
      'CUSTOMER' => CancelledBy.customer,
      'VENDOR' => CancelledBy.vendor,
      'ADMIN' => CancelledBy.admin,
      'SYSTEM' => CancelledBy.system,
      _ => null,
    };

/// `refundStatus` (contract 1.3): where the refund of a cancelled, paid order stands.
enum RefundStatus { none, pending, done, failed }

RefundStatus _parseRefund(Object? raw) => switch (raw?.toString().trim().toUpperCase()) {
      'PENDING' => RefundStatus.pending,
      'DONE' => RefundStatus.done,
      'FAILED' => RefundStatus.failed,
      _ => RefundStatus.none,
    };

/// Server-side reasons the app phrases specially (contract 1.3).
const String kReasonPaymentNotCompleted = 'Payment not completed';
const String kReasonRestaurantNoResponse = 'Restaurant did not respond';

/// How long the server keeps an unpaid order before cancelling it (`PAYMENT_WINDOW_MIN`).
/// Only used for the hint shown to the student; the server is the one that enforces it.
const Duration kPaymentWindow = Duration(minutes: 15);

double _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? 0;
  return 0;
}

double? _numOrNull(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

String? _str(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

DateTime? _date(Object? v) {
  if (v is! String || v.isEmpty) return null;
  return DateTime.tryParse(v)?.toUtc();
}

Map<String, dynamic>? _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : null;

/// One line of the order, priced by the server at the time of ordering.
class OrderLine {
  const OrderLine({required this.id, required this.menuItemId, required this.name, required this.quantity, required this.price});

  final String id;
  final String menuItemId;
  final String name;
  final int quantity;

  /// Unit price in rupees.
  final double price;

  double get lineTotal => price * quantity;

  factory OrderLine.fromJson(Map<String, dynamic> json) => OrderLine(
        id: _str(json['id']) ?? '',
        menuItemId: _str(json['menuItemId'] ?? json['itemId']) ?? '',
        name: _str(json['name']) ?? 'Item',
        quantity: (json['quantity'] is num) ? (json['quantity'] as num).toInt() : int.tryParse('${json['quantity']}') ?? 1,
        price: _num(json['price']),
      );
}

/// The assigned rider (null until a rider claims the order).
class OrderRider {
  const OrderRider({required this.id, required this.name, this.phone});

  final String id;
  final String name;
  final String? phone;

  static OrderRider? fromJson(Object? raw) {
    final json = _map(raw);
    if (json == null) return null;
    final id = _str(json['id']);
    if (id == null) return null;
    return OrderRider(id: id, name: _str(json['name']) ?? 'Your rider', phone: _str(json['phone']));
  }
}

/// Last reported rider position from the `rider_location` socket event. The backend sends
/// exactly `{orderId, driverId, lat, lng, heading, at}` (backend/src/realtime.ts
/// `recordRiderLocation`).
class RiderLocation {
  const RiderLocation({required this.orderId, required this.lat, required this.lng, required this.receivedAt, this.driverId, this.heading, this.at});

  final String orderId;
  final String? driverId;
  final double lat;
  final double lng;
  final double? heading;

  /// Server time of the fix (UTC).
  final DateTime? at;

  /// When the app received it (device clock; used for "updated X ago").
  final DateTime receivedAt;

  static RiderLocation? fromJson(Object? raw, {DateTime? now}) {
    final json = _map(raw);
    if (json == null) return null;
    final orderId = _str(json['orderId']);
    final lat = _numOrNull(json['lat']);
    final lng = _numOrNull(json['lng']);
    if (orderId == null || lat == null || lng == null || lat.abs() > 90 || lng.abs() > 180) return null;
    return RiderLocation(
      orderId: orderId,
      driverId: _str(json['driverId']),
      lat: lat,
      lng: lng,
      heading: _numOrNull(json['heading']),
      at: _date(json['at']),
      receivedAt: now ?? DateTime.now(),
    );
  }
}

/// A point on the campus map: the drop point (`OrderView.dropoff`) or the restaurant pin.
class OrderPlace {
  const OrderPlace({required this.name, required this.lat, required this.lng});

  final String name;
  final double lat;
  final double lng;

  /// `{name, lat, lng}`; null when the server sent nothing usable (old backend, legacy value).
  static OrderPlace? fromJson(Object? raw) {
    final json = _map(raw);
    if (json == null) return null;
    final lat = _numOrNull(json['lat']);
    final lng = _numOrNull(json['lng']);
    if (lat == null || lng == null || lat.abs() > 90 || lng.abs() > 180) return null;
    return OrderPlace(name: _str(json['name']) ?? '', lat: lat, lng: lng);
  }
}

/// Text the server puts on the siblings of the restaurant that cancelled a combined order
/// (Docs/22 4.4: `Another restaurant in your order could not take it: <reason>`).
const String kReasonSiblingPrefix = 'Another restaurant in your order could not take it';

/// One restaurant of a combined order as `OrderView.group.stops[]` lists it (Docs/22 10.4).
class GroupStop {
  const GroupStop({required this.orderId, required this.index, required this.status, required this.vendorName, this.address, this.itemCount = 0});

  final String orderId;
  final int index;
  final OrderProgressStatus status;
  final String vendorName;
  final String? address;

  /// Total quantity of dishes ordered at this restaurant.
  final int itemCount;

  static GroupStop? tryParse(Object? raw) {
    final json = _map(raw);
    if (json == null) return null;
    final orderId = _str(json['orderId']);
    final status = OrderProgressStatusX.parse(json['status']);
    if (orderId == null || status == null) return null;
    final vendor = _map(json['vendor']);
    final index = json['index'];
    final count = json['itemCount'];
    return GroupStop(
      orderId: orderId,
      index: index is num ? index.toInt() : 0,
      status: status,
      vendorName: _str(vendor?['name']) ?? 'Restaurant',
      address: _str(vendor?['address']),
      itemCount: count is num ? count.toInt() : 0,
    );
  }
}

/// `OrderView.group` for the customer: which combined order this child belongs to. A single
/// restaurant order has no `group` key at all; a restaurant's own copy has no `id` (never ours).
class OrderGroupRef {
  const OrderGroupRef({required this.id, required this.index, required this.size, required this.primary, this.stops = const []});

  final String id;

  /// 0 = the primary child (carries the payment and the base fee).
  final int index;
  final int size;
  final bool primary;
  final List<GroupStop> stops;

  static OrderGroupRef? tryParse(Object? raw) {
    final json = _map(raw);
    if (json == null) return null;
    final id = _str(json['id']);
    if (id == null) return null;
    final rawStops = json['stops'];
    final stops = rawStops is List ? (rawStops.map(GroupStop.tryParse).whereType<GroupStop>().toList()..sort((a, b) => a.index.compareTo(b.index))) : <GroupStop>[];
    final index = json['index'] is num ? (json['index'] as num).toInt() : 0;
    final size = json['size'] is num ? (json['size'] as num).toInt() : stops.length;
    return OrderGroupRef(id: id, index: index, size: size < 1 ? (stops.isEmpty ? 1 : stops.length) : size, primary: json['primary'] is bool ? json['primary'] as bool : index == 0, stops: List.unmodifiable(stops));
  }
}

/// Status of a combined order from its children. Docs/22 4.4: every cancel path cancels the
/// whole group, so one cancelled child means a cancelled order (even while the other children's
/// updates are still on their way). Otherwise the least advanced child leads.
OrderProgressStatus deriveGroupProgress(Iterable<OrderProgressStatus> children) {
  final list = children.toList();
  if (list.isEmpty) return OrderProgressStatus.placed;
  if (list.any((s) => s == OrderProgressStatus.cancelled)) return OrderProgressStatus.cancelled;
  if (list.every((s) => s == OrderProgressStatus.delivered)) return OrderProgressStatus.delivered;
  return list.reduce((a, b) => b.stage < a.stage ? b : a);
}

/// A server `OrderView`. Immutable: a newer server copy replaces it (see [isNewerThan]).
class OrderModel {
  const OrderModel({
    required this.id,
    required this.status,
    required this.paymentStatus,
    required this.subtotal,
    required this.deliveryFee,
    required this.taxAndPackaging,
    required this.discount,
    required this.totalAmount,
    required this.dropoffHostel,
    required this.dropoffNotes,
    required this.createdAt,
    required this.updatedAt,
    required this.items,
    required this.vendorId,
    required this.vendorName,
    this.vendorAddress,
    this.vendorLat,
    this.vendorLng,
    this.vendorHasLocation = false,
    this.dropoff,
    this.paidAt,
    this.acceptedAt,
    this.pickedUpAt,
    this.deliveredAt,
    this.cancelledAt,
    this.cancelledBy,
    this.cancelReason,
    this.rider,
    this.otpCode,
    this.payBy,
    this.acceptBy,
    this.refundStatus = RefundStatus.none,
    this.isReviewed = false,
    this.group,
    this.members,
    this.cancelTriggerName,
  });

  final String id;
  final OrderProgressStatus status;
  final PaymentStatus paymentStatus;
  final double subtotal;
  final double deliveryFee;
  final double taxAndPackaging;
  final double discount;
  final double totalAmount;
  final String dropoffHostel;
  final String dropoffNotes;

  /// Server timestamps (UTC).
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? paidAt;
  final DateTime? acceptedAt;
  final DateTime? pickedUpAt;
  final DateTime? deliveredAt;
  final DateTime? cancelledAt;
  final CancelledBy? cancelledBy;
  final String? cancelReason;

  final List<OrderLine> items;
  final String vendorId;
  final String vendorName;
  final String? vendorAddress;

  /// The restaurant's pin. Only meaningful (and only drawn on the map) when [vendorHasLocation]:
  /// an old server never sends the flag, and a placeholder pin is not a real location.
  final double? vendorLat;
  final double? vendorLng;
  final bool vendorHasLocation;

  /// `OrderView.dropoff`: the drop point with coordinates. Null from an old server or for a
  /// stored value that cannot be normalised; use [dropoffPlace] to also try the local table.
  final OrderPlace? dropoff;
  final OrderRider? rider;

  /// The gate OTP. Only ever non-null while [status] is `ARRIVED_AT_GATE` and the server sent it.
  final String? otpCode;

  /// Server deadline to pay (unpaid PLACED orders only), else null.
  final DateTime? payBy;

  /// Server deadline for the restaurant to accept (PLACED + PAID only), else null.
  final DateTime? acceptBy;
  final RefundStatus refundStatus;

  /// The student already reviewed this order.
  final bool isReviewed;

  /// Set when this order is one restaurant's part of a combined order (absent on single orders).
  final OrderGroupRef? group;

  /// Only on the composite copy the app builds for a whole combined order ([OrderModel.composite]):
  /// its children, primary first. Null on server orders and single orders.
  final List<OrderModel>? members;

  /// Composite only: the restaurant whose part caused the cancellation (its own reason, not the
  /// generic sibling text), when the app knows it.
  final String? cancelTriggerName;

  /// True for a combined order (a child of one, or the composite of all its children).
  bool get isGroup => group != null;

  /// Parses an `OrderView`. Returns null when the payload is not an order (no id / status).
  static OrderModel? tryParse(Object? raw) {
    var json = _map(raw);
    if (json == null) return null;
    // Tolerate `{data: OrderView}` / `{order: OrderView}` envelopes (socket payloads).
    if (json['id'] == null) json = _map(json['data']) ?? _map(json['order']) ?? json;
    final id = _str(json['id']);
    final status = OrderProgressStatusX.parse(json['status']);
    if (id == null || status == null) return null;

    final vendor = _map(json['vendor']);
    final created = _date(json['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
    final otp = _str(json['otpCode']);
    final rawItems = json['items'];
    return OrderModel(
      id: id,
      status: status,
      paymentStatus: _parsePayment(json['paymentStatus']),
      subtotal: _num(json['subtotal']),
      deliveryFee: _num(json['deliveryFee']),
      taxAndPackaging: _num(json['taxAndPackaging']),
      discount: _num(json['discount']),
      totalAmount: _num(json['totalAmount']),
      dropoffHostel: _str(json['dropoffHostel']) ?? '',
      dropoffNotes: _str(json['dropoffNotes']) ?? '',
      createdAt: created,
      updatedAt: _date(json['updatedAt']) ?? created,
      paidAt: _date(json['paidAt']),
      acceptedAt: _date(json['acceptedAt']),
      pickedUpAt: _date(json['pickedUpAt']),
      deliveredAt: _date(json['deliveredAt']),
      cancelledAt: _date(json['cancelledAt']),
      cancelledBy: _parseCancelledBy(json['cancelledBy']),
      cancelReason: _str(json['cancelReason']),
      items: rawItems is List ? rawItems.whereType<Map>().map((m) => OrderLine.fromJson(Map<String, dynamic>.from(m))).toList(growable: false) : const [],
      vendorId: _str(json['vendorId']) ?? _str(vendor?['id']) ?? '',
      vendorName: _str(vendor?['name']) ?? 'Restaurant',
      vendorAddress: _str(vendor?['address']),
      vendorLat: _numOrNull(vendor?['lat']),
      vendorLng: _numOrNull(vendor?['lng']),
      vendorHasLocation: vendor?['hasLocation'] == true && _numOrNull(vendor?['lat']) != null && _numOrNull(vendor?['lng']) != null,
      dropoff: OrderPlace.fromJson(json['dropoff']),
      rider: OrderRider.fromJson(json['driver']),
      // Defence in depth: an OTP is only meaningful (and only shown) at the gate, and only if it
      // looks like the server's 4-digit code.
      otpCode: status == OrderProgressStatus.arrivedAtGate && otp != null && RegExp(r'^\d{4,6}$').hasMatch(otp) ? otp : null,
      payBy: _date(json['payBy']),
      acceptBy: _date(json['acceptBy']),
      refundStatus: _parseRefund(json['refundStatus']),
      isReviewed: json['isReviewed'] == true,
      group: OrderGroupRef.tryParse(json['group']),
    );
  }

  /// The one order the app shows for a whole combined order: built from its [children] (the
  /// server orders of the group, any subset) and never stored or sent anywhere. `id` is the
  /// PRIMARY child's id (the one payment, cancel and push all use); money is the sum of the
  /// children (they add up to the group total to the paisa, Docs/22 section 1). [groupTotal]
  /// (from `GET /order-groups/:id`) stands in for the sum while some children are not loaded yet.
  static OrderModel composite(List<OrderModel> children, {double? groupTotal}) {
    assert(children.isNotEmpty);
    final list = [...children]..sort((a, b) => (a.group?.index ?? 0).compareTo(b.group?.index ?? 0));
    final primary = list.firstWhere((o) => o.group?.primary == true, orElse: () => list.first);
    final ref = primary.group;
    final byId = {for (final o in list) o.id: o};
    final stops = ref?.stops ?? const <GroupStop>[];
    final statuses = stops.isEmpty ? [for (final o in list) o.status] : [for (final s in stops) byId[s.orderId]?.status ?? s.status];
    final names = stops.isEmpty ? [for (final o in list) o.vendorName] : [for (final s in stops) byId[s.orderId]?.vendorName ?? s.vendorName];
    T? firstOf<T>(T? Function(OrderModel o) pick) {
      for (final o in list) {
        final v = pick(o);
        if (v != null) return v;
      }
      return null;
    }

    double sum(double Function(OrderModel o) f) => list.fold(0.0, (a, o) => a + f(o));
    final complete = ref == null || list.length >= ref.size;
    final cancelled = list.where((o) => o.status == OrderProgressStatus.cancelled).toList();
    final trigger = cancelled.isEmpty ? null : cancelled.firstWhere((o) => !(o.cancelReason ?? '').startsWith(kReasonSiblingPrefix), orElse: () => cancelled.first);
    DateTime? earliest(DateTime? Function(OrderModel o) f) {
      DateTime? best;
      for (final o in list) {
        final d = f(o);
        if (d != null && (best == null || d.isBefore(best))) best = d;
      }
      return best;
    }

    return OrderModel(
      id: primary.id,
      status: deriveGroupProgress(statuses),
      paymentStatus: primary.paymentStatus,
      subtotal: sum((o) => o.subtotal),
      deliveryFee: sum((o) => o.deliveryFee),
      taxAndPackaging: sum((o) => o.taxAndPackaging),
      discount: sum((o) => o.discount),
      totalAmount: !complete && groupTotal != null ? groupTotal : sum((o) => o.totalAmount),
      dropoffHostel: primary.dropoffHostel,
      dropoffNotes: primary.dropoffNotes,
      createdAt: primary.createdAt,
      updatedAt: list.map((o) => o.updatedAt).reduce((a, b) => b.isAfter(a) ? b : a),
      items: [for (final o in list) ...o.items],
      vendorId: primary.vendorId,
      vendorName: names.join(' + '),
      vendorAddress: primary.vendorAddress,
      vendorLat: primary.vendorLat,
      vendorLng: primary.vendorLng,
      vendorHasLocation: primary.vendorHasLocation,
      dropoff: primary.dropoff,
      paidAt: primary.paidAt,
      acceptedAt: earliest((o) => o.acceptedAt),
      pickedUpAt: earliest((o) => o.pickedUpAt),
      deliveredAt: earliest((o) => o.deliveredAt),
      cancelledAt: earliest((o) => o.cancelledAt),
      cancelledBy: trigger?.cancelledBy,
      cancelReason: trigger?.cancelReason,
      cancelTriggerName: trigger != null && trigger.cancelledBy == CancelledBy.vendor ? trigger.vendorName : null,
      rider: firstOf((o) => o.rider),
      otpCode: firstOf((o) => o.otpCode),
      payBy: primary.payBy,
      acceptBy: earliest((o) => o.acceptBy),
      refundStatus: primary.refundStatus,
      isReviewed: list.every((o) => o.isReviewed),
      group: ref,
      members: List.unmodifiable(list),
    );
  }

  /// "2 restaurants" for a combined order, else the restaurant's name.
  String get title => isGroup ? '${group!.size} restaurants' : vendorName;

  /// Where the order goes: the server's `dropoff` when present, else the app's own table of
  /// drop points looked up by [dropoffHostel] (legacy spellings included). Null when unknown.
  OrderPlace? get dropoffPlace {
    final d = dropoff;
    if (d != null) return d;
    final p = dropPointByName(dropoffHostel);
    return p == null ? null : OrderPlace(name: p.name, lat: p.lat, lng: p.lng);
  }

  /// The restaurant pin, only when the server says it is a real one.
  OrderPlace? get vendorPlace => vendorHasLocation && vendorLat != null && vendorLng != null ? OrderPlace(name: vendorName, lat: vendorLat!, lng: vendorLng!) : null;

  bool get isTerminal => status.isTerminal;
  bool get isLive => !isTerminal;
  bool get isPaid => paymentStatus == PaymentStatus.paid;

  /// PLACED and not paid yet: the student still has to pay (or it expires).
  bool get awaitsPayment => status == OrderProgressStatus.placed && (paymentStatus == PaymentStatus.pending || paymentStatus == PaymentStatus.failed);

  /// The student may cancel only while PLACED (contract 1.3); a combined order only while EVERY
  /// restaurant is still PLACED (Docs/22 4.4).
  bool get canCancel {
    final all = members;
    if (all != null) return all.isNotEmpty && all.every((m) => m.status == OrderProgressStatus.placed);
    return status == OrderProgressStatus.placed;
  }

  /// When the server will cancel this order if it is still unpaid: the server's `payBy`, or
  /// (older backend) createdAt + 15 minutes.
  DateTime get paymentDeadline => payBy ?? createdAt.add(kPaymentWindow);

  /// A cancelled order that was paid and whose refund has neither finished nor failed yet: the
  /// server publishes the refund result as a second event shortly after the cancellation.
  bool get isRefundInProgress =>
      status == OrderProgressStatus.cancelled && paymentStatus == PaymentStatus.paid && refundStatus != RefundStatus.failed && refundStatus != RefundStatus.done;

  bool get isPaymentNotCompletedCancel => status == OrderProgressStatus.cancelled && cancelReason == kReasonPaymentNotCompleted;

  int get itemCount => items.fold(0, (sum, i) => sum + i.quantity);

  /// Total in paise, the unit Razorpay and the server compare in.
  int get totalPaise => (totalAmount * 100).round();

  /// Merge rule (contract 3): a copy replaces another when its `updatedAt` is not older.
  /// Equal timestamps never move a live order backwards on the happy path.
  bool isNewerThan(OrderModel other) {
    final cmp = updatedAt.compareTo(other.updatedAt);
    if (cmp != 0) return cmp > 0;
    if (other.status == OrderProgressStatus.cancelled) return status == OrderProgressStatus.cancelled;
    if (status == OrderProgressStatus.cancelled) return true;
    if (status.stage != other.status.stage) return status.stage > other.status.stage;
    // Same status and timestamp: never "un-pay" an order.
    return !(other.paymentStatus != PaymentStatus.pending && paymentStatus == PaymentStatus.pending);
  }
}
