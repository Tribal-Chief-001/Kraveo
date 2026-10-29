import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { adminErrorText } from '../lib/errors';
import { Modal } from './ui/Modal';

/** A one-click "are you sure" for actions that need no reason (restore, reinstate, enable, reset password). Cannot be closed or double-sent while the request runs. */
export const ActionConfirm: React.FC<{
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Throw to keep the dialog open with the server's message; the parent closes it on success. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  onAuthError?: (error: unknown) => void;
}> = ({ title, children, confirmLabel, danger = false, onConfirm, onClose, onAuthError }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await onConfirm();
    } catch (e) {
      onAuthError?.(e);
      if (mounted.current) setError(adminErrorText(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      locked={busy}
      onClose={onClose}
      footer={(
        <div className="flex flex-col-reverse gap-2 pb-3 sm:flex-row sm:gap-3">
          <button type="button" data-autofocus className="k-btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`${danger ? 'k-btn-danger' : 'k-btn-primary'} flex-1`} onClick={() => void run()} disabled={busy} aria-busy={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : confirmLabel}
          </button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm text-kraveo-ink2">
        {children}
        {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-kraveo-ink">{error}</p>}
      </div>
    </Modal>
  );
};
