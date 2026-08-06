class Dhaba {
  final String id;
  final String name;
  final String category;
  final double rating;
  final String eta;
  final String bannerUrl;
  final bool isAcceptingOrders;
  final String address;
  final double deliveryFee;
  final double minOrder;
  final bool isFavorite;
  final List<String> tags;

  Dhaba({
    required this.id,
    required this.name,
    required this.category,
    required this.rating,
    required this.eta,
    required this.bannerUrl,
    required this.isAcceptingOrders,
    required this.address,
    this.deliveryFee = 25.0,
    this.minOrder = 99.0,
    this.isFavorite = false,
    this.tags = const [],
  });

  Dhaba copyWith({
    String? id,
    String? name,
    String? category,
    double? rating,
    String? eta,
    String? bannerUrl,
    bool? isAcceptingOrders,
    String? address,
    double? deliveryFee,
    double? minOrder,
    bool? isFavorite,
    List<String>? tags,
  }) {
    return Dhaba(
      id: id ?? this.id,
      name: name ?? this.name,
      category: category ?? this.category,
      rating: rating ?? this.rating,
      eta: eta ?? this.eta,
      bannerUrl: bannerUrl ?? this.bannerUrl,
      isAcceptingOrders: isAcceptingOrders ?? this.isAcceptingOrders,
      address: address ?? this.address,
      deliveryFee: deliveryFee ?? this.deliveryFee,
      minOrder: minOrder ?? this.minOrder,
      isFavorite: isFavorite ?? this.isFavorite,
      tags: tags ?? this.tags,
    );
  }

  factory Dhaba.fromJson(Map<String, dynamic> json) {
    return Dhaba(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      category: json['category'] ?? '',
      rating: (json['rating'] ?? 4.5).toDouble(),
      eta: json['eta'] ?? '25-30 mins',
      bannerUrl: json['bannerImage'] ?? json['bannerUrl'] ?? '',
      isAcceptingOrders: json['isAcceptingOrders'] ?? true,
      address: json['address'] ?? '',
      deliveryFee: (json['deliveryFee'] ?? 25.0).toDouble(),
      minOrder: (json['minOrder'] ?? 99.0).toDouble(),
      isFavorite: json['isFavorite'] ?? false,
      tags: (json['tags'] as List<dynamic>?)?.map((t) => t.toString()).toList() ?? [],
    );
  }
}
