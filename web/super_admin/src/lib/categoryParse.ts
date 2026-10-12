// Managed categories (Docs/23). ONE place that turns the backend's category answers into the shapes the dashboard uses.
// The shapes are the REAL ones from backend/src/services/categories.ts (Docs/23 section 8.4). Parsers never throw:
// they return null (or safe defaults) when an answer cannot be understood and the caller shows a plain message.

/** The fixed icon set the apps know (Docs/23 section 1). An unknown key shows the generic restaurant icon. */
export const ICON_KEYS = [
  'restaurant', 'thali', 'rice', 'biryani', 'dosa', 'noodles', 'roll', 'burger', 'pizza', 'snack', 'bread', 'tandoor', 'egg', 'chicken', 'fish',
  'veg', 'sweet', 'dessert', 'icecream', 'tea', 'coffee', 'juice', 'shake', 'healthy', 'latenight',
] as const;
export type IconKey = (typeof ICON_KEYS)[number];

export const ICON_LABEL: Record<IconKey, string> = {
  restaurant: 'Restaurant', thali: 'Thali', rice: 'Rice', biryani: 'Biryani', dosa: 'Dosa', noodles: 'Noodles', roll: 'Roll', burger: 'Burger', pizza: 'Pizza',
  snack: 'Snack', bread: 'Bread', tandoor: 'Tandoor', egg: 'Egg', chicken: 'Chicken', fish: 'Fish', veg: 'Vegetables', sweet: 'Sweet', dessert: 'Dessert',
  icecream: 'Ice cream', tea: 'Tea', coffee: 'Coffee', juice: 'Juice', shake: 'Shake', healthy: 'Healthy', latenight: 'Late night',
};

export const isIconKey = (value: unknown): value is IconKey => typeof value === 'string' && (ICON_KEYS as readonly string[]).includes(value);
/** An unknown key from a newer server maps to the generic icon, as the apps do. */
export const iconKeyOf = (value: unknown): IconKey => (isIconKey(value) ? value : 'restaurant');

/** Limits the server enforces (Docs/23 8.2); the form mirrors them so most mistakes are caught before the request. */
export const CATEGORY_NAME_MIN = 2;
export const CATEGORY_NAME_MAX = 30;
export const MAX_RESTAURANT_CATEGORIES = 6;
const NAME_CHARS = /^[A-Za-z0-9 &\-'/+]+$/;

export interface Category {
  id: string;
  name: string;
  nameHi: string | null;
  icon: string;
  forRestaurants: boolean;
  forDishes: boolean;
  showOnHome: boolean;
  sortOrder: number;
  isActive: boolean;
  /** Live (approved, not deleted) restaurants / dishes: what customers see. */
  restaurantCount: number;
  dishCount: number;
  /** Every restaurant / dish in any state. A delete is refused while either is above 0. */
  usage: { restaurants: number; dishes: number };
  inUse: boolean;
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** One category row (public list or admin view). Null when it has no id. */
export const parseCategory = (raw: unknown): Category | null => {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : '';
  if (!id) return null;
  const restaurantCount = count(raw.restaurantCount);
  const dishCount = count(raw.dishCount);
  const usage = isObject(raw.usage) ? { restaurants: count(raw.usage.restaurants), dishes: count(raw.usage.dishes) } : { restaurants: restaurantCount, dishes: dishCount };
  const sort = Number(raw.sortOrder);
  return {
    id,
    name: text(raw.name) ?? 'Unnamed category',
    nameHi: text(raw.nameHi),
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : 'restaurant',
    forRestaurants: raw.forRestaurants !== false,
    forDishes: raw.forDishes !== false,
    showOnHome: raw.showOnHome === true,
    sortOrder: Number.isFinite(sort) ? sort : 0,
    isActive: raw.isActive !== false,
    restaurantCount,
    dishCount,
    usage,
    inUse: (typeof raw.inUse === 'boolean' && raw.inUse) || usage.restaurants + usage.dishes > 0,
  };
};

/** `{ data: [...] }` or a bare array. Rows without an id are dropped; null when the answer is not a list at all. */
export const parseCategoryList = (body: unknown): Category[] | null => {
  const data = isObject(body) && 'data' in body ? body.data : body;
  if (!Array.isArray(data)) return null;
  return data.map(parseCategory).filter((row): row is Category => row !== null);
};

/** create / patch answer: `{ data: category, changed?, message? }`. */
export const parseCategoryResult = (body: unknown): { category: Category | null; changed: boolean; message: string } => {
  const b = isObject(body) ? body : {};
  return { category: parseCategory(b.data), changed: b.changed !== false, message: typeof b.message === 'string' ? b.message : '' };
};

export interface MergePreview {
  dryRun: boolean;
  from: { id: string; name: string } | null;
  into: { id: string; name: string } | null;
  dishes: number;
  restaurants: number;
  message: string;
  /** Only after a real merge: the target category as it is now. */
  category: Category | null;
}

const idName = (raw: unknown): { id: string; name: string } | null => (isObject(raw) && typeof raw.id === 'string' ? { id: raw.id, name: text(raw.name) ?? 'category' } : null);

/** merge answer (dry run or real). Null when the answer has no `data` object. */
export const parseMergeResult = (body: unknown): MergePreview | null => {
  const b = isObject(body) ? body : {};
  const d = isObject(b.data) ? b.data : null;
  if (!d) return null;
  return {
    dryRun: d.dryRun !== false,
    from: idName(d.from),
    into: idName(d.into),
    dishes: count(d.dishes),
    restaurants: count(d.restaurants),
    message: typeof b.message === 'string' ? b.message : '',
    category: parseCategory(d.category),
  };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 restaurant and 2 dishes", "3 dishes", or "" when nothing uses it. */
export const usageText = (usage: { restaurants: number; dishes: number }): string => {
  const parts: string[] = [];
  if (usage.restaurants > 0) parts.push(plural(usage.restaurants, 'restaurant'));
  if (usage.dishes > 0) parts.push(plural(usage.dishes, 'dish', 'dishes'));
  return parts.join(' and ');
};

/** What a merge would move, in words: "Moves 5 dishes and 2 restaurants." / "Nothing uses it, so nothing moves." */
export const mergeSummary = (preview: Pick<MergePreview, 'dishes' | 'restaurants'>): string => {
  const moved = usageText({ restaurants: preview.restaurants, dishes: preview.dishes });
  return moved ? `Moves ${moved}.` : 'Nothing uses it, so nothing moves.';
};

/** Why a category cannot be deleted right now, or null when it can. */
export const deleteBlockReason = (category: Category): string | null => {
  const used = usageText(category.usage);
  return used ? `Used by ${used}. Hide it, or merge it into another category.` : null;
};

/** Mirrors the server's name rule. Returns an error message or '' when fine. */
export const validateCategoryName = (raw: string): string => {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < CATEGORY_NAME_MIN) return 'Enter a name of at least 2 letters.';
  if (name.length > CATEGORY_NAME_MAX) return 'Keep the name to 30 characters or fewer.';
  if (!NAME_CHARS.test(name) || !/[A-Za-z0-9]/.test(name)) return 'Use only letters, digits, spaces and & - \' / + in the name. Put the Hindi label in the Hindi name field.';
  return '';
};

export const validateHindiName = (raw: string): string => {
  const name = raw.trim();
  if (name.length > CATEGORY_NAME_MAX) return 'Keep the Hindi name to 30 characters or fewer.';
  // eslint-disable-next-line no-control-regex
  if (/[<>\u0000-\u001f]/.test(name)) return 'The Hindi name cannot contain < or > or control characters.';
  return '';
};

/** Moves the item at `index` by `delta` (-1 up, +1 down). Returns the same array when it cannot move. */
export const moveItem = <T,>(list: readonly T[], index: number, delta: number): T[] => {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list as T[];
  const next = list.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
};

/** Case and spacing insensitive key, like the server's slug rule (letters and digits only). */
export const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Active categories a restaurant may be tagged with / a dish may be filed under. */
export const restaurantChoices = (all: readonly Category[]): Category[] => all.filter((c) => c.isActive && c.forRestaurants);
export const dishChoices = (all: readonly Category[]): Category[] => all.filter((c) => c.isActive && c.forDishes);
