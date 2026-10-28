import 'customization.dart';

class MenuItemModel {
  final String id;
  final String vendorId;
  final String name;
  final double price;
  final String category;
  final String description;
  final String imageUrl;
  final bool isAvailable;
  final bool isVeg;

  /// Position in the restaurant's own menu order (Docs/26 section 3); 0 = unordered legacy dish.
  final int sortOrder;
  final List<CustomizationGroup> customizationGroups;

  const MenuItemModel({
    required this.id,
    required this.vendorId,
    required this.name,
    required this.price,
    required this.category,
    required this.description,
    required this.imageUrl,
    required this.isAvailable,
    this.isVeg = true,
    this.sortOrder = 0,
    this.customizationGroups = const [],
  });

  bool get hasCustomizations => customizationGroups.isNotEmpty;

  factory MenuItemModel.fromJson(Map<String, dynamic> json) {
    return MenuItemModel(
      id: json['id'] ?? '',
      vendorId: json['vendorId'] ?? '',
      name: json['name'] ?? '',
      price: (json['price'] ?? 0).toDouble(),
      category: json['category'] ?? '',
      description: json['description'] ?? '',
      imageUrl: json['imageUrl'] ?? '',
      isAvailable: json['isAvailable'] ?? true,
      isVeg: json['isVeg'] ?? true,
      sortOrder: _parseSortOrder(json['sortOrder']),
      customizationGroups: (json['customizationGroups'] as List<dynamic>?)
              ?.map((cg) => CustomizationGroup.fromJson(cg as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}

/// Missing, garbled, fractional-garbage or negative values mean 0 (unordered).
int _parseSortOrder(Object? raw) {
  final n = raw is num && raw.isFinite ? raw.toInt() : (raw is String ? int.tryParse(raw.trim()) ?? 0 : 0);
  return n > 0 ? n : 0;
}

/// True when the restaurant has set its own menu order (any dish with a positive sortOrder).
bool hasMenuOrder(List<MenuItemModel> items) => items.any((i) => i.sortOrder > 0);

/// The dishes in the restaurant's menu order: positive sortOrder ascending, then the unordered
/// ones (0), each group keeping the server's order for ties. With no positive sortOrder the list
/// is returned unchanged.
List<MenuItemModel> menuOrdered(List<MenuItemModel> items) {
  if (!hasMenuOrder(items)) return items;
  final indexed = [for (var i = 0; i < items.length; i++) (i, items[i])];
  indexed.sort((a, b) {
    final x = a.$2.sortOrder, y = b.$2.sortOrder;
    if (x != y) return x == 0 ? 1 : (y == 0 ? -1 : x.compareTo(y));
    return a.$1.compareTo(b.$1);
  });
  return [for (final e in indexed) e.$2];
}

/// Category key used to merge spellings that differ only by case or surrounding spaces.
String menuCategoryKey(String category) => category.trim().toLowerCase();

/// Category tabs of an ordered menu: each category at its first dish; the first spelling wins.
List<String> menuOrderedCategories(List<MenuItemModel> ordered) {
  final seen = <String>{};
  return [for (final i in ordered) if (seen.add(menuCategoryKey(i.category))) i.category];
}
