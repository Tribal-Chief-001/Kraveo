/**
 * Campus data: the single source of truth for delivery drop points (Docs/19_campus_maps_contract.md section 1).
 * The mobile apps keep a mirrored constant list for offline use; `GET /api/campus` serves this one.
 *
 * Several names share one pin on purpose (the blocks are close together).
 */
export type DropPointGroup = 'boys' | 'girls';
export type DropPoint = { id: string; name: string; group: DropPointGroup; lat: number; lng: number };

const point = (name: string, group: DropPointGroup, lat: number, lng: number): DropPoint => ({ id: name, name, group, lat, lng });

/** Display / list order is exactly this order. */
export const DROP_POINTS: readonly DropPoint[] = Object.freeze([
  point('BH1', 'boys', 23.074861, 76.859889),
  point('BH2', 'boys', 23.073556, 76.859861),
  point('BH3', 'boys', 23.073556, 76.859861),
  point('BH4', 'boys', 23.073361, 76.858389),
  point('BH5', 'boys', 23.073361, 76.858389),
  point('Special Block', 'boys', 23.073361, 76.858389),
  point('BH6', 'boys', 23.07275, 76.86),
  point('BH7', 'boys', 23.072889, 76.859222),
  point('BH8', 'boys', 23.072889, 76.859222),
  point('GH1', 'girls', 23.074778, 76.851972),
  point('GH2', 'girls', 23.074917, 76.853194),
]);

export const DROP_POINT_NAMES: readonly string[] = DROP_POINTS.map((p) => p.name);

const BY_LOWER = new Map(DROP_POINTS.map((p) => [p.name.toLowerCase(), p.name] as const));

/** Arithmetic mean of the distinct pins (not of the names, so shared pins do not count twice). */
export const CAMPUS_CENTER: { lat: number; lng: number } = (() => {
  const distinct = new Map<string, DropPoint>();
  for (const p of DROP_POINTS) distinct.set(`${p.lat},${p.lng}`, p);
  const pins = [...distinct.values()];
  return {
    lat: pins.reduce((s, p) => s + p.lat, 0) / pins.length,
    lng: pins.reduce((s, p) => s + p.lng, 0) / pins.length,
  };
})();

/** Locations further than this from the campus centre are rejected for restaurants. */
export const NEAR_CAMPUS_KM = 3;

/** Legacy spellings that old apps, stored profiles and old orders contain. N is checked against the real range below. */
const LEGACY_BLOCK_RE = /^(?:boys hostel block|block) ([1-6])$/;
const LEGACY_GATE_RE = /^(?:girls hostel gate|girls gate) ([12])$/;

/**
 * Canonical drop point name for any accepted spelling, or null.
 * Accepts the canonical names (case-insensitive) and the legacy forms `Block N`, `Boys Hostel Block N` (N 1..6 -> BHN),
 * `Girls Gate N`, `Girls Hostel Gate N` (N 1..2 -> GHN); extra spaces are tolerated. `VIT Main Gate` and anything else is null.
 */
export function normalizeDropPoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!s || s.length > 40) return null;
  const direct = BY_LOWER.get(s);
  if (direct) return direct;
  const block = LEGACY_BLOCK_RE.exec(s);
  if (block) return `BH${block[1]}`;
  const gate = LEGACY_GATE_RE.exec(s);
  if (gate) return `GH${gate[1]}`;
  return null;
}

/** Coordinates of a drop point (any accepted spelling), or null when the name is not a drop point. */
export function dropPointCoords(name: unknown): { lat: number; lng: number } | null {
  const canonical = normalizeDropPoint(name);
  if (!canonical) return null;
  const p = DROP_POINTS.find((d) => d.name === canonical);
  return p ? { lat: p.lat, lng: p.lng } : null;
}

/** `{ name, lat, lng }` for OrderView, or null when the stored text is not a drop point (very old data). */
export function dropoffView(stored: unknown): { name: string; lat: number; lng: number } | null {
  const canonical = normalizeDropPoint(stored);
  const coords = canonical ? dropPointCoords(canonical) : null;
  return canonical && coords ? { name: canonical, ...coords } : null;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when the point is a valid coordinate within 3 km of the campus centre. */
export function isNearCampus(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return distanceKm(CAMPUS_CENTER, { lat, lng }) <= NEAR_CAMPUS_KM;
}

/** The pin every restaurant got before it had a real one (schema default). */
export const PLACEHOLDER_VENDOR_PIN = Object.freeze({ lat: 23.0768, lng: 76.8524 });

/** A restaurant has a real pin when it is a finite coordinate and not the schema's placeholder (or 0,0). */
export function vendorHasLocation(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return !(Math.abs(lat - PLACEHOLDER_VENDOR_PIN.lat) < 1e-9 && Math.abs(lng - PLACEHOLDER_VENDOR_PIN.lng) < 1e-9);
}

export type LocationCheck = { ok: true; lat: number; lng: number } | { ok: false; field: 'lat' | 'lng' | 'location'; message: string };

/** Validates a restaurant pin from untrusted input: numbers (not strings), real ranges, and on campus. */
export function checkVendorLocation(lat: unknown, lng: unknown): LocationCheck {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, field: 'lat', message: 'Latitude must be a number between -90 and 90.' };
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, field: 'lng', message: 'Longitude must be a number between -180 and 180.' };
  if (!isNearCampus(lat, lng)) return { ok: false, field: 'location', message: `The location must be within ${NEAR_CAMPUS_KM} km of the campus.` };
  return { ok: true, lat, lng };
}
