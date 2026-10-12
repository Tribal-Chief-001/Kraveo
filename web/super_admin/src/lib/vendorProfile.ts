// Edit-restaurant form rules (Docs/23 3.3): what the server accepts, in plain words, and which fields changed.
import type { Vendor } from '../types';
import type { VendorProfileChanges } from '../services/api';
import { isHttpUrl } from './pricing';

export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const ADDRESS_MIN = 3;
export const ADDRESS_MAX = 140;
export const BANNER_MAX = 500;

export interface ProfileForm {
  name: string;
  cuisineIds: string[];
  address: string;
  /** The banner web address; '' when none. */
  banner: string;
  /** "Use the default banner" was chosen (sent as null). */
  resetBanner: boolean;
  fssai: string;
  eta: string;
}

export type ProfileField = 'name' | 'cuisineIds' | 'address' | 'bannerImage' | 'fssaiNumber' | 'eta';
export const PROFILE_FIELDS: readonly ProfileField[] = ['name', 'cuisineIds', 'address', 'bannerImage', 'fssaiNumber', 'eta'];

export const FIELD_LABEL: Record<ProfileField, string> = { name: 'name', cuisineIds: 'categories', address: 'address', bannerImage: 'banner', fssaiNumber: 'FSSAI number', eta: 'delivery time' };

/** The form as it is when the drawer opens. The placeholder text the list shows for a missing address is not a value. */
export const formFromVendor = (vendor: Vendor): ProfileForm => ({
  name: vendor.name === 'Unnamed vendor' ? '' : vendor.name,
  cuisineIds: (vendor.cuisines ?? []).map((c) => c.id),
  address: vendor.address === 'Address unavailable' ? '' : vendor.address,
  banner: vendor.bannerImage ?? '',
  resetBanner: false,
  fssai: vendor.fssaiNumber ?? '',
  eta: vendor.eta ?? '',
});

const collapse = (text: string) => text.trim().replace(/\s+/g, ' ');

/** "15-20", "15 - 20 min", "15-20 mins" -> "15-20 min". Null when it is not a range of two numbers. */
export const normalizeEta = (raw: string): string | null => {
  const m = /^(\d{1,3})\s*-\s*(\d{1,3})(?:\s*min(?:s|utes)?)?$/i.exec(raw.trim());
  if (!m) return null;
  return `${Number(m[1])}-${Number(m[2])} min`;
};

export const digitsOnly = (text: string) => text.replace(/[\s-]/g, '');

/** Messages per field for the fields the admin changed. Untouched fields are never reported (old rows may not meet today's rules). */
export const validateProfile = (form: ProfileForm, base: ProfileForm, maxCategories: number): Partial<Record<ProfileField, string>> => {
  const errors: Partial<Record<ProfileField, string>> = {};
  const name = collapse(form.name);
  if (form.name !== base.name) {
    if (name.length < NAME_MIN) errors.name = 'Enter the restaurant name (at least 2 letters).';
    else if (name.length > NAME_MAX) errors.name = 'Keep the name to 60 characters or fewer.';
    else if (/[<>]/.test(name)) errors.name = 'The name cannot contain < or >.';
  }
  if (form.cuisineIds.length > maxCategories) errors.cuisineIds = `A restaurant can have at most ${maxCategories} categories.`;
  if (form.address !== base.address) {
    const address = collapse(form.address);
    if (address.length < ADDRESS_MIN) errors.address = 'Enter where the kitchen is (at least 3 letters).';
    else if (address.length > ADDRESS_MAX) errors.address = 'Keep the address to 140 characters or fewer.';
  }
  if (!form.resetBanner && form.banner !== base.banner) {
    const banner = form.banner.trim();
    if (banner === '') errors.bannerImage = 'Paste a link, upload a photo, or choose “Use the default banner”.';
    else if (!isHttpUrl(banner)) errors.bannerImage = 'Enter a full web address starting with https://';
    else if (banner.length > BANNER_MAX) errors.bannerImage = 'The link is too long (500 characters at most). Upload the photo instead.';
  }
  if (form.fssai !== base.fssai && form.fssai.trim() !== '' && !/^\d{14}$/.test(digitsOnly(form.fssai))) errors.fssaiNumber = 'The FSSAI number has exactly 14 digits. Leave it empty to remove it.';
  if (form.eta !== base.eta) {
    const eta = normalizeEta(form.eta);
    if (!eta) errors.eta = 'Write the time as a range, for example 15-20 min.';
    else {
      const [a, b] = eta.split(' ')[0].split('-').map(Number);
      if (a > b) errors.eta = 'The first number must not be bigger than the second, for example 15-20 min.';
    }
  }
  return errors;
};

/** Only the fields that differ from the saved restaurant, in the shape the server takes. Empty = nothing changed. */
export const profileChanges = (form: ProfileForm, base: ProfileForm): VendorProfileChanges => {
  const out: VendorProfileChanges = {};
  if (form.name !== base.name) out.name = collapse(form.name);
  if (form.cuisineIds.length !== base.cuisineIds.length || form.cuisineIds.some((id, i) => id !== base.cuisineIds[i])) out.cuisineIds = form.cuisineIds;
  if (form.address !== base.address) out.address = collapse(form.address);
  if (form.resetBanner) out.bannerImage = null;
  else if (form.banner !== base.banner) out.bannerImage = form.banner.trim();
  if (form.fssai !== base.fssai) out.fssaiNumber = form.fssai.trim() === '' ? null : digitsOnly(form.fssai);
  if (form.eta !== base.eta) { const eta = normalizeEta(form.eta); if (eta) out.eta = eta; }
  return out;
};

/** "name, categories and banner" for the success message. */
export const changedFieldsText = (changes: VendorProfileChanges): string => {
  const labels = PROFILE_FIELDS.filter((f) => f in changes).map((f) => FIELD_LABEL[f]);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
};
