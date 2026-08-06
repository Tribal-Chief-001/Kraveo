class CustomizationOption {
  final String id;
  final String name;
  final double price;

  const CustomizationOption({
    required this.id,
    required this.name,
    required this.price,
  });

  factory CustomizationOption.fromJson(Map<String, dynamic> json) {
    return CustomizationOption(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      price: (json['price'] ?? 0).toDouble(),
    );
  }
}

class CustomizationGroup {
  final String id;
  final String title;
  final bool isRequired;
  final int maxSelection;
  final List<CustomizationOption> options;

  const CustomizationGroup({
    required this.id,
    required this.title,
    required this.isRequired,
    this.maxSelection = 1,
    required this.options,
  });

  factory CustomizationGroup.fromJson(Map<String, dynamic> json) {
    return CustomizationGroup(
      id: json['id'] ?? '',
      title: json['title'] ?? '',
      isRequired: json['isRequired'] ?? false,
      maxSelection: json['maxSelection'] ?? 1,
      options: (json['options'] as List<dynamic>?)
              ?.map((o) => CustomizationOption.fromJson(o as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}
