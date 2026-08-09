import 'package:flutter/material.dart';
import '../services/audio_alert_service.dart';
import '../services/permission_service.dart';
import '../services/vendor_api_service.dart';
import '../services/order_queue_service.dart';
import '../models/order_model.dart';
import '../models/dish_model.dart';
import 'kitchen_queue.dart';
import 'stock_manager.dart';
import 'sales_analytics.dart';

class VendorHomeScreen extends StatefulWidget {
  const VendorHomeScreen({super.key});

  @override
  State<VendorHomeScreen> createState() => _VendorHomeScreenState();
}

class _VendorHomeScreenState extends State<VendorHomeScreen> {
  int _currentIndex = 0;
  bool isStoreOpen = true;

  // Master State for Kitchen Orders
  late List<OrderModel> _orders;

  // Master State for Menu Stock
  late List<DishModel> _dishes;

  @override
  void initState() {
    super.initState();
    _initSampleData();
    PermissionService.requestVendorPermissions();
  }

  void _initSampleData() {
    _orders = [
      OrderModel(
        id: '#ord-8492',
        studentName: 'Rahul Sharma',
        studentLocation: 'Hostel Block A, R-304',
        items: [
          OrderItem(name: 'Paneer Butter Masala', quantity: 1, unitPrice: 180),
          OrderItem(name: 'Tandoori Roti', quantity: 4, unitPrice: 15),
          OrderItem(name: 'Mango Lassi', quantity: 2, unitPrice: 60),
        ],
        totalAmount: 360,
        prepTimeMinutes: 15,
        createdAt: DateTime.now().subtract(const Duration(minutes: 4)),
        customerNote: 'Make it extra spicy please!',
        status: OrderStatus.preparing,
      ),
      OrderModel(
        id: '#ord-8493',
        studentName: 'Ananya Verma',
        studentLocation: 'Girls Gate 1, Block C',
        items: [
          OrderItem(name: 'Cheese Butter Maggi', quantity: 2, unitPrice: 90),
          OrderItem(name: 'Paneer Sandwich', quantity: 1, unitPrice: 110),
        ],
        totalAmount: 290,
        prepTimeMinutes: 10,
        createdAt: DateTime.now().subtract(const Duration(minutes: 2)),
        customerNote: 'No onions in sandwich',
        status: OrderStatus.preparing,
      ),
      OrderModel(
        id: '#ord-8494',
        studentName: 'Vikram Patel',
        studentLocation: 'Hostel Block B, R-102',
        items: [
          OrderItem(name: 'Paneer Butter Masala', quantity: 2, unitPrice: 180),
          OrderItem(name: 'Tandoori Roti', quantity: 8, unitPrice: 15),
        ],
        totalAmount: 480,
        prepTimeMinutes: 20,
        createdAt: DateTime.now().subtract(const Duration(minutes: 18)),
        status: OrderStatus.readyForPickup,
      ),
    ];

    _dishes = [
      DishModel(id: 'd1', name: 'Paneer Butter Masala', category: 'Main Course', price: 180, inStock: true),
      DishModel(id: 'd2', name: 'Tandoori Roti', category: 'Breads', price: 15, inStock: true),
      DishModel(id: 'd3', name: 'Mango Lassi', category: 'Beverages', price: 60, inStock: false),
      DishModel(id: 'd4', name: 'Cheese Butter Maggi', category: 'Snacks', price: 90, inStock: true),
      DishModel(id: 'd5', name: 'Paneer Sandwich', category: 'Snacks', price: 110, inStock: true),
      DishModel(id: 'd6', name: 'Chicken Biryani', category: 'Main Course', price: 220, inStock: true),
      DishModel(id: 'd7', name: 'Cold Coffee', category: 'Beverages', price: 70, inStock: true),
    ];
  }

  void _triggerIncomingOrderAlert() {
    if (!isStoreOpen) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('🔴 Store is CLOSED. Open store to accept incoming orders.'),
          backgroundColor: Color(0xFFBA1A1A),
        ),
      );
      return;
    }

    final newOrder = OrderModel(
      id: '#ord-${(DateTime.now().millisecondsSinceEpoch % 10000).toString().padLeft(4, '0')}',
      studentName: 'Siddharth Roy',
      studentLocation: 'Hostel Block C, R-210',
      items: [
        OrderItem(name: 'Paneer Butter Masala', quantity: 1, unitPrice: 180),
        OrderItem(name: 'Tandoori Roti', quantity: 4, unitPrice: 15),
      ],
      totalAmount: 240,
      prepTimeMinutes: 15,
      createdAt: DateTime.now(),
      status: OrderStatus.placed,
    );

    OrderQueueService.enqueueIncomingOrder(
      context,
      newOrder,
      (acceptedOrder) {
        setState(() {
          _orders.insert(0, acceptedOrder);
          _currentIndex = 0; // Switch to Kitchen Queue tab
        });

        // Sync order status to backend API
        VendorApiService.updateOrderStatus(acceptedOrder.id.replaceAll('#', ''), 'PREPARING');

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Order ${acceptedOrder.id} Accepted! Added to Kitchen Queue.'),
            backgroundColor: const Color(0xFF00450D),
            duration: const Duration(seconds: 4),
          ),
        );
      },
    );
  }

  void _toggleStoreStatusWithConfirmation(bool newValue) {
    showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text(
          newValue ? 'Open Store? / दुकान चालू करें?' : 'Close Store? / दुकान बंद करें?',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
        ),
        content: Text(
          newValue
              ? 'Are you sure you want to open Sharma Dhaba for new campus orders?'
              : 'Are you sure you want to pause incoming orders for Sharma Dhaba?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx),
            child: const Text('CANCEL', style: TextStyle(color: Colors.grey, fontWeight: FontWeight.bold)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: newValue ? const Color(0xFF00450D) : const Color(0xFFBA1A1A),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () {
              Navigator.pop(dialogCtx);
              setState(() => isStoreOpen = newValue);

              // Sync status to backend
              VendorApiService.toggleStoreStatus('ven-1', isStoreOpen);

              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(isStoreOpen ? '🟢 Store is now OPEN for orders' : '🔴 Store is now CLOSED'),
                  duration: const Duration(seconds: 2),
                ),
              );
            },
            child: Text(
              newValue ? 'CONFIRM OPEN' : 'CONFIRM CLOSE',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }

  void _callCampusAdminSupport() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Row(
          children: [
            Icon(Icons.phone_in_talk, color: Color(0xFFFDD400)),
            SizedBox(width: 10),
            Text('Calling Kraveo Campus Ops Helpline: +91 98765 43214', style: TextStyle(fontWeight: FontWeight.bold)),
          ],
        ),
        backgroundColor: Color(0xFF00450D),
        duration: Duration(seconds: 4),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final activeCount = _orders.where((o) => o.status == OrderStatus.preparing || o.status == OrderStatus.readyForPickup).length;

    return Scaffold(
      backgroundColor: const Color(0xFFFCF9F8),
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0.5,
        title: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF00450D),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.storefront, color: Color(0xFFFDD400), size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: const [
                  Text(
                    'FC Night Mess',
                    style: TextStyle(fontWeight: FontWeight.w900, fontSize: 17, color: Color(0xFF1B1C1C)),
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    'Sharma Dhaba • Campus Hub',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Colors.grey),
                  ),
                ],
              ),
            ),

            // Master Store OPEN / CLOSED Switch with Confirmation Guard
            Row(
              children: [
                Switch(
                  value: isStoreOpen,
                  activeThumbColor: const Color(0xFF00450D),
                  onChanged: _toggleStoreStatusWithConfirmation,
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: isStoreOpen ? const Color(0xFFE2F7E4) : const Color(0xFFFFDAD6),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: isStoreOpen ? const Color(0xFF00450D) : const Color(0xFFBA1A1A),
                    ),
                  ),
                  child: Text(
                    isStoreOpen ? 'OPEN / चालू' : 'CLOSED / बंद',
                    style: TextStyle(
                      color: isStoreOpen ? const Color(0xFF00450D) : const Color(0xFFBA1A1A),
                      fontWeight: FontWeight.w900,
                      fontSize: 10,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.headset_mic_rounded, color: Color(0xFF00450D)),
                  tooltip: 'Call Kraveo Campus Ops Support',
                  onPressed: _callCampusAdminSupport,
                ),
              ],
            ),
          ],
        ),
      ),
      body: IndexedStack(
        index: _currentIndex,
        children: [
          KitchenQueueScreen(
            orders: _orders,
            onOrderUpdate: () => setState(() {}),
          ),
          StockManagerScreen(
            dishes: _dishes,
            onDishListChanged: () => setState(() {}),
          ),
          SalesAnalyticsScreen(
            orders: _orders,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _triggerIncomingOrderAlert,
        backgroundColor: const Color(0xFFBA1A1A),
        icon: const Icon(Icons.ring_volume, color: Colors.white),
        label: const Text(
          'TEST INCOMING ALARM',
          style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, letterSpacing: 0.5),
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentIndex,
        selectedItemColor: const Color(0xFF00450D),
        unselectedItemColor: Colors.grey,
        selectedLabelStyle: const TextStyle(fontWeight: FontWeight.w900, fontSize: 12),
        unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
        onTap: (index) => setState(() => _currentIndex = index),
        items: [
          BottomNavigationBarItem(
            icon: Badge(
              label: Text('$activeCount'),
              isLabelVisible: activeCount > 0,
              backgroundColor: const Color(0xFFBA1A1A),
              child: const Icon(Icons.soup_kitchen),
            ),
            label: 'Kitchen Queue',
          ),
          const BottomNavigationBarItem(
            icon: Icon(Icons.inventory_2),
            label: 'Stock Manager',
          ),
          const BottomNavigationBarItem(
            icon: Icon(Icons.bar_chart_rounded),
            label: 'Daily Earnings',
          ),
        ],
      ),
    );
  }
}
