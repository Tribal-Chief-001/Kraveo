import { vendorHasLocation } from '../config/campus';

/**
 * Restaurant map pin bookkeeping (Docs/20_vendor_location_contract.md).
 * `Vendor.locationSource` is DEVICE (the restaurant's own phone) or ADMIN (typed in the dashboard); null = never set / legacy row.
 */
export type LocationSource = 'DEVICE' | 'ADMIN';

/** Columns every vendor query that feeds a location view must select. */
export const VENDOR_LOCATION_SELECT = { lat: true, lng: true, locationSource: true, locationSetAt: true, locationAccuracyM: true } as const;

/** Largest GPS accuracy radius (metres) the API accepts; anything above is useless as a pin and is treated as bad input. */
export const MAX_ACCURACY_M = 5000;

/** The location fields every partner / admin view carries. */
export const vendorLocationView = (v: any) => ({
  hasLocation: vendorHasLocation(v?.lat, v?.lng),
  lat: typeof v?.lat === 'number' ? v.lat : null,
  lng: typeof v?.lng === 'number' ? v.lng : null,
  locationSource: (v?.locationSource ?? null) as LocationSource | null,
  locationSetAt: v?.locationSetAt ?? null,
  locationAccuracyM: typeof v?.locationAccuracyM === 'number' ? v.locationAccuracyM : null,
});

/** Optional accuracy radius in metres: absent/null = null, otherwise a finite JSON number 0..5000. Strings are rejected. */
export const checkAccuracy = (raw: unknown): { ok: true; value: number | null } | { ok: false; message: string } => {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_ACCURACY_M) {
    return { ok: false, message: `Accuracy must be a number between 0 and ${MAX_ACCURACY_M} metres.` };
  }
  return { ok: true, value: raw };
};

/** Columns to write when an admin sets the pin (existing endpoint, create paths). */
export const adminPinData = (lat: number, lng: number) => ({ lat, lng, locationSource: 'ADMIN' as const, locationSetAt: new Date(), locationAccuracyM: null });

/** Columns to write when the restaurant's phone sets the pin. */
export const devicePinData = (lat: number, lng: number, accuracyM: number | null) => ({ lat, lng, locationSource: 'DEVICE' as const, locationSetAt: new Date(), locationAccuracyM: accuracyM });

/** "23.074500, 76.859000 (set by admin)" or "not set" - for audit lines. */
export const describePin = (v: { lat?: unknown; lng?: unknown; locationSource?: unknown }): string =>
  vendorHasLocation(v.lat, v.lng)
    ? `${(v.lat as number).toFixed(6)}, ${(v.lng as number).toFixed(6)}${v.locationSource ? ` (${String(v.locationSource).toLowerCase()})` : ''}`
    : 'not set';
