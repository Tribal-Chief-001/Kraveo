class DishModel {
  final String id;
  String name;
  String category;
  double price;
  bool inStock;
  String? imageUrl;

  DishModel({
    required this.id,
    required this.name,
    required this.category,
    required this.price,
    this.inStock = true,
    this.imageUrl,
  });

  /// Parses a menu item from `GET /menus/:vendorId` or `POST /vendors/:id/items`.
  static DishModel? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString() ?? '';
    final name = raw['name']?.toString().trim() ?? '';
    if (id.isEmpty || name.isEmpty) return null;
    final price = raw['price'];
    final category = raw['category']?.toString().trim() ?? '';
    final image = raw['imageUrl']?.toString().trim() ?? '';
    return DishModel(
      id: id,
      name: name,
      category: category.isEmpty ? 'Other' : category,
      price: price is num ? price.toDouble() : (double.tryParse(price?.toString() ?? '') ?? 0),
      inStock: raw['isAvailable'] is bool ? raw['isAvailable'] as bool : true,
      imageUrl: image.isEmpty ? null : image,
    );
  }
}
