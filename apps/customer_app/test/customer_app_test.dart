import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/providers/order_provider.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/models/order.dart';
import 'package:customer_app/widgets/split_bill_modal.dart';

void main() {
  group('Customer App - CartProvider Tests', () {
    late CartProvider cart;
    late MenuItemModel dummyItem1;
    late MenuItemModel dummyItem2;

    setUp(() {
      cart = CartProvider();
      dummyItem1 = const MenuItemModel(
        id: 'item-1',
        vendorId: 'ven-1',
        name: 'Paneer Thali',
        price: 180,
        category: 'Thalis',
        description: 'Delicious thali',
        imageUrl: '',
        isAvailable: true,
        isVeg: true,
      );
      dummyItem2 = const MenuItemModel(
        id: 'item-2',
        vendorId: 'ven-1',
        name: 'Kulhad Lassi',
        price: 50,
        category: 'Beverages',
        description: 'Chilled lassi',
        imageUrl: '',
        isAvailable: true,
        isVeg: true,
      );
    });

    test('Initial cart is empty', () {
      expect(cart.items.isEmpty, isTrue);
      expect(cart.itemCount, equals(0));
      expect(cart.subtotal, equals(0.0));
      expect(cart.grandTotal, equals(0.0));
      expect(cart.deliveryFee, equals(0.0));
    });

    test('Add item updates subtotal, fees, and grand total', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba');

      expect(cart.items.length, equals(1));
      expect(cart.itemCount, equals(1));
      expect(cart.subtotal, equals(180.0));
      expect(cart.deliveryFee, equals(25.0));
      expect(cart.taxAndPackaging, equals(15.0));
      expect(cart.grandTotal, equals(220.0)); // 180 + 25 + 15
    });

    test('Adding item from different Dhaba clears existing cart', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba');
      expect(cart.dhabaId, equals('ven-1'));

      final newItem = const MenuItemModel(
        id: 'item-201',
        vendorId: 'ven-2',
        name: 'Paneer Roll',
        price: 110,
        category: 'Fast Food',
        description: 'Roll',
        imageUrl: '',
        isAvailable: true,
        isVeg: true,
      );

      cart.addItem(item: newItem, dhabaId: 'ven-2', dhabaName: 'FC Night Mess');
      expect(cart.dhabaId, equals('ven-2'));
      expect(cart.items.length, equals(1));
      expect(cart.items.first.item.name, equals('Paneer Roll'));
    });

    test('Promo Code VITFIRST - minimum subtotal validation', () {
      cart.addItem(item: dummyItem2, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹50 subtotal
      final result = cart.applyCoupon('VITFIRST');

      expect(result, isFalse);
      expect(cart.appliedCouponCode, isNull);
      expect(cart.couponDiscountAmount, equals(0.0));
      expect(cart.couponError, contains('Minimum subtotal of ₹100 required'));
    });

    test('Promo Code VITFIRST - 20% discount calculation', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹180 subtotal
      final result = cart.applyCoupon('VITFIRST');

      expect(result, isTrue);
      expect(cart.appliedCouponCode, equals('VITFIRST'));
      expect(cart.couponDiscountAmount, equals(36.0)); // 20% of 180
      expect(cart.grandTotal, equals(184.0)); // 180 + 25 + 15 - 36
    });

    test('Promo Code VITFIRST - discount capped at ₹50', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba');
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // 2x 180 = 360 subtotal
      final result = cart.applyCoupon('VITFIRST');

      expect(result, isTrue);
      expect(cart.couponDiscountAmount, equals(50.0)); // 20% of 360 = 72, capped at 50
    });

    test('Decrementing item invalidates coupon when subtotal falls below threshold', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹180
      cart.applyCoupon('VITFIRST');
      expect(cart.appliedCouponCode, equals('VITFIRST'));

      // Decrement item 1 quantity by switching to lesser item
      cart.removeItem(cart.items.first.cartItemId);
      cart.addItem(item: dummyItem2, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹50

      expect(cart.subtotal, equals(50.0));
      expect(cart.appliedCouponCode, isNull);
      expect(cart.couponDiscountAmount, equals(0.0));
    });
  });

  group('Customer App - DhabaProvider Tests', () {
    late DhabaProvider dhabaProvider;

    setUp(() {
      dhabaProvider = DhabaProvider();
    });

    test('Returns initial list of dhabas', () {
      expect(dhabaProvider.dhabas.length, equals(4));
    });

    test('Filter dhabas by search query', () {
      dhabaProvider.setSearchQuery('Punjabi');
      expect(dhabaProvider.dhabas.length, equals(1));
      expect(dhabaProvider.dhabas.first.name, contains('Singh Punjabi Kitchen'));
    });

    test('Toggle Dhaba favorite status', () {
      dhabaProvider.toggleFavorite('ven-2');
      dhabaProvider.toggleFavoritesOnly();
      expect(dhabaProvider.dhabas.any((d) => d.id == 'ven-2'), isTrue);
    });
  });

  group('Customer App - OrderProvider Tests', () {
    late OrderProvider orderProvider;
    late CartProvider cartProvider;

    setUp(() {
      orderProvider = OrderProvider();
      cartProvider = CartProvider();
      cartProvider.addItem(
        item: const MenuItemModel(
          id: 'item-1',
          vendorId: 'ven-1',
          name: 'Paneer Thali',
          price: 180,
          category: 'Thalis',
          description: 'Thali',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
        dhabaId: 'ven-1',
        dhabaName: 'Sharma Dhaba',
      );
    });

    test('Place order creates valid order with OTP code', () {
      final order = orderProvider.placeOrder(
        cart: cartProvider,
        hostel: 'Block 2',
        deliveryNote: 'Gate 1',
        paymentMethod: 'UPI',
      );

      expect(order.id, startsWith('ORD-'));
      expect(order.otpCode.length, equals(4));
      expect(orderProvider.activeOrder, equals(order));
      expect(cartProvider.items.isEmpty, isTrue);
    });

    test('Gate Handshake OTP verification succeeds with correct OTP', () {
      final order = orderProvider.placeOrder(
        cart: cartProvider,
        hostel: 'Block 2',
        deliveryNote: 'Gate 1',
        paymentMethod: 'UPI',
      );

      final result = orderProvider.verifyGateHandshakeOtp(order.otpCode);
      expect(result, isTrue);
      expect(orderProvider.activeOrder!.status, equals(OrderProgressStatus.delivered));
    });
  });

  group('Customer App - SplitBillModal Widget Test', () {
    testWidgets('SplitBillModal displays correct per-person split', (WidgetTester tester) async {
      final order = OrderModel(
        id: 'ORD-100',
        dhabaId: 'ven-1',
        dhabaName: 'Sharma Dhaba',
        items: [],
        subtotal: 200,
        discount: 0,
        deliveryFee: 20,
        taxAndPackaging: 10,
        totalAmount: 230,
        hostel: 'Block 1',
        deliveryNote: '',
        paymentMethod: 'UPI',
        status: OrderProgressStatus.placed,
        otpCode: '1234',
        createdAt: DateTime.now(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SplitBillModal(order: order),
          ),
        ),
      );

      expect(find.text('Roommate Split-Bill Generator'), findsOneWidget);
      expect(find.text('₹115'), findsOneWidget); // 230 / 2 = 115

      // Tap add roommate button
      await tester.tap(find.byIcon(Icons.add_circle_outline));
      await tester.pump();

      expect(find.text('₹77'), findsOneWidget); // 230 / 3 = 76.66 -> 77
    });
  });
}
