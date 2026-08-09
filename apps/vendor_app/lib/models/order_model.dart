enum OrderStatus {
  placed,
  accepted,
  preparing,
  readyForPickup,
  pickedUp,
  arrivedAtGate,
  delivered,
  cancelled
}

class OrderItem {
  final String name;
  final int quantity;
  final double unitPrice;
  bool isPrepared;

  OrderItem({
    required this.name,
    required this.quantity,
    required this.unitPrice,
    this.isPrepared = false,
  });

  double get totalPrice => quantity * unitPrice;
}

class OrderModel {
  final String id;
  final String studentName;
  final String studentLocation;
  final List<OrderItem> items;
  final double totalAmount;
  int prepTimeMinutes;
  final DateTime createdAt;
  final String? customerNote;
  OrderStatus status;

  OrderModel({
    required this.id,
    required this.studentName,
    required this.studentLocation,
    required this.items,
    required this.totalAmount,
    this.prepTimeMinutes = 15,
    required this.createdAt,
    this.customerNote,
    this.status = OrderStatus.preparing,
  });

  // Calculate target preparation deadline time
  DateTime get targetCompletionTime => createdAt.add(Duration(minutes: prepTimeMinutes));

  // Remaining duration for countdown timer
  Duration get remainingDuration => targetCompletionTime.difference(DateTime.now());

  bool get isAllItemsPrepared => items.isEmpty || items.every((item) => item.isPrepared);
}
