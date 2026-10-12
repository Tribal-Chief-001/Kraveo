import React, { useEffect, useId, useRef, useState } from 'react';
import { ImageOff, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { apiService } from '../services/api';
import { ImageEnv, ImageProblem, browserEnv, compressImage } from '../lib/imageCompress';
import { isHttpUrl } from '../lib/pricing';
import { errorText } from '../lib/errors';
import { Field } from './ui/Field';

interface Props {
  /** Prefix for element ids (the URL input gets `${id}`). */
  id: string;
  label: string;
  purpose: 'banner' | 'dish';
  /** The picture's web address ('' = none). Uploading fills it with the new address. */
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
  error?: string;
  hint?: string;
  /** Text for the preview's alt attribute. */
  previewAlt: string;
  /** Replaces the plain "Remove" button (e.g. "Use the default banner"). Return nothing: the parent changes `value`. */
  removeLabel?: string;
  onRemove?: () => void;
  /** Hide the Remove button (a saved dish must keep a photo: replace it instead). */
  hideRemove?: boolean;
  /** Shown instead of the preview when there is no picture (for example "The default banner is used"). */
  emptyNote?: string;
  /** True while a picture is being prepared or uploaded: the parent should keep Save off. */
  onBusyChange?: (busy: boolean) => void;
  onAuthError?: (error: unknown) => void;
  /** Tests inject a fake canvas. */
  env?: ImageEnv;
}

type Phase = 'idle' | 'preparing' | 'uploading';

const kb = (bytes: number | null): string => (bytes === null ? '' : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A web address field with an Upload button next to it. The chosen picture is shrunk in the browser first (lib/imageCompress),
 * sent to the server, and the returned address is put in the field. Replace and remove are always available.
 */
export const ImageUploadField: React.FC<Props> = ({ id, label, purpose, value, onChange, disabled = false, error, hint, previewAlt, removeLabel = 'Remove photo', onRemove, hideRemove = false, emptyNote, onBusyChange, onAuthError, env }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const statusId = useId();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPreviewFailed(false); }, [value]);

  const setBusy = (next: Phase) => {
    setPhase(next);
    onBusyChange?.(next !== 'idle');
  };

  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // the same file can be chosen again later
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setProblem(''); setDone('');
    setBusy('preparing');
    try {
      const small = await compressImage(file, env ?? browserEnv());
      if (!mounted.current) return;
      setBusy('uploading');
      const result = await apiService.uploadImage(small.blob, purpose);
      if (!mounted.current) return;
      onChange(result.url);
      const size = result.width && result.height ? `${result.width} x ${result.height}, ` : '';
      setDone(`Photo uploaded (${size}${kb(result.bytes ?? small.blob.size)}).`);
    } catch (failure) {
      if (!mounted.current) return;
      if (!(failure instanceof ImageProblem)) onAuthError?.(failure);
      setProblem(errorText(failure, 'The photo could not be uploaded. Try again, or paste a link instead.'));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy('idle');
      else onBusyChange?.(false);
    }
  };

  const hasUrl = value.trim() !== '' && isHttpUrl(value);
  const working = phase !== 'idle';
  const message = problem || error;

  return (
    <div className="space-y-3">
      <Field label={label} htmlFor={id} error={message} hint={hint}>
        <input id={id} className="k-input" inputMode="url" value={value} disabled={disabled || working} autoComplete="off" aria-invalid={Boolean(message)} aria-describedby={`${id}-msg ${statusId}`}
          onChange={(event) => { onChange(event.target.value); setDone(''); setProblem(''); }} />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label={`${label}: choose a photo file`} data-testid={`${id}-file`} onChange={pick} disabled={disabled || working} />
        <button type="button" className="k-btn-ghost !min-h-[40px]" onClick={() => fileInput.current?.click()} disabled={disabled || working} aria-busy={working}>
          {working ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
          {working ? (phase === 'preparing' ? 'Preparing photo…' : 'Uploading…') : value.trim() ? 'Replace photo' : 'Upload photo'}
        </button>
        {value.trim() !== '' && !working && !hideRemove && (
          <button type="button" className="k-btn-danger !min-h-[40px]" onClick={() => { if (onRemove) onRemove(); else onChange(''); setDone(''); setProblem(''); }} disabled={disabled}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />{removeLabel}
          </button>
        )}
      </div>
      <p id={statusId} className="text-xs text-kraveo-ink3" role="status" aria-live="polite">{working ? (phase === 'preparing' ? 'Making the photo smaller…' : 'Sending the photo…') : done}</p>

      {hasUrl ? (
        <div className="k-inset flex h-36 items-center justify-center overflow-hidden">
          {!previewFailed
            ? <img src={value.trim()} alt={previewAlt} className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setPreviewFailed(true)} />
            : <p className="flex items-center gap-2 px-3 text-center text-sm text-kraveo-ink3"><ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />The preview could not be loaded here. The link may still work in the app.</p>}
        </div>
      ) : emptyNote ? <p className="k-inset px-3 py-3 text-sm text-kraveo-ink3">{emptyNote}</p> : null}
    </div>
  );
};
