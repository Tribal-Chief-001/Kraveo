import React, { useCallback, useId, useRef, useState } from 'react';
import { ExternalLink, Image as ImageIcon, Loader2, TriangleAlert } from 'lucide-react';
import { ApiError, apiService } from '../services/api';
import {
  Banner, BannerForm, CTA_MAX, SUBTITLE_MAX, TITLE_MAX, changesOf, checkHttpsAddress, collapse, createBody, emptyForm, formFromBanner, imageHostWarning,
  scheduleText, validateCta, validateImageUrl, validateLink, validateSchedule, validateSubtitle, validateTitle, istToInstant,
} from '../lib/bannerParse';
import { errorText, fieldOf } from '../lib/errors';
import type { ImageEnv } from '../lib/imageCompress';
import { BannerPreview } from './BannerPreview';
import { ImageUploadField } from './ImageUploadField';
import { Drawer } from './ui/Drawer';
import { Field } from './ui/Field';
import { Switch } from './ui/Switch';
import { useConfirm } from './ui/ConfirmDialog';

type FormField = 'title' | 'subtitle' | 'imageUrl' | 'linkUrl' | 'ctaLabel' | 'startsAt' | 'endsAt';
const SERVER_FIELDS = ['title', 'subtitle', 'imageUrl', 'linkUrl', 'ctaLabel', 'startsAt', 'endsAt'] as const;

interface Props {
  /** null = add a banner. */
  banner: Banner | null;
  onClose: () => void;
  onSaved: (banner: Banner, created: boolean, message: string) => void;
  onAuthError: (error: unknown) => void;
  /** Tests inject a fake canvas for the picture upload. */
  imageEnv?: ImageEnv;
}

const HALF_FILLED = 'Enter the time too, or press Clear.';
const HOST_CODES: Partial<Record<FormField, string>> = { linkUrl: 'BANNER_LINK_INVALID', imageUrl: 'BANNER_IMAGE_INVALID' };

const count = (value: string) => Array.from(collapse(value)).length;

export const BannerDrawer: React.FC<Props> = ({ banner, onClose, onSaved, onAuthError, imageEnv }) => {
  const uid = useId();
  const id = (part: string) => `${uid}-${part}`;
  const initialForm = useRef<BannerForm>(banner ? formFromBanner(banner) : emptyForm()).current;
  const [form, setForm] = useState<BannerForm>(initialForm);
  // A half-typed date-time reports value '' (Chrome: validity.badInput). That must never read as "no schedule".
  const [bad, setBad] = useState<{ startsAt: boolean; endsAt: boolean }>({ startsAt: false, endsAt: false });
  const [pickerKey, setPickerKey] = useState<{ startsAt: number; endsAt: number }>({ startsAt: 0, endsAt: 0 });
  const { confirm, dialog } = useConfirm();
  const asking = useRef(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [serverField, setServerField] = useState<{ field: FormField; message: string; code?: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; message: string } | null>(null);
  const busy = useRef(false);
  const uploadingRef = useRef(false);
  const dirtyRef = useRef(false);

  const set = <K extends keyof BannerForm>(key: K, value: BannerForm[K]) => { setForm((c) => ({ ...c, [key]: value })); setServerField(null); setNotice(null); };

  const schedule = validateSchedule(form.startLocal, form.endLocal);
  const problems: Record<FormField, string> = {
    title: validateTitle(form.title),
    subtitle: validateSubtitle(form.subtitle),
    imageUrl: validateImageUrl(form.imageUrl),
    linkUrl: validateLink(form.linkUrl),
    ctaLabel: validateCta(form.ctaLabel),
    startsAt: bad.startsAt ? HALF_FILLED : schedule.start,
    endsAt: bad.endsAt ? HALF_FILLED : schedule.end,
  };
  // Inline messages for the text and date fields show as soon as the admin has typed something (the picture field waits for Save).
  const error = (field: FormField): string => {
    if (serverField?.field === field) return serverField.message;
    if (field === 'imageUrl') return touched ? problems.imageUrl : form.imageUrl.trim() !== '' ? problems.imageUrl : '';
    if (field === 'title') return touched || form.title !== '' ? problems.title : '';
    return problems[field];
  };

  const linkOk = form.linkUrl.trim() !== '' && problems.linkUrl === '';
  const testHref = linkOk ? checkHttpsAddress(form.linkUrl, 'The link').url : '';
  const hostWarning = imageHostWarning(form.imageUrl);
  const startInstant = form.startLocal.trim() ? istToInstant(form.startLocal) : null;
  const endInstant = form.endLocal.trim() ? istToInstant(form.endLocal) : null;
  const whenText = scheduleText({ startsAt: startInstant, endsAt: endInstant });

  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm) || bad.startsAt || bad.endsAt;

  const syncPicker = (key: 'startLocal' | 'endLocal', event: React.SyntheticEvent<HTMLInputElement>, takeValue: boolean) => {
    const field = key === 'startLocal' ? 'startsAt' : 'endsAt';
    const isBad = Boolean(event.currentTarget.validity?.badInput);
    setBad((c) => (c[field] === isBad ? c : { ...c, [field]: isBad }));
    if (takeValue) set(key, event.currentTarget.value);
  };
  const clearPicker = (key: 'startLocal' | 'endLocal') => {
    const field = key === 'startLocal' ? 'startsAt' : 'endsAt';
    set(key, '');
    setBad((c) => ({ ...c, [field]: false }));
    setPickerKey((c) => ({ ...c, [field]: c[field] + 1 })); // new element = the browser's half-typed text is gone too
  };

  // Close requests (Esc, backdrop, X, Cancel) are ignored while a save or an upload runs; unsaved edits ask first.
  const requestClose = useCallback(async () => {
    if (busy.current || uploadingRef.current || asking.current) return;
    if (dirtyRef.current) {
      asking.current = true;
      const ok = await confirm({ title: 'Discard changes?', message: 'What you typed in this banner will be lost.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true });
      asking.current = false;
      if (!ok || busy.current || uploadingRef.current) return;
    }
    onClose();
  }, [confirm, onClose]);

  // The server may limit links / pictures to a list of sites (operator setting) and names them in its message, which is shown in full above.
  const serverHint = (f: FormField) => (serverField?.field === f && serverField.code === HOST_CODES[f] && /one of these sites/.test(serverField.message)
    ? <p className="break-words text-xs text-kraveo-ink2" data-testid={`${f}-host-hint`}>Only the sites named above are allowed on this server. Use an address on one of them.</p>
    : null);

  const focusFirstInvalid = () => {
    const order: FormField[] = ['imageUrl', 'title', 'subtitle', 'linkUrl', 'ctaLabel', 'startsAt', 'endsAt'];
    const first = order.find((f) => problems[f]);
    if (first) document.getElementById(id(first))?.focus();
  };

  const submit = async () => {
    if (busy.current || uploading) return;
    setTouched(true);
    if (Object.values(problems).some(Boolean)) { setNotice({ kind: 'error', message: 'Some fields need fixing. They are marked below.' }); focusFirstInvalid(); return; }
    const body = banner ? changesOf(form, banner) : createBody(form);
    if (banner && Object.keys(body).length === 0) { setNotice({ kind: 'info', message: 'Nothing was changed.' }); return; }
    busy.current = true;
    setSaving(true); setNotice(null); setServerField(null);
    try {
      if (banner) {
        const out = await apiService.updateBanner(banner.id, body);
        onSaved(out.banner, false, out.changed ? 'Banner saved.' : 'Nothing to change.');
      } else {
        const created = await apiService.createBanner(body);
        onSaved(created, true, 'Banner added.');
      }
    } catch (failure) {
      onAuthError(failure);
      const field = fieldOf(failure, SERVER_FIELDS);
      if (field) { setServerField({ field, message: errorText(failure), code: (failure as ApiError).code }); window.setTimeout(() => document.getElementById(id(field))?.focus(), 0); }
      else setNotice({ kind: 'error', message: errorText(failure, 'The banner could not be saved. Try again.') });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  uploadingRef.current = uploading;
  dirtyRef.current = dirty;
  const locked = saving;
  const footer = (
    <div className="flex gap-3 pb-4">
      <button type="button" className="k-btn-ghost flex-1" onClick={() => void requestClose()} disabled={saving || uploading}>Cancel</button>
      <button type="button" className="k-btn-primary flex-1" onClick={() => void submit()} disabled={saving || uploading} aria-busy={saving}>
        {saving ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Saving…</> : uploading ? 'Wait for the picture…' : banner ? 'Save changes' : 'Add banner'}
      </button>
    </div>
  );

  return (
    <>
    <Drawer open onClose={() => void requestClose()} title={banner ? `Edit “${banner.title}”` : 'Add a banner'} subtitle="Shown at the top of the customer app Home" icon={ImageIcon} wide footer={footer}>
      <div className="space-y-5" onKeyDown={(event) => { const t = event.target as HTMLInputElement; if (event.nativeEvent.isComposing || event.keyCode === 229) return; // Enter that confirms an IME word (Hindi, etc.) is not Save
        if (event.key === 'Enter' && t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'datetime-local')) { event.preventDefault(); void submit(); } }}>
        <p role={notice ? (notice.kind === 'error' ? 'alert' : 'status') : undefined} aria-live="polite" className={notice ? `break-words rounded-k-sm border px-3 py-2 text-sm text-kraveo-ink ${notice.kind === 'error' ? 'border-kraveo-danger/30 bg-kraveo-danger/10' : 'border-kraveo-line bg-kraveo-surface2'}` : 'sr-only'}>{notice?.message ?? ''}</p>

        <BannerPreview title={form.title} subtitle={form.subtitle} imageUrl={form.imageUrl} theme={form.theme} hasLink={form.linkUrl.trim() !== ''} ctaLabel={form.ctaLabel} />

        <ImageUploadField
          id={id('imageUrl')}
          label="Picture"
          purpose="promo"
          value={form.imageUrl}
          onChange={(url) => set('imageUrl', url)}
          disabled={locked}
          error={error('imageUrl')}
          hint="Best size: 1200 x 600 pixels (2 wide, 1 tall). The app crops it to fill the card, so keep the important part in the middle. JPG, PNG or WebP; it is made smaller automatically."
          previewAlt="Banner picture"
          hideRemove
          hidePreview
          onBusyChange={setUploading}
          onAuthError={onAuthError}
          env={imageEnv}
        />
        {serverHint('imageUrl')}
        {hostWarning && !error('imageUrl') && (
          <p role="status" className="flex items-start gap-2 rounded-k-sm border border-kraveo-yellow/30 bg-kraveo-yellow/10 px-3 py-2 text-xs text-kraveo-ink"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{hostWarning}</span></p>
        )}

        <Field label="Title" htmlFor={id('title')} required error={error('title')} hint={`${count(form.title)} of ${TITLE_MAX} characters. Shown in bold, up to 2 lines.`}>
          <input id={id('title')} className="k-input" value={form.title} autoComplete="off" disabled={locked} onChange={(e) => set('title', e.target.value)} aria-invalid={Boolean(error('title'))} aria-describedby={`${id('title')}-msg`} />
        </Field>

        <Field label="Subtitle (optional)" htmlFor={id('subtitle')} error={error('subtitle')} hint={`${count(form.subtitle)} of ${SUBTITLE_MAX} characters. Shown under the title, up to 2 lines.`}>
          <textarea id={id('subtitle')} className="k-input !py-2.5" rows={2} value={form.subtitle} disabled={locked} onChange={(e) => set('subtitle', e.target.value)} aria-invalid={Boolean(error('subtitle'))} aria-describedby={`${id('subtitle')}-msg`} />
        </Field>

        <div className="space-y-2">
          <Field label="Link (optional)" htmlFor={id('linkUrl')} error={error('linkUrl')} hint="Where a tap goes: a web page, a Play Store page or a Google Form. It must start with https://. Leave empty for a banner that only shows.">
            <input id={id('linkUrl')} className="k-input" inputMode="url" value={form.linkUrl} autoComplete="off" disabled={locked} onChange={(e) => set('linkUrl', e.target.value)} aria-invalid={Boolean(error('linkUrl'))} aria-describedby={`${id('linkUrl')}-msg`} />
          </Field>
          {serverHint('linkUrl')}
          {linkOk ? (
            <a className="k-btn-ghost !min-h-[40px]" href={testHref} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" aria-hidden="true" />Test link<span className="sr-only"> (opens in a new tab)</span></a>
          ) : (
            <button type="button" className="k-btn-ghost !min-h-[40px]" disabled><ExternalLink className="h-4 w-4" aria-hidden="true" />Test link</button>
          )}
        </div>

        <Field label="Button text (optional)" htmlFor={id('ctaLabel')} error={error('ctaLabel')} hint={`${count(form.ctaLabel)} of ${CTA_MAX} characters, like “Order now”. The button only shows when the banner has a link. Without button text the whole card can still be tapped.`}>
          <input id={id('ctaLabel')} className="k-input" value={form.ctaLabel} autoComplete="off" disabled={locked} onChange={(e) => set('ctaLabel', e.target.value)} aria-invalid={Boolean(error('ctaLabel'))} aria-describedby={`${id('ctaLabel')}-msg`} />
        </Field>

        <fieldset className="space-y-2" disabled={locked}>
          <legend className="k-label mb-2">Text colour</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Text colour">
            {([['DARK', 'Light text', 'On a dark picture'], ['LIGHT', 'Dark text', 'On a bright picture']] as const).map(([value, title, help]) => (
              <label key={value} className="relative cursor-pointer">
                <input type="radio" name={id('theme')} value={value} checked={form.theme === value} onChange={() => set('theme', value)} className="peer sr-only" />
                <span className="flex min-h-[56px] flex-col justify-center rounded-k-sm border border-kraveo-line bg-kraveo-surface2 px-3 py-2 text-xs text-kraveo-ink2 peer-checked:border-kraveo-g400 peer-checked:bg-kraveo-g400/15 peer-focus-visible:ring-2 peer-focus-visible:ring-kraveo-g400/60">
                  <span className="text-sm font-bold text-kraveo-ink">{title}</span>{help}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3" disabled={locked}>
          <legend className="k-label mb-1">When it shows (India time, IST)</legend>
          {([['startsAt', 'startLocal', 'Starts (IST)', 'Empty = starts right away.'], ['endsAt', 'endLocal', 'Ends (IST)', 'Empty = never ends.']] as const).map(([field, key, label, hint]) => (
            <div key={field} className="space-y-1.5">
              <Field label={label} htmlFor={id(field)} error={error(field)} hint={hint}>
                <div className="flex gap-2">
                  <input key={`${field}-${pickerKey[field]}`} id={id(field)} type="datetime-local" className="k-input min-w-0 flex-1" value={form[key]} onChange={(e) => syncPicker(key, e, true)} onInput={(e) => syncPicker(key, e, true)} onBlur={(e) => syncPicker(key, e, false)} aria-invalid={Boolean(error(field))} aria-describedby={`${id(field)}-msg`} />
                  <button type="button" className="k-btn-ghost !min-h-[44px] shrink-0 !px-3 text-xs" onClick={() => clearPicker(key)} disabled={form[key] === '' && !bad[field]} aria-label={`Clear ${label}`}>Clear</button>
                </div>
              </Field>
            </div>
          ))}
          <p className="text-xs text-kraveo-ink2" data-testid="banner-when">{bad.startsAt || bad.endsAt ? 'A time is only half filled in. Finish it or press Clear before saving.' : whenText}</p>
        </fieldset>

        <div className="k-inset flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0"><p className="text-sm font-bold text-kraveo-ink">Switched on</p><p className="text-[11px] text-kraveo-ink3">Off keeps the banner saved but hides it from customers, whatever the dates say.</p></div>
          <Switch checked={form.isActive} onChange={() => set('isActive', !form.isActive)} label="Switched on" disabled={locked} />
        </div>

        {banner && (
          <p className="text-xs text-kraveo-ink3">Views {banner.viewCount}, taps {banner.clickCount}. These counters are read-only.</p>
        )}
      </div>
    </Drawer>
    {dialog}
    </>
  );
};
