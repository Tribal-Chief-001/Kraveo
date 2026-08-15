import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../config/api_config.dart';
import '../models/order.dart';
import '../services/customer_api_service.dart';
import 'cart_provider.dart';
import 'dhaba_provider.dart';

class OrderProvider with ChangeNotifier {
  OrderModel? _activeOrder;
  final List<OrderModel> _orderHistory = [
    OrderModel(
      id: 'ORD-98421',
      dhabaId: 'ven-1',
      dhabaName: 'Sharma Highway Dhaba',
      items: [],
      subtotal: 270.0,
      discount: 50.0,
      deliveryFee: 25.0,
      taxAndPackaging: 15.0,
      totalAmount: 260.0,
      hostel: 'Block 2',
      deliveryNote: 'Call on reaching Gate 1',
      paymentMethod: 'PhonePe UPI',
      status: OrderProgressStatus.delivered,
      otpCode: '3184',
      createdAt: DateTime.now().subtract(const Duration(days: 1, hours: 2)),
    ),
    OrderModel(
      id: 'ORD-97104',
      dhabaId: 'ven-2',
      dhabaName: 'FC Night Mess',
      items: [],
      subtotal: 180.0,
      discount: 0.0,
      deliveryFee: 15.0,
      taxAndPackaging: 15.0,
      totalAmount: 210.0,
      hostel: 'Block 1',
      deliveryNote: 'Leave at security table',
      paymentMethod: 'Google Pay UPI',
      status: OrderProgressStatus.delivered,
      otpCode: '9012',
      createdAt: DateTime.now().subtract(const Duration(days: 3, hours: 5)),
    ),
  ];

  Timer? _statusTimer;

  OrderModel? get activeOrder => _activeOrder;
  List<OrderModel> get orderHistory => List.unmodifiable(_orderHistory);

  OrderModel placeOrder({
    required CartProvider cart,
    required String hostel,
    required String deliveryNote,
    required String paymentMethod,
  }) {
    final random = Random();
    final otp = (1000 + random.nextInt(9000)).toString();
    final orderId = 'ORD-${10000 + random.nextInt(90000)}';

    final order = OrderModel(
      id: orderId,
      dhabaId: cart.dhabaId ?? 'ven-1',
      dhabaName: cart.dhabaName ?? 'Sharma Highway Dhaba',
      items: List.from(cart.items),
      subtotal: cart.subtotal,
      discount: cart.couponDiscountAmount,
      deliveryFee: cart.deliveryFee,
      taxAndPackaging: cart.taxAndPackaging,
      totalAmount: cart.grandTotal,
      hostel: hostel,
      deliveryNote: deliveryNote,
      paymentMethod: paymentMethod,
      status: OrderProgressStatus.placed,
      otpCode: otp,
      createdAt: DateTime.now(),
    );

    _activeOrder = order;
    _orderHistory.insert(0, order);

    // Consume redeemed coins if applied
    cart.consumeRedeemedCoins();
    cart.clearCart();

    // Async sync to AWS EC2 backend API
    CustomerApiService.placeOrder(order.toJson());

    _connectToOrderSocket(order.id);
    _startSimulatedProgression();
    notifyListeners();
    return order;
  }

  void _connectToOrderSocket(String orderId) {
    try {
      final socket = IO.io(
        ApiConfig.baseUrl,
        IO.OptionBuilder()
            .setTransports(['websocket', 'polling'])
            .disableAutoConnect()
            .build(),
      );

      socket.connect();

      socket.onConnect((_) {
        debugPrint('🌐 [Customer Socket] Connected. Joining order_$orderId');
        socket.emit('join_room', 'order_$orderId');
      });

      socket.on('order_updated', (data) {
        debugPrint('🔔 [Customer Socket] Order update received: $data');
        if (data is Map && _activeOrder != null) {
          final newStatus = data['status']?.toString().toUpperCase();
          if (newStatus != null) {
            _updateStatusFromBackend(newStatus, data['otpCode']?.toString());
          }
        }
      });
    } catch (e) {
      debugPrint('⚠️ [Customer Socket Notice] Socket connection delayed ($e).');
    }
  }

  void _updateStatusFromBackend(String statusStr, String? serverOtp) {
    if (_activeOrder == null) return;
    _statusTimer?.cancel();

    switch (statusStr) {
      case 'PLACED':
        _activeOrder!.status = OrderProgressStatus.placed;
        break;
      case 'ACCEPTED':
      case 'PREPARING':
        _activeOrder!.status = OrderProgressStatus.preparing;
        break;
      case 'READY_FOR_PICKUP':
      case 'PICKED_UP':
        _activeOrder!.status = OrderProgressStatus.pickedUp;
        break;
      case 'IN_TRANSIT':
        _activeOrder!.status = OrderProgressStatus.onTheWay;
        break;
      case 'ARRIVED_AT_GATE':
      case 'ARRIVED':
        _activeOrder!.status = OrderProgressStatus.arrivedAtGate;
        if (serverOtp != null && serverOtp.isNotEmpty) {
          _activeOrder!.otpCode = serverOtp;
        }
        break;
      case 'DELIVERED':
        _activeOrder!.status = OrderProgressStatus.delivered;
        break;
      case 'CANCELLED':
        _activeOrder!.status = OrderProgressStatus.cancelled;
        break;
    }
    notifyListeners();
  }

  void _startSimulatedProgression() {
    _statusTimer?.cancel();
    _statusTimer = Timer.periodic(const Duration(seconds: 12), (timer) {
      if (_activeOrder == null) {
        timer.cancel();
        return;
      }
      switch (_activeOrder!.status) {
        case OrderProgressStatus.placed:
          _activeOrder!.status = OrderProgressStatus.preparing;
          notifyListeners();
          break;
        case OrderProgressStatus.preparing:
          _activeOrder!.status = OrderProgressStatus.pickedUp;
          notifyListeners();
          break;
        case OrderProgressStatus.pickedUp:
          _activeOrder!.status = OrderProgressStatus.onTheWay;
          notifyListeners();
          break;
        case OrderProgressStatus.onTheWay:
          _activeOrder!.status = OrderProgressStatus.arrivedAtGate;
          notifyListeners();
          timer.cancel();
          break;
        case OrderProgressStatus.arrivedAtGate:
        case OrderProgressStatus.delivered:
        case OrderProgressStatus.cancelled:
          timer.cancel();
          break;
      }
    });
  }

  void advanceActiveOrderStatus() {
    if (_activeOrder == null) return;
    switch (_activeOrder!.status) {
      case OrderProgressStatus.placed:
        _activeOrder!.status = OrderProgressStatus.preparing;
        break;
      case OrderProgressStatus.preparing:
        _activeOrder!.status = OrderProgressStatus.pickedUp;
        break;
      case OrderProgressStatus.pickedUp:
        _activeOrder!.status = OrderProgressStatus.onTheWay;
        break;
      case OrderProgressStatus.onTheWay:
        _activeOrder!.status = OrderProgressStatus.arrivedAtGate;
        break;
      case OrderProgressStatus.arrivedAtGate:
        _activeOrder!.status = OrderProgressStatus.delivered;
        break;
      case OrderProgressStatus.delivered:
      case OrderProgressStatus.cancelled:
        break;
    }
    notifyListeners();
  }

  bool verifyGateHandshakeOtp(String enteredOtp) {
    if (_activeOrder == null) return false;
    if (_activeOrder!.otpCode == enteredOtp.trim()) {
      _activeOrder!.status = OrderProgressStatus.delivered;
      notifyListeners();
      return true;
    }
    return false;
  }

  void reorder(OrderModel pastOrder, CartProvider cart, DhabaProvider dhabaProvider) {
    cart.clearCart();
    final items = dhabaProvider.getMenuItemsForDhaba(pastOrder.dhabaId);
    if (items.isNotEmpty) {
      for (final pastCartItem in pastOrder.items) {
        final currentMenuItem = items.firstWhere(
          (i) => i.id == pastCartItem.item.id,
          orElse: () => items.first,
        );
        for (int i = 0; i < pastCartItem.quantity; i++) {
          cart.addItem(
            item: currentMenuItem,
            dhabaId: pastOrder.dhabaId,
            dhabaName: pastOrder.dhabaName,
            selectedOptions: pastCartItem.selectedOptions,
          );
        }
      }
    }
  }

  @override
  void dispose() {
    _statusTimer?.cancel();
    super.dispose();
  }
}
