import { describe, expect, it } from 'vitest';
import { normalizeVendor } from '../types';
import { NO_LOCATION_TEXT, formatAccuracy, formatSetDate, googleMapsUrl, pinSourceInfo, readPin, vendorsNeedingLocation } from './vendorLocation';

const PLACEHOLDER = { lat: 23.0768, lng: 76.8524 };
const PIN = { lat: 23.0745, lng: 76.859 };

describe('googleMapsUrl / formatAccuracy / formatSetDate', () => {
  it('builds the universal Google Maps link', () => {
    expect(googleMapsUrl(23.0745, 76.859)).toBe('https://www.google.com/maps/search/?api=1&query=23.0745,76.859');
  });
  it('rounds the accuracy and switches to km above 1 km; unknown stays null', () => {
    expect(formatAccuracy(12.4)).toBe('about 12 m');
    expect(formatAccuracy(0.2)).toBe('about 1 m');
    expect(formatAccuracy(0)).toBe('about 1 m');
    expect(formatAccuracy(1500)).toBe('about 1.5 km');
    for (const bad of [null, undefined, -3, NaN, Infinity]) expect(formatAccuracy(bad as any)).toBeNull();
  });
  it('formats the date in Indian time and tolerates junk', () => {
    expect(formatSetDate('2026-10-05T10:00:00.000Z')).toBe('5 Oct 2026');
    expect(formatSetDate('2026-10-05T20:00:00.000Z')).toBe('6 Oct 2026'); // already the 6th in IST
    expect(formatSetDate(null)).toBe('');
    expect(formatSetDate('not a date')).toBe('');
  });
});

describe('pinSourceInfo', () => {
  it('the restaurant set it: date and accuracy', () => {
    expect(pinSourceInfo({ ...PIN, hasLocation: true, locationSource: 'DEVICE', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: 12.2 }))
      .toEqual({ kind: 'DEVICE', label: 'Set by the restaurant on 5 Oct 2026, about 12 m' });
  });
  it('the restaurant set it without an accuracy or a date', () => {
    expect(pinSourceInfo({ ...PIN, hasLocation: true, locationSource: 'DEVICE' })).toEqual({ kind: 'DEVICE', label: 'Set by the restaurant' });
  });
  it('admin set it', () => {
    expect(pinSourceInfo({ ...PIN, hasLocation: true, locationSource: 'ADMIN' })).toEqual({ kind: 'ADMIN', label: 'Set by admin' });
    expect(pinSourceInfo({ ...PIN, hasLocation: true, locationSource: 'ADMIN', locationSetAt: '2026-10-05T10:00:00.000Z' }).label).toBe('Set by admin on 5 Oct 2026');
  });
  it('a real pin with no recorded source is "Location set" (older rows)', () => {
    expect(pinSourceInfo({ ...PIN, hasLocation: true })).toEqual({ kind: 'LEGACY', label: 'Location set' });
    expect(pinSourceInfo(PIN).kind).toBe('LEGACY'); // older server without hasLocation
  });
  it('the placeholder, 0,0, missing or hasLocation=false is "Not set" whatever the source says', () => {
    expect(pinSourceInfo({ ...PLACEHOLDER, hasLocation: false })).toEqual({ kind: 'NONE', label: 'Not set' });
    expect(pinSourceInfo(PLACEHOLDER).kind).toBe('NONE');
    expect(pinSourceInfo({ lat: 0, lng: 0 }).kind).toBe('NONE');
    expect(pinSourceInfo({}).kind).toBe('NONE');
    expect(pinSourceInfo({ lat: null, lng: null, hasLocation: true }).kind).toBe('NONE');
    expect(pinSourceInfo({ ...PLACEHOLDER, hasLocation: false, locationSource: 'DEVICE' }).kind).toBe('NONE');
  });
});

describe('vendorsNeedingLocation', () => {
  const v = (id: string, over: object = {}) => ({ id, ...PIN, hasLocation: true, approvalStatus: 'APPROVED', ...over });
  it('lists live restaurants without a real pin, not the ones that have one', () => {
    const list = [v('a'), v('b', { ...PLACEHOLDER, hasLocation: false }), v('c', { hasLocation: undefined, ...PLACEHOLDER })];
    expect(vendorsNeedingLocation(list).map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('ignores pending, rejected and suspended restaurants; an older server without a status counts as live', () => {
    const list = [v('p', { hasLocation: false, approvalStatus: 'PENDING' }), v('r', { hasLocation: false, approvalStatus: 'REJECTED' }), v('s', { hasLocation: false, approvalStatus: 'SUSPENDED' }), v('o', { hasLocation: false, approvalStatus: undefined })];
    expect(vendorsNeedingLocation(list).map((x) => x.id)).toEqual(['o']);
  });
  it('the warning text is the specified one', () => {
    expect(NO_LOCATION_TEXT).toBe('No location - riders cannot navigate to it');
  });
});

describe('server fields on the models', () => {
  it('readPin keeps valid values and nulls junk', () => {
    expect(readPin({ hasLocation: true, locationSource: 'DEVICE', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: 12 })).toEqual({ hasLocation: true, locationSource: 'DEVICE', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: 12 });
    expect(readPin({ locationSource: 'HACKED', locationSetAt: 5, locationAccuracyM: 'x' })).toEqual({ hasLocation: undefined, locationSource: null, locationSetAt: null, locationAccuracyM: null });
    expect(readPin(undefined)).toEqual({ hasLocation: undefined, locationSource: null, locationSetAt: null, locationAccuracyM: null });
  });
  it('normalizeVendor carries the location fields (and works on an older server row)', () => {
    const full = normalizeVendor({ id: 'v1', name: 'Dhaba', lat: 23.0745, lng: 76.859, hasLocation: true, locationSource: 'ADMIN', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: null });
    expect(full).toMatchObject({ lat: 23.0745, hasLocation: true, locationSource: 'ADMIN', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: null });
    const old = normalizeVendor({ id: 'v2', name: 'Old', lat: 23.0768, lng: 76.8524 });
    expect(old).toMatchObject({ hasLocation: undefined, locationSource: null, locationSetAt: null, locationAccuracyM: null });
  });
});
