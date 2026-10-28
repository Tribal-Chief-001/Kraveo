import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { BannerTheme } from '../lib/bannerParse';

interface CardProps {
  title: string;
  subtitle: string;
  imageUrl: string;
  theme: BannerTheme;
  /** The button pill only shows when the banner has a link AND button text (Docs/25 4.1). */
  hasLink: boolean;
  ctaLabel: string;
  /** Smaller type for the second, worst-case preview. */
  small?: boolean;
}

/**
 * The banner card as the customer app draws it (Docs/25 4.1): 2:1 picture cropped to fill (cover), rounded corners, a gradient overlay chosen by
 * the theme, title and subtitle cut at two lines each, a button pill only when there is a link. Everything is rendered as plain React text.
 */
export const BannerCard: React.FC<CardProps> = ({ title, subtitle, imageUrl, theme, hasLink, ctaLabel, small = false }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [imageUrl]);
  const dark = theme === 'DARK';
  const src = imageUrl.trim();
  const showPicture = src !== '' && !failed;
  return (
    <div data-testid="banner-card" data-theme={theme} className="relative aspect-[2/1] w-full overflow-hidden rounded-k-lg border border-kraveo-line bg-gradient-to-br from-kraveo-g700 to-kraveo-g950 shadow-k-lift">
      {showPicture && <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
      {!showPicture && (
        <div className="absolute inset-0 flex items-start justify-end p-2 text-white/60" data-testid="banner-card-nopicture">
          <ImageOff className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{src === '' ? 'No picture yet' : 'The picture could not be shown here'}</span>
        </div>
      )}
      <div className={`absolute inset-0 bg-gradient-to-t ${dark ? 'from-black/85 via-black/35 to-transparent' : 'from-white/95 via-white/55 to-transparent'}`} aria-hidden="true" />
      <div className={`absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 ${small ? 'p-2' : 'p-3'} ${dark ? 'text-white' : 'text-zinc-900'}`}>
        <div className="min-w-0 flex-1">
          <p data-testid="banner-card-title" className={`line-clamp-2 break-words font-extrabold leading-tight ${small ? 'text-[11px]' : 'text-[15px]'}`}>{title.trim() || 'Your title'}</p>
          {subtitle.trim() !== '' && <p data-testid="banner-card-subtitle" className={`line-clamp-2 break-words leading-snug ${small ? 'text-[9px]' : 'text-[11px]'} ${dark ? 'text-white/85' : 'text-zinc-700'}`}>{subtitle.trim()}</p>}
        </div>
        {hasLink && ctaLabel.trim() !== '' && (
          <span data-testid="banner-card-cta" className={`max-w-[45%] shrink-0 truncate rounded-full bg-kraveo-g400 font-bold text-kraveo-g950 ${small ? 'px-2 py-0.5 text-[9px]' : 'px-3 py-1 text-[11px]'}`}>{ctaLabel.trim()}</span>
        )}
      </div>
    </div>
  );
};

const LONG_TITLE = 'Wonderful Weekend Feast Festival: Everything Hot, Fresh & Free Delivery';
const LONG_SUBTITLE = 'Order from your favourite campus restaurants this weekend and enjoy special launch offers on thalis, biryani, rolls and desserts, valid on all orders.';

interface PreviewProps extends Omit<CardProps, 'small'> {}

/** A phone-shaped frame around the card, plus a small "longest text" version so the admin sees what two-line cutting does. */
export const BannerPreview: React.FC<PreviewProps> = (props) => (
  <section aria-label="Preview of the banner" className="space-y-3">
    <p className="k-label">Preview (how it looks in the customer app)</p>
    <div className="mx-auto w-full max-w-[300px] rounded-[28px] border-2 border-kraveo-line bg-kraveo-night p-3 shadow-k-lift" data-testid="banner-phone">
      <div className="mx-auto mb-3 h-1.5 w-16 rounded-full bg-kraveo-line" aria-hidden="true" />
      <div className="mb-2 h-3 w-1/2 rounded bg-kraveo-surface2" aria-hidden="true" />
      <BannerCard {...props} />
      <div className="mt-3 flex gap-2" aria-hidden="true">
        <div className="h-5 w-14 rounded-full bg-kraveo-surface2" /><div className="h-5 w-16 rounded-full bg-kraveo-surface2" /><div className="h-5 w-12 rounded-full bg-kraveo-surface2" />
      </div>
    </div>
    <div className="mx-auto w-full max-w-[200px] space-y-1" data-testid="banner-longtext">
      <BannerCard {...props} title={LONG_TITLE.slice(0, 60)} subtitle={`${LONG_SUBTITLE.slice(0, 119)}.`} small />
      <p className="text-center text-[11px] text-kraveo-ink3">With the longest text allowed (sample words, not yours). Anything past two lines is cut off in the app.</p>
    </div>
  </section>
);
