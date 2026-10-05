// @vitest-environment jsdom
// Restaurant location in the dashboard (Docs/20 section 1): source badge, Google Maps link, the editor, the Applications
// card ("not provided" / what the restaurant sent) and the needs-attention entry. API calls are mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ToastProvider } from './ui/Toast';
import { VendorLocationEditor } from './VendorLocationEditor';
import { ApplicationsPanel } from './ApplicationsPanel';
import { NeedsAttentionPanel } from './NeedsAttentionPanel';
import { apiService } from '../services/api';
import { Application, Vendor } from '../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = async (ui: React.ReactElement) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider>{ui}</ToastProvider>); });
  return host;
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

const PIN = { lat: 23.0745, lng: 76.859 };

describe('VendorLocationEditor', () => {
  it('no pin: "Not set" badge, no map link, a "Set location" button', async () => {
    const h = await mount(<VendorLocationEditor id="v1" name="Sharma Dhaba" pin={{ lat: 23.0768, lng: 76.8524, hasLocation: false }} />);
    expect(h.textContent).toContain('Not set');
    expect(h.querySelector('a')).toBeNull();
    expect(h.textContent).toContain('Set location');
  });

  it('notSetLabel replaces "Not set" (the Applications card says "Not provided")', async () => {
    const h = await mount(<VendorLocationEditor id="v1" name="X" pin={{ hasLocation: false }} notSetLabel="Not provided" />);
    expect(h.textContent).toContain('Not provided');
    expect(h.textContent).not.toContain('Not set');
  });

  it('a device pin shows coordinates, who/when/how accurate and an Open in Google Maps link', async () => {
    const h = await mount(<VendorLocationEditor id="v1" name="Sharma Dhaba" pin={{ ...PIN, hasLocation: true, locationSource: 'DEVICE', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: 12.4 }} />);
    expect(h.textContent).toContain('23.07450, 76.85900');
    expect(h.textContent).toContain('Set by the restaurant on 5 Oct 2026, about 12 m');
    const a = h.querySelector('a') as HTMLAnchorElement;
    expect(a.href).toBe('https://www.google.com/maps/search/?api=1&query=23.0745,76.859');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(h.textContent).toContain('Change');
  });

  it('an admin pin says "Set by admin"', async () => {
    const h = await mount(<VendorLocationEditor id="v1" name="X" pin={{ ...PIN, hasLocation: true, locationSource: 'ADMIN' }} />);
    expect(h.querySelector('[data-pin-kind="ADMIN"]')?.textContent).toBe('Set by admin');
  });

  it('typing coordinates saves through the API and reports the saved pin; a bad value never reaches the server', async () => {
    const saved = { lat: 23.0745, lng: 76.859, hasLocation: true, locationSource: 'ADMIN' as const, locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: null };
    const spy = vi.spyOn(apiService, 'setVendorLocation').mockResolvedValue(saved);
    const onSaved = vi.fn();
    const h = await mount(<VendorLocationEditor id="v1" name="Sharma Dhaba" pin={{ hasLocation: false }} onSaved={onSaved} />);
    await click(h.querySelector('button')!); // "Set location"
    const input = h.querySelector('input') as HTMLInputElement;
    await type(input, '28.6139, 77.2090'); // Delhi
    await act(async () => { h.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(spy).not.toHaveBeenCalled();
    expect(h.textContent).toMatch(/more than 3 km from the campus/);
    await type(input, '23.0745, 76.8590');
    await act(async () => { h.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(spy).toHaveBeenCalledWith('v1', 23.0745, 76.859);
    expect(onSaved).toHaveBeenCalledWith('v1', saved);
  });
});

const application = (over: Partial<Application> & { vendor?: Application['vendor'] } = {}): Application => ({
  id: 'a1', kind: 'VENDOR', userId: 'u1', name: 'Ramesh', phone: '+91 9000000001', status: 'PENDING', rejectionReason: null, selfSignup: true,
  appliedAt: new Date().toISOString(), reviewedAt: null, createdAt: new Date().toISOString(),
  vendor: { name: 'Pending Dhaba', category: 'North Indian', address: 'Ashta road', fssaiNumber: null, isAcceptingOrders: false, lat: 23.0768, lng: 76.8524, hasLocation: false, locationSource: null, locationSetAt: null, locationAccuracyM: null },
  ...over,
});

describe('ApplicationsPanel: the location a pending restaurant sent', () => {
  const counts = { PENDING: 2, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 };

  it('shows the coordinates, accuracy and a Google Maps link when the restaurant sent a pin', async () => {
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts, data: [application({ vendor: { ...application().vendor!, ...PIN, hasLocation: true, locationSource: 'DEVICE', locationSetAt: '2026-10-05T10:00:00.000Z', locationAccuracyM: 18 } })] } as any);
    const h = await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    expect(h.textContent).toContain('Pending Dhaba');
    expect(h.textContent).toContain('23.07450, 76.85900');
    expect(h.textContent).toContain('Set by the restaurant on 5 Oct 2026, about 18 m');
    expect(Array.from(h.querySelectorAll('a')).some((a) => a.href.startsWith('https://www.google.com/maps/search/'))).toBe(true);
    expect(h.textContent).not.toContain('did not send a location');
  });

  it('shows a "not provided" state with a hint and the editor when no pin was sent', async () => {
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts, data: [application()] } as any);
    const h = await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    expect(h.textContent).toContain('Not provided');
    expect(h.textContent).toContain('did not send a location');
    expect(h.querySelector('[aria-label="Set map location of Pending Dhaba"]')).not.toBeNull();
    expect(Array.from(h.querySelectorAll('a')).some((a) => a.href.includes('google.com/maps'))).toBe(false);
  });

  it('an older server (no location fields at all) renders as "not provided", not as a crash', async () => {
    const old = application();
    delete (old.vendor as any).lat; delete (old.vendor as any).lng; delete (old.vendor as any).hasLocation;
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts, data: [old] } as any);
    const h = await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    expect(h.textContent).toContain('Not provided');
  });

  it('riders have no map pin block', async () => {
    const rider: Application = { ...application(), id: 'r1', kind: 'DRIVER', vendor: undefined, driver: { runnerCode: 'RUN-1234', vehicleType: 'Bike', vehicleRegNo: 'MP04', emergencyPhone: null, upiId: null } };
    vi.spyOn(apiService, 'fetchApplications').mockResolvedValue({ counts, data: [rider] } as any);
    const h = await mount(<ApplicationsPanel refreshKey={0} onChanged={() => {}} onAuthError={() => {}} />);
    await flush();
    expect(h.textContent).not.toContain('Map pin');
  });
});

const vendor = (over: Partial<Vendor> = {}): Vendor => ({ id: 'v1', name: 'Sharma Dhaba', category: 'North Indian', rating: 4.5, isAcceptingOrders: true, address: 'Ashta road', activeOrdersCount: 0, approvalStatus: 'APPROVED', ...over });
const attentionProps = { entries: [], serverAvailable: true, loading: false, error: '', checkedAt: Date.now(), onRefresh: () => {}, onOpenOrder: () => {}, onResetOtpLock: async () => true, onRetryRefund: async () => true };

describe('NeedsAttentionPanel: restaurants without a location', () => {
  it('lists them with the specified text and a button to the Vendors tab', async () => {
    const onOpenVendors = vi.fn();
    const h = await mount(<NeedsAttentionPanel {...attentionProps} locationGaps={[vendor(), vendor({ id: 'v2', name: 'Campus Cafe' })]} onOpenVendors={onOpenVendors} />);
    expect(h.textContent).toContain('Sharma Dhaba');
    expect(h.textContent).toContain('Campus Cafe');
    expect((h.textContent!.match(/No location - riders cannot navigate to it/g) ?? []).length).toBe(2);
    expect(h.textContent).toContain('2 without location');
    expect(h.textContent).not.toContain('Nothing needs you right now');
    await click(h.querySelector('[aria-label="Set the map location of Sharma Dhaba in the Vendors tab"]')!);
    expect(onOpenVendors).toHaveBeenCalledTimes(1);
  });

  it('nothing to show: the usual empty state, and no location section', async () => {
    const h = await mount(<NeedsAttentionPanel {...attentionProps} />);
    expect(h.textContent).toContain('Nothing needs you right now');
    expect(h.textContent).not.toContain('without a map location');
  });

  it('the search box filters the restaurants too', async () => {
    const h = await mount(<NeedsAttentionPanel {...attentionProps} locationGaps={[vendor(), vendor({ id: 'v2', name: 'Campus Cafe' })]} query="campus" />);
    expect(h.textContent).toContain('Campus Cafe');
    expect(h.textContent).not.toContain('Sharma Dhaba');
  });
});
