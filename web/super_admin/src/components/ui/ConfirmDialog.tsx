import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

const FOCUSABLE = 'button:not([disabled])';

/** Small centred "Are you sure?" dialog. Cancel is focused first; Esc, the backdrop and Cancel all say no. */
export const ConfirmDialog: React.FC<ConfirmOptions & { onResult: (confirmed: boolean) => void }> = ({ title, message, confirmLabel, cancelLabel = 'Cancel', danger = false, onResult }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    cancelRef.current?.focus();
    // Capture on window so Esc / Tab are handled here first and never reach a drawer that is open underneath.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        onResultRef.current(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      event.stopPropagation();
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index === nodes.length - 1 ? 0 : index + 1);
      event.preventDefault();
      nodes[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={() => onResult(false)} aria-hidden="true" />
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} className="relative w-full max-w-sm animate-scale-in rounded-k-xl border border-kraveo-line bg-kraveo-surface p-5 shadow-k-lift">
        <h2 id={titleId} className="font-display text-lg font-bold text-kraveo-ink">{title}</h2>
        <p id={messageId} className="mt-2 break-words text-sm text-kraveo-ink2">{message}</p>
        <div className="mt-5 flex gap-3">
          <button ref={cancelRef} type="button" className="k-btn-ghost flex-1" onClick={() => onResult(false)}>{cancelLabel}</button>
          <button type="button" className={`${danger ? 'k-btn-danger' : 'k-btn-accent'} flex-1`} onClick={() => onResult(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/**
 * `const { confirm, dialog } = useConfirm();` then `if (!(await confirm({...}))) return;` and render `{dialog}` once.
 * A question that is still open when the component goes away answers "no".
 */
export const useConfirm = () => {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    pending.current?.(false);
    pending.current = resolve;
    setRequest({ ...options, resolve });
  }), []);

  const settle = useCallback((ok: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(ok);
  }, []);

  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);

  const dialog = request ? <ConfirmDialog {...request} onResult={settle} /> : null;
  return { confirm, dialog };
};
