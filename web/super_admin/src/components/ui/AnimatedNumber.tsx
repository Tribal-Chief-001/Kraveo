import React, { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Count-up hook (easeOutCubic). Animates from the previously shown value. Reduced motion: jumps straight to the target. */
export const useCountUp = (target: number | null, durationMs = 900): number | null => {
  const [display, setDisplay] = useState<number | null>(target);
  const shown = useRef<number>(target ?? 0);

  useEffect(() => {
    if (target === null || !Number.isFinite(target)) {
      setDisplay(null);
      return undefined;
    }
    if (prefersReducedMotion() || durationMs <= 0) {
      shown.current = target;
      setDisplay(target);
      return undefined;
    }
    const from = shown.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = from + (target - from) * eased;
      shown.current = value;
      setDisplay(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return display;
};

interface AnimatedNumberProps {
  /** null/undefined renders a dash: never a made-up number. */
  value: number | null | undefined;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({ value, decimals = 0, prefix = '', suffix = '', className }) => {
  const animated = useCountUp(value ?? null);
  if (animated === null || value === null || value === undefined) return <span className={className} aria-label="Not available">-</span>;
  const text = animated.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const finalText = value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span className={className} aria-label={`${prefix}${finalText}${suffix}`}>{prefix}{text}{suffix}</span>;
};
