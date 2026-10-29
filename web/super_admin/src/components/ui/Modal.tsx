import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** true = a request is running (or a secret must be copied first): Esc, the backdrop and the close button do nothing. */
  locked?: boolean;
  /** Wider panel (the owner / outcome dialogs). */
  wide?: boolean;
  /** The element that gets focus first. Default: the first field, else the first button. */
  initialFocus?: React.RefObject<HTMLElement>;
  role?: 'dialog' | 'alertdialog';
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A centred dialog for decisions (reason, type-the-name, show-once secret). Rendered into <body> above drawers (z-80) and below
 * the small "Are you sure?" dialog (z-90). Esc is handled in the capture phase, so a drawer under it never also closes. While
 * `locked` nothing can close it. Focus moves in on open, is trapped, and returns to the opener on close. Scrolls on a 360px phone.
 */
export const Modal: React.FC<ModalProps> = ({ onClose, title, subtitle, children, footer, locked = false, wide = false, initialFocus, role = 'dialog' }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = initialFocus?.current ?? panel?.querySelector<HTMLElement>('input,select,textarea') ?? panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        if (!lockedRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) { event.preventDefault(); return; }
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index === nodes.length - 1 ? 0 : index + 1);
      event.stopPropagation();
      event.preventDefault();
      nodes[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (previous && previous.isConnected) previous.focus?.();
    };
    // Focus is placed once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-4" onKeyDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={() => { if (!locked) onClose(); }} aria-hidden="true" />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={locked || undefined}
        tabIndex={-1}
        className={`relative flex max-h-[94vh] w-full animate-scale-in flex-col rounded-t-k-2xl border border-kraveo-line bg-kraveo-surface shadow-k-lift outline-none sm:max-h-[90vh] sm:rounded-k-xl ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-kraveo-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words font-display text-lg font-bold leading-snug tracking-tight text-kraveo-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 break-words text-xs text-kraveo-ink3">{subtitle}</p>}
          </div>
          <button type="button" aria-label="Close dialog" onClick={onClose} disabled={locked} className="k-icon-btn shrink-0 disabled:opacity-40"><X className="h-4 w-4" aria-hidden="true" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <footer className="pb-safe border-t border-kraveo-line px-4 pt-3 sm:px-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
};
