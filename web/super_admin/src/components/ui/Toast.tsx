import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';

interface ToastInput {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  kind: ToastKind;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};

const KIND_STYLE: Record<ToastKind, { Icon: React.ElementType; accent: string; ring: string }> = {
  success: { Icon: CheckCircle2, accent: 'text-kraveo-g400', ring: 'bg-kraveo-g400/15' },
  error: { Icon: TriangleAlert, accent: 'text-kraveo-danger', ring: 'bg-kraveo-danger/15' },
  info: { Icon: Info, accent: 'text-kraveo-status-pickedUp', ring: 'bg-kraveo-status-pickedUp/15' },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback((input: ToastInput) => {
    counter.current += 1;
    const id = counter.current;
    const kind = input.kind ?? 'info';
    setItems((current) => [...current.slice(-3), { ...input, id, kind }]);
    const duration = input.durationMs ?? (kind === 'error' ? 8000 : 4200);
    timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
  }, [dismiss]);

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const api = useMemo<ToastApi>(() => ({
    toast,
    success: (title, description) => toast({ kind: 'success', title, description }),
    error: (title, description) => toast({ kind: 'error', title, description }),
    info: (title, description) => toast({ kind: 'info', title, description }),
  }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 px-4 pb-4 sm:inset-x-auto sm:right-4 sm:items-end sm:pb-6"
      >
        {items.map((item) => {
          const { Icon, accent, ring } = KIND_STYLE[item.kind];
          return (
            <div
              key={item.id}
              role={item.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-k-lg border border-kraveo-line bg-kraveo-surface2 p-3.5 shadow-k-lift"
            >
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${ring} ${accent}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-kraveo-ink">{item.title}</p>
                {item.description && <p className="mt-0.5 text-xs text-kraveo-ink2">{item.description}</p>}
                {item.action && (
                  <button
                    onClick={() => { item.action?.onClick(); dismiss(item.id); }}
                    className="mt-2 text-xs font-bold text-kraveo-g300 underline-offset-2 hover:underline"
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
              <button aria-label="Dismiss notification" onClick={() => dismiss(item.id)} className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-kraveo-ink3 hover:bg-kraveo-line hover:text-kraveo-ink">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};
