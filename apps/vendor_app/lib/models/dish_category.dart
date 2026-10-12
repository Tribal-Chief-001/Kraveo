import '../widgets/ui/vendor_ui.dart' show hindiCategory;

/// A dish category the restaurant can pick when adding a dish (`GET /api/categories?for=dishes`, Docs/23).
/// The value sent to the server is always the [name] string, exactly as before the categories were managed.
class DishCategory {
  const DishCategory(this.name, {this.nameHi});

  final String name;

  /// Hindi name from the server; null when the admin did not set one.
  final String? nameHi;

  /// The Hindi sublabel: the server's `nameHi`, else the app's own map, else nothing.
  String? get hindiLabel {
    final hi = nameHi?.trim() ?? '';
    if (hi.isNotEmpty) return hi;
    final own = hindiCategory(name);
    return own.isEmpty ? null : own;
  }

  /// The six categories the app has always offered: used while the list loads, offline, on an old server (404) and
  /// when the server list is empty.
  static const List<DishCategory> fallback = [
    DishCategory('Main Course'),
    DishCategory('Breads'),
    DishCategory('Beverages'),
    DishCategory('Snacks'),
    DishCategory('Desserts'),
    DishCategory('Fast Food'),
  ];

  /// The default pick when nothing else was chosen.
  static const String defaultName = 'Main Course';

  /// One row of `data`; null when it has no usable name. Everything else missing or garbled is ignored.
  static DishCategory? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final name = raw['name'];
    if (name is! String || name.trim().isEmpty) return null;
    final hi = raw['nameHi'];
    return DishCategory(name.trim(), nameHi: hi is String && hi.trim().isNotEmpty ? hi.trim() : null);
  }

  /// The `data` list in the server's order, without rows that have no name and without repeats (any case).
  static List<DishCategory> parseList(Object? raw) {
    if (raw is! List) return const [];
    final seen = <String>{};
    final out = <DishCategory>[];
    for (final row in raw) {
      final c = tryParse(row);
      if (c != null && seen.add(c.name.toLowerCase())) out.add(c);
    }
    return out;
  }
}
