import { describe, expect, it } from 'vitest';
import { DriverPin, normalizeDriverPin } from '../types';
import { formatLatLng, groupDropPins, FALLBACK_DROP_POINTS, campusCenter, isNearCampus, parseLocationInput, vendorHasRealPin } from './campus';
import { STALE_AFTER_MS, ageLabel, countByState, mergeRiderPins, newestPerRider, replaceRiderPins, riderMarkerState } from './riderMarkers';

const NOW = Date.parse('2026-10-06T10:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const pin = (id: string, over: Partial<DriverPin> = {}): DriverPin => ({ id, name: `R${id}`, lat: 23.0735, lng: 76.859, heading: 0, status: 'IDLE', lastUpdated: ago(5_000), dutyStatus: 'ONLINE', ...over });

describe('riderMarkerState', () => {
  it('idle: on duty, fresh, no order', () => {
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: ago(10_000), now: NOW })).toBe('idle');
  });
  it('to restaurant: accepted / preparing / ready', () => {
    for (const orderStatus of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
      expect(riderMarkerState({ dutyStatus: 'IN_TRANSIT', lastUpdated: ago(1_000), orderStatus, now: NOW })).toBe('toRestaurant');
    }
  });
  it('delivering: picked up / at the gate', () => {
    for (const orderStatus of ['PICKED_UP', 'ARRIVED_AT_GATE']) {
      expect(riderMarkerState({ dutyStatus: 'IN_TRANSIT', lastUpdated: ago(1_000), orderStatus, now: NOW })).toBe('delivering');
    }
  });
  it('a finished or unknown order does not change idle', () => {
    for (const orderStatus of ['DELIVERED', 'CANCELLED', 'PLACED', 'WHATEVER', null, undefined]) {
      expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: ago(1_000), orderStatus, now: NOW })).toBe('idle');
    }
  });
  it('stale: older than 2 minutes, exactly 2 minutes is still fresh', () => {
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: ago(STALE_AFTER_MS), now: NOW })).toBe('idle');
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: ago(STALE_AFTER_MS + 1), now: NOW })).toBe('stale');
    expect(riderMarkerState({ dutyStatus: 'IN_TRANSIT', lastUpdated: ago(10 * 60_000), orderStatus: 'PICKED_UP', now: NOW })).toBe('stale');
  });
  it('stale when the time is missing or not a date', () => {
    expect(riderMarkerState({ dutyStatus: 'ONLINE', now: NOW })).toBe('stale');
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: 'garbage', now: NOW })).toBe('stale');
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: '', now: NOW })).toBe('stale');
  });
  it('offline beats everything, even a fresh position with an order', () => {
    expect(riderMarkerState({ dutyStatus: 'OFFLINE', lastUpdated: ago(1_000), orderStatus: 'PICKED_UP', now: NOW })).toBe('offline');
    expect(riderMarkerState({ dutyStatus: 'OFFLINE', lastUpdated: ago(60 * 60_000), now: NOW })).toBe('offline');
  });
  it('an older server without dutyStatus counts as on duty', () => {
    expect(riderMarkerState({ lastUpdated: ago(1_000), now: NOW })).toBe('idle');
  });
  it('a clock a little ahead of the server does not make a fix stale', () => {
    expect(riderMarkerState({ dutyStatus: 'ONLINE', lastUpdated: new Date(NOW + 5_000).toISOString(), now: NOW })).toBe('idle');
  });
});

describe('countByState / ageLabel', () => {
  it('counts every state, zero included', () => {
    expect(countByState(['idle', 'idle', 'offline'])).toEqual({ idle: 2, toRestaurant: 0, delivering: 0, stale: 0, offline: 1 });
  });
  it('labels ages', () => {
    expect(ageLabel(null)).toBe('no update yet');
    expect(ageLabel(1_000)).toBe('just now');
    expect(ageLabel(12_000)).toBe('12 s ago');
    expect(ageLabel(3 * 60_000)).toBe('3 min ago');
    expect(ageLabel(3 * 3_600_000)).toBe('3 h ago');
  });
});

describe('mergeRiderPins', () => {
  it('returns the same array when nothing changes', () => {
    const prev = [pin('a'), pin('b')];
    expect(mergeRiderPins(prev, [])).toBe(prev);
    expect(mergeRiderPins(prev, [{ ...prev[0] }])).toBe(prev);
  });
  it('replaces only the changed rider and keeps identity of the others', () => {
    const prev = [pin('a'), pin('b'), pin('c')];
    const next = mergeRiderPins(prev, [pin('b', { lat: 23.0736, lastUpdated: ago(1_000) })]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[2]).toBe(prev[2]);
    expect(next[1].lat).toBe(23.0736);
    expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
  it('adds a new rider at the front, once', () => {
    const prev = [pin('a')];
    const next = mergeRiderPins(prev, [pin('z'), pin('z')]);
    expect(next.map((p) => p.id)).toEqual(['z', 'a']);
  });
  it('ignores an older fix that arrives late', () => {
    const prev = [pin('a', { lat: 23.0740, lastUpdated: ago(1_000) })];
    const next = mergeRiderPins(prev, [pin('a', { lat: 23.0700, lastUpdated: ago(30_000) })]);
    expect(next).toBe(prev);
  });
  it('keeps duty status and name when an update does not carry them', () => {
    const prev = [pin('a', { name: 'Vikram', dutyStatus: 'IN_TRANSIT' })];
    const next = mergeRiderPins(prev, [pin('a', { name: 'Runner', dutyStatus: undefined, lat: 23.0741, lastUpdated: ago(500) })]);
    expect(next[0]).toMatchObject({ name: 'Vikram', dutyStatus: 'IN_TRANSIT', lat: 23.0741 });
  });
  it('a duty change alone is a change (offline marker must update)', () => {
    const prev = [pin('a')];
    const next = mergeRiderPins(prev, [{ ...prev[0], dutyStatus: 'OFFLINE' }]);
    expect(next).not.toBe(prev);
    expect(next[0].dutyStatus).toBe('OFFLINE');
  });
  it('newestPerRider keeps the latest of a burst', () => {
    const out = newestPerRider([pin('a', { lat: 1, lastUpdated: ago(3_000) }), pin('a', { lat: 2, lastUpdated: ago(1_000) }), pin('b')]);
    expect(out.find((p) => p.id === 'a')!.lat).toBe(2);
    expect(out).toHaveLength(2);
  });
});

describe('replaceRiderPins', () => {
  it('keeps the same array when the server list is identical', () => {
    const prev = [pin('a'), pin('b')];
    expect(replaceRiderPins(prev, [{ ...prev[0] }, { ...prev[1] }])).toBe(prev);
  });
  it('drops riders the server no longer lists and adds new ones', () => {
    const prev = [pin('a'), pin('b')];
    const next = replaceRiderPins(prev, [pin('b'), pin('c')]);
    expect(next.map((p) => p.id).sort()).toEqual(['b', 'c']);
    expect(next.find((p) => p.id === 'b')).toBe(prev[1]);
  });
  it('an empty server list empties the map', () => {
    expect(replaceRiderPins([pin('a')], [])).toEqual([]);
  });
});

describe('normalizeDriverPin', () => {
  it('reads the REST row (driverId) and the socket event (driverId + id)', () => {
    expect(normalizeDriverPin({ driverId: 'u1', driverName: 'Vikram', lat: 23.07, lng: 76.85, heading: 90, lastUpdated: 'x', dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' }))
      .toMatchObject({ id: 'u1', name: 'Vikram', lat: 23.07, lng: 76.85, heading: 90, dutyStatus: 'ONLINE', approvalStatus: 'APPROVED' });
    expect(normalizeDriverPin({ id: 'u2', driverId: 'u2', lat: '23.07', lng: '76.85' })).toMatchObject({ id: 'u2', name: 'Runner', lat: 23.07 });
  });
  it('rejects rows that would add a ghost marker', () => {
    expect(normalizeDriverPin({ lat: 23, lng: 76 })).toBeNull();
    expect(normalizeDriverPin({ driverId: 'u', lat: NaN, lng: 76 })).toBeNull();
    expect(normalizeDriverPin({ driverId: 'u', lat: 123, lng: 76 })).toBeNull();
    expect(normalizeDriverPin(null)).toBeNull();
  });
});

describe('campus helpers', () => {
  it('groups names that share a pin', () => {
    const pins = groupDropPins(FALLBACK_DROP_POINTS);
    expect(pins).toHaveLength(7);
    expect(pins.find((p) => p.names.includes('BH2'))!.names).toEqual(['BH2', 'BH3']);
    expect(pins.find((p) => p.names.includes('Special Block'))!.names).toEqual(['BH4', 'BH5', 'Special Block']);
  });
  it('centre is on campus and near the backend value', () => {
    const c = campusCenter();
    expect(isNearCampus(c.lat, c.lng)).toBe(true);
    expect(c.lat).toBeCloseTo(23.0739, 3);
    expect(c.lng).toBeCloseTo(76.8575, 3);
  });
  it('parses what Google Maps gives', () => {
    expect(parseLocationInput('23.0745, 76.8590')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(parseLocationInput('  23.0745 76.8590 ')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(parseLocationInput('(23.0745, 76.8590)')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(parseLocationInput('https://www.google.com/maps/@23.0745,76.859,17z')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(parseLocationInput('https://www.google.com/maps/place/X/data=!3d23.0745!4d76.859')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
    expect(parseLocationInput('https://maps.google.com/?q=23.0745,76.859')).toEqual({ ok: true, lat: 23.0745, lng: 76.859 });
  });
  it('explains what is wrong', () => {
    expect(parseLocationInput('')).toMatchObject({ ok: false });
    expect(parseLocationInput('somewhere')).toMatchObject({ ok: false });
    expect(parseLocationInput('23.0745')).toMatchObject({ ok: false });
    expect(parseLocationInput('95, 76.8')).toMatchObject({ ok: false, message: expect.stringContaining('Latitude') });
    expect(parseLocationInput('23.07, 190')).toMatchObject({ ok: false, message: expect.stringContaining('Longitude') });
    expect(parseLocationInput('28.6139, 77.2090')).toMatchObject({ ok: false, message: expect.stringContaining('km from the campus') });
    expect(parseLocationInput('76.8590, 23.0745')).toMatchObject({ ok: false }); // swapped
  });
  it('knows the placeholder pin is not a real location', () => {
    expect(vendorHasRealPin({ lat: 23.0768, lng: 76.8524 })).toBe(false);
    expect(vendorHasRealPin({ lat: 23.0768, lng: 76.8524, hasLocation: true })).toBe(true); // the server decides when it says
    expect(vendorHasRealPin({ lat: 23.0745, lng: 76.859, hasLocation: false })).toBe(false);
    expect(vendorHasRealPin({ lat: 23.0745, lng: 76.859 })).toBe(true);
    expect(vendorHasRealPin({})).toBe(false);
  });
  it('formats', () => {
    expect(formatLatLng(23.0745, 76.859)).toBe('23.07450, 76.85900');
  });
});
