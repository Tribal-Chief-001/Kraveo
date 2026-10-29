import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BlockInfo, BlockOrder } from '../lib/accountParse';
import { adminErrorText, fieldOf } from '../lib/errors';
import { orderCode } from '../lib/orders';
import { ORDER_STATUS_LABEL, inr } from '../lib/tokens';
import { Modal } from './ui/Modal';
import { Field } from './ui/Field';

export interface DialogFlag { key: string; label: string; hint?: string; defaultChecked?: boolean }

export interface ReasonValues {
  reason: string;
  confirmName: string;
  flags: Record<string, boolean>;
  /** The admin explicitly chose to resolve the blocking orders (cancel them / hand them back). false = never. */
  resolve: boolean;
}

export interface ReasonDialogProps {
  title: string;
  subtitle?: string;
  /** What happens, in plain words (the consequences). */
  intro?: React.ReactNode;
  /** More content between the intro and the reason (an impact summary, a warning). */
  children?: React.ReactNode;
  reasonLabel?: string;
  reasonHint?: string;
  quickReasons?: string[];
  /** A note instead of a required reason (restore dialogs). */
  reasonOptional?: boolean;
  reasonMin?: number;
  reasonMax?: number;
  /** Remove dialogs: the admin must type this name (case does not matter, the server checks it too). */
  confirmName?: { label: string; expected: string };
  flags?: DialogFlag[];
  /** Blocking orders already known before sending (the server can still answer 409 with its own list). */
  block?: BlockInfo | null;
  /** Turns a 409 error into the blocking panel. Any other error is shown as the server's message. */
  toBlock?: (error: unknown) => BlockInfo | null;
  confirmLabel: string;
  danger?: boolean;
  /** Runs the request. Throw to keep the dialog open with the server's message; the parent closes it on success. */
  onSubmit: (values: ReasonValues) => Promise<void>;
  onClose: () => void;
  onAuthError?: (error: unknown) => void;
  /** Makes each blocking order a link (closes this dialog and opens the order). */
  onOpenOrder?: (orderId: string) => void;
  /** Extra reason to keep the confirm button off (for example "pick an option"). */
  confirmDisabled?: boolean;
}

const OrderLine: React.FC<{ o: BlockOrder; onOpen?: (id: string) => void }> = ({ o, onOpen }) => {
  const parts = [o.status ? ORDER_STATUS_LABEL[o.status] ?? o.status : null, o.paymentStatus ? (o.paymentStatus === 'PAID' ? 'Paid' : o.paymentStatus.charAt(0) + o.paymentStatus.slice(1).toLowerCase()) : null, o.totalAmount !== null ? inr(o.totalAmount) : null].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-k-sm bg-kraveo-night/50 px-3 py-2 text-xs">
      <span className="min-w-0 break-words"><span className="font-mono font-bold text-kraveo-ink">{orderCode(o.id)}</span>{parts.length ? <span className="text-kraveo-ink2"> · {parts.join(' · ')}</span> : null}{o.groupId ? <span className="text-kraveo-ink3"> · combined order</span> : null}</span>
      {onOpen && <button type="button" className="font-bold text-kraveo-g300 underline-offset-2 hover:underline" onClick={() => onOpen(o.id)} aria-label={`Open order ${orderCode(o.id)}`}>Open order</button>}
    </li>
  );
};

/** The blocking orders and, when the action can resolve them, the explicit choice. Used inside ReasonDialog. */
export const BlockPanel: React.FC<{ block: BlockInfo; resolve: boolean; onResolve: (v: boolean) => void; disabled: boolean; fromServer: boolean; onOpenOrder?: (id: string) => void }> = ({ block, resolve, onResolve, disabled, fromServer, onOpenOrder }) => (
  <div role="alert" className="space-y-3 rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm text-kraveo-ink">
    <p className="break-words font-bold">{block.message}</p>
    {fromServer && <p className="text-xs text-kraveo-ink2">Nothing was changed.</p>}
    {block.orders.length > 0 && <ul aria-label="Orders in the way" className="space-y-1.5">{block.orders.map((o) => <OrderLine key={o.id} o={o} onOpen={onOpenOrder} />)}</ul>}
    {block.choice ? (
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="k-label mb-1">What do you want to do?</legend>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-k-sm border border-kraveo-line bg-kraveo-surface p-2.5 text-sm">
          <input type="radio" name="rd-resolve" className="mt-0.5" checked={!resolve} onChange={() => onResolve(false)} />
          <span><b>Stop here.</b> <span className="text-kraveo-ink2">Deal with these orders first, then come back.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-k-sm border border-kraveo-line bg-kraveo-surface p-2.5 text-sm">
          <input type="radio" name="rd-resolve" className="mt-0.5" checked={resolve} onChange={() => onResolve(true)} />
          <span><b>{block.choice.label}</b>{block.choice.detail ? <span className="block text-xs text-kraveo-ink2">{block.choice.detail}</span> : null}</span>
        </label>
      </fieldset>
    ) : (
      <p className="text-xs text-kraveo-ink2">This cannot be done while it lasts. Wait until it is finished, or fix it from the Orders tab, then try again.</p>
    )}
  </div>
);

const Inner: React.FC<ReasonDialogProps> = ({
  title, subtitle, intro, children, reasonLabel = 'Reason', reasonHint, quickReasons, reasonOptional = false, reasonMin = 3, reasonMax = 200,
  confirmName, flags, block, toBlock, confirmLabel, danger = false, onSubmit, onClose, onAuthError, onOpenOrder, confirmDisabled = false,
}) => {
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries((flags ?? []).map((f) => [f.key, f.defaultChecked === true])));
  const [resolve, setResolve] = useState(false);
  const [serverBlock, setServerBlock] = useState<BlockInfo | null>(null);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState<{ field: 'reason' | 'confirmName'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const active = serverBlock ?? block ?? null;
  const trimmed = reason.trim();
  const reasonOk = reasonOptional ? trimmed.length <= reasonMax : trimmed.length >= reasonMin && trimmed.length <= reasonMax;
  const nameOk = !confirmName || name.trim().toLowerCase() === confirmName.expected.trim().toLowerCase();
  const blockOk = !active || (Boolean(active.choice) && resolve);
  const canSubmit = reasonOk && nameOk && blockOk && !confirmDisabled && !busy;
  const reasonProblem = !reasonOk && reason.length > 0 ? (trimmed.length > reasonMax ? `At most ${reasonMax} characters.` : `Give a short reason (at least ${reasonMin} characters).`) : '';
  const buttonLabel = active?.choice && resolve ? active.choice.submitLabel : confirmLabel;

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busyRef.current || !canSubmit) return;
    busyRef.current = true;
    setBusy(true); setError(''); setFieldError(null);
    try {
      await onSubmit({ reason: trimmed, confirmName: name.trim(), flags: checked, resolve: Boolean(active?.choice) && resolve });
    } catch (failure) {
      onAuthError?.(failure);
      if (!mounted.current) return;
      const fromServer = toBlock?.(failure) ?? null;
      if (fromServer) { setServerBlock(fromServer); setResolve(false); return; }
      const field = fieldOf(failure, ['reason', 'confirmName'] as const);
      if (field) setFieldError({ field, message: adminErrorText(failure) });
      else setError(adminErrorText(failure));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      locked={busy}
      title={title}
      subtitle={subtitle}
      footer={(
        <div className="flex flex-col-reverse gap-2 pb-3 sm:flex-row sm:gap-3">
          <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`${danger ? 'k-btn-danger' : 'k-btn-primary'} flex-1`} onClick={() => void submit()} disabled={!canSubmit} aria-busy={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : buttonLabel}
          </button>
        </div>
      )}
    >
      <form noValidate className="space-y-4" onSubmit={submit}>
        {intro && <div className="space-y-2 text-sm text-kraveo-ink2">{intro}</div>}
        {children}
        {active && <BlockPanel block={active} resolve={resolve} onResolve={setResolve} disabled={busy} fromServer={Boolean(serverBlock)} onOpenOrder={onOpenOrder && !busy ? onOpenOrder : undefined} />}
        {quickReasons && quickReasons.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick reasons">
            {quickReasons.map((c) => <button key={c} type="button" className="k-chip" aria-pressed={reason === c} disabled={busy} onClick={() => { setReason(c); setFieldError(null); }}>{c}</button>)}
          </div>
        )}
        <Field label={reasonLabel} htmlFor="rd-reason" required={!reasonOptional} error={fieldError?.field === 'reason' ? fieldError.message : reasonProblem || undefined} hint={reasonHint ?? (reasonOptional ? `Optional, up to ${reasonMax} characters.` : `${reasonMin} to ${reasonMax} characters.`)}>
          <textarea id="rd-reason" rows={3} maxLength={reasonMax + 40} className="k-input !min-h-[84px] py-3" value={reason} disabled={busy}
            onChange={(e) => { setReason(e.target.value); setFieldError(null); setError(''); }} aria-invalid={Boolean(reasonProblem) || fieldError?.field === 'reason'} aria-describedby="rd-reason-msg" />
        </Field>
        {confirmName && (
          <Field label={confirmName.label} htmlFor="rd-name" required error={fieldError?.field === 'confirmName' ? fieldError.message : name.length > 0 && !nameOk ? 'This does not match yet.' : undefined} hint={`Type exactly: ${confirmName.expected}`}>
            <input id="rd-name" className="k-input" value={name} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy}
              onChange={(e) => { setName(e.target.value); setFieldError(null); setError(''); }} aria-invalid={(name.length > 0 && !nameOk) || fieldError?.field === 'confirmName'} aria-describedby="rd-name-msg" />
          </Field>
        )}
        {flags && flags.length > 0 && (
          <div className="space-y-2.5">
            {flags.map((f) => (
              <label key={f.key} className="flex cursor-pointer items-start gap-2.5 text-sm text-kraveo-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked[f.key] === true} disabled={busy} onChange={(e) => setChecked((c) => ({ ...c, [f.key]: e.target.checked }))} />
                <span><span className="font-semibold">{f.label}</span>{f.hint ? <span className="block text-xs text-kraveo-ink3">{f.hint}</span> : null}</span>
              </label>
            ))}
          </div>
        )}
        {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{error}</p>}
      </form>
    </Modal>
  );
};

/** One dialog for every "give a reason" decision: suspend, remove (type the name), restore (optional note), reject. Mounted only while open. */
export const ReasonDialog: React.FC<ReasonDialogProps & { open?: boolean }> = ({ open = true, ...props }) => (open ? <Inner {...props} /> : null);
