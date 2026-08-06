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
      customizationGroups: (json['customizationGroups'] as List<dynamic>?)
              ?.map((cg) => CustomizationGroup.fromJson(cg as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}
