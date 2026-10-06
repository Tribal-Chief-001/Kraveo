// Campus constants for the dashboard map (Docs/19_campus_maps_contract.md section 1). The server's `GET /api/campus`
// is the source of truth; this mirror is what the map uses until that answer arrives (or when it never does), so the
// map never depends on a second request to draw the drop points. Keep the numbers identical to backend/src/config/campus.ts.

export type DropPointGroup = 'boys' | 'girls';
export interface DropPointInfo { id: string; name: string; group: DropPointGroup; lat: number; lng: number }

const dp = (name: string, group: DropPointGroup, lat: number, lng: number): DropPointInfo => ({ id: name, name, group, lat, lng });

export const FALLBACK_DROP_POINTS: DropPointInfo[] = [
  dp('BH1', 'boys', 23.074861, 76.859889),
  dp('BH2', 'boys', 23.073556, 76.859861),
  dp('BH3', 'boys', 23.073556, 76.859861),
  dp('BH4', 'boys', 23.073361, 76.858389),
  dp('BH5', 'boys', 23.073361, 76.858389),
  dp('Special Block', 'boys', 23.073361, 76.858389),
  dp('BH6', 'boys', 23.07275, 76.86),
  dp('BH7', 'boys', 23.072889, 76.859222),
  dp('BH8', 'boys', 23.072889, 76.859222),
  dp('GH1', 'girls', 23.074778, 76.851972),
  dp('GH2', 'girls', 23.074917, 76.853194),
];

export interface LatLng { lat: number; lng: number }

/** One entry per distinct pin; names that share a pin are listed together (BH2 and BH3 are the same spot). */
export interface DropPin extends LatLng { key: string; names: string[]; group: DropPointGroup }

export const groupDropPins = (points: DropPointInfo[]): DropPin[] => {
  const byKey = new Map<string, DropPin>();
  for (const p of points) {
    const key = `${p.lat},${p.lng}`;
    const existing = byKey.get(key);
    if (existing) existing.names.push(p.name);
    else byKey.set(key, { key, names: [p.name], group: p.group, lat: p.lat, lng: p.lng });
  }
  return [...byKey.values()];
};

/** Mean of the distinct pins (same definition as the server). */
export const campusCenter = (points: DropPointInfo[] = FALLBACK_DROP_POINTS): LatLng => {
  const pins = groupDropPins(points);
  if (pins.length === 0) return { lat: 23.0735, lng: 76.857 };
  return { lat: pins.reduce((s, p) => s + p.lat, 0) / pins.length, lng: pins.reduce((s, p) => s + p.lng, 0) / pins.length };
};

export const NEAR_CAMPUS_KM = 3;
/** The pin every restaurant has until an admin sets a real one. */
export const PLACEHOLDER_PIN: LatLng = { lat: 23.0768, lng: 76.8524 };

const rad = (deg: number) => (deg * Math.PI) / 180;
export const distanceKm = (a: LatLng, b: LatLng): number => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const isNearCampus = (lat: number, lng: number, center: LatLng = campusCenter()): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && distanceKm(center, { lat, lng }) <= NEAR_CAMPUS_KM;

/** A restaurant has a real pin when the server says so, or (older server) when it is a finite pin that is not the placeholder. */
export const vendorHasRealPin = (v: { lat?: number | null; lng?: number | null; hasLocation?: boolean }): boolean => {
  if (typeof v.hasLocation === 'boolean') return v.hasLocation && Number.isFinite(v.lat) && Number.isFinite(v.lng);
  if (typeof v.lat !== 'number' || typeof v.lng !== 'number' || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return false;
  if (v.lat === 0 && v.lng === 0) return false;
  return !(Math.abs(v.lat - PLACEHOLDER_PIN.lat) < 1e-9 && Math.abs(v.lng - PLACEHOLDER_PIN.lng) < 1e-9);
};

export type LocationParse = { ok: true; lat: number; lng: number } | { ok: false; message: string };

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(String.raw`^\(?\s*(${NUM})\s*(?:,|;|\s)\s*(${NUM})\s*\)?$`);
const AT = new RegExp(String.raw`@(${NUM}),(${NUM})`);
const BANG = new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`);
const QUERY = new RegExp(String.raw`[?&](?:q|ll|query|destination)=(${NUM})(?:,|%2C)(${NUM})`, 'i');

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const FORMAT_HELP = 'Paste the numbers from Google Maps, like 23.0745, 76.8590 or 23°04\'53.4"N 76°50\'35.0"E (a plus code or a short link cannot be read: right-click the pin and click the first line).';

// One coordinate written as degrees, optionally minutes and seconds, with a hemisphere letter before or after:
//   23°04'53.4"N   23°04.89'N   23.0815°N   23.0815 N   N 23.0815   N 23°04'53.4"   -23°04'53.4"   23 04 53.4 N
// Symbols are normalised first (º ˚ -> °, ′ ’ -> ', ″ ” '' -> "), and a comma inside a number is a decimal comma (53,4).
const NUMP = String.raw`\d{1,3}(?:[.,]\d+)?`;
const PARTS = String.raw`(-)?\s*(${NUMP})\s*°?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*'?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*"?)?)?`;
const COMP = new RegExp(String.raw`(?:([NSEW])\s*${PARTS}|${PARTS}\s*([NSEW])?)`, 'gi');
const HEMI_OR_DEG = /[°º˚]|(?:^|[^A-Za-z])[NSEW](?![A-Za-z])/i;

type Comp = { value: number; hemi: string | null; err?: string };

const readComponents = (text: string): Comp[] | { err: string } => {
  const norm = text
    .replace(/[º˚]/g, '°')
    .replace(/[′’‘`]/g, "'")
    .replace(/[″”“]/g, '"')
    .replace(/''/g, '"')
    .replace(/\s+/g, ' ');
  const out: Comp[] = [];
  COMP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMP.exec(norm)) !== null) {
    if (m[0].trim() === '') { COMP.lastIndex++; continue; }
    const pre = m[1] !== undefined;
    const [neg, deg, min, sec, post] = pre ? [m[2], m[3], m[4], m[5], undefined] : [m[6], m[7], m[8], m[9], m[10]];
    const hemi = (pre ? m[1] : post)?.toUpperCase() ?? null;
    const num = (x?: string) => Number((x ?? '0').replace(',', '.'));
    const d = num(deg), mi = num(min), se = num(sec);
    if (mi >= 60) return { err: 'Minutes must be below 60. Check the numbers.' };
    if (se >= 60) return { err: 'Seconds must be below 60. Check the numbers.' };
    let value = d + mi / 60 + se / 3600;
    if (neg || hemi === 'S' || hemi === 'W') value = -value;
    out.push({ value, hemi });
  }
  return out;
};

/**
 * Turns what an admin pastes from Google Maps into coordinates: "23.0745, 76.8590" (right-click -> first line),
 * "23.0745 76.8590", degrees-minutes-seconds like 23°04'53.4"N 76°50'35.0"E, or a maps link containing `@lat,lng`, `!3dlat!4dlng` or `?q=lat,lng`. Checks ranges and that the
 * point is on campus, with a message that says what to fix. The server validates again.
 */
export const parseLocationInput = (raw: string, center: LatLng = campusCenter()): LocationParse => {
  const text = raw.trim().replace(/ /g, ' ');
  if (!text) return { ok: false, message: 'Paste the coordinates from Google Maps, for example 23.0745, 76.8590.' };
  // Plain decimals, "@lat,lng", "!3d..!4d.." and "?q=lat,lng" first (below); everything with degree symbols or N/S/E/W letters here.
  if (!PAIR.test(text) && !BANG.test(text) && !AT.test(text) && !QUERY.test(text) && HEMI_OR_DEG.test(text)) {
    const comps = readComponents(text);
    if ('err' in comps) return { ok: false, message: comps.err };
    if (comps.length !== 2) return { ok: false, message: `Could not read that. ${FORMAT_HELP}` };
    const [a, b] = comps;
    const aLat = a.hemi ? /[NS]/.test(a.hemi) : null;
    const bLat = b.hemi ? /[NS]/.test(b.hemi) : null;
    if (a.hemi && b.hemi && aLat === bLat) return { ok: false, message: 'Use one north/south value and one east/west value, like 23°04\'53.4"N 76°50\'35.0"E.' };
    // The N/S value is the latitude; with no letters (or only one) the first number is the latitude.
    const aIsLat = aLat !== null ? aLat : bLat !== null ? !bLat : true;
    const lat = round6(aIsLat ? a.value : b.value);
    const lng = round6(aIsLat ? b.value : a.value);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, message: 'Those degrees are out of range. Check the numbers.' };
    if (!isNearCampus(lat, lng, center)) return { ok: false, message: farMessage(lat, lng, center) };
    return { ok: true, lat, lng };
  }
  const m = PAIR.exec(text) ?? BANG.exec(text) ?? AT.exec(text) ?? QUERY.exec(text);
  if (!m) return { ok: false, message: `Could not read that. ${FORMAT_HELP}` };
  const lat = round6(Number(m[1]));
  const lng = round6(Number(m[2]));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, message: `Could not read that. ${FORMAT_HELP}` };
  if (Math.abs(lat) > 90) return { ok: false, message: 'Latitude must be between -90 and 90. Did you swap the two numbers?' };
  if (Math.abs(lng) > 180) return { ok: false, message: 'Longitude must be between -180 and 180.' };
  if (!isNearCampus(lat, lng, center)) return { ok: false, message: farMessage(lat, lng, center) };
  return { ok: true, lat, lng };
};

/** The 'too far' message; says so when the two numbers look swapped (a very common slip). */
const farMessage = (lat: number, lng: number, center: LatLng): string =>
  Math.abs(lng) <= 90 && isNearCampus(lng, lat, center)
    ? `Latitude and longitude look swapped. Latitude (north) comes first: ${formatLatLng(lng, lat)}.`
    : `That point is more than ${NEAR_CAMPUS_KM} km from the campus. Check the numbers (latitude first).`;

export const formatLatLng = (lat: number, lng: number): string => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
