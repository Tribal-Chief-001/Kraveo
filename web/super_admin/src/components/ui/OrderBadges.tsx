import React from 'react';
import { LockKeyhole, TriangleAlert } from 'lucide-react';
import { Order } from '../../types';
import { paymentMeta, refundInfo, Tone } from '../../lib/orders';
import { TONE_CLASS } from '../../lib/orderProblems';

const base = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold';

/** Payment state in the same pill language as StatusPill: Paid / Unpaid / Payment failed / Refunded. */
export const PaymentPill: React.FC<{ status: string; className?: string }> = ({ status, className = '' }) => {
  const meta = paymentMeta(status);
  return <span className={`${base} ${meta.cls} ${className}`} title={`Payment: ${meta.label}`}>{meta.label}</span>;
};

export const TonePill: React.FC<{ tone: Tone; children: React.ReactNode; icon?: React.ElementType; title?: string; className?: string }> = ({ tone, children, icon: Icon, title, className = '' }) => (
  <span className={`${base} ${TONE_CLASS[tone].pill} ${className}`} title={title}>
    {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
    {children}
  </span>
);

/** Refund line under a payment pill. A failed refund is loud on purpose: it is money owed to a customer. */
export const RefundPill: React.FC<{ order: Order }> = ({ order }) => {
  const info = refundInfo(order);
  if (!info || (info.label === 'Refunded' && order.paymentStatus === 'REFUNDED')) return null;
  return (
    <TonePill tone={info.tone} icon={info.tone === 'danger' ? TriangleAlert : undefined} title={info.detail} className={info.tone === 'danger' ? 'ring-1 ring-kraveo-danger/50' : ''}>
      {info.label}
    </TonePill>
  );
};

export const OtpLockedPill: React.FC<{ order: Order }> = ({ order }) => (order.otpLocked
  ? <TonePill tone="danger" icon={LockKeyhole} title={`Gate OTP locked${order.otpAttempts ? ` after ${order.otpAttempts} wrong attempts` : ''}`}>OTP locked</TonePill>
  : null);
