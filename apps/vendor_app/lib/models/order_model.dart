/// An order as the restaurant sees it. Built ONLY from the server's `OrderView`
/// (Docs/16_order_flow_contract.md section 2.1): the app never invents an id, a price,
/// a status or a customer detail.
library;

enum OrderStatus {
  placed,
  accepted,
  preparing,
  readyForPickup,
  pickedUp,
  arrivedAtGate,
  delivered,
  cancelled,

  /// A status this version of the app does not know. Shown read-only, never acted on.
  unknown;

  static OrderStatus parse(Object? raw) {
    switch (raw?.toString().trim().toUpperCase()) {
      case 'PLACED':
        return OrderStatus.placed;
      case 'ACCEPTED':
        return OrderStatus.accepted;
      case 'PREPARING':
        return OrderStatus.preparing;
      case 'READY_FOR_PICKUP':
        return OrderStatus.readyForPickup;
      case 'PICKED_UP':
        return OrderStatus.pickedUp;
      case 'ARRIVED_AT_GATE':
        return OrderStatus.arrivedAtGate;
      case 'DELIVERED':
        return OrderStatus.delivered;
      case 'CANCELLED':
        return OrderStatus.cancelled;
      default:
        return OrderStatus.unknown;
    }
  }

  /// The value the server expects in `PATCH /orders/:id/status`.
  String get wire => switch (this) {
        OrderStatus.placed => 'PLACED',
        OrderStatus.accepted => 'ACCEPTED',
        OrderStatus.preparing => 'PREPARING',
        OrderStatus.readyForPickup => 'READY_FOR_PICKUP',
        OrderStatus.pickedUp => 'PICKED_UP',
        OrderStatus.arrivedAtGate => 'ARRIVED_AT_GATE',
        OrderStatus.delivered => 'DELIVERED',
        OrderStatus.cancelled => 'CANCELLED',
        OrderStatus.unknown => 'UNKNOWN',
      };

  /// Position in the lifecycle. Terminal states share the top rank.
  int get rank => switch (this) {
        OrderStatus.placed => 0,
        OrderStatus.accepted => 1,
        OrderStatus.preparing => 2,
        OrderStatus.readyForPickup => 3,
        OrderStatus.pickedUp => 4,
        OrderStatus.arrivedAtGate => 5,
        OrderStatus.delivered => 6,
        OrderStatus.cancelled => 6,
        OrderStatus.unknown => -1,
      };

  bool get isTerminal => this == OrderStatus.delivered || this == OrderStatus.cancelled;

  /// The states the kitchen works on (after accepting, before the runner collects).
  bool get isKitchen => this == OrderStatus.accepted || this == OrderStatus.preparing || this == OrderStatus.readyForPickup;
}

enum PaymentStatus {
  pending,
  paid,
  failed,
  refunded,
  unknown;

  static PaymentStatus parse(Object? raw) {
    switch (raw?.toString().trim().toUpperCase()) {
      case 'PENDING':
        return PaymentStatus.pending;
      case 'PAID':
        return PaymentStatus.paid;
      case 'FAILED':
        return PaymentStatus.failed;
      case 'REFUNDED':
        return PaymentStatus.refunded;
      default:
        return PaymentStatus.unknown;
    }
  }
}

/// Who cancelled an order (`cancelledBy`).
enum CancelledBy {
  customer,
  vendor,
  admin,
  system,
  unknown;

  static CancelledBy? parse(Object? raw) {
    if (raw == null) return null;
    switch (raw.toString().trim().toUpperCase()) {
      case 'CUSTOMER':
        return CancelledBy.customer;
      case 'VENDOR':
        return CancelledBy.vendor;
      case 'ADMIN':
        return CancelledBy.admin;
      case 'SYSTEM':
        return CancelledBy.system;
      case '':
        return null;
      default:
        return CancelledBy.unknown;
    }
  }
}

class OrderItem {
  const OrderItem({this.id, this.menuItemId, required this.name, required this.quantity, required this.unitPrice});

  final String? id;
  final String? menuItemId;
  final String name;
  final int quantity;
  final double unitPrice;

  double get totalPrice => quantity * unitPrice;

  static OrderItem? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final name = raw['name']?.toString().trim() ?? (raw['menuItem'] is Map ? (raw['menuItem'] as Map)['name']?.toString().trim() : null) ?? '';
    final qty = _int(raw['quantity']) ?? 0;
    if (name.isEmpty || qty <= 0) return null;
    return OrderItem(
      id: raw['id']?.toString(),
      menuItemId: raw['menuItemId']?.toString(),
      name: name,
      quantity: qty,
      unitPrice: _double(raw['price']) ?? 0,
    );
  }
}

/// The runner who claimed the order. The restaurant may see the runner's name and phone once assigned.
class OrderRider {
  const OrderRider({required this.id, required this.name, this.phone});
  final String id;
  final String name;
  final String? phone;

  static OrderRider? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString() ?? '';
    final name = raw['name']?.toString().trim() ?? '';
    if (id.isEmpty && name.isEmpty) return null;
    final phone = raw['phone']?.toString().trim();
    return OrderRider(id: id, name: name.isEmpty ? 'Runner' : name, phone: (phone == null || phone.isEmpty) ? null : phone);
  }
}

class OrderModel {
  const OrderModel({
    required this.id,
    required this.status,
    required this.paymentStatus,
    required this.items,
    required this.totalAmount,
    this.subtotal,
    this.deliveryFee,
    this.taxAndPackaging,
    this.discount,
    this.dropoffHostel,
    this.dropoffNotes,
    required this.createdAt,
    this.updatedAt,
    this.paidAt,
    this.acceptedAt,
    this.pickedUpAt,
    this.deliveredAt,
    this.cancelledAt,
    this.cancelledBy,
    this.cancelReason,
    this.customerFirstName,
    this.rider,
    this.vendorId,
    this.acceptBy,
    this.refundStatus,
  });

  /// How long the restaurant has to accept a paid order before Kraveo cancels and refunds it
  /// (`VENDOR_ACCEPT_WINDOW_MIN`). The server enforces it; the app only shows the countdown.
  static const Duration acceptWindow = Duration(minutes: 10);

  final String id;
  final OrderStatus status;
  final PaymentStatus paymentStatus;
  final List<OrderItem> items;
  final double totalAmount;
  final double? subtotal;
  final double? deliveryFee;
  final double? taxAndPackaging;
  final double? discount;
  final String? dropoffHostel;
  final String? dropoffNotes;
  final DateTime createdAt;
  final DateTime? updatedAt;
  final DateTime? paidAt;
  final DateTime? acceptedAt;
  final DateTime? pickedUpAt;
  final DateTime? deliveredAt;
  final DateTime? cancelledAt;
  final CancelledBy? cancelledBy;
  final String? cancelReason;

  /// Customer FIRST name only (visibility rule). Never the phone.
  final String? customerFirstName;
  final OrderRider? rider;
  final String? vendorId;

  /// The server's deadline for Accept / Reject (`acceptBy`, only while PLACED + PAID).
  final DateTime? acceptBy;

  /// `NONE|PENDING|DONE|FAILED` when the server sends it (the vendor view currently does not).
  final String? refundStatus;

  /// Short code a cook can read out ("#05EFB9"): '#' + the last 6 characters of the server id, uppercased.
  /// The same rule is used by every Kraveo app and the dashboard, so people can match orders by voice.
  String get shortCode => '#${(id.length <= 6 ? id : id.substring(id.length - 6)).toUpperCase()}';

  String get studentName => customerFirstName ?? 'Customer';
  String get studentLocation => dropoffHostel ?? 'Drop point not given';
  String? get customerNote => (dropoffNotes == null || dropoffNotes!.trim().isEmpty) ? null : dropoffNotes!.trim();

  bool get isPaid => paymentStatus == PaymentStatus.paid;

  /// Something the restaurant may legitimately see: paid, or cancelled/refunded after payment.
  /// Unpaid orders never reach the kitchen (contract 1.2); we drop them even if a server bug sends one.
  bool get isVisibleToVendor => paymentStatus == PaymentStatus.paid || paymentStatus == PaymentStatus.refunded || (status == OrderStatus.cancelled && paymentStatus != PaymentStatus.pending && paymentStatus != PaymentStatus.failed);

  /// A new paid order waiting for Accept / Reject.
  bool get isIncoming => status == OrderStatus.placed && isPaid;

  /// When the accept window closes: the server's `acceptBy`; only if it is missing, payment time + 10 minutes.
  DateTime get acceptDeadline => acceptBy ?? (paidAt ?? createdAt).add(acceptWindow);

  /// Sum of the items as the server priced them (fallback when `subtotal` is missing).
  double get itemsTotal => items.fold<double>(0, (sum, it) => sum + it.totalPrice);

  /// The food value of the order (what the kitchen sold), before fees.
  double get foodValue => (subtotal != null && subtotal! > 0) ? subtotal! : itemsTotal;

  /// When the order reached its final state, for sorting history.
  DateTime get lastEventAt => cancelledAt ?? deliveredAt ?? pickedUpAt ?? updatedAt ?? createdAt;

  OrderModel copyWith({OrderStatus? status}) => OrderModel(
        id: id,
        status: status ?? this.status,
        paymentStatus: paymentStatus,
        items: items,
        totalAmount: totalAmount,
        subtotal: subtotal,
        deliveryFee: deliveryFee,
        taxAndPackaging: taxAndPackaging,
        discount: discount,
        dropoffHostel: dropoffHostel,
        dropoffNotes: dropoffNotes,
        createdAt: createdAt,
        updatedAt: updatedAt,
        paidAt: paidAt,
        acceptedAt: acceptedAt,
        pickedUpAt: pickedUpAt,
        deliveredAt: deliveredAt,
        cancelledAt: cancelledAt,
        cancelledBy: cancelledBy,
        cancelReason: cancelReason,
        customerFirstName: customerFirstName,
        rider: rider,
        vendorId: vendorId,
        acceptBy: acceptBy,
        refundStatus: refundStatus,
      );

  /// True when [incoming] (from a poll, a socket event or an action response) is at least as new
  /// as this copy. The server's `updatedAt` decides; without it, the lifecycle never moves backwards.
  bool isSupersededBy(OrderModel incoming) {
    if (status.isTerminal && !incoming.status.isTerminal) return false; // a finished order never reopens
    final a = updatedAt;
    final b = incoming.updatedAt;
    if (a != null && b != null) {
      if (b.isAfter(a)) return true;
      if (b.isBefore(a)) return false;
      return incoming.status.rank >= status.rank;
    }
    return incoming.status.rank >= status.rank || incoming.status.isTerminal;
  }

  /// Parses one `OrderView`. Returns null when the payload is not a usable order
  /// (no id, no parsable creation time), so a malformed socket event can never crash the kitchen.
  static OrderModel? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString().trim() ?? '';
    if (id.isEmpty) return null;
    final createdAt = _date(raw['createdAt']);
    if (createdAt == null) return null;

    final itemsRaw = raw['items'];
    final items = <OrderItem>[
      if (itemsRaw is List)
        for (final it in itemsRaw)
          if (OrderItem.fromJson(it) case final OrderItem item) item,
    ];

    String? firstName;
    final customer = raw['customer'];
    if (customer is Map) {
      final full = customer['name']?.toString().trim() ?? '';
      // Visibility rule: first name only. Enforced here as well, in case a server sends more.
      if (full.isNotEmpty) firstName = full.split(RegExp(r'\s+')).first;
    }

    final hostel = raw['dropoffHostel']?.toString().trim();
    final notes = raw['dropoffNotes']?.toString();
    final reason = raw['cancelReason']?.toString().trim();

    return OrderModel(
      id: id,
      status: OrderStatus.parse(raw['status']),
      paymentStatus: PaymentStatus.parse(raw['paymentStatus']),
      items: items,
      totalAmount: _double(raw['totalAmount']) ?? 0,
      subtotal: _double(raw['subtotal']),
      deliveryFee: _double(raw['deliveryFee']),
      taxAndPackaging: _double(raw['taxAndPackaging']),
      discount: _double(raw['discount']),
      dropoffHostel: (hostel == null || hostel.isEmpty) ? null : hostel,
      dropoffNotes: notes,
      createdAt: createdAt,
      updatedAt: _date(raw['updatedAt']),
      paidAt: _date(raw['paidAt']),
      acceptedAt: _date(raw['acceptedAt']),
      pickedUpAt: _date(raw['pickedUpAt']),
      deliveredAt: _date(raw['deliveredAt']),
      cancelledAt: _date(raw['cancelledAt']),
      cancelledBy: CancelledBy.parse(raw['cancelledBy']),
      cancelReason: (reason == null || reason.isEmpty) ? null : reason,
      customerFirstName: firstName,
      rider: OrderRider.fromJson(raw['driver']),
      vendorId: (raw['vendorId'] ?? (raw['vendor'] is Map ? (raw['vendor'] as Map)['id'] : null))?.toString(),
      acceptBy: _date(raw['acceptBy']),
      refundStatus: raw['refundStatus']?.toString(),
    );
  }
}

int? _int(Object? v) {
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v.trim());
  return null;
}

double? _double(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v.trim());
  return null;
}

/// ISO timestamps from the server are UTC; the UI shows them in local time.
DateTime? _date(Object? v) {
  if (v is! String || v.trim().isEmpty) return null;
  return DateTime.tryParse(v.trim())?.toLocal();
}
