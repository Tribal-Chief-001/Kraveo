import React, { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './campusMap.css';
import { DropPointInfo, LatLng, groupDropPins, formatLatLng } from '../lib/campus';
import { RIDER_STATE_META, RiderMarkerState, ageLabel, describeRider, positionAgeMs } from '../lib/riderMarkers';

export interface MapRider {
  id: string;
  name: string;
  lat: number;
  lng: number;
  state: RiderMarkerState;
  lastUpdated?: string;
  /** "SHORTID to BH2" when the rider carries an order. */
  orderLabel: string | null;
}
export interface MapVendor { id: string; name: string; lat: number; lng: number }

interface Props {
  riders: MapRider[];
  vendors: MapVendor[];
  dropPoints: DropPointInfo[];
  center: LatLng;
  /** Re-evaluated every 30 s by the parent so stale / "x min ago" text moves on without a new position. */
  now: number;
  /** Pan to a rider and open its popup. A new object (new `n`) re-triggers even for the same rider. */
  focusRequest?: { id: string; n: number } | null;
}

interface RiderEntry { marker: L.Marker; root: HTMLElement; label: HTMLElement; data: MapRider; aria: string }

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
/** After this many tile errors in a row the map says the background is unavailable (markers keep working). */
const TILE_ERROR_LIMIT = 3;

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Popup content as DOM nodes with textContent only: a rider's name can never inject markup. */
const riderPopup = (r: MapRider, now: number): HTMLElement => {
  const meta = RIDER_STATE_META[r.state];
  const box = el('div');
  box.appendChild(el('div', 'k-popup__title', r.name));
  const state = el('div', 'k-popup__row', meta.label);
  state.style.color = meta.hex;
  state.style.fontWeight = '700';
  box.appendChild(state);
  box.appendChild(el('div', 'k-popup__row', `Updated ${ageLabel(positionAgeMs(r.lastUpdated, now))}`));
  box.appendChild(el('div', 'k-popup__row', r.orderLabel ? `Order ${r.orderLabel}` : 'No active order'));
  box.appendChild(el('div', 'k-popup__mono', formatLatLng(r.lat, r.lng)));
  return box;
};

const CampusMap: React.FC<Props> = ({ riders, vendors, dropPoints, center, now, focusRequest }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ridersRef = useRef(new Map<string, RiderEntry>());
  const vendorsRef = useRef(new Map<string, { marker: L.Marker; lat: number; lng: number; name: string }>());
  const staticLayerRef = useRef<L.LayerGroup | null>(null);
  const nowRef = useRef(now);
  nowRef.current = now;
  const fittedRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);

  // ---- create the map once; remove it on unmount -------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    fittedRef.current = false;
    selectedRef.current = null;
    let map: L.Map;
    try {
      map = L.map(host, { center: [center.lat, center.lng], zoom: 16, minZoom: 12, maxZoom: 19, zoomSnap: 0.5, attributionControl: true });
    } catch {
      return undefined; // Leaflet could not start (very old browser): the list beside the map keeps working
    }
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    const tiles = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION });
    let errors = 0;
    tiles.on('tileerror', () => { errors += 1; if (errors >= TILE_ERROR_LIMIT) setTilesFailed(true); });
    tiles.on('tileload', () => { errors = 0; setTilesFailed(false); });
    tiles.addTo(map);
    staticLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // The card can change size (window, sidebar, orientation): tell Leaflet.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
      observer.observe(host);
    }
    map.on('popupclose', () => {
      const entry = selectedRef.current ? ridersRef.current.get(selectedRef.current) : null;
      entry?.root.classList.remove('k-rider--selected');
      selectedRef.current = null;
    });
    return () => {
      observer?.disconnect();
      ridersRef.current.clear();
      vendorsRef.current.clear();
      staticLayerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- drop points (static) and restaurants -------------------------------------------------------------
  useEffect(() => {
    const layer = staticLayerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    for (const pin of groupDropPins(dropPoints)) {
      const text = pin.names.join(' / ');
      const node = el('span', `k-pin k-pin--${pin.group}`, text);
      const marker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({ className: 'k-pin-marker', html: node, iconSize: [0, 0] }),
        keyboard: false,
        zIndexOffset: -500,
      });
      const popup = el('div');
      popup.appendChild(el('div', 'k-popup__title', `Drop point: ${text}`));
      popup.appendChild(el('div', 'k-popup__row', pin.group === 'girls' ? 'Girls hostel' : 'Boys hostel'));
      popup.appendChild(el('div', 'k-popup__mono', formatLatLng(pin.lat, pin.lng)));
      marker.bindPopup(popup, { className: 'k-popup' });
      marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `Drop point ${text}`));
      marker.addTo(layer);
    }
  }, [dropPoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = vendorsRef.current;
    const seen = new Set<string>();
    for (const v of vendors) {
      seen.add(v.id);
      const entry = live.get(v.id);
      if (entry) {
        if (entry.lat !== v.lat || entry.lng !== v.lng) { entry.marker.setLatLng([v.lat, v.lng]); entry.lat = v.lat; entry.lng = v.lng; }
        continue;
      }
      const marker = L.marker([v.lat, v.lng], {
        icon: L.divIcon({ className: 'k-pin-marker', html: el('span', 'k-pin k-pin--vendor', v.name), iconSize: [0, 0] }),
        keyboard: true,
        zIndexOffset: -200,
      });
      const popup = el('div');
      popup.appendChild(el('div', 'k-popup__title', v.name));
      popup.appendChild(el('div', 'k-popup__row', 'Restaurant'));
      popup.appendChild(el('div', 'k-popup__mono', formatLatLng(v.lat, v.lng)));
      marker.bindPopup(popup, { className: 'k-popup' });
      marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `Restaurant ${v.name}`));
      marker.addTo(map);
      live.set(v.id, { marker, lat: v.lat, lng: v.lng, name: v.name });
    }
    for (const [id, entry] of live) {
      if (!seen.has(id)) { entry.marker.remove(); live.delete(id); }
    }
  }, [vendors]);

  // Fit the view to the campus (drop points + restaurants) once, never again: the admin may be exploring.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    const pts: L.LatLngTuple[] = groupDropPins(dropPoints).map((p) => [p.lat, p.lng]);
    for (const v of vendors) pts.push([v.lat, v.lng]);
    if (pts.length === 0) return;
    fittedRef.current = true;
    try { map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 17, animate: false }); } catch { /* keep the default view */ }
  }, [dropPoints, vendors]);

  // ---- riders: update markers in place (no re-creation of the map or of unchanged markers) ----------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = ridersRef.current;
    const seen = new Set<string>();
    for (const r of riders) {
      seen.add(r.id);
      let entry = live.get(r.id);
      if (!entry) {
        const root = el('span', `k-rider k-rider--${r.state}`);
        root.appendChild(el('span', 'k-rider__dot'));
        const label = el('span', 'k-rider__label', r.name);
        root.appendChild(label);
        const marker = L.marker([r.lat, r.lng], {
          icon: L.divIcon({ className: 'k-rider-marker', html: root, iconSize: [24, 24], iconAnchor: [12, 12] }),
          keyboard: true,
          zIndexOffset: 1000,
          riseOnHover: true,
        });
        marker.bindPopup(() => {
          const e = ridersRef.current.get(r.id);
          return e ? riderPopup(e.data, nowRef.current) : el('div');
        }, { className: 'k-popup', autoPanPadding: [30, 30] });
        const aria = describeRider(r.name, r.state, positionAgeMs(r.lastUpdated, now), r.orderLabel);
        marker.on('add', () => {
          const e = ridersRef.current.get(r.id);
          marker.getElement()?.setAttribute('aria-label', e ? e.aria : aria);
        });
        marker.addTo(map);
        entry = { marker, root, label, data: r, aria };
        live.set(r.id, entry);
        marker.getElement()?.setAttribute('aria-label', aria);
        continue;
      }
      const prev = entry.data;
      if (prev.lat !== r.lat || prev.lng !== r.lng) entry.marker.setLatLng([r.lat, r.lng]);
      if (prev.state !== r.state) {
        entry.root.classList.remove(`k-rider--${prev.state}`);
        entry.root.classList.add(`k-rider--${r.state}`);
      }
      if (prev.name !== r.name) entry.label.textContent = r.name;
      const aria = describeRider(r.name, r.state, positionAgeMs(r.lastUpdated, now), r.orderLabel);
      if (aria !== entry.aria) { entry.aria = aria; entry.marker.getElement()?.setAttribute('aria-label', aria); }
      entry.data = r;
      if (entry.marker.isPopupOpen()) entry.marker.getPopup()?.setContent(riderPopup(r, now));
    }
    for (const [id, entry] of live) {
      if (!seen.has(id)) { entry.marker.remove(); live.delete(id); if (selectedRef.current === id) selectedRef.current = null; }
    }
  }, [riders, now]);

  // ---- list click -> pan to the rider and open the popup ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusRequest) return;
    const entry = ridersRef.current.get(focusRequest.id);
    if (!entry) return;
    ridersRef.current.get(selectedRef.current ?? '')?.root.classList.remove('k-rider--selected');
    selectedRef.current = focusRequest.id;
    entry.root.classList.add('k-rider--selected');
    map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 17), { animate: true });
    entry.marker.openPopup();
  }, [focusRequest]);

  return (
    <div className="k-map-wrap relative isolate h-full w-full overflow-hidden rounded-k-lg bg-[radial-gradient(ellipse_at_50%_40%,#12281A_0%,#0B140D_55%,#080D09_100%)]">
      <div className="k-map-grid absolute inset-0" aria-hidden="true" />
      <div
        ref={hostRef}
        className="absolute inset-0"
        role="region"
        aria-label="Live campus map. Drop points, restaurants and riders. The list beside the map has the same riders."
      />
      {tilesFailed && (
        <p role="status" className="pointer-events-none absolute bottom-7 left-2 z-[500] max-w-[16rem] rounded-md border border-kraveo-line bg-kraveo-night/90 px-2.5 py-1.5 text-[11px] text-kraveo-ink2">
          Map background could not be loaded. Riders and drop points still update.
        </p>
      )}
    </div>
  );
};

export default CampusMap;
