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
}
