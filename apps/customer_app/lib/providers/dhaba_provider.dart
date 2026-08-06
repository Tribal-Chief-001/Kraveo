import 'package:flutter/material.dart';
import '../models/dhaba.dart';
import '../models/menu_item.dart';
import '../models/customization.dart';

class DhabaProvider with ChangeNotifier {
  String _searchQuery = '';
  int _selectedCategoryIndex = 0;
  bool _showFavoritesOnly = false;
  final Set<String> _favoriteDhabaIds = {'ven-1', 'ven-3'};

  final List<String> categories = [
    'All',
    'Night Mess',
    'Thalis',
    'Fast Food',
    'Beverages',
    'North Indian',
    'Parathas',
  ];

  final List<Dhaba> _dhabas = [
    Dhaba(
      id: 'ven-1',
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      rating: 4.8,
      eta: '25-30 min',
      bannerUrl: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600',
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
      bannerUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600',
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
      bannerUrl: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=600',
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
      bannerUrl: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600',
      isAcceptingOrders: true,
      address: 'Main Highway Circle, Ashta',
      deliveryFee: 20.0,
      minOrder: 99.0,
      isFavorite: false,
      tags: ['Hot Biryani', 'Night Mess', 'Beverages'],
    ),
  ];

  final Map<String, List<MenuItemModel>> _menuItems = {
    'ven-1': [
      MenuItemModel(
        id: 'item-1',
        vendorId: 'ven-1',
        name: 'Special Shahi Paneer Thali',
        price: 180,
        category: 'Thalis',
        description: 'Paneer Butter Masala, Dal Makhani, 4 Butter Rotis, Steamed Rice, Sweet & Salad',
        imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
        isAvailable: true,
        isVeg: true,
        customizationGroups: const [
          CustomizationGroup(
            id: 'cg-1',
            title: 'Bread Selection',
            isRequired: true,
            maxSelection: 1,
            options: [
              CustomizationOption(id: 'co-1', name: '4 Butter Rotis', price: 0),
              CustomizationOption(id: 'co-2', name: '2 Butter Naans (+₹25)', price: 25),
              CustomizationOption(id: 'co-3', name: '4 Plain Tandoori Rotis', price: 0),
            ],
          ),
          CustomizationGroup(
            id: 'cg-2',
            title: 'Extra Add-ons',
            isRequired: false,
            maxSelection: 3,
            options: [
              CustomizationOption(id: 'co-4', name: 'Extra Butter Scoop', price: 15),
              CustomizationOption(id: 'co-5', name: 'Gulab Jamun (2 pcs)', price: 30),
              CustomizationOption(id: 'co-6', name: 'Extra Boondi Raita', price: 25),
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
        description: 'Crispy tandoori parathas stuffed with spiced potatoes and onions, served with fresh curd',
        imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400',
        isAvailable: true,
        isVeg: true,
        customizationGroups: const [
          CustomizationGroup(
            id: 'cg-3',
            title: 'Paratha Preparation',
            isRequired: true,
            maxSelection: 1,
            options: [
              CustomizationOption(id: 'co-7', name: 'Amul Butter Tawa', price: 0),
              CustomizationOption(id: 'co-8', name: 'Desi Ghee (+₹20)', price: 20),
            ],
          ),
          CustomizationGroup(
            id: 'cg-4',
            title: 'Accompaniments',
            isRequired: false,
            maxSelection: 2,
            options: [
              CustomizationOption(id: 'co-9', name: 'Extra Curd Bowl', price: 20),
              CustomizationOption(id: 'co-10', name: 'Homemade Mango Pickle', price: 10),
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
        description: 'Chilled thick creamy lassi topped with dry fruits in earthen kulhad',
        imageUrl: 'https://images.unsplash.com/photo-1571006682855-3bc67776510d?w=400',
        isAvailable: true,
        isVeg: true,
      ),
      MenuItemModel(
        id: 'item-4',
        vendorId: 'ven-1',
        name: 'Dal Makhani & Jeera Rice Box',
        price: 140,
        category: 'Thalis',
        description: 'Overnight slow-cooked black lentils in cream and butter with aromatic jeera rice',
        imageUrl: 'https://images.unsplash.com/photo-1588877329975-bc678f99e82c?w=400',
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
        description: 'Grilled paneer cubes rolled in crisp paratha with onions and mint sauce',
        imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400',
        isAvailable: true,
        isVeg: true,
        customizationGroups: const [
          CustomizationGroup(
            id: 'cg-201',
            title: 'Sauce Choice',
            isRequired: false,
            maxSelection: 2,
            options: [
              CustomizationOption(id: 'co-201', name: 'Extra Mint Mayo', price: 10),
              CustomizationOption(id: 'co-202', name: 'Chipotle Sauce', price: 15),
              CustomizationOption(id: 'co-203', name: 'Extra Cheese Blend', price: 25),
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
        description: 'Thick espresso blended with chilled milk and chocolate vanilla ice cream scoop',
        imageUrl: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=400',
        isAvailable: true,
        isVeg: true,
      ),
      MenuItemModel(
        id: 'item-203',
        vendorId: 'ven-2',
        name: 'Veg Loaded Cheese Burger',
        price: 85,
        category: 'Fast Food',
        description: 'Crispy patty, melt-in-mouth cheese slice, veggies and house sauce',
        imageUrl: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
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
        description: 'Tender chicken in rich tomato butter gravy, 2 Garlic Naans, Rice, Salad & Gulab Jamun',
        imageUrl: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=400',
        isAvailable: true,
        isVeg: false,
      ),
      MenuItemModel(
        id: 'item-302',
        vendorId: 'ven-3',
        name: 'Amritsari Chole Kulche',
        price: 130,
        category: 'North Indian',
        description: 'Authentic Amritsari spicy chickpeas served with 2 stuffed butter kulchas',
        imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400',
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
        description: 'Long grain basmati rice dum cooked with fragrant spices and tender chicken served with mirchi ka salan',
        imageUrl: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=400',
        isAvailable: true,
        isVeg: false,
      ),
      MenuItemModel(
        id: 'item-402',
        vendorId: 'ven-4',
        name: 'Masala Chai Flask (500ml)',
        price: 80,
        category: 'Beverages',
        description: 'Freshly brewed ginger cardamom tea in insulated flask for late night study sessions',
        imageUrl: 'https://images.unsplash.com/photo-1571006682855-3bc67776510d?w=400',
        isAvailable: true,
        isVeg: true,
      ),
    ],
  };

  // Getters
  String get searchQuery => _searchQuery;
  int get selectedCategoryIndex => _selectedCategoryIndex;
  bool get showFavoritesOnly => _showFavoritesOnly;

  List<Dhaba> get dhabas {
    return _dhabas.map((d) {
      return d.copyWith(isFavorite: _favoriteDhabaIds.contains(d.id));
    }).where((d) {
      if (_showFavoritesOnly && !_favoriteDhabaIds.contains(d.id)) {
        return false;
      }
      final selectedCategory = categories[_selectedCategoryIndex];
      if (selectedCategory != 'All') {
        final matchesCategory = d.category.toLowerCase().contains(selectedCategory.toLowerCase()) ||
            d.tags.any((t) => t.toLowerCase() == selectedCategory.toLowerCase());
        if (!matchesCategory) return false;
      }
      if (_searchQuery.trim().isNotEmpty) {
        final query = _searchQuery.trim().toLowerCase();
        final nameMatch = d.name.toLowerCase().contains(query);
        final catMatch = d.category.toLowerCase().contains(query);
        final tagMatch = d.tags.any((t) => t.toLowerCase().contains(query));
        
        // Also search in dhaba menu items!
        final items = _menuItems[d.id] ?? [];
        final itemMatch = items.any((item) =>
            item.name.toLowerCase().contains(query) || item.description.toLowerCase().contains(query));

        if (!nameMatch && !catMatch && !tagMatch && !itemMatch) {
          return false;
        }
      }
      return true;
    }).toList();
  }

  List<MenuItemModel> getMenuItemsForDhaba(String dhabaId) {
    return _menuItems[dhabaId] ?? [];
  }

  void setSearchQuery(String query) {
    _searchQuery = query;
    notifyListeners();
  }

  void setSelectedCategoryIndex(int index) {
    _selectedCategoryIndex = index;
    notifyListeners();
  }

  void toggleFavoritesOnly() {
    _showFavoritesOnly = !_showFavoritesOnly;
    notifyListeners();
  }

  void toggleFavorite(String dhabaId) {
    if (_favoriteDhabaIds.contains(dhabaId)) {
      _favoriteDhabaIds.remove(dhabaId);
    } else {
      _favoriteDhabaIds.add(dhabaId);
    }
    notifyListeners();
  }
}
