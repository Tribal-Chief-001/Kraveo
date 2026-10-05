# Campus drop points, maps and live rider tracking - contract (5 Oct 2026)

Owner decisions (all settled, do not re-ask): hostels are named BH1..BH8 (boys), "Special Block" (boys, its own drop point), GH1, GH2 (girls); "VIT Main Gate" is removed; old stored values are migrated; the customer picks the delivery point at the start (profile) AND confirms it again at checkout in a small clean popup; riders can be tracked on the admin dashboard at any time while they are on duty; everything must stay fast, must not regress anything that works today, and must degrade gracefully (no map key / no Play Services / offline = the old behaviour, never a crash).

Non-goals: no Directions/Routes/Places API, no turn-by-turn inside Kraveo (the rider's "Navigate" opens the Google Maps app), no location HISTORY (only the latest rider position is stored, as today), no location for customers.

## 1. Campus data (single source of truth: backend `src/config/campus.ts`, mirrored as constants in the apps for offline use)

| id (= name shown) | group | lat | lng |
|---|---|---|---|
| BH1 | boys | 23.074861 | 76.859889 |
| BH2 | boys | 23.073556 | 76.859861 |
| BH3 | boys | 23.073556 | 76.859861 |
| BH4 | boys | 23.073361 | 76.858389 |
| BH5 | boys | 23.073361 | 76.858389 |
| Special Block | boys | 23.073361 | 76.858389 |
| BH6 | boys | 23.072750 | 76.860000 |
| BH7 | boys | 23.072889 | 76.859222 |
| BH8 | boys | 23.072889 | 76.859222 |
| GH1 | girls | 23.074778 | 76.851972 |
| GH2 | girls | 23.074917 | 76.853194 |

Display/list order is exactly the table order. Campus centre = arithmetic mean of the distinct pins. Several names share one pin on purpose (blocks are close together).

Legacy values (old apps, stored data, tests) are accepted and normalised to the canonical name: `Block N`, `Boys Hostel Block N` (N 1..6 -> BHN), `Girls Gate N`, `Girls Hostel Gate N` (N 1..2 -> GHN), case-insensitive, extra spaces tolerated. `VIT Main Gate` and anything else unknown stay INVALID for new input (400, same message and field as today).

## 2. Backend (and the web dashboard)

- `config/campus.ts`: `DROP_POINTS`, `normalizeDropPoint(raw): string | null` (canonical name or null), `dropPointCoords(name)`, `CAMPUS_CENTER`, `isNearCampus(lat,lng)` (within 3 km of the centre). `DROP_POINT_RE` / `HOSTEL_RE` in routes are replaced by `normalizeDropPoint`; order creation and profile update STORE the canonical name (so legacy input is saved as BHn / GHn). Idempotent replay of an order compares canonical names.
- `GET /api/campus` (auth required, cached 5 min is fine): `{ success:true, data:{ center:{lat,lng}, dropPoints:[{ id, name, group, lat, lng }] } }`.
- OrderView (Docs/16, additive, same visibility as `dropoffHostel`): `dropoff: { name, lat, lng } | null` (null for a stored legacy value that cannot be normalised); `vendor` already has `lat`,`lng` - add `hasLocation: boolean` (false while the vendor still has the placeholder pin 23.0768/76.8524 or no real pin).
- Data migration (additive, runs on prod via `prisma migrate deploy`): rewrite `User.hostelBlock` and `Order.dropoffHostel` from legacy values to canonical names with SQL (only recognised legacy patterns; everything else untouched). Include a safe `lock_timeout`/short transaction. Prod holds test data only (Block 1, Block 3, Boys Hostel Block 1).
- Vendors: `PATCH /api/admin/vendors/:id/location` `{ lat, lng }` (ADMIN only, validated number ranges AND `isNearCampus`, audit-logged) and the existing create-vendor path validates the same way. The dashboard vendor drawer/manager gets an input "Location (paste from Google Maps, e.g. 23.0745, 76.8590)" with validation and a "not set" badge.
- Rider location pipeline stays (`POST /api/drivers/location`, socket `update_driver_location`, `driver_location_update` to admins, `rider_location` to the owning customer). Add: `GET /api/drivers/locations` (admin) also returns `dutyStatus`, `approvalStatus` and `lastUpdated`; a rider's position is only broadcast to admins while the rider is ONLINE (a position that arrives after going OFFLINE is stored but not broadcast) - check the current behaviour first and only change it if it differs.
- Dashboard (web/super_admin, Vite+React): replace the fake projected grid in `LiveCommandCenter` with a REAL map using Leaflet + OpenStreetMap tiles (no API key; attribution kept): campus drop points (labelled, grouped), vendor pins (only with real location), live rider markers coloured by state (idle / heading to restaurant / delivering / stale > 2 min / offline), click = name, status, last update, active order; smooth marker updates from the existing `driver_location_update` socket event (no full re-render, no flicker); list on the side stays; works when the tile server is unreachable (markers + list still render); responsive (phone width) and fast (no per-update list rebuild storm). Keep the existing panel behaviour and tests.
- Tests: normalisation table (every legacy and canonical form, rejects), order create/replay with legacy and canonical names, profile update, OrderView `dropoff` + `hasLocation`, migration SQL against the test DB (apply it to a table with legacy rows), `/api/campus`, vendor location endpoint (auth, validation, near-campus), tracking visibility unchanged. Existing 433 tests must keep passing; update an existing assertion ONLY where the stored text legitimately changes from `Block 2` to `BH2` and say so.

## 3. Customer app (apps/customer_app)

- `kHostelBlocks` becomes the 11 canonical names (order as in section 1); a `DropPoint` model with coordinates (const list, same numbers as the backend); `normalizeHostelBlock` maps every legacy form (including "Block 3", "Boys Hostel Block 3", "Girls Gate 1") to the canonical name; "VIT Main Gate" -> not recognised (null: the user is asked to choose again). Profile setup and profile edit use the new list.
- Checkout: a "Delivering to <name>" row with "Change", and when the customer taps Pay (before the order is created / payment opens) a small clean bottom sheet: title "Confirm your delivery point", the 11 points as selectable chips (current one preselected, grouped Boys / Girls), a primary button "Confirm and pay" and a quiet "Cancel". Choosing a different point updates the order's `dropoffHostel` (and the saved profile point only if the customer ticks nothing extra - do NOT silently change the profile). The sheet appears once per payment attempt, never blocks a retry of an already-created order (keep Docs/16 idempotency intact: the same cart + same point replays the same order).
- Tracking: a real Google map (`google_maps_flutter`) showing the restaurant pin (only if `vendor.hasLocation`), the delivery point pin, and the rider marker moving smoothly from `rider_location` sockets (interpolate between fixes, no jumps); camera fits the visible pins; "Rider is about N min away" only when computable from straight-line distance and a fixed average speed (label it approximate, e.g. "about 5 min"). If the map cannot load (no key, no Play Services, any plugin error) the existing `AnimatedRiderMap` is shown instead - the tracking screen must never crash or show a blank box. Never show the rider position when the order is not ARRIVING/PICKED_UP-phase per the current visibility rules.
- Android: Maps key comes from Gradle property `MAPS_API_KEY` (or env `KRAVEO_MAPS_API_KEY`) -> `manifestPlaceholders`; the manifest contains `${MAPS_API_KEY}` and NEVER a literal key; with no key the build still works and the fallback map shows. Remove the unused `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` permissions and `usesCleartextTraffic="true"` (release traffic is https; keep http only for the debug/local config via a debug manifest overlay if the app uses a local server in debug).
- Tests: normalisation table, picker list, confirm sheet behaviour (preselect, change, cancel, confirm), checkout still replays the same order, tracking falls back to the animated map when the map factory is unavailable (inject a fake), no overflow at 360x640 / 1.3x text. Existing 218 tests keep passing.

## 4. Driver app (apps/driver_app) - done after the backend contract is in

- While the rider is ONLINE (on duty) the app keeps sending its position even with the screen off, using a foreground service (geolocator foreground notification: "Kraveo - you are on duty, sharing your location with Kraveo"), Android 14 `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` already handled. Position interval about 10 s when moving; battery-friendly settings; stops when the rider goes OFFLINE or logs out; survives the app being swiped away only as far as Android allows (do not promise more). Use while-in-use permission with the foreground service and REMOVE `ACCESS_BACKGROUND_LOCATION` (Play review). Existing GPS states/problems UI and tests stay.
- Active delivery: buttons "Navigate to restaurant" / "Navigate to <drop point>" that open the Google Maps app (`google.navigation:q=lat,lng`, fall back to a `geo:` / https maps link); a restaurant without a real pin disables the first button with "Restaurant location not set - call the restaurant". A small map card (Google map, same key mechanism as the customer app, with a plain fallback card) shows pickup, drop and the rider's own position.
- Tests with fakes: foreground service start/stop with duty, no sends when OFFLINE, navigate URL building, missing-location handling, fallback when the map is unavailable. Existing 165 tests keep passing.

## 5. Secrets and builds

- The two Maps keys live in `~/.kraveo-secrets/maps-customer-key.txt` and `maps-driver-key.txt` (restricted by package + SHA-1 + Maps SDK for Android). They are never committed, printed or logged. Release builds pass them as `KRAVEO_MAPS_API_KEY=$(tr -d '[:space:]' < ~/.kraveo-secrets/maps-<app>-key.txt) flutter build apk --release`.
- The old literal key that is in the repo history (`AIzaSyC_C0fr...`) is deleted in the Google Cloud console by the owner after the new APKs are verified on a phone.
- Debug SHA-1 `60:FA:23:1D:98:67:34:C3:45:99:58:AE:98:71:FA:3D:79:63:8E:2E` is what the current APKs are signed with; the release/Play SHA-1s are added later.
