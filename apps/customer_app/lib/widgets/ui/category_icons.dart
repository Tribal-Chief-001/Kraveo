import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Icons for the fixed set of category icon keys the admin portal offers (Docs/23).
const Map<String, IconData> kCategoryIconKeys = {
  'restaurant': LucideIcons.utensils,
  'thali': LucideIcons.cookingPot,
  'rice': LucideIcons.wheat,
  'biryani': LucideIcons.soup,
  'dosa': LucideIcons.cookie,
  'noodles': LucideIcons.utensilsCrossed,
  'roll': LucideIcons.sandwich,
  'burger': LucideIcons.hamburger,
  'pizza': LucideIcons.pizza,
  'snack': LucideIcons.popcorn,
  'bread': LucideIcons.croissant,
  'tandoor': LucideIcons.flame,
  'egg': LucideIcons.egg,
  'chicken': LucideIcons.drumstick,
  'fish': LucideIcons.fish,
  'veg': LucideIcons.leaf,
  'sweet': LucideIcons.candy,
  'dessert': LucideIcons.cakeSlice,
  'icecream': LucideIcons.iceCreamCone,
  'tea': LucideIcons.coffee,
  'coffee': LucideIcons.bean,
  'juice': LucideIcons.citrus,
  'shake': LucideIcons.milk,
  'healthy': LucideIcons.salad,
  'latenight': LucideIcons.moon,
};

/// The keyword fallback used before icon keys existed (also for the derived chips of an old server).
IconData categoryIconForLabel(String label) {
  switch (label.toLowerCase()) {
    case 'all':
      return LucideIcons.utensilsCrossed;
    case 'night mess':
      return LucideIcons.moon;
    case 'thalis':
      return LucideIcons.cookingPot;
    case 'fast food':
      return LucideIcons.sandwich;
    case 'beverages':
      return LucideIcons.cupSoda;
    case 'north indian':
      return LucideIcons.flame;
    case 'parathas':
      return LucideIcons.wheat;
    default:
      return LucideIcons.utensils;
  }
}

/// Server icon [key] -> icon; an unknown or missing key falls back to the keyword table on [label],
/// which ends in the generic utensils icon.
IconData categoryIcon({String? key, required String label}) {
  final icon = key == null ? null : kCategoryIconKeys[key.trim().toLowerCase()];
  return icon ?? categoryIconForLabel(label);
}
