// @vitest-environment jsdom
// Smoke test of the Leaflet map in jsdom (no real tiles, zero-size canvas): markers are created once and then updated in place.
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import CampusMap, { MapRider } from './CampusMap';
import { FALLBACK_DROP_POINTS, campusCenter } from '../lib/campus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rider = (over: Partial<MapRider> = {}): MapRider => ({ id: 'r1', name: 'Vikram', lat: 23.0735, lng: 76.859, state: 'idle', lastUpdated: new Date().toISOString(), orderLabel: null, ...over });
const center = campusCenter();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = async (props: Partial<React.ComponentProps<typeof CampusMap>> = {}) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const base = { riders: [rider()], vendors: [{ id: 'v1', name: 'Sharma Dhaba', lat: 23.0745, lng: 76.859 }], dropPoints: FALLBACK_DROP_POINTS, center, now: Date.now() };
  const render = async (extra: Partial<React.ComponentProps<typeof CampusMap>> = {}) => {
    await act(async () => { root!.render(<CampusMap {...base} {...props} {...extra} />); });
  };
  await render();
  return { render, host };
};

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe('CampusMap (jsdom smoke)', () => {
  it('draws drop points (7 distinct pins), a restaurant and a rider, with the OSM attribution', async () => {
    const { host } = await mount();
    expect(host.querySelectorAll('.k-pin--boys, .k-pin--girls')).toHaveLength(7);
    expect(host.querySelectorAll('.k-pin--vendor')).toHaveLength(1);
    expect(host.querySelectorAll('.k-rider')).toHaveLength(1);
    expect(host.querySelector('.leaflet-control-attribution')?.textContent).toContain('OpenStreetMap');
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toMatch(/Live campus map/);
    expect(host.querySelector('.leaflet-marker-icon.k-rider-marker')?.getAttribute('aria-label')).toMatch(/Rider Vikram, idle/);
  });

  it('updates a rider in place: same DOM node, new state class, new aria label, moved marker', async () => {
    const { host, render } = await mount();
    const before = host.querySelector('.k-rider') as HTMLElement;
    const icon = host.querySelector('.leaflet-marker-icon.k-rider-marker') as HTMLElement;
    // jsdom has no 3D transforms, so Leaflet positions with left/top here
    const posBefore = `${icon.style.left}|${icon.style.top}|${icon.style.transform}`;
    await render({ riders: [rider({ lat: 23.0740, lng: 76.8595, state: 'delivering', orderLabel: 'AB12CD to BH2' })] });
    const after = host.querySelector('.k-rider') as HTMLElement;
    expect(after).toBe(before); // not re-created
    expect(after.className).toContain('k-rider--delivering');
    expect(after.className).not.toContain('k-rider--idle');
    expect(host.querySelector('.leaflet-marker-icon.k-rider-marker')).toBe(icon);
    expect(icon.getAttribute('aria-label')).toMatch(/delivering.*AB12CD to BH2/);
    expect(`${icon.style.left}|${icon.style.top}|${icon.style.transform}`).not.toBe(posBefore);
  });

  it('adds and removes riders without touching the others', async () => {
    const { host, render } = await mount();
    const first = host.querySelector('.k-rider') as HTMLElement;
    await render({ riders: [rider(), rider({ id: 'r2', name: 'Arjun', lat: 23.0731 })] });
    expect(host.querySelectorAll('.k-rider')).toHaveLength(2);
    expect(host.querySelector('.k-rider')).toBe(first);
    await render({ riders: [rider({ id: 'r2', name: 'Arjun', lat: 23.0731 })] });
    expect(host.querySelectorAll('.k-rider')).toHaveLength(1);
    expect(host.querySelector('.k-rider__label')?.textContent).toBe('Arjun');
    await render({ riders: [] });
    expect(host.querySelectorAll('.k-rider')).toHaveLength(0);
  });

  it('a rider name is text, never markup', async () => {
    const { host } = await mount({ riders: [rider({ name: '<img src=x onerror=alert(1)>' })] });
    expect(host.querySelector('.k-rider__label')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(host.querySelector('.k-rider img')).toBeNull();
  });

  it('opens a popup for a focus request and keeps working when tiles never load', async () => {
    const { host, render } = await mount();
    await render({ focusRequest: { id: 'r1', n: 1 } });
    expect(host.querySelector('.leaflet-popup .k-popup__title')?.textContent).toBe('Vikram');
    expect(host.querySelector('.k-rider--selected')).not.toBeNull();
    await render({ riders: [rider({ state: 'stale' })], focusRequest: { id: 'r1', n: 1 } });
    expect(host.querySelector('.leaflet-popup .k-popup__row')?.textContent).toBe('Stale');
  });

  it('unmounting removes the map', async () => {
    const { host } = await mount();
    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    expect(host.querySelector('.leaflet-container')).toBeNull();
  });
});
