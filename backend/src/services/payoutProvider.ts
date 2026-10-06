import { AUTO_PAYOUT_AVAILABLE } from './pricing';

/**
 * Payout provider hook (Docs/21 section 5). `manual` is always available: the admin pays by bank or UPI and records the reference
 * (mark-paid). `razorpayx` is a stub that reports "not configured" until the owner activates RazorpayX payouts and the keys exist;
 * `AUTO_PAYOUT` mode is refused by the settings validation (services/pricing.ts) for as long as no provider that can send is enabled.
 */
export type PayoutProvider = {
  name: 'manual' | 'razorpayx';
  enabled: boolean;
  /** Why the provider cannot be used (null when enabled). */
  reason: string | null;
  /** Sends the money for a settlement. The manual provider cannot: the admin does it outside and records the reference. */
  send: (settlement: { id: string; netPayable: number }) => Promise<{ ok: false; code: string; message: string }>;
};

export const manualProvider: PayoutProvider = {
  name: 'manual',
  enabled: true,
  reason: null,
  send: async () => ({ ok: false, code: 'MANUAL_PAYOUT', message: 'Pay this settlement by bank or UPI, then record the reference with mark-paid.' }),
};

export const razorpayxProvider: PayoutProvider = {
  name: 'razorpayx',
  enabled: AUTO_PAYOUT_AVAILABLE,
  reason: AUTO_PAYOUT_AVAILABLE ? null : 'RazorpayX payouts are not configured.',
  send: async () => ({ ok: false, code: 'PROVIDER_NOT_CONFIGURED', message: 'RazorpayX payouts are not configured.' }),
};

export const payoutProviders = (): PayoutProvider[] => [manualProvider, razorpayxProvider];
export const payoutProviderStatus = () => payoutProviders().map((p) => ({ name: p.name, enabled: p.enabled, reason: p.reason }));
