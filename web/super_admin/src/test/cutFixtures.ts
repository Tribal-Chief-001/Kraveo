// JSON copied from the REAL server answers in Docs/26 section 7.4 (backend/test/e2e/cut_commission.test.ts, menu_order.test.ts).
// Ids and times differ per run; long lists are cut to a few rows.

export const CUT_DISH_CREATED = {
  success: true,
  message: 'Dish created and live.',
  data: {
    id: '2b5f1172-3395-4d4b-b9f0-9a37c75fb617', vendorId: 'cut-ven-1', vendorName: 'Cut Kitchen 1', name: 'Dish c55c391e', category: 'Main Course',
    categoryId: '82681b26-f8ff-47a4-ae8c-90dbd9e55c1b', description: '', imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
    isVeg: true, isAvailable: true, sortOrder: 10, rating: 4.5, ratingCount: 0, status: 'LIVE', approvalStatus: 'APPROVED', rejectionReason: null,
    vendorPrice: 80.5, pendingVendorPrice: null, price: 115, computedPrice: 115, priceIsStale: false, pendingPrice: null, effectiveCommission: 34.5,
    commission: { type: 'CUT', value: 30, source: 'VENDOR' }, commissionOverride: null, createdBy: 'ADMIN',
    createdAt: '2026-10-28T23:34:23.820Z', updatedAt: '2026-10-28T23:34:23.820Z', reviewedAt: '2026-10-28T23:34:23.819Z', reviewedByUserId: 'usr-5', deletedAt: null,
  },
};

export const CUT_PREVIEW_MENU = {
  success: true,
  data: { menuPrice: 115, vendorPrice: 80.5, price: 115, effectiveCommission: 34.5, nominalCommission: 34.5, commission: { type: 'CUT', value: 30, source: 'DISH' }, roundingStep: 1 },
};

export const CUT_PREVIEW_VENDOR = {
  success: true,
  data: { vendorPrice: 80, price: 100, effectiveCommission: 20, nominalCommission: 20, commission: { type: 'CUT', value: 20, source: 'VENDOR' }, roundingStep: 1 },
};

export const CUT_SETTING_SAVED = {
  success: true, changed: true, message: 'Saved. Existing dish prices keep their old value until you run "Recalculate prices".', recalculateRecommended: true,
  data: { group: 'commission', value: { type: 'CUT', value: 20 }, isDefault: false, updatedAt: '2026-10-28T23:34:23.305Z', updatedBy: 'usr-5' },
};

export const CUT_VENDOR_SAVED = {
  success: true, message: 'Saved.',
  data: { vendor: { id: 'cut-ven-1', name: 'Cut Kitchen 1', commissionType: 'CUT', commissionValue: 30 }, effective: { type: 'CUT', value: 30, source: 'VENDOR' }, dishCount: 0, staleDishes: 0 },
};

export const IMPORT_DRY_CUT = {
  success: true,
  message: 'Preview only: 4 to add, 0 to update, 0 to skip, 0 not valid.',
  data: {
    dryRun: true, applied: false, summary: { create: 4, update: 0, skip: 0, invalid: 0, total: 4 },
    rows: [
      { index: 0, name: 'Imp A', action: 'create', errors: [], computedPrice: 115, vendorPrice: 80.5, sortOrder: 10 },
      { index: 1, name: 'Imp B', action: 'create', errors: [], computedPrice: 100, vendorPrice: 70, sortOrder: 20 },
      { index: 2, name: 'Imp C', action: 'create', errors: [], computedPrice: 99, vendorPrice: 69.3, sortOrder: 30 },
      { index: 3, name: 'Imp D', action: 'create', errors: [], computedPrice: 250, vendorPrice: 175, sortOrder: 70 },
    ],
  },
};

export const IMPORT_INVALID_CUT = {
  success: false, code: 'IMPORT_INVALID', message: '2 rows are not valid. Nothing was imported. Fix them and try again.', field: 'rows',
  data: {
    dryRun: false, applied: false, summary: { create: 1, update: 0, skip: 0, invalid: 2, total: 3 },
    rows: [
      { index: 0, name: 'Good One', action: 'create', errors: [], computedPrice: 115, vendorPrice: 80.5, sortOrder: 10 },
      { index: 1, name: 'Both', action: 'invalid', errors: [{ field: 'menuPrice', code: 'PRICE_REQUIRED', message: 'Give either the restaurant price (vendorPrice) or the customer menu price (menuPrice), not both.' }], computedPrice: null, vendorPrice: null, sortOrder: null },
      { index: 2, name: 'Neither', action: 'invalid', errors: [{ field: 'vendorPrice', code: 'PRICE_REQUIRED', message: 'Give the restaurant price (vendorPrice) or the customer menu price (menuPrice).' }], computedPrice: null, vendorPrice: null, sortOrder: null },
    ],
  },
};

export const IMPORT_ROW_NOT_EXACT = {
  index: 0, name: 'Third', action: 'invalid',
  errors: [{ field: 'menuPrice', code: 'MENU_PRICE_NOT_EXACT', message: 'Rs 10 cannot be split exactly at a 33.33% cut. The nearest price that works is Rs 9.99.', nearestPrice: 9.99 }],
  computedPrice: null, vendorPrice: null, sortOrder: null,
};

export const IMPORT_ROW_NEEDS_CUT = {
  index: 0, name: 'Plain', action: 'invalid',
  errors: [{ field: 'menuPrice', code: 'MENU_PRICE_NEEDS_CUT_RULE', message: 'A menu price can only be used when the commission is "Cut from sale". Enter the restaurant price instead, or change the commission to "Cut from sale" first.' }],
  computedPrice: null, vendorPrice: null, sortOrder: null,
};

export const ERR_PRICE_REQUIRED = { success: false, code: 'PRICE_REQUIRED', message: 'Send either the restaurant price (vendorPrice) or the customer menu price (menuPrice), not both.', field: 'menuPrice' };
export const ERR_NEEDS_CUT = { success: false, code: 'MENU_PRICE_NEEDS_CUT_RULE', message: 'A menu price can only be used when the commission is "Cut from sale". Enter the restaurant price instead, or change the commission to "Cut from sale" first.', field: 'menuPrice' };
export const ERR_NOT_EXACT = { success: false, code: 'MENU_PRICE_NOT_EXACT', message: 'Rs 10 cannot be split exactly at a 33.33% cut. The nearest price that works is Rs 9.99.', field: 'menuPrice', nearestPrice: 9.99 };
export const ERR_ORDER_INVALID = { success: false, code: 'MENU_ORDER_INVALID', message: 'This restaurant has no dishes in a section called "Biryani".', field: 'sections[1]' };

export const MENU_ORDER_SAVED = {
  success: true, changed: true, message: 'Menu order saved.', count: 3,
  data: [{ category: 'Desserts', dishCount: 1 }, { category: 'Snacks', dishCount: 2 }, { category: 'Main Course', dishCount: 3 }],
};
export const MENU_ORDER_UNCHANGED = { ...MENU_ORDER_SAVED, changed: false, message: 'Nothing to change: the menu already has this order.' };
