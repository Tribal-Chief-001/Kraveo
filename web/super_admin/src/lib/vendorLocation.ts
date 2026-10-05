// Restaurant map pin: where it came from and how to show that (Docs/20_vendor_location_contract.md section 1).
// Pure helpers, so the wording is unit-tested.
import { vendorHasRealPin } from './campus';

export type LocationSource = 'DEVICE' | 'ADMIN';

/** The location fields the server puts on a vendor row, an application's `vendor` and `/partner/me`. All optional: an older server sends none. */
export interface PinInfo {
  lat?: number | null;
  lng?: number | null;
  hasLocation?: boolean;
  locationSource?: LocationSource | null;
  locationSetAt?: string | null;
  locationAccuracyM?: number | null;
}

/** "Open in Google Maps" link for a point (the universal URL: opens the app on a phone, the site on a desktop). */
export const googleMapsUrl = (lat: number, lng: number): string => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

/** "about 12 m" (rounded; at least 1 m) or "about 1.2 km"; null when unknown. */
export const formatAccuracy = (m?: number | null): string | null => {
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return null;
  if (m >= 1000) return `about ${(m / 1000).toFixed(1)} km`;
  return `about ${Math.max(1, Math.round(m))} m`;
};

/** "5 Oct 2026" in Indian time (the dashboard is used on campus); empty for a missing or unreadable date. */
export const formatSetDate = (iso?: string | null): string => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

export type PinKind = 'DEVICE' | 'ADMIN' | 'LEGACY' | 'NONE';

export interface PinSourceInfo { kind: PinKind; label: string }

/**
 * The badge text:
 *   DEVICE -> "Set by the restaurant on 5 Oct 2026, about 12 m"
 *   ADMIN  -> "Set by admin" (+ " on 5 Oct 2026" when the time is known)
 *   LEGACY -> a real pin with no recorded source (set before this feature existed)
 *   NONE   -> "Not set"
 */
export const pinSourceInfo = (p: PinInfo): PinSourceInfo => {
  const has = vendorHasRealPin(p);
  if (!has) return { kind: 'NONE', label: 'Not set' };
  const date = formatSetDate(p.locationSetAt);
  if (p.locationSource === 'DEVICE') {
    const acc = formatAccuracy(p.locationAccuracyM);
    return { kind: 'DEVICE', label: `Set by the restaurant${date ? ` on ${date}` : ''}${acc ? `, ${acc}` : ''}` };
  }
  if (p.locationSource === 'ADMIN') return { kind: 'ADMIN', label: `Set by admin${date ? ` on ${date}` : ''}` };
  return { kind: 'LEGACY', label: 'Location set' };
};

/** Restaurants that are live (approved, or from an older server that does not say) but have no real pin: riders cannot navigate to them. */
export const vendorsNeedingLocation = <T extends PinInfo & { approvalStatus?: string }>(vendors: T[]): T[] =>
  vendors.filter((v) => (v.approvalStatus === undefined || v.approvalStatus === 'APPROVED') && !vendorHasRealPin(v));

export const NO_LOCATION_TEXT = 'No location - riders cannot navigate to it';

/** Reads the location fields off a raw server object (vendor row, application vendor). */
export const readPin = (raw: any): { hasLocation?: boolean; locationSource: LocationSource | null; locationSetAt: string | null; locationAccuracyM: number | null } => ({
  hasLocation: typeof raw?.hasLocation === 'boolean' ? raw.hasLocation : undefined,
  locationSource: raw?.locationSource === 'DEVICE' || raw?.locationSource === 'ADMIN' ? raw.locationSource : null,
  locationSetAt: typeof raw?.locationSetAt === 'string' ? raw.locationSetAt : null,
  locationAccuracyM: typeof raw?.locationAccuracyM === 'number' && Number.isFinite(raw.locationAccuracyM) ? raw.locationAccuracyM : null,
});

/** What the dashboard learns when an admin saves a pin (PATCH /api/admin/vendors/:id/location). */
export interface SavedPin {
  lat: number;
  lng: number;
  hasLocation: boolean;
  locationSource: LocationSource;
  locationSetAt: string;
  locationAccuracyM: number | null;
}
