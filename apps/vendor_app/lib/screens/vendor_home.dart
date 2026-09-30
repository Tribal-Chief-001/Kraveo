import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:wakelock_plus/wakelock_plus.dart';
import '../config/api_config.dart';
import '../services/permission_service.dart';
import '../services/vendor_api_service.dart';
import '../services/order_queue_service.dart';
import '../session/session_controller.dart';
import '../models/partner_session.dart';
import '../models/order_model.dart';
import '../models/dish_model.dart';
import 'kitchen_queue.dart';
import 'stock_manager.dart';
import 'sales_analytics.dart';
import '../widgets/ui/ui.dart';

class VendorHomeScreen extends StatefulWidget {
  const VendorHomeScreen({super.key});

  @override
  State<VendorHomeScreen> createState() => _VendorHomeScreenState();
}

class _VendorHomeScreenState extends State<VendorHomeScreen> {
  int _currentIndex = 0;
  bool isStoreOpen = true;
  IO.Socket? _socket;
  final String vendorId = 'ven-1';

  // Master State for Kitchen Orders
  late List<OrderModel> _orders;

  // Master State for Menu Stock
  late List<DishModel> _dishes;

  @override
  void initState() {
    super.initState();
    _initSampleData();
    PermissionService.requestVendorPermissions();
    _enableScreenWakeLock();
    _initWebSocket();
    _fetchBackendOrders();
  }

  @override
  void dispose() {
    _socket?.disconnect();
    _socket?.dispose();
    super.dispose();
  }

  Future<void> _enableScreenWakeLock() async {
    try {
      await WakelockPlus.enable();
    } catch (_) {}
  }

  void _initWebSocket() {
    try {
      _socket = IO.io(
        ApiConfig.baseUrl,
        IO.OptionBuilder()
            .setTransports(['websocket', 'polling'])
            .disableAutoConnect()
            .build(),
      );

      _socket?.connect();

      _socket?.onConnect((_) {
        debugPrint('🌐 [Vendor Socket] Connected to backend. Joining vendor_$vendorId');
        _socket?.emit('join_room', 'vendor_$vendorId');
      });

      _socket?.on('new_order_alert', (data) {
        debugPrint('🚨 [Vendor Socket] Real-time new order alert received: $data');
        if (data is Map && isStoreOpen) {
          _handleIncomingBackendOrder(data);
        }
      });
    } catch (e) {
      debugPrint('⚠️ [Vendor Socket Notice] Connection delayed ($e).');
    }
  }

  Future<void> _fetchBackendOrders() async {
    try {
      final backendOrders = await VendorApiService.fetchIncomingOrders(vendorId);
      if (backendOrders.isNotEmpty && mounted) {
        debugPrint('📦 [Vendor App] Loaded ${backendOrders.length} orders from backend.');
      }
    } catch (_) {}
  }

  void _handleIncomingBackendOrder(Map<dynamic, dynamic> data) {
    if (!mounted) return;
    try {
      final id = data['id']?.toString() ?? 'ord-new';
      final total = (data['totalAmount'] as num?)?.toDouble() ?? 250.0;
      final student = data['customer']?['name']?.toString() ?? 'VIT Student';
      final location = data['customer']?['hostelBlock']?.toString() ?? 'Hostel Gate';

      final itemsRaw = data['items'] as List<dynamic>? ?? [];
      final parsedItems = itemsRaw.map((it) {
        return OrderItem(
          name: it['name']?.toString() ?? 'Dish',
          quantity: (it['quantity'] as num?)?.toInt() ?? 1,
          unitPrice: (it['price'] as num?)?.toDouble() ?? 100.0,
        );
      }).toList();

      final newOrder = OrderModel(
        id: '#$id',
        studentName: student,
        studentLocation: location,
        items: parsedItems.isNotEmpty
            ? parsedItems
            : [OrderItem(name: 'Dhaba Thali', quantity: 1, unitPrice: total)],
        totalAmount: total,
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
            _currentIndex = 0;
          });
          VendorApiService.updateOrderStatus(acceptedOrder.id, 'PREPARING');
        },
      );
    } catch (e) {
      debugPrint('⚠️ [Vendor App Error] Error handling incoming order: $e');
    }
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
          content: Text('Store is CLOSED. Open the store to get orders.  ·  दुकान बंद है, पहले खोलें'),
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
            content: Text('Order ${acceptedOrder.id} accepted!  ·  किचन में जुड़ गया'),
            duration: const Duration(seconds: 4),
          ),
        );
      },
    );
  }

  /// Opening is instant (it is always safe). Closing asks first, because a mis-tap would
  /// silently stop new orders in the middle of a rush.
  Future<void> _toggleStoreStatusWithConfirmation(bool newValue) async {
    if (!newValue) {
      final confirmed = await showConfirmSheet(
        context,
        icon: LucideIcons.powerOff,
        title: 'Close the store?',
        hindiTitle: 'दुकान बंद करें?',
        message: 'You will stop getting new orders until you open again.\nनए ऑर्डर आना बंद हो जाएंगे।',
        safeLabel: 'Keep open',
        safeSublabel: 'खुला रखें',
        confirmLabel: 'Yes, close store',
        confirmSublabel: 'हाँ, बंद करें',
      );
      if (!confirmed || !mounted) return;
    }

    setState(() => isStoreOpen = newValue);

    // Sync status to backend
    VendorApiService.toggleStoreStatus('ven-1', isStoreOpen);

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(isStoreOpen ? 'Store is now OPEN for orders  ·  दुकान खुली' : 'Store is now CLOSED  ·  दुकान बंद'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  void _callCampusAdminSupport() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            Icon(LucideIcons.phone, color: context.k.onBrand),
            const SizedBox(width: 10),
            const Expanded(child: Text('Kraveo Campus Ops helpline: +91 98765 43214')),
          ],
        ),
        duration: const Duration(seconds: 4),
      ),
    );
  }

  /// Asks first (a mis-tap would stop order alerts on this phone), then signs out. The session
  /// gate swaps to the login screen once the controller reports signed-out.
  Future<void> _confirmLogout() async {
    final controller = SessionScope.maybeOf(context);
    if (controller == null) return;
    final confirmed = await showConfirmSheet(
      context,
      icon: LucideIcons.logOut,
      title: 'Log out?',
      hindiTitle: 'लॉग आउट करें?',
      message: 'You will not get new order alerts on this phone until you log in again.\nदोबारा लॉग इन करने तक इस फ़ोन पर नए ऑर्डर नहीं आएंगे।',
      safeLabel: 'Stay logged in',
      safeSublabel: 'लॉग इन रहें',
      confirmLabel: 'Yes, log out',
      confirmSublabel: 'हाँ, लॉग आउट',
    );
    if (!confirmed || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Logging out…  ·  लॉग आउट हो रहा है'), duration: Duration(seconds: 6)));
    await controller.logout();
    messenger.hideCurrentSnackBar();
  }

  void _openHelpSheet() {
    final partner = SessionScope.maybeOf(context)?.session;
    showKSheet<void>(
      context,
      builder: (sheetContext) {
        final k = sheetContext.k;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Need help?', style: KraveoType.headline.copyWith(color: k.ink)),
            Text('मदद चाहिए?', style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
            const SizedBox(height: 16),
            KCard(
              color: k.brandSoft,
              elevated: false,
              child: Row(children: [
                Icon(LucideIcons.headset, size: 30, color: k.brand),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Kraveo Campus Ops', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                    FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text('+91 98765 43214', style: KraveoType.headlineSm.copyWith(color: k.ink))),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 16),
            KButton(
              label: 'Call helpline',
              sublabel: 'मदद के लिए फ़ोन',
              icon: LucideIcons.phoneCall,
              large: true,
              onPressed: () {
                Navigator.of(sheetContext).pop();
                _callCampusAdminSupport();
              },
            ),
            const SizedBox(height: 12),
            KButton(
              label: 'Test the order alarm',
              sublabel: 'अलार्म जाँचें',
              icon: LucideIcons.bellRing,
              kind: KButtonKind.tonal,
              large: true,
              onPressed: () {
                Navigator.of(sheetContext).pop();
                _triggerIncomingOrderAlert();
              },
            ),
            if (partner != null) ...[
              const SizedBox(height: 20),
              _AccountCard(partner: partner),
              const SizedBox(height: 12),
              KButton(
                key: const ValueKey('logout-button'),
                label: 'Log out',
                sublabel: 'लॉग आउट',
                icon: LucideIcons.logOut,
                kind: KButtonKind.ghost,
                large: true,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  _confirmLogout();
                },
              ),
            ],
          ]),
        );
      },
    );
  }

  /// Owner name under the restaurant name (or the phone when the account is named after it).
  static String _headerSubtitle(PartnerSession? partner) {
    if (partner == null) return 'Kraveo Restaurant Partner';
    final owner = partner.name.trim();
    if (owner.isNotEmpty && owner != partner.restaurantName) return owner;
    return (partner.phone?.trim().isNotEmpty ?? false) ? partner.phone! : 'Kraveo Restaurant Partner';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final partner = SessionScope.maybeOf(context)?.session;
    final activeCount = _orders.where((o) => o.status == OrderStatus.preparing || o.status == OrderStatus.readyForPickup).length;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Top bar: which store + help
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 6, 12, 0),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: k.brand, borderRadius: BorderRadius.circular(KRadius.md)),
                    child: Icon(LucideIcons.store, color: k.onBrand, size: 24),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(partner?.restaurantName ?? 'Your restaurant', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
                        Text(_headerSubtitle(partner), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                      ],
                    ),
                  ),
                  Semantics(
                    button: true,
                    label: 'Help and support',
                    excludeSemantics: true,
                    child: KPressable(
                      onTap: _openHelpSheet,
                      child: Container(
                        width: 52,
                        height: 52,
                        decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
                        child: Icon(LucideIcons.headset, size: 26, color: k.brand),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),

            // The store OPEN / CLOSED control - always visible
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: VMaxWidth(
                child: VStoreStatusHero(
                  isOpen: isStoreOpen,
                  onTap: () => _toggleStoreStatusWithConfirmation(!isStoreOpen),
                ),
              ),
            ),

            Expanded(
              child: IndexedStack(
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
            ),
          ],
        ),
      ),
      bottomNavigationBar: VBigNav(
        index: _currentIndex,
        onChanged: (index) => setState(() => _currentIndex = index),
        items: [
          VNavItem(icon: LucideIcons.chefHat, label: 'Orders', hindi: 'ऑर्डर', badge: activeCount),
          const VNavItem(icon: LucideIcons.utensils, label: 'Menu', hindi: 'मेनू'),
          const VNavItem(icon: LucideIcons.wallet, label: 'Earnings', hindi: 'कमाई'),
        ],
      ),
    );
  }
}

/// "Logged in as" card inside the help sheet: who is signed in on this phone.
class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.partner});

  final PartnerSession partner;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final phone = partner.phone?.trim() ?? '';
    return KCard(
      elevated: false,
      child: Row(children: [
        KAvatar(id: partner.avatarId, size: 48),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Logged in as · लॉग इन', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
            Text(partner.restaurantName, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
            if (phone.isNotEmpty) Text(phone, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          ]),
        ),
      ]),
    );
  }
}
