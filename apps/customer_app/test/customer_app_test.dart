import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:customer_app/providers/cart_provider.dart';
import 'package:customer_app/providers/dhaba_provider.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/widgets/split_bill_modal.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'support/order_fakes.dart';
import 'support/sample_catalog.dart';

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

    test('KRAVEO20 is not offered by the app any more (the server only accepts it after 50 coins are redeemed, which the app cannot do)', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹180 subtotal
      final result = cart.applyCoupon('KRAVEO20');

      expect(result, isFalse);
      expect(cart.appliedCouponCode, isNull);
      expect(cart.couponDiscountAmount, equals(0.0));
      expect(cart.grandTotal, equals(220.0));
      expect(cart.couponError, isNot(contains('KRAVEO20')), reason: 'the hint must not advertise it');
    });

    test('Promo Code KRAVEO50 keeps its client rule (min ₹150, flat ₹50)', () {
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba');
      expect(cart.applyCoupon('KRAVEO50'), isTrue);
      expect(cart.couponDiscountAmount, 50.0);
      cart.removeCoupon();
      cart.clearCart();
      cart.addItem(item: dummyItem2, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba');
      expect(cart.applyCoupon('KRAVEO50'), isFalse);
      expect(cart.couponError, contains('₹150'));
    });

    test('at most 20 of one dish: further adds and increments are refused (all option variants count together)', () {
      for (var i = 0; i < 20; i++) {
        expect(cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'), isTrue);
      }
      expect(cart.itemCount, 20);
      expect(cart.canAddMore(dummyItem1.id), isFalse);
      expect(cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'), isFalse);
      expect(cart.incrementItem(cart.items.first.cartItemId), isFalse);
      expect(cart.itemCount, 20);
      // a differently customised line of the same dish counts toward the same 20
      expect(cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba', specialInstructions: 'less spicy'), isFalse);
      // another dish is unaffected, and removing one frees a slot
      expect(cart.addItem(item: dummyItem2, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'), isTrue);
      cart.decrementItem(cart.items.first.cartItemId);
      expect(cart.canAddMore(dummyItem1.id), isTrue);
    });

    test('Kraveo Coins are a balance only: they never lower the estimate (the server cannot redeem them)', () {
      cart.setKraveoCoins(120);
      cart.addItem(item: dummyItem1, dhabaId: 'ven-1', dhabaName: 'Sharma Dhaba'); // ₹180 subtotal
      expect(cart.userKraveoCoins, 120);
      expect(cart.grandTotal, equals(220.0)); // 180 + 25 + 15, same formula as the server
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
      dhabaProvider = sampleCatalogProvider();
    });

    test('A new provider has NO built-in kitchens: only what the server returns is ever shown', () {
      final fresh = DhabaProvider();
      expect(fresh.allDhabas, isEmpty);
      expect(fresh.dhabas, isEmpty);
      expect(fresh.catalogStatus, CatalogStatus.idle);
      expect(fresh.isLiveVendor('ven-1'), isFalse);
      expect(fresh.byId('ven-1'), isNull);
    });

    test('An injected catalog lists its kitchens and counts as live', () {
      expect(dhabaProvider.dhabas.length, equals(4));
      expect(dhabaProvider.isLiveVendor('ven-2'), isTrue);
      expect(dhabaProvider.byId('ven-2')?.name, 'FC Night Mess');
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

  group('Customer App - SplitBillModal Widget Test', () {
    testWidgets('SplitBillModal displays correct per-person split', (WidgetTester tester) async {
      final order = orderModel(status: 'ACCEPTED', paymentStatus: 'PAID', totalAmount: 230);

      await tester.pumpWidget(
        MaterialApp(
          theme: KraveoTheme.customer(),
          home: Scaffold(
            body: SplitBillModal(order: order),
          ),
        ),
      );

      expect(find.text('Split the bill'), findsOneWidget);
      expect(find.text('₹115'), findsOneWidget); // 230 / 2 = 115

      // Tap add roommate button
      await tester.tap(find.byIcon(LucideIcons.plus));
      await tester.pump();

      expect(find.text('₹77'), findsOneWidget); // 230 / 3 = 76.66 -> 77
    });
  });
}
