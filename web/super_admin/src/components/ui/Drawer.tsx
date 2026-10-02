import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ElementType;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Wider panel for detail views (tablet and up). */
  wide?: boolean;
  /** Forms focus their first field on open (default). Detail views set false so focus lands on the panel itself. */
  focusFirstField?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Right-hand drawer on >=640px, bottom sheet on phones. Esc closes, focus is trapped and restored, body scroll is locked. */
export const Drawer: React.FC<DrawerProps> = ({ open, onClose, title, subtitle, icon: Icon, children, footer, wide = false, focusFirstField = true }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keep the latest onClose in a ref so re-renders (e.g. typing in a form) never re-run the focus/scroll-lock effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    const first = focusFirstField ? panel?.querySelector<HTMLElement>('input,select,textarea') ?? panel?.querySelector<HTMLElement>(FOCUSABLE) : null;
    (first ?? panel)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) { event.preventDefault(); lastNode.focus(); }
      else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); firstNode.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  // Rendered into <body>: the tab content sits inside an animated (transformed) wrapper, which would otherwise become the
  // containing block of this fixed overlay and shrink the drawer to the content area.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-end sm:items-stretch">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full animate-slide-up flex-col rounded-t-k-2xl border border-kraveo-line bg-kraveo-surface shadow-k-lift outline-none sm:max-h-none ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'} sm:animate-slide-in-right sm:rounded-none sm:rounded-l-k-2xl sm:border-y-0 sm:border-r-0`}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-kraveo-line sm:hidden" aria-hidden="true" />
        <header className="flex items-start justify-between gap-3 border-b border-kraveo-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {Icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-k-sm bg-kraveo-g400/15 text-kraveo-g400"><Icon className="h-5 w-5" aria-hidden="true" /></span>}
            <div className="min-w-0">
              <h2 id={titleId} className="truncate font-display text-lg font-bold tracking-tight text-kraveo-ink">{title}</h2>
              {subtitle && <p className="truncate text-xs text-kraveo-ink3">{subtitle}</p>}
            </div>
          </div>
          <button aria-label="Close panel" onClick={onClose} className="k-icon-btn shrink-0"><X className="h-4 w-4" aria-hidden="true" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="pb-safe border-t border-kraveo-line px-5 pt-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
};
