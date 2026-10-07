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

/// One restaurant stop of a combined order (Docs/22 section 10.4: `group.stops[]`).
///
/// Built either from the server's `stops` entry (name, address, coordinates, item count, status) or,
/// once the rider also holds that stop's own order copy, from that copy (which can vouch for the
/// pin with `hasLocation`; the `stops` entry cannot, so its coordinates are never used to navigate).
class GroupStopView {
  const GroupStopView({
    required this.orderId,
    required this.index,
    required this.status,
    required this.name,
    this.address,
    this.lat,
    this.lng,
    this.itemCount = 0,
    this.locationVouched = false,
  });

  final String orderId;
  final int index;
  final OrderStatus status;
  final String name;
  final String? address;
  final double? lat, lng;
  final int itemCount;

  /// The server said this pin is a real restaurant location (only known from the stop's own order copy).
  final bool locationVouched;

  GeoPoint? get point {
    final la = lat, ln = lng;
    if (!locationVouched || la == null || ln == null) return null;
    final p = GeoPoint(la, ln);
    return p.isValid ? p : null;
  }

  /// The restaurant already gave the food to the rider (or the order is closed).
  bool get pickedUp => status.rank >= OrderStatus.pickedUp.rank && status != OrderStatus.cancelled;

  GroupStopView copyWith({OrderStatus? status}) => GroupStopView(
        orderId: orderId,
        index: index,
        status: status ?? this.status,
        name: name,
        address: address,
        lat: lat,
        lng: lng,
        itemCount: itemCount,
        locationVouched: locationVouched,
      );
}

/// `OrderView.group` for a rider (Docs/22 section 10.4). Absent on a single-restaurant order.
class GroupInfo {
  const GroupInfo({required this.id, required this.index, required this.size, required this.primary, this.stops = const []});

  final String id;
  final int index;
  final int size;
  final bool primary;

  /// Ordered by `index`. On a merged delivery these are the resolved stops (see [OrderView.mergeGroup]).
  final List<GroupStopView> stops;
}

class OrderView {
  const OrderView({
    required this.id,
    required this.status,
    this.group,
    this.groupParts = const [],
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

  /// Set only on a child of a combined order (Docs/22). Null on every single-restaurant order.
  final GroupInfo? group;

  /// Only on a MERGED combined delivery ([mergeGroup]): the separate child copies it was built from.
  final List<OrderView> groupParts;

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

  // ---- combined orders (Docs/22) ----

  bool get isGroup => group != null;

  /// The stops of a combined order, ordered; empty for a single order.
  List<GroupStopView> get stops => group?.stops ?? const [];

  /// "Combined order - 2 restaurants" for a combined order, else the restaurant's name.
  String get headlineName => isGroup ? 'Combined order - ${group!.size} restaurants' : restaurantName;

  /// The restaurant names of a combined order joined with " + ", else the restaurant's name.
  String get pickupLabel => isGroup && stops.isNotEmpty ? stops.map((s) => s.name).join(' + ') : restaurantName;

  /// Every restaurant of a combined order handed over its food.
  bool get allStopsPickedUp => isGroup ? stops.isNotEmpty && stops.every((s) => s.pickedUp) : status.rank >= OrderStatus.pickedUp.rank;

  /// Release is allowed only before the first pickup (a combined order: before ANY stop was picked up).
  bool get canRelease => isGroup ? stops.every((s) => s.status.isBeforePickup) : status.isBeforePickup;

  /// Folds the copies of ONE combined order (the rider's `GET /orders?scope=active` returns each child as its own
  /// OrderView, every one carrying the same `group`) into ONE delivery. Returns null when no copy has a `group`.
  ///
  /// The merged view takes its id from the first stop (the primary child; any child id is accepted by the server for
  /// accept / arrive / OTP / release). Its status is the LEAST advanced stop (so "Picked up" shows only when every
  /// restaurant handed over its food); a cancelled stop cancels the whole order and a delivered stop delivers it
  /// (the server does both for every child at once). Each stop's status is the most advanced one reported by its
  /// own copy or by any copy's `stops` list, so a stale copy can never move a stop backwards.
  static OrderView? mergeGroup(Iterable<OrderView> copies) {
    final first = copies.where((c) => c.group != null).firstOrNull;
    if (first == null) return null;
    final gid = first.group!.id;
    final byId = <String, OrderView>{};
    for (final c in copies) {
      if (c.group?.id != gid) continue;
      final old = byId[c.id];
      if (old == null || c.isAtLeastAsNewAs(old)) byId[c.id] = c;
    }
    return _build(byId.values.toList());
  }

  /// This merged delivery updated with newer copies of its children (same rules as [mergeGroup]).
  OrderView? mergedWith(Iterable<OrderView> incoming) {
    final g = group;
    if (g == null) return null;
    return mergeGroup([...(groupParts.isEmpty ? [this] : groupParts), ...incoming.where((o) => o.group?.id == g.id)]);
  }

  static OrderView _build(List<OrderView> parts) {
    parts.sort((a, b) => (a.group?.index ?? 0).compareTo(b.group?.index ?? 0));
    final byId = {for (final p in parts) p.id: p};

    // Candidate stop data: every copy's own stop, plus every copy's `stops` list.
    final candidates = <String, List<GroupStopView>>{};
    for (final p in parts) {
      for (final s in p.group!.stops) {
        (candidates[s.orderId] ??= []).add(s);
      }
    }
    final stops = <GroupStopView>[];
    final ids = <String>{...candidates.keys, ...byId.keys};
    for (final id in ids) {
      final own = byId[id];
      final listed = candidates[id] ?? const <GroupStopView>[];
      var status = own?.status ?? OrderStatus.unknown;
      for (final s in listed) {
        status = _moreAdvanced(status, s.status);
      }
      final ref = listed.isEmpty ? null : listed.first;
      final ownIndex = own?.group?.index;
      stops.add(GroupStopView(
        orderId: id,
        index: ref?.index ?? ownIndex ?? 0,
        status: status,
        name: own != null && own.vendor != null ? own.restaurantName : (ref?.name ?? 'Restaurant'),
        address: own?.vendor?.address ?? ref?.address,
        lat: own?.vendor?.lat ?? ref?.lat,
        lng: own?.vendor?.lng ?? ref?.lng,
        itemCount: own != null && own.items.isNotEmpty ? own.itemCount : (ref?.itemCount ?? 0),
        locationVouched: own?.vendor?.hasLocation ?? false,
      ));
    }
    stops.sort((a, b) => a.index.compareTo(b.index));

    final leadId = stops.first.orderId;
    final base = byId[leadId] ?? parts.first;
    OrderStatus status;
    if (stops.any((s) => s.status == OrderStatus.cancelled)) {
      status = OrderStatus.cancelled;
    } else if (stops.any((s) => s.status == OrderStatus.delivered)) {
      status = OrderStatus.delivered;
    } else {
      status = stops.map((s) => s.status).reduce((a, b) => a.rank <= b.rank ? a : b);
    }

    T? firstOf<T>(T? Function(OrderView) pick) {
      final b = pick(base);
      if (b != null) return b;
      for (final p in parts) {
        final v = pick(p);
        if (v != null) return v;
      }
      return null;
    }

    DateTime? latest(DateTime? Function(OrderView) pick) {
      DateTime? best;
      for (final p in parts) {
        final v = pick(p);
        if (v != null && (best == null || v.isAfter(best))) best = v;
      }
      return best;
    }

    double? sum(double? Function(OrderView) pick) {
      var total = 0.0;
      for (final p in parts) {
        final v = pick(p);
        if (v == null) return null;
        total += v;
      }
      return parts.length >= base.group!.size ? total : null;
    }

    final cancelled = parts.where((p) => p.status == OrderStatus.cancelled);
    final trigger = cancelled.where((p) => p.cancelledBy != null && p.cancelledBy != 'SYSTEM').firstOrNull ?? cancelled.firstOrNull ?? base;

    return OrderView(
      id: leadId,
      status: status,
      group: GroupInfo(id: base.group!.id, index: base.group!.index, size: stops.length > base.group!.size ? stops.length : base.group!.size, primary: base.group!.primary, stops: stops),
      groupParts: List.unmodifiable(parts),
      paymentStatus: base.paymentStatus,
      totalAmount: sum((p) => p.totalAmount),
      deliveryFee: sum((p) => p.deliveryFee),
      dropoffHostel: firstOf((p) => p.dropoffHostel),
      dropoffNotes: firstOf((p) => p.dropoffNotes),
      dropoff: firstOf((p) => p.dropoff),
      createdAt: base.createdAt,
      updatedAt: latest((p) => p.updatedAt),
      paidAt: base.paidAt,
      acceptedAt: base.acceptedAt,
      pickedUpAt: latest((p) => p.pickedUpAt),
      deliveredAt: latest((p) => p.deliveredAt),
      cancelledAt: latest((p) => p.cancelledAt),
      cancelledBy: trigger.cancelledBy,
      cancelReason: trigger.cancelReason,
      items: [for (final p in parts) ...p.items],
      vendor: base.vendor,
      customer: firstOf((p) => p.customer),
      driver: firstOf((p) => p.driver),
    );
  }

  /// Of two reports for one stop, the one further along the happy path; a closed state beats an open one.
  static OrderStatus _moreAdvanced(OrderStatus a, OrderStatus b) {
    if (a == OrderStatus.unknown) return b;
    if (b == OrderStatus.unknown) return a;
    if (a.isTerminal) return a;
    if (b.isTerminal) return b;
    return a.rank >= b.rank ? a : b;
  }

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
      group: _group(raw['group']),
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

  /// `group` of Docs/22 section 10.4. Anything that is not a map with an id is read as "not a combined order".
  static GroupInfo? _group(Object? raw) {
    if (raw is! Map) return null;
    final id = _str(raw['id']);
    if (id == null) return null;
    final stops = <GroupStopView>[];
    final rawStops = raw['stops'];
    if (rawStops is List) {
      for (final e in rawStops) {
        if (e is! Map) continue;
        final orderId = _str(e['orderId']);
        if (orderId == null) continue;
        final v = e['vendor'];
        final vm = v is Map ? v : const {};
        stops.add(GroupStopView(
          orderId: orderId,
          index: _int(e['index']) ?? stops.length,
          status: OrderStatus.parse(e['status']),
          name: _str(vm['name']) ?? 'Restaurant',
          address: _str(vm['address']),
          lat: _num(vm['lat']),
          lng: _num(vm['lng']),
          itemCount: _int(e['itemCount']) ?? 0,
        ));
      }
      stops.sort((a, b) => a.index.compareTo(b.index));
    }
    final index = _int(raw['index']) ?? 0;
    return GroupInfo(
      id: id,
      index: index,
      size: _int(raw['size']) ?? (stops.isEmpty ? 1 : stops.length),
      primary: raw['primary'] == true || (raw['primary'] == null && index == 0),
      stops: List.unmodifiable(stops),
    );
  }

  static int? _int(Object? v) {
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v);
    return null;
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
