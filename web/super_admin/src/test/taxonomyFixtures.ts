// JSON copied from REAL backend answers (Docs/23 section 8.4, produced by backend/test/e2e/{categories_admin,restaurant_profile,
// dish_categories_bulk_import,uploads}.test.ts against PostgreSQL). Component and API tests build their data from these.
import { parseCategory } from '../lib/categoryParse';

/** One row of GET /api/admin/categories?includeInactive=1 (the admin view; create / patch / merge return the same object). */
export const rawCategory = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: '72077a2d-9b97-48de-9956-8d0167228f34',
  name: 'Biryani',
  nameHi: 'बिरयानी',
  icon: 'biryani',
  forRestaurants: true,
  forDishes: true,
  showOnHome: true,
  sortOrder: 25,
  restaurantCount: 1,
  dishCount: 1,
  slug: 'biryani',
  isActive: true,
  usage: { restaurants: 1, dishes: 1 },
  inUse: true,
  createdAt: '2026-10-12T07:51:29.270Z',
  updatedAt: '2026-10-12T07:51:29.270Z',
  ...over,
});

export const rawNorthIndian = (over: Record<string, unknown> = {}) => rawCategory({
  id: '02236158-229f-48fc-9fe8-4b1220e74ed7', name: 'North Indian', nameHi: null, icon: 'restaurant', sortOrder: 26, restaurantCount: 1, dishCount: 0,
  slug: 'north-indian', usage: { restaurants: 1, dishes: 0 }, ...over,
});

/** An unused, dish-only category (deletable). */
export const rawUnused = (over: Record<string, unknown> = {}) => rawCategory({
  id: '3f19f8c2-09bc-414c-962d-183fc2237e9a', name: 'Rolls & Wraps', nameHi: null, icon: 'roll', showOnHome: false, sortOrder: 27, restaurantCount: 0, dishCount: 0,
  slug: 'rolls-wraps', usage: { restaurants: 0, dishes: 0 }, inUse: false, ...over,
});

export const rawCategoryList = (rows: Record<string, unknown>[] = [rawCategory(), rawNorthIndian(), rawUnused()]) => ({ success: true, count: rows.length, data: rows });

export const category = (over: Record<string, unknown> = {}) => parseCategory(rawCategory(over))!;

/** Admin vendor view after PATCH /api/admin/vendors/:id/profile. */
export const rawVendor = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: 'sh-ven-1',
  userId: 'usr-sh-o',
  name: 'Shape Kitchen & Co',
  category: 'North Indian • Biryani',
  rating: 4.5,
  totalRatingsCount: 50,
  eta: '15-20 min',
  bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600',
  address: 'Ashta road, near gate 4',
  isAcceptingOrders: true,
  lat: 23.0768,
  lng: 76.8524,
  locationSource: null,
  locationSetAt: null,
  locationAccuracyM: null,
  approvalStatus: 'APPROVED',
  rejectionReason: null,
  fssaiNumber: '12345678901234',
  appliedAt: null,
  reviewedAt: null,
  commissionType: null,
  commissionValue: null,
  createdAt: '2026-10-12T07:51:29.186Z',
  updatedAt: '2026-10-12T07:51:29.551Z',
  menuItems: [],
  cuisines: [
    { id: '02236158-229f-48fc-9fe8-4b1220e74ed7', name: 'North Indian', icon: 'restaurant' },
    { id: '72077a2d-9b97-48de-9956-8d0167228f34', name: 'Biryani', icon: 'biryani' },
  ],
  tags: ['North Indian', 'Biryani'],
  hasLocation: false,
  ...over,
});

export const profileSaved = (over: Record<string, unknown> = {}) => ({ success: true, changed: true, message: 'Restaurant saved.', data: rawVendor(over) });

/** POST /api/admin/catalog/bulk: UNAVAILABLE on 2 live dishes, 1 deleted dish and 1 unknown id. */
export const bulkMixed = {
  success: true,
  message: '2 done, 2 could not be changed.',
  data: {
    results: [
      { id: '0e4af759-820a-4859-9135-ccb08af7b0b0', ok: true, changed: true },
      { id: 'efbf262d-5b74-403a-8547-f334323bb1f0', ok: true, changed: true },
      { id: '1686259a-acb1-400c-b4d5-9ebcff5725a1', ok: false, changed: false, code: 'ITEM_DELETED', message: 'This dish is deleted. Restore it first.' },
      { id: 'missing-id', ok: false, changed: false, code: 'NOT_FOUND', message: 'Menu item not found.' },
    ],
    ok: 2,
    failed: 2,
  },
};

/** POST /api/admin/vendors/:id/menu-import dry run: row 1 duplicate, row 3 two errors, row 4 repeats a name of the file. */
export const importDryRun = {
  success: true,
  message: 'Preview only: 2 to add, 0 to update, 1 to skip, 2 not valid.',
  data: {
    dryRun: true,
    applied: false,
    summary: { create: 2, update: 0, skip: 1, invalid: 2, total: 5 },
    rows: [
      { index: 0, name: 'Paneer Tikka', action: 'create', errors: [], computedPrice: 150 },
      { index: 1, name: 'chicken biryani', action: 'skip', errors: [], computedPrice: 190, reason: 'DUPLICATE_EXISTS', dishId: '0e4af759-820a-4859-9135-ccb08af7b0b0' },
      { index: 2, name: 'Masala Chai', action: 'create', errors: [], computedPrice: 20 },
      { index: 3, name: 'Bad One', action: 'invalid', errors: [{ field: 'category', message: 'Pick a category from the list.' }, { field: 'vendorPrice', message: 'The price must be more than 0.' }], computedPrice: null },
      { index: 4, name: 'Masala chai', action: 'invalid', errors: [{ field: 'name', message: 'This dish name is repeated in the file (first at row 3).' }], computedPrice: null },
    ],
  },
};

/** The same file without the two bad rows (3 rows). */
export const importDryRunGood = {
  success: true,
  message: 'Preview only: 2 to add, 0 to update, 1 to skip, 0 not valid.',
  data: {
    dryRun: true,
    applied: false,
    summary: { create: 2, update: 0, skip: 1, invalid: 0, total: 3 },
    rows: [
      { index: 0, name: 'Paneer Tikka', action: 'create', errors: [], computedPrice: 150 },
      { index: 1, name: 'chicken biryani', action: 'skip', errors: [], computedPrice: 190, reason: 'DUPLICATE_EXISTS', dishId: '0e4af759-820a-4859-9135-ccb08af7b0b0' },
      { index: 2, name: 'Masala Chai', action: 'create', errors: [], computedPrice: 20 },
    ],
  },
};

export const importApplied = {
  success: true,
  message: 'Imported: 2 added, 0 updated, 1 skipped.',
  data: {
    dryRun: false,
    applied: true,
    summary: { create: 2, update: 0, skip: 1, invalid: 0, total: 3 },
    rows: [
      { index: 0, name: 'Paneer Tikka', action: 'create', errors: [], computedPrice: 150, dishId: 'f4084af6-c433-430a-82d0-02ea9781b61e' },
      { index: 1, name: 'chicken biryani', action: 'skip', errors: [], computedPrice: 190, reason: 'DUPLICATE_EXISTS', dishId: '0e4af759-820a-4859-9135-ccb08af7b0b0' },
      { index: 2, name: 'Masala Chai', action: 'create', errors: [], computedPrice: 20, dishId: '39e8d175-0d15-411e-be18-6806decf9078' },
    ],
  },
};

export const importInvalid = {
  success: false,
  code: 'IMPORT_INVALID',
  message: '2 rows are not valid. Nothing was imported. Fix them and try again.',
  field: 'rows',
  data: { ...importDryRun.data, dryRun: false },
};

export const uploadOk = { success: true, data: { url: 'https://api.kraveo.site/uploads/banner/2026/bcff31b889235190508d11aaf6161e67.png', width: 800, height: 450, bytes: 68 } };

export const mergeDryRun = {
  success: true,
  message: 'Merging would move 0 dishes and 1 restaurant. Nothing was changed.',
  data: { dryRun: true, from: { id: '02236158-229f-48fc-9fe8-4b1220e74ed7', name: 'North Indian' }, into: { id: '72077a2d-9b97-48de-9956-8d0167228f34', name: 'Biryani' }, dishes: 0, restaurants: 1 },
};

export const errorBody = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ success: false, code, message, ...extra });
