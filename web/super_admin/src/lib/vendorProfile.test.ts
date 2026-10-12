import { describe, expect, it } from 'vitest';
import { changedFieldsText, formFromVendor, normalizeEta, profileChanges, validateProfile } from './vendorProfile';
import { normalizeVendor } from '../types';
import { rawVendor } from '../test/taxonomyFixtures';

const vendor = (over: Record<string, unknown> = {}) => normalizeVendor(rawVendor(over));

describe('formFromVendor', () => {
  it('starts from the saved restaurant', () => {
    expect(formFromVendor(vendor())).toEqual({
      name: 'Shape Kitchen & Co', cuisineIds: ['02236158-229f-48fc-9fe8-4b1220e74ed7', '72077a2d-9b97-48de-9956-8d0167228f34'], address: 'Ashta road, near gate 4',
      banner: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600', resetBanner: false, fssai: '12345678901234', eta: '15-20 min',
    });
  });
  it('placeholders the list shows for missing data are not treated as values', () => {
    const f = formFromVendor(normalizeVendor({ id: 'v', rating: 0, isAcceptingOrders: true }));
    expect(f).toMatchObject({ name: '', address: '', banner: '', fssai: '', eta: '', cuisineIds: [] });
  });
});

describe('normalizeEta', () => {
  it.each([['15-20', '15-20 min'], ['15 - 20 min', '15-20 min'], ['15-20 mins', '15-20 min'], ['5-10 Minutes', '5-10 min'], ['015-020', '15-20 min']])('%s -> %s', (raw, out) => expect(normalizeEta(raw)).toBe(out));
  it.each(['', '20', 'soon', '15-', '1000-2000', '15-20-30', '15:20'])('%s is not a range', (raw) => expect(normalizeEta(raw)).toBeNull());
});

describe('validateProfile', () => {
  const base = formFromVendor(vendor());
  it('an untouched form has no errors even when the saved values would not pass today (old rows)', () => {
    const oldBase = { ...base, eta: '25-35 mins', fssai: 'pending', name: 'A' };
    expect(validateProfile(oldBase, oldBase, 6)).toEqual({});
  });
  it('checks only the fields that changed, with plain messages', () => {
    const f = { ...base, name: 'X', address: 'ab', fssai: '123', eta: '30-20' };
    const e = validateProfile(f, base, 6);
    expect(e.name).toBe('Enter the restaurant name (at least 2 letters).');
    expect(e.address).toBe('Enter where the kitchen is (at least 3 letters).');
    expect(e.fssaiNumber).toBe('The FSSAI number has exactly 14 digits. Leave it empty to remove it.');
    expect(e.eta).toContain('first number must not be bigger');
  });
  it('limits: name 60, address 140, banner link, 6 categories', () => {
    expect(validateProfile({ ...base, name: 'x'.repeat(61) }, base, 6).name).toMatch(/60/);
    expect(validateProfile({ ...base, name: 'a<b' }, base, 6).name).toMatch(/cannot contain/);
    expect(validateProfile({ ...base, address: 'x'.repeat(141) }, base, 6).address).toMatch(/140/);
    expect(validateProfile({ ...base, banner: 'ftp://x' }, base, 6).bannerImage).toMatch(/https/);
    expect(validateProfile({ ...base, banner: `https://x.test/${'a'.repeat(500)}` }, base, 6).bannerImage).toMatch(/500/);
    expect(validateProfile({ ...base, banner: '  ' }, base, 6).bannerImage).toMatch(/default banner/);
    expect(validateProfile({ ...base, cuisineIds: ['1', '2', '3', '4', '5', '6', '7'] }, base, 6).cuisineIds).toBe('A restaurant can have at most 6 categories.');
  });
  it('resetting the banner is valid, FSSAI may be cleared, spaces and dashes in FSSAI are ignored', () => {
    expect(validateProfile({ ...base, banner: '', resetBanner: true }, base, 6)).toEqual({});
    expect(validateProfile({ ...base, fssai: '' }, base, 6)).toEqual({});
    expect(validateProfile({ ...base, fssai: '1234 5678 9012 99' }, base, 6)).toEqual({});
  });
});

describe('profileChanges', () => {
  const base = formFromVendor(vendor());
  it('nothing changed -> empty', () => {
    expect(profileChanges(base, base)).toEqual({});
  });
  it('only the changed keys, normalised', () => {
    const f = { ...base, name: '  New   Name ', cuisineIds: [...base.cuisineIds].reverse(), address: ' Gate 2 ', fssai: '1234 5678 9012 99', eta: '10 - 15' };
    expect(profileChanges(f, base)).toEqual({
      name: 'New Name', cuisineIds: ['72077a2d-9b97-48de-9956-8d0167228f34', '02236158-229f-48fc-9fe8-4b1220e74ed7'], address: 'Gate 2', fssaiNumber: '12345678901299', eta: '10-15 min',
    });
  });
  it('banner: reset sends null, a new link is trimmed, same link is not sent', () => {
    expect(profileChanges({ ...base, resetBanner: true, banner: '' }, base)).toEqual({ bannerImage: null });
    expect(profileChanges({ ...base, banner: ' https://x.test/a.webp ' }, base)).toEqual({ bannerImage: 'https://x.test/a.webp' });
    expect(profileChanges({ ...base }, base)).toEqual({});
  });
  it('clearing FSSAI sends null; clearing all categories sends an empty list', () => {
    expect(profileChanges({ ...base, fssai: '' }, base)).toEqual({ fssaiNumber: null });
    expect(profileChanges({ ...base, cuisineIds: [] }, base)).toEqual({ cuisineIds: [] });
  });
  it('describes what changed in words', () => {
    expect(changedFieldsText({})).toBe('');
    expect(changedFieldsText({ name: 'x' })).toBe('name');
    expect(changedFieldsText({ name: 'x', cuisineIds: [], bannerImage: null })).toBe('name, categories and banner');
  });
});
