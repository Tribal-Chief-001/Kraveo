import React from 'react';
import {
  Beef, Cake, Candy, Carrot, Citrus, Coffee, Cookie, Croissant, Drumstick, Egg, Fish, Flame, IceCream, Leaf, Milk, Moon, Pizza, Popcorn, Salad, Sandwich, Soup, Utensils,
  UtensilsCrossed, Wheat,
} from 'lucide-react';
import { ICON_LABEL, IconKey, iconKeyOf } from '../../lib/categoryParse';

/** Icon key -> lucide icon. An unknown key shows the generic restaurant icon, like the apps do. */
export const ICONS: Record<IconKey, React.ElementType> = {
  restaurant: Utensils, thali: UtensilsCrossed, rice: Wheat, biryani: Soup, dosa: Cookie, noodles: Soup, roll: Sandwich, burger: Beef, pizza: Pizza, snack: Popcorn,
  bread: Croissant, tandoor: Flame, egg: Egg, chicken: Drumstick, fish: Fish, veg: Carrot, sweet: Candy, dessert: Cake, icecream: IceCream, tea: Leaf, coffee: Coffee,
  juice: Citrus, shake: Milk, healthy: Salad, latenight: Moon,
};

interface Props {
  icon: string | null | undefined;
  className?: string;
  /** Adds a screen-reader name (e.g. "Biryani icon"). Decorative by default. */
  label?: boolean;
}

export const CategoryIcon: React.FC<Props> = ({ icon, className = 'h-4 w-4', label = false }) => {
  const key = iconKeyOf(icon);
  const Icon = ICONS[key];
  return label
    ? <Icon className={className} role="img" aria-label={`${ICON_LABEL[key]} icon`} />
    : <Icon className={className} aria-hidden="true" />;
};
