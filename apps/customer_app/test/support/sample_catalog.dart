// ignore_for_file: prefer_const_constructors
// A small made-up catalog for widget tests. The app itself has NO built-in kitchens (it shows what
// `GET /vendors` returns); tests that need kitchens inject this one:
//   DhabaProvider(dhabas: sampleDhabas(), menus: sampleMenus())  ==  sampleCatalogProvider()
import 'package:customer_app/models/customization.dart';
import 'package:customer_app/models/dhaba.dart';
import 'package:customer_app/models/menu_item.dart';
import 'package:customer_app/providers/dhaba_provider.dart';

DhabaProvider sampleCatalogProvider() =>
    DhabaProvider(dhabas: sampleDhabas(), menus: sampleMenus());

List<Dhaba> sampleDhabas() => [
      Dhaba(
        id: 'ven-1',
        name: 'Sharma Highway Dhaba',
        category: 'North Indian • Thalis • Parathas',
        rating: 4.8,
        eta: '25-30 min',
        bannerUrl: '',
        isAcceptingOrders: true,
        address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal',
        deliveryFee: 25.0,
        minOrder: 99.0,
        isFavorite: true,
        tags: ['Top Rated', 'Free Delivery over ₹299', 'Night Mess'],
      ),
      Dhaba(
        id: 'ven-2',
        name: 'FC Night Mess',
        category: 'Fast Food • Rolls • Beverages',
        rating: 4.5,
        eta: '15-20 min',
        bannerUrl: '',
        isAcceptingOrders: true,
        address: 'VIT Bhopal Entry Gate 1',
        deliveryFee: 15.0,
        minOrder: 49.0,
        isFavorite: false,
        tags: ['Fast Delivery', 'Open till 3 AM', 'Night Mess', 'Fast Food'],
      ),
      Dhaba(
        id: 'ven-3',
        name: 'Singh Punjabi Kitchen',
        category: 'Butter Chicken • Naan • Thalis',
        rating: 4.9,
        eta: '30-35 min',
        bannerUrl: '',
        isAcceptingOrders: true,
        address: 'Kothri Bypass Road',
        deliveryFee: 30.0,
        minOrder: 149.0,
        isFavorite: true,
        tags: ['Authentic Punjabi', 'North Indian', 'Thalis'],
      ),
      Dhaba(
        id: 'ven-4',
        name: 'Bhopal Express Night Dhaba',
        category: 'Biryani • Chai • Night Mess',
        rating: 4.6,
        eta: '20-25 min',
        bannerUrl: '',
        isAcceptingOrders: true,
        address: 'Main Highway Circle, Ashta',
        deliveryFee: 20.0,
        minOrder: 99.0,
        isFavorite: false,
        tags: ['Hot Biryani', 'Night Mess', 'Beverages'],
      ),
    ];

Map<String, List<MenuItemModel>> sampleMenus() => {
      'ven-1': [
        MenuItemModel(
          id: 'item-1',
          vendorId: 'ven-1',
          name: 'Special Shahi Paneer Thali',
          price: 180,
          category: 'Thalis',
          description:
              'Paneer Butter Masala, Dal Makhani, 4 Butter Rotis, Steamed Rice, Sweet & Salad',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
          customizationGroups: const [
            CustomizationGroup(
              id: 'cg-1',
              title: 'Bread Selection',
              isRequired: true,
              maxSelection: 1,
              options: [
                CustomizationOption(
                    id: 'co-1', name: '4 Butter Rotis', price: 0),
                CustomizationOption(
                    id: 'co-2', name: '2 Butter Naans (+₹25)', price: 25),
                CustomizationOption(
                    id: 'co-3', name: '4 Plain Tandoori Rotis', price: 0),
              ],
            ),
            CustomizationGroup(
              id: 'cg-2',
              title: 'Extra Add-ons',
              isRequired: false,
              maxSelection: 3,
              options: [
                CustomizationOption(
                    id: 'co-4', name: 'Extra Butter Scoop', price: 15),
                CustomizationOption(
                    id: 'co-5', name: 'Gulab Jamun (2 pcs)', price: 30),
                CustomizationOption(
                    id: 'co-6', name: 'Extra Boondi Raita', price: 25),
              ],
            ),
          ],
        ),
        MenuItemModel(
          id: 'item-2',
          vendorId: 'ven-1',
          name: 'Aloo Pyaz Paratha (2 pcs)',
          price: 90,
          category: 'Parathas',
          description:
              'Crispy tandoori parathas stuffed with spiced potatoes and onions, served with fresh curd',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
          customizationGroups: const [
            CustomizationGroup(
              id: 'cg-3',
              title: 'Paratha Preparation',
              isRequired: true,
              maxSelection: 1,
              options: [
                CustomizationOption(
                    id: 'co-7', name: 'Amul Butter Tawa', price: 0),
                CustomizationOption(
                    id: 'co-8', name: 'Desi Ghee (+₹20)', price: 20),
              ],
            ),
            CustomizationGroup(
              id: 'cg-4',
              title: 'Accompaniments',
              isRequired: false,
              maxSelection: 2,
              options: [
                CustomizationOption(
                    id: 'co-9', name: 'Extra Curd Bowl', price: 20),
                CustomizationOption(
                    id: 'co-10', name: 'Homemade Mango Pickle', price: 10),
              ],
            ),
          ],
        ),
        MenuItemModel(
          id: 'item-3',
          vendorId: 'ven-1',
          name: 'Kulhad Sweet Lassi',
          price: 50,
          category: 'Beverages',
          description:
              'Chilled thick creamy lassi topped with dry fruits in earthen kulhad',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
        MenuItemModel(
          id: 'item-4',
          vendorId: 'ven-1',
          name: 'Dal Makhani & Jeera Rice Box',
          price: 140,
          category: 'Thalis',
          description:
              'Overnight slow-cooked black lentils in cream and butter with aromatic jeera rice',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
      ],
      'ven-2': [
        MenuItemModel(
          id: 'item-201',
          vendorId: 'ven-2',
          name: 'Paneer Kathi Roll',
          price: 110,
          category: 'Fast Food',
          description:
              'Grilled paneer cubes rolled in crisp paratha with onions and mint sauce',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
          customizationGroups: const [
            CustomizationGroup(
              id: 'cg-201',
              title: 'Sauce Choice',
              isRequired: false,
              maxSelection: 2,
              options: [
                CustomizationOption(
                    id: 'co-201', name: 'Extra Mint Mayo', price: 10),
                CustomizationOption(
                    id: 'co-202', name: 'Chipotle Sauce', price: 15),
                CustomizationOption(
                    id: 'co-203', name: 'Extra Cheese Blend', price: 25),
              ],
            ),
          ],
        ),
        MenuItemModel(
          id: 'item-202',
          vendorId: 'ven-2',
          name: 'Cold Coffee with Ice Cream',
          price: 70,
          category: 'Beverages',
          description:
              'Thick espresso blended with chilled milk and chocolate vanilla ice cream scoop',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
        MenuItemModel(
          id: 'item-203',
          vendorId: 'ven-2',
          name: 'Veg Loaded Cheese Burger',
          price: 85,
          category: 'Fast Food',
          description:
              'Crispy patty, melt-in-mouth cheese slice, veggies and house sauce',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
      ],
      'ven-3': [
        MenuItemModel(
          id: 'item-301',
          vendorId: 'ven-3',
          name: 'Punjabi Butter Chicken Thali',
          price: 240,
          category: 'Thalis',
          description:
              'Tender chicken in rich tomato butter gravy, 2 Garlic Naans, Rice, Salad & Gulab Jamun',
          imageUrl: '',
          isAvailable: true,
          isVeg: false,
        ),
        MenuItemModel(
          id: 'item-302',
          vendorId: 'ven-3',
          name: 'Amritsari Chole Kulche',
          price: 130,
          category: 'North Indian',
          description:
              'Authentic Amritsari spicy chickpeas served with 2 stuffed butter kulchas',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
      ],
      'ven-4': [
        MenuItemModel(
          id: 'item-401',
          vendorId: 'ven-4',
          name: 'Hyderabadi Dum Biryani',
          price: 190,
          category: 'Night Mess',
          description:
              'Long grain basmati rice dum cooked with fragrant spices and tender chicken served with mirchi ka salan',
          imageUrl: '',
          isAvailable: true,
          isVeg: false,
        ),
        MenuItemModel(
          id: 'item-402',
          vendorId: 'ven-4',
          name: 'Masala Chai Flask (500ml)',
          price: 80,
          category: 'Beverages',
          description:
              'Freshly brewed ginger cardamom tea in insulated flask for late night study sessions',
          imageUrl: '',
          isAvailable: true,
          isVeg: true,
        ),
      ],
    };
