import React from 'react';
import logo from '../../assets/logo-bgremove.png';

/** Full logo (bowl + wordmark) on a cream rounded badge: the artwork is dark green + yellow and needs a light ground on dark UIs. */
export const LogoBadge: React.FC<{ className?: string; imgClassName?: string }> = ({ className = '', imgClassName = 'h-10' }) => (
  <span className={`inline-flex items-center justify-center rounded-k-md bg-kraveo-cream px-3 py-1.5 shadow-k-soft ${className}`}>
    <img src={logo} alt="Kraveo" className={`w-auto object-contain ${imgClassName}`} draggable={false} />
  </span>
);

/** Compact mark: the artwork cropped to the bowl only (no wordmark). Source is 1672x940; the bowl spans x 24-78%, y 6.5-66.5%. Landscape window because the bowl is wider than tall. */
export const LogoMark: React.FC<{ size?: number; className?: string }> = ({ size = 44, className = '' }) => {
  const w = Math.round(size * 1.5);
  const s = w / 903; // window covers 903 source px horizontally
  const h = Math.round(564 * s);
  return (
    <span
      role="img"
      aria-label="Kraveo"
      className={`inline-block shrink-0 rounded-k-md bg-kraveo-cream shadow-k-soft ${className}`}
      style={{
        width: w,
        height: h,
        backgroundImage: `url(${logo})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${1672 * s}px ${940 * s}px`,
        backgroundPosition: `${-0.24 * 1672 * s}px ${-0.065 * 940 * s}px`,
      }}
    />
  );
};
