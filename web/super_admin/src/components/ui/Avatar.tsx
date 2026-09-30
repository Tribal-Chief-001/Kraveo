import React, { useState } from 'react';
import { initials } from '../../lib/tokens';

const TINTS = [
  'bg-kraveo-g700 text-kraveo-g100',
  'bg-kraveo-g800 text-kraveo-g200',
  'bg-kraveo-status-accepted/25 text-kraveo-status-accepted',
  'bg-kraveo-status-pickedUp/25 text-kraveo-status-pickedUp',
  'bg-kraveo-status-atGate/25 text-kraveo-status-atGate',
  'bg-kraveo-status-preparing/25 text-kraveo-status-preparing',
];

const hash = (value: string): number => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
};

interface AvatarProps {
  name: string;
  imageUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE = { sm: 'h-8 w-8 text-[11px]', md: 'h-11 w-11 text-sm', lg: 'h-14 w-14 text-lg' };

export const Avatar: React.FC<AvatarProps> = ({ name, imageUrl, size = 'md', className = '' }) => {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-bold ${SIZE[size]} ${showImage ? 'bg-kraveo-surface2' : TINTS[hash(name) % TINTS.length]} ${className}`} aria-hidden="true">
      {showImage ? <img src={imageUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initials(name)}
    </span>
  );
};
