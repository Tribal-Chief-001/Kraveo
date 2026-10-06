/// The restaurant's own settlements (Docs/21 section 5): `GET /api/partner/settlements[/:id]`.
///
/// ONLY restaurant-side amounts exist here: `vendorAmount` (what the restaurant earned), `adjustmentTotal` and
/// `netPayable` (what it receives). The server never sends customer prices, fees or commission, and this model has no
/// field that could hold one, so no screen can show it.
enum SettlementStatus {
  pending,
  onHold,
  paid;

  /// `PENDING | ON_HOLD | PAID`. A word this version does not know counts as pending: the cautious claim, because it
  /// never tells the owner money was paid when we cannot tell. (The server never sends CANCELLED to a restaurant.)
  static SettlementStatus parse(Object? raw) => switch (raw?.toString().trim().toUpperCase()) {
        'PAID' => SettlementStatus.paid,
        'ON_HOLD' => SettlementStatus.onHold,
        _ => SettlementStatus.pending,
      };
}

num? _num(Object? v) => v is num && v.isFinite ? v : (v is String ? num.tryParse(v) : null);
DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

class Settlement {
  const Settlement({
    required this.id,
    required this.status,
    required this.orderCount,
    required this.vendorAmount,
    required this.adjustmentTotal,
    required this.netPayable,
    required this.periodStart,
    required this.periodEnd,
    required this.createdAt,
    this.paidAt,
    this.paymentReference,
  });

  final String id;
  final SettlementStatus status;
  final int orderCount;

  /// What the restaurant earned for the orders in this settlement.
  final double vendorAmount;

  /// Credits (+) and debits (-) added by Kraveo.
  final double adjustmentTotal;

  /// What the restaurant receives: [vendorAmount] plus [adjustmentTotal].
  final double netPayable;
  final DateTime periodStart;
  final DateTime periodEnd;
  final DateTime createdAt;
  final DateTime? paidAt;

  /// The bank / UPI reference (UTR) of the payment, once paid.
  final String? paymentReference;

  bool get isPaid => status == SettlementStatus.paid;

  /// Null when the entry cannot be read (no id, no amount to receive, no period): it is skipped, never shown half-broken.
  static Settlement? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'];
    final net = _num(json['netPayable']);
    final start = _date(json['periodStart']);
    final end = _date(json['periodEnd']) ?? start;
    if (id is! String || id.isEmpty || net == null || start == null || end == null) return null;
    final ref = json['paymentReference'];
    return Settlement(
      id: id,
      status: SettlementStatus.parse(json['status']),
      orderCount: _num(json['orderCount'])?.toInt() ?? 0,
      vendorAmount: (_num(json['vendorAmount']) ?? net).toDouble(),
      adjustmentTotal: (_num(json['adjustmentTotal']) ?? 0).toDouble(),
      netPayable: net.toDouble(),
      periodStart: start,
      periodEnd: end,
      createdAt: _date(json['createdAt']) ?? end,
      paidAt: _date(json['paidAt']),
      paymentReference: ref is String && ref.trim().isNotEmpty ? ref.trim() : null,
    );
  }
}

/// One order inside a settlement: what the restaurant earned for it (never the customer's total).
class SettlementOrder {
  const SettlementOrder({required this.id, required this.amount, this.deliveredAt});
  final String id;
  final double amount;
  final DateTime? deliveredAt;

  /// A short reference the owner can read out: the first 8 characters of the id, upper-case.
  String get shortId => (id.length > 8 ? id.substring(0, 8) : id).toUpperCase();
}

class SettlementAdjustment {
  const SettlementAdjustment({required this.amount, required this.reason, this.createdAt});
  final double amount;
  final String reason;
  final DateTime? createdAt;
}

/// A per-dish line: how many portions and what the restaurant earned for them.
class SettlementDish {
  const SettlementDish({required this.name, required this.units, required this.amount});
  final String name;
  final int units;
  final double amount;
}

class SettlementDetail {
  const SettlementDetail({required this.settlement, required this.orders, required this.ordersTruncated, required this.adjustments, required this.dishes});

  final Settlement settlement;
  final List<SettlementOrder> orders;

  /// More orders were settled than the list holds.
  final bool ordersTruncated;
  final List<SettlementAdjustment> adjustments;
  final List<SettlementDish> dishes;

  static SettlementDetail? fromJson(Object? json) {
    final s = Settlement.fromJson(json);
    if (s == null || json is! Map) return null;
    List<T> read<T>(String key, T? Function(Map m) one) {
      final raw = json[key];
      if (raw is! List) return const [];
      return [
        for (final e in raw)
          if (e is Map)
            if (one(e) case final T v) v,
      ];
    }

    return SettlementDetail(
      settlement: s,
      orders: read('orders', (m) {
        final id = m['id'];
        final amount = _num(m['amount']);
        return id is String && amount != null ? SettlementOrder(id: id, amount: amount.toDouble(), deliveredAt: _date(m['deliveredAt'])) : null;
      }),
      ordersTruncated: json['ordersTruncated'] == true,
      adjustments: read('adjustments', (m) {
        final amount = _num(m['amount']);
        return amount != null ? SettlementAdjustment(amount: amount.toDouble(), reason: m['reason']?.toString() ?? '', createdAt: _date(m['createdAt'])) : null;
      }),
      dishes: read('dishes', (m) {
        final name = m['name'];
        final amount = _num(m['amount']);
        return name is String && amount != null ? SettlementDish(name: name, units: _num(m['units'])?.toInt() ?? 0, amount: amount.toDouble()) : null;
      }),
    );
  }
}

/// One page of `GET /partner/settlements` (newest first).
class SettlementsPage {
  const SettlementsPage({required this.items, required this.page, required this.pages, required this.total, this.skipped = 0});
  final List<Settlement> items;
  final int page;
  final int pages;
  final int total;

  /// Entries that could not be read (skipped, never shown half-broken).
  final int skipped;

  bool get hasMore => page < pages;
}

// ---------------------------------------------------------------------------------------------------------------------
// India time. The server stores instants; settlements are explained in Asia/Kolkata (UTC+5:30, no daylight saving).
// ---------------------------------------------------------------------------------------------------------------------

/// The same instant as a wall-clock time in India (the returned DateTime is only used for its fields).
DateTime inIst(DateTime t) => t.toUtc().add(const Duration(hours: 5, minutes: 30));

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "7 Oct 2026" (India date).
String formatIstDate(DateTime t, {bool year = true}) {
  final d = inIst(t);
  return '${d.day} ${_months[d.month - 1]}${year ? ' ${d.year}' : ''}';
}

/// "7 Oct 2026, 9:05 PM" (India time).
String formatIstDateTime(DateTime t) {
  final d = inIst(t);
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '${formatIstDate(t)}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
}

/// The days a settlement covers: "7 Oct 2026" when it is one India day, else "5 Oct to 7 Oct 2026".
String settlementPeriodText(DateTime start, DateTime end) {
  final a = inIst(start);
  final b = inIst(end);
  if (a.year == b.year && a.month == b.month && a.day == b.day) return formatIstDate(end);
  if (a.year == b.year) return '${formatIstDate(start, year: false)} to ${formatIstDate(end)}';
  return '${formatIstDate(start)} to ${formatIstDate(end)}';
}
