/** Public (customer app) views of vendors and menu items, and validation of what restaurants may write to the menu. */

export const MAX_MENU_PRICE = 10_000;

/** What a customer needs to see of a menu item: nothing internal. */
export const publicMenuItem = (m: any) => ({
  id: m.id,
  vendorId: m.vendorId,
  name: m.name,
  price: m.price,
  category: m.category,
  description: m.description,
  imageUrl: m.imageUrl,
  isAvailable: m.isAvailable,
  isVeg: m.isVeg,
  rating: m.rating ?? null,
  ratingCount: m.ratingCount ?? null,
});

/** What a customer needs to see of a restaurant (no owner id, FSSAI number, review state or timestamps). */
export const publicVendorView = (v: any) => ({
  id: v.id,
  name: v.name,
  category: v.category,
  rating: v.rating,
  totalRatingsCount: v.totalRatingsCount,
  eta: v.eta,
  bannerImage: v.bannerImage,
  address: v.address,
  isAcceptingOrders: v.isAcceptingOrders,
  lat: v.lat,
  lng: v.lng,
  menuItems: (v.menuItems ?? []).map(publicMenuItem),
});

/** A price a restaurant may set: a finite JSON number, 0 < price <= 10000, at most 2 decimals. */
export const priceProblem = (price: unknown): string | null => {
  if (typeof price !== 'number' || !Number.isFinite(price)) return 'Price must be a number.';
  if (price <= 0) return 'Price must be more than 0.';
  if (price > MAX_MENU_PRICE) return `Price cannot be more than ₹${MAX_MENU_PRICE}.`;
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) return 'Price can have at most 2 decimals.';
  return null;
};

const text = (raw: unknown, max: number): string | null | false => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return false;
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : false;
};

export type MenuItemInput = { name: string; price: number; category: string; description: string; imageUrl: string | null; isVeg: boolean };
export type FieldProblem = { field: string; message: string };

/** Validates the body of POST /vendors/:id/items. */
export const validateMenuItemFields = (b: any): { ok: true; data: MenuItemInput } | { ok: false; error: FieldProblem } => {
  const name = text(b?.name, 80);
  if (!name) return { ok: false, error: { field: 'name', message: 'Item name is required (up to 80 characters).' } };
  const price = priceProblem(b?.price);
  if (price) return { ok: false, error: { field: 'price', message: price } };
  const category = text(b?.category, 40);
  if (category === false) return { ok: false, error: { field: 'category', message: 'Category can be at most 40 characters.' } };
  const description = text(b?.description, 300);
  if (description === false) return { ok: false, error: { field: 'description', message: 'Description can be at most 300 characters.' } };
  const imageUrl = text(b?.imageUrl, 500);
  if (imageUrl === false || (imageUrl && !/^https?:\/\//i.test(imageUrl))) return { ok: false, error: { field: 'imageUrl', message: 'Image must be an http(s) link (up to 500 characters).' } };
  if (b?.isVeg !== undefined && typeof b.isVeg !== 'boolean') return { ok: false, error: { field: 'isVeg', message: 'isVeg must be true or false.' } };
  return { ok: true, data: { name, price: b.price, category: category || 'Main Course', description: description || '', imageUrl: imageUrl || null, isVeg: b?.isVeg !== false } };
};
