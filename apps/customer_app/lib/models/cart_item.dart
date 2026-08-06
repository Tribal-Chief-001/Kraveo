import 'menu_item.dart';
import 'customization.dart';

class CartItem {
  final String cartItemId;
  final MenuItemModel item;
  int quantity;
  final List<CustomizationOption> selectedOptions;
  final String? specialInstructions;

  CartItem({
    required this.cartItemId,
    required this.item,
    this.quantity = 1,
    this.selectedOptions = const [],
    this.specialInstructions,
  });

  double get unitPrice {
    double total = item.price;
    for (final opt in selectedOptions) {
      total += opt.price;
    }
    return total;
  }

  double get totalPrice => unitPrice * quantity;

  String get customizationSummary {
    if (selectedOptions.isEmpty) return '';
    return selectedOptions.map((o) => o.name).join(', ');
  }

  CartItem copyWith({
    int? quantity,
    List<CustomizationOption>? selectedOptions,
    String? specialInstructions,
  }) {
    return CartItem(
      cartItemId: cartItemId,
      item: item,
      quantity: quantity ?? this.quantity,
      selectedOptions: selectedOptions ?? this.selectedOptions,
      specialInstructions: specialInstructions ?? this.specialInstructions,
    );
  }
}
