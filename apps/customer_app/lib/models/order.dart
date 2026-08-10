import 'cart_item.dart';

enum OrderProgressStatus {
  placed,
  preparing,
  pickedUp,
  onTheWay,
  arrivedAtGate,
  delivered,
  cancelled,
}

extension OrderProgressStatusX on OrderProgressStatus {
  String get displayName {
    switch (this) {
      case OrderProgressStatus.placed:
        return 'Order Placed';
      case OrderProgressStatus.preparing:
        return 'Preparing Dish';
      case OrderProgressStatus.pickedUp:
        return 'Runner Picked Up';
      case OrderProgressStatus.onTheWay:
        return 'On The Way to Gate';
      case OrderProgressStatus.arrivedAtGate:
        return 'Arrived at Gate';
      case OrderProgressStatus.delivered:
        return 'Delivered';
      case OrderProgressStatus.cancelled:
        return 'Cancelled';
    }
  }

  double get progressValue {
    switch (this) {
      case OrderProgressStatus.placed:
        return 0.15;
      case OrderProgressStatus.preparing:
        return 0.40;
      case OrderProgressStatus.pickedUp:
        return 0.65;
      case OrderProgressStatus.onTheWay:
        return 0.85;
      case OrderProgressStatus.arrivedAtGate:
        return 0.95;
      case OrderProgressStatus.delivered:
        return 1.0;
      case OrderProgressStatus.cancelled:
        return 0.0;
    }
  }
}

class OrderModel {
  final String id;
  final String dhabaId;
  final String dhabaName;
  final List<CartItem> items;
  final double subtotal;
  final double discount;
  final double deliveryFee;
  final double taxAndPackaging;
  final double totalAmount;
  final String hostel;
  final String deliveryNote;
  final String paymentMethod;
  OrderProgressStatus status;
  final String otpCode;
  final DateTime createdAt;
  final String riderName;
  final String riderPhone;
  final String riderVehicle;

  OrderModel({
    required this.id,
    required this.dhabaId,
    required this.dhabaName,
    required this.items,
    required this.subtotal,
    required this.discount,
    required this.deliveryFee,
    required this.taxAndPackaging,
    required this.totalAmount,
    required this.hostel,
    required this.deliveryNote,
    required this.paymentMethod,
    required this.status,
    required this.otpCode,
    required this.createdAt,
    this.riderName = 'Vikram Singh',
    this.riderPhone = '+91 98765 43210',
    this.riderVehicle = 'Hero Splendor (MP-04-KV-8821)',
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'dhabaId': dhabaId,
      'dhabaName': dhabaName,
      'subtotal': subtotal,
      'discount': discount,
      'deliveryFee': deliveryFee,
      'taxAndPackaging': taxAndPackaging,
      'totalAmount': totalAmount,
      'hostel': hostel,
      'deliveryNote': deliveryNote,
      'paymentMethod': paymentMethod,
      'status': status.name,
      'otpCode': otpCode,
      'createdAt': createdAt.toIso8601String(),
    };
  }

  factory OrderModel.fromJson(Map<String, dynamic> json) {
    return OrderModel(
      id: json['id'] ?? '',
      dhabaId: json['dhabaId'] ?? '',
      dhabaName: json['dhabaName'] ?? '',
      items: const [],
      subtotal: (json['subtotal'] ?? 0.0).toDouble(),
      discount: (json['discount'] ?? 0.0).toDouble(),
      deliveryFee: (json['deliveryFee'] ?? 0.0).toDouble(),
      taxAndPackaging: (json['taxAndPackaging'] ?? 0.0).toDouble(),
      totalAmount: (json['totalAmount'] ?? 0.0).toDouble(),
      hostel: json['hostel'] ?? '',
      deliveryNote: json['deliveryNote'] ?? '',
      paymentMethod: json['paymentMethod'] ?? 'UPI',
      status: OrderProgressStatus.values.firstWhere(
        (s) => s.name == json['status'],
        orElse: () => OrderProgressStatus.placed,
      ),
      otpCode: json['otpCode'] ?? '1234',
      createdAt: json['createdAt'] != null
          ? DateTime.parse(json['createdAt'])
          : DateTime.now(),
    );
  }
}

