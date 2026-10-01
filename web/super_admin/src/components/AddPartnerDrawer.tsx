import React, { useEffect, useState } from 'react';
import { Bike, Check, Copy, Loader2, RefreshCw, Store } from 'lucide-react';
import { NewPartnerInput, PartnerKind } from '../types';
import { apiService } from '../services/api';
import { copyText, generatePassword } from '../lib/credentials';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { useToast } from './ui/Toast';

interface Props {
  open: boolean;
  kind: PartnerKind;
  onClose: () => void;
  /** Called after the account exists, so the lists can refresh. */
  onCreated: () => void;
}

const VEHICLES = ['Bike', 'Scooter', 'Cycle', 'On foot'];
const NO_PLATE = new Set(['Cycle', 'On foot']);
const CATEGORIES = ['North Indian', 'South Indian', 'Chinese', 'Rolls & Wraps', 'Tea & Snacks', 'Biryani', 'Fast food', 'Desserts'];

type Form = Record<'name' | 'phone' | 'password' | 'restaurantName' | 'category' | 'address' | 'fssaiNumber' | 'vehicleType' | 'vehicleRegNo' | 'emergencyPhone' | 'upiId', string>;
const EMPTY: Form = { name: '', phone: '', password: '', restaurantName: '', category: '', address: '', fssaiNumber: '', vehicleType: 'Bike', vehicleRegNo: '', emergencyPhone: '', upiId: '' };

const digits = (v: string) => v.replace(/\D/g, '').slice(-10);

const validate = (kind: PartnerKind, f: Form): Partial<Record<keyof Form, string>> => {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.name.trim().length < 2) e.name = kind === 'VENDOR' ? 'Enter the owner’s name.' : 'Enter the rider’s name.';
  if (!/^[6-9]\d{9}$/.test(digits(f.phone))) e.phone = 'Enter a valid 10-digit mobile number.';
  if (f.password.length < 8) e.password = 'At least 8 characters. Use Generate for a strong one.';
  if (kind === 'VENDOR') {
    if (f.restaurantName.trim().length < 2) e.restaurantName = 'Enter the restaurant name.';
    if (f.address.trim().length < 3) e.address = 'Enter where the kitchen is.';
    if (f.fssaiNumber.trim() && !/^\d{14}$/.test(f.fssaiNumber.replace(/\s/g, ''))) e.fssaiNumber = 'FSSAI number has 14 digits. Leave empty if not available.';
  } else {
    if (!NO_PLATE.has(f.vehicleType) && f.vehicleRegNo.trim().length < 4) e.vehicleRegNo = 'Enter the number plate (leave a note if not known yet).';
    if (f.emergencyPhone.trim() && !/^[6-9]\d{9}$/.test(digits(f.emergencyPhone))) e.emergencyPhone = 'Enter a valid 10-digit number or leave empty.';
    if (f.upiId.trim() && !/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(f.upiId.trim())) e.upiId = 'Example: name@upi';
  }
  return e;
};

/** Add a restaurant (with its owner login) or a rider. The account is approved immediately and the login details are shown once. */
export const AddPartnerDrawer: React.FC<Props> = ({ open, kind, onClose, onCreated }) => {
  const toast = useToast();
  const [form, setForm] = useState<Form>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ phone: string; password: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, password: generatePassword() });
      setTouched(false); setError(''); setCreated(null); setCopied(false);
    }
  }, [open, kind]);

  const errors = validate(kind, form);
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((c) => ({ ...c, [key]: e.target.value }));
  const show = (key: keyof Form) => (touched ? errors[key] : undefined);
  const isVendor = kind === 'VENDOR';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true); setError('');
    const input: NewPartnerInput = {
      role: kind,
      name: form.name.trim(),
      phone: digits(form.phone),
      password: form.password,
      ...(isVendor
        ? { restaurantName: form.restaurantName.trim(), category: form.category.trim() || 'Campus kitchen', address: form.address.trim(), fssaiNumber: form.fssaiNumber.replace(/\s/g, '') }
        : { vehicleType: form.vehicleType, vehicleRegNo: form.vehicleRegNo.trim(), emergencyPhone: digits(form.emergencyPhone) || '', upiId: form.upiId.trim() }),
    };
    try {
      await apiService.createPartner(input);
      setCreated({ phone: digits(form.phone), password: form.password, name: isVendor ? form.restaurantName.trim() : form.name.trim() });
      onCreated();
      toast.success(isVendor ? 'Restaurant added' : 'Rider added', 'The account is approved and ready to log in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The account could not be created.');
    } finally { setSaving(false); }
  };

  const loginText = created ? `Kraveo ${isVendor ? 'Restaurant Partner' : 'Delivery Partner'} login\nPhone: ${created.phone}\nPassword: ${created.password}` : '';
  const copyLogin = async () => { setCopied(await copyText(loginText)); };

  return (
    <Drawer
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      title={created ? 'Account ready' : isVendor ? 'Add a restaurant' : 'Add a rider'}
      subtitle={created ? 'Share the login with them now' : isVendor ? 'Creates the restaurant and its owner login' : 'Creates a rider login'}
      icon={isVendor ? Store : Bike}
      footer={created ? (
        <div className="flex gap-3"><button type="button" onClick={onClose} className="k-btn-primary flex-1">Done</button></div>
      ) : (
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={saving} className="k-btn-ghost flex-1">Cancel</button>
          <button type="submit" form="add-partner-form" disabled={saving} className="k-btn-primary flex-1" aria-busy={saving}>
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : isVendor ? 'Add restaurant' : 'Add rider'}
          </button>
        </div>
      )}
    >
      {created ? (
        <div className="space-y-4">
          <div className="rounded-k-md border border-kraveo-g400/30 bg-kraveo-g400/10 p-4 text-sm text-kraveo-ink">
            <p className="font-bold">{created.name} can log in now.</p>
            <p className="mt-1 text-kraveo-ink2">This password is shown only here. Send it to them, then ask them to keep it safe.</p>
          </div>
          <div className="k-inset space-y-3 p-4 font-mono text-sm">
            <div><p className="k-label font-body">Phone</p><p className="text-base font-bold text-kraveo-ink">{created.phone}</p></div>
            <div><p className="k-label font-body">Password</p><p className="select-all text-base font-bold text-kraveo-ink">{created.password}</p></div>
          </div>
          <button type="button" onClick={copyLogin} className="k-btn-accent w-full">
            {copied ? <><Check className="h-4 w-4" aria-hidden="true" />Copied</> : <><Copy className="h-4 w-4" aria-hidden="true" />Copy login details</>}
          </button>
        </div>
      ) : (
        <form id="add-partner-form" onSubmit={submit} className="space-y-5" noValidate>
          {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}
          {isVendor && (
            <>
              <Field label="Restaurant name" htmlFor="ap-restaurant" required error={show('restaurantName')}>
                <input id="ap-restaurant" className="k-input" value={form.restaurantName} onChange={set('restaurantName')} placeholder="Name as students know it" aria-invalid={Boolean(show('restaurantName'))} />
              </Field>
              <Field label="Cuisine or category" htmlFor="ap-category">
                <input id="ap-category" className="k-input" list="ap-categories" value={form.category} onChange={set('category')} placeholder="For example: North Indian" />
                <datalist id="ap-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Where is the kitchen?" htmlFor="ap-address" required error={show('address')}>
                <input id="ap-address" className="k-input" value={form.address} onChange={set('address')} placeholder="Area or landmark near campus" aria-invalid={Boolean(show('address'))} />
              </Field>
              <Field label="FSSAI licence number" htmlFor="ap-fssai" hint="Optional now. 14 digits." error={show('fssaiNumber')}>
                <input id="ap-fssai" className="k-input" inputMode="numeric" value={form.fssaiNumber} onChange={set('fssaiNumber')} aria-invalid={Boolean(show('fssaiNumber'))} />
              </Field>
            </>
          )}
          <Field label={isVendor ? 'Owner name' : 'Full name'} htmlFor="ap-name" required error={show('name')}>
            <input id="ap-name" className="k-input" autoComplete="off" value={form.name} onChange={set('name')} aria-invalid={Boolean(show('name'))} />
          </Field>
          <Field label="Mobile number" htmlFor="ap-phone" required error={show('phone')} hint="They log in with this number.">
            <input id="ap-phone" className="k-input" inputMode="tel" autoComplete="off" value={form.phone} onChange={set('phone')} placeholder="98765 43210" aria-invalid={Boolean(show('phone'))} />
          </Field>
          <Field label="Password" htmlFor="ap-password" required error={show('password')}>
            <div className="flex gap-2">
              <input id="ap-password" className="k-input font-mono" autoComplete="off" value={form.password} onChange={set('password')} aria-invalid={Boolean(show('password'))} />
              <button type="button" className="k-btn-ghost shrink-0" onClick={() => setForm((c) => ({ ...c, password: generatePassword() }))} aria-label="Generate a new password">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />Generate
              </button>
            </div>
          </Field>
          {!isVendor && (
            <>
              <Field label="Vehicle" htmlFor="ap-vehicle" required>
                <select id="ap-vehicle" className="k-select" value={form.vehicleType} onChange={set('vehicleType')}>{VEHICLES.map((v) => <option key={v}>{v}</option>)}</select>
              </Field>
              {!NO_PLATE.has(form.vehicleType) && (
                <Field label="Number plate" htmlFor="ap-plate" required error={show('vehicleRegNo')}>
                  <input id="ap-plate" className="k-input uppercase" value={form.vehicleRegNo} onChange={set('vehicleRegNo')} placeholder="MP04 AB 1234" aria-invalid={Boolean(show('vehicleRegNo'))} />
                </Field>
              )}
              <Field label="Emergency contact" htmlFor="ap-emergency" hint="Optional. Someone else’s number." error={show('emergencyPhone')}>
                <input id="ap-emergency" className="k-input" inputMode="tel" value={form.emergencyPhone} onChange={set('emergencyPhone')} aria-invalid={Boolean(show('emergencyPhone'))} />
              </Field>
              <Field label="UPI id for payouts" htmlFor="ap-upi" hint="Optional." error={show('upiId')}>
                <input id="ap-upi" className="k-input" value={form.upiId} onChange={set('upiId')} placeholder="name@upi" aria-invalid={Boolean(show('upiId'))} />
              </Field>
            </>
          )}
        </form>
      )}
    </Drawer>
  );
};
