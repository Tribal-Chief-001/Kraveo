/// A managed category from `GET /api/categories` (Docs/23 section 8.4). Parsed defensively: a row
/// without a usable id or name is dropped, anything else missing gets a harmless default.
class FoodCategory {
  const FoodCategory({required this.id, required this.name, this.nameHi, this.icon = 'restaurant', this.sortOrder = 0});

  final String id;
  final String name;
  final String? nameHi;

  /// One of the fixed icon keys (`restaurant`, `thali`, `biryani` ...); unknown keys are mapped in the UI.
  final String icon;

  /// Global admin order; lower comes first.
  final int sortOrder;

  static FoodCategory? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final name = raw['name'];
    if (id is! String || id.trim().isEmpty || name is! String || name.trim().isEmpty) return null;
    final icon = raw['icon'];
    final hi = raw['nameHi'];
    final order = raw['sortOrder'];
    return FoodCategory(
      id: id.trim(),
      name: name.trim(),
      nameHi: hi is String && hi.trim().isNotEmpty ? hi.trim() : null,
      icon: icon is String && icon.trim().isNotEmpty ? icon.trim().toLowerCase() : 'restaurant',
      sortOrder: order is num && order.isFinite ? order.toInt() : 0,
    );
  }

  /// Parses a whole `data` list; anything that is not a list gives an empty result.
  static List<FoodCategory> parseList(Object? raw) {
    if (raw is! List) return const [];
    return [for (final row in raw) if (tryParse(row) != null) tryParse(row)!];
  }
}

/// A cuisine of a restaurant (`cuisines: [{id, name, icon}]` on every restaurant payload).
class Cuisine {
  const Cuisine({required this.id, required this.name, this.icon = 'restaurant'});

  final String id;
  final String name;
  final String icon;

  static Cuisine? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final name = raw['name'];
    if (name is! String || name.trim().isEmpty) return null;
    final id = raw['id'];
    final icon = raw['icon'];
    return Cuisine(
      id: id is String ? id : '',
      name: name.trim(),
      icon: icon is String && icon.trim().isNotEmpty ? icon.trim().toLowerCase() : 'restaurant',
    );
  }

  static List<Cuisine> parseList(Object? raw) {
    if (raw is! List) return const [];
    return [for (final row in raw) if (tryParse(row) != null) tryParse(row)!];
  }
}
