/// The rider's view of a Kraveo order (contract `Docs/16_order_flow_contract.md`, section 2.1).
///
/// The server is the only source of truth: this class never invents an id, a price or a status.
/// It deliberately has **no OTP field**: the gate code belongs to the customer, and even if a
/// misconfigured server ever sent `otpCode` to a rider, the app would drop it while parsing.
library;

import 'drop_point.dart';
import 'geo.dart';

enum OrderStatus {
  placed,
  accepted,
  preparing,
  readyForPickup,
  pickedUp,
  arrivedAtGate,
  delivered,
  cancelled,
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

  /// The wire value the server expects in `PATCH /orders/:id/status`.
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

  bool get isTerminal => this == OrderStatus.delivered || this == OrderStatus.cancelled;

  /// Before the rider has the food: the job can still be released back to the pool.
  bool get isBeforePickup => this == OrderStatus.accepted || this == OrderStatus.preparing || this == OrderStatus.readyForPickup || this == OrderStatus.placed;

  /// Position in the happy path, used only as a tie-breaker when two copies carry the same `updatedAt`.
  int get rank => switch (this) {
        OrderStatus.unknown => -1,
        OrderStatus.placed => 0,
        OrderStatus.accepted => 1,
        OrderStatus.preparing => 2,
        OrderStatus.readyForPickup => 3,
        OrderStatus.pickedUp => 4,
        OrderStatus.arrivedAtGate => 5,
        OrderStatus.delivered => 6,
        OrderStatus.cancelled => 6,
      };
}

class OrderItemView {
  const OrderItemView({required this.name, required this.quantity, this.price});
  final String name;
  final int quantity;
  final double? price;
}

class VendorView {
  const VendorView({this.id, required this.name, this.address, this.lat, this.lng, this.hasLocation = false});
  final String? id;
  final String name;
  final String? address;
  final double? lat, lng;

  /// The server's word that [lat]/[lng] are a REAL pin (Docs/19). False while the vendor still
  /// has the placeholder pin, and false when an older server does not send the flag at all: the
  /// app never navigates to a coordinate the server did not vouch for.
  final bool hasLocation;

  /// The restaurant pin, only when [hasLocation] and the numbers are a valid coordinate.
  GeoPoint? get point {
    final la = lat, ln = lng;
    if (!hasLocation || la == null || ln == null) return null;
    final p = GeoPoint(la, ln);
    return p.isValid ? p : null;
  }
}

/// Where the order is delivered, as the server resolved it (Docs/19: `dropoff {name,lat,lng}`).
class DropoffView {
  const DropoffView({required this.name, required this.lat, required this.lng});
  final String name;
  final double lat, lng;

  GeoPoint get point => GeoPoint(lat, lng);
}

class PersonView {
  const PersonView({this.id, this.name, this.phone, this.hostelBlock});
  final String? id;
  final String? name;
  final String? phone;
  final String? hostelBlock;
}

class OrderView {
  const OrderView({
    required this.id,
    required this.status,
    this.paymentStatus,
    this.totalAmount,
    this.deliveryFee,
    this.dropoffHostel,
    this.dropoffNotes,
    this.dropoff,
    this.createdAt,
    this.updatedAt,
    this.paidAt,
    this.acceptedAt,
    this.pickedUpAt,
    this.deliveredAt,
    this.cancelledAt,
    this.cancelledBy,
    this.cancelReason,
    this.items = const [],
    this.vendor,
    this.customer,
    this.driver,
  });

  final String id;
  final OrderStatus status;

  /// `PENDING | PAID | FAILED | REFUNDED` (upper case), or null when the server did not say.
  final String? paymentStatus;
  final double? totalAmount;
  final double? deliveryFee;
  final String? dropoffHostel;
  final String? dropoffNotes;

  /// The server's drop point with coordinates (additive; null for an older server or a stored
  /// value it could not recognise).
  final DropoffView? dropoff;
  final DateTime? createdAt, updatedAt, paidAt, acceptedAt, pickedUpAt, deliveredAt, cancelledAt;

  /// `CUSTOMER | VENDOR | ADMIN | SYSTEM`.
  final String? cancelledBy;
  final String? cancelReason;
  final List<OrderItemView> items;
  final VendorView? vendor;

  /// Hidden by the server in the pool view; name/phone appear once this rider is assigned.
  final PersonView? customer;
  final PersonView? driver;

  bool get isRefunded => paymentStatus == 'REFUNDED';

  /// Short, human friendly reference ("#A1B2C3") built from the real id; never a made-up number.
  /// Same rule in every Kraveo app: '#' + the last 6 characters of the id, upper case.
  String get shortRef {
    final tail = id.length <= 6 ? id : id.substring(id.length - 6);
    return '#${tail.toUpperCase()}';
  }

  int get itemCount => items.fold(0, (sum, i) => sum + i.quantity);

  String get restaurantName => (vendor?.name.trim().isNotEmpty ?? false) ? vendor!.name.trim() : 'Restaurant';

  String get dropLabel {
    final d = dropoffHostel?.trim();
    if (d != null && d.isNotEmpty) return d;
    final h = customer?.hostelBlock?.trim();
    if (h != null && h.isNotEmpty) return h;
    return 'Drop point not set';
  }

  /// The drop point as a map pin and navigation target: the server's `dropoff` when it came with
  /// valid coordinates, otherwise the campus table (same numbers) looked up by the hostel name.
  /// Null when the point is unknown: then no pin and no Navigate button are offered, and the
  /// screens keep showing [dropLabel] as plain text.
  DropoffView? get dropPlace {
    final d = dropoff;
    if (d != null && d.point.isValid) return d;
    final byName = dropPointByName(dropoffHostel) ?? dropPointByName(customer?.hostelBlock);
    return byName == null ? null : DropoffView(name: byName.name, lat: byName.lat, lng: byName.lng);
  }

  /// When the order entered the pool (paid), for "x min ago".
  DateTime? get offeredAt => paidAt ?? createdAt;

  /// When the rider finished it (for earnings and trip logs).
  DateTime? get finishedAt => deliveredAt ?? cancelledAt ?? updatedAt ?? createdAt;

  /// Merge rule from the contract (section 3): keep whichever copy is newer by `updatedAt`.
  /// Equal timestamps (or missing ones) fall back to the status order so a stale copy can never
  /// move a delivery backwards on screen.
  bool isAtLeastAsNewAs(OrderView other) {
    final a = updatedAt, b = other.updatedAt;
    if (a != null && b != null && a != b) return a.isAfter(b);
    if (status.isTerminal && !other.status.isTerminal) return true;
    if (other.status.isTerminal && !status.isTerminal) return false;
    return status.rank >= other.status.rank;
  }

  /// Tolerant parser. Returns null when the payload has no id (never invents one).
  static OrderView? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString().trim();
    if (id == null || id.isEmpty) return null;
    // NOTE: `otpCode` is intentionally ignored. A rider must never see the gate code.
    return OrderView(
      id: id,
      status: OrderStatus.parse(raw['status']),
      paymentStatus: raw['paymentStatus']?.toString().toUpperCase(),
      totalAmount: _num(raw['totalAmount']),
      deliveryFee: _num(raw['deliveryFee']),
      dropoffHostel: _str(raw['dropoffHostel']),
      dropoffNotes: _str(raw['dropoffNotes']),
      dropoff: _dropoff(raw['dropoff']),
      createdAt: _date(raw['createdAt']),
      updatedAt: _date(raw['updatedAt']),
      paidAt: _date(raw['paidAt']),
      acceptedAt: _date(raw['acceptedAt']),
      pickedUpAt: _date(raw['pickedUpAt']),
      deliveredAt: _date(raw['deliveredAt']),
      cancelledAt: _date(raw['cancelledAt']),
      cancelledBy: _str(raw['cancelledBy'])?.toUpperCase(),
      cancelReason: _str(raw['cancelReason']),
      items: _items(raw['items']),
      vendor: _vendor(raw['vendor']),
      customer: _person(raw['customer']),
      driver: _person(raw['driver']),
    );
  }

  static List<OrderView> parseList(Object? raw) {
    if (raw is! List) return const [];
    return raw.map(tryParse).whereType<OrderView>().toList();
  }

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  static double? _num(Object? v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }

  static DateTime? _date(Object? v) {
    if (v is! String || v.isEmpty) return null;
    return DateTime.tryParse(v)?.toUtc();
  }

  static List<OrderItemView> _items(Object? raw) {
    if (raw is! List) return const [];
    final out = <OrderItemView>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final name = _str(e['name']) ?? _str(e['menuItem'] is Map ? (e['menuItem'] as Map)['name'] : null) ?? 'Item';
      final q = e['quantity'];
      out.add(OrderItemView(name: name, quantity: q is num ? q.toInt() : int.tryParse('$q') ?? 1, price: _num(e['price'])));
    }
    return out;
  }

  static VendorView? _vendor(Object? raw) {
    if (raw is! Map) return null;
    return VendorView(
      id: _str(raw['id']),
      name: _str(raw['name']) ?? 'Restaurant',
      address: _str(raw['address']),
      lat: _num(raw['lat']),
      lng: _num(raw['lng']),
      hasLocation: raw['hasLocation'] == true,
    );
  }

  static DropoffView? _dropoff(Object? raw) {
    if (raw is! Map) return null;
    final name = _str(raw['name']);
    final lat = _num(raw['lat']);
    final lng = _num(raw['lng']);
    if (name == null || lat == null || lng == null) return null;
    final view = DropoffView(name: name, lat: lat, lng: lng);
    return view.point.isValid ? view : null;
  }

  static PersonView? _person(Object? raw) {
    if (raw is! Map) return null;
    return PersonView(
      id: _str(raw['id']),
      name: _str(raw['name']),
      phone: _str(raw['phone']),
      hostelBlock: _str(raw['hostelBlock']),
    );
  }
}
