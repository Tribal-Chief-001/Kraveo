# WEB - Admin dashboard (web/super_admin) bug hunt, 6 Oct 2026

Hunter: WEB. Read-only review; nothing was run (no tests, builds, browsers). All paths are under `/home/lucifer/Documents/Projects/Kraveo/` unless noted.

## 1. Scope covered

Read completely: `web/super_admin/{index.html, vercel.json, vite.config.ts, tsconfig.json, postcss.config.js, tailwind.config.js, package.json, .gitignore}`, env files (variable names and hosts only; no secret values were printed; the `.env*` files are gitignored and not tracked), and every file under `src/`: `App.tsx`, `main.tsx`, `types.ts`, `index.css`, `services/api.ts`, `lib/{orders, orderProblems, tokens, campus, riderMarkers, vendorLocation, credentials}.ts`, `components/{LiveCommandCenter, CampusMap (+campusMap.css), OrdersTable, OrderDrawer, OrderControls, NeedsAttentionPanel, ApplicationsPanel, CustomersPanel, VendorManager, DriverManager, AddPartnerDrawer, VendorLocationEditor, AnalyticsPanel, Sidebar, Header, LoginScreen}.tsx`, and all of `components/ui/*`. Tests: `CampusMap.test.tsx`, `lib/riderMarkers.test.ts`, `lib/vendorLocation.test.ts` read in full; `VendorLocation.test.tsx` read to line 80 only (the rest is the same mocking style for ApplicationsPanel and NeedsAttentionPanel). Built output `dist/assets` was inspected only for hosts, source maps and the font shorthand.

Backend counterparts read: `backend/src/routes/api.ts` (admin login, drivers, locations, campus, admin/partners, vendors, analytics), `routes/partners.ts` (applications, status, reset-password, customers, audit log), `routes/orders.ts` (list, status, reassign, admin cancel/reset-otp/retry-refund, needs-attention), `realtime.ts` (whole), `services/orderView.ts`, `services/orderFlow.ts` (reassign, refreshRiderDuty), `services/password.ts` (policy), `config/campus.ts` (drop points), prisma `Payment` / `DriverPartner`. Docs read: 16, 19, 20 (dashboard parts) and the other hunters' reports (BE2 only, for admin overlaps).

Not read: `VendorLocation.test.tsx` lines 80-166; `public/logo-bgremove.png` (binary); `package-lock.json` (no dependency audit was possible offline).

## 2. Summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 2 |
| MEDIUM | 7 |
| LOW | 13 |

No XSS, injection or authz hole was found in the dashboard. The risks are wrong numbers on screen, silent data limits, and a socket that gives up.

## 3. Findings

### HIGH

**WEB-01 - Vendors tab "Active orders" is always 0** - HIGH - CONFIRMED
- Where: `web/super_admin/src/types.ts:387` (`activeOrdersCount: asNumber(raw?.activeOrdersCount ?? raw?._count?.orders)`), shown at `components/VendorManager.tsx:102`. Backend `GET /api/vendors` (`routes/api.ts:582`) is `findMany({ include: { menuItems: true } })`; the string `activeOrdersCount` does not exist anywhere in `backend/src`, and there is no `_count`.
- Trigger: open the Vendors tab while a restaurant has live orders (the demo: customer orders from "Sharma Dhaba", then admin opens Vendors).
- What happens: every restaurant card says "Active orders 0" while the live map and Orders tab show open orders for it.
- Demo impact: the owner sees a number that contradicts the screen next to it.
- Fix (S): compute it in `VendorManager` from the `orders` prop (count non-terminal orders by `vendorId`), or drop the tile. Do not wait for a backend change.
- OWNER-INPUT: no.

**WEB-02 - Drivers tab KPIs and rider stats are numbers nothing ever computes** - HIGH - CONFIRMED
- Where: `components/DriverManager.tsx:74-77, 85-92, 126-130, 160-163` show "Trips today", "Payouts today" (a money figure), "Avg completion", "On-time rate" and rating from `DriverPartner.ordersToday / totalEarningsToday / avgCompletionTimeMinutes / onTimeRatePercent / rating`. No backend code writes `ordersToday`, `totalEarningsToday`, `avgCompletionTimeMinutes` or `onTimeRatePercent` (grep of `backend/src`: only `store.ts` and `utils/seedDb.ts` seeds, 8 trips / 320 rupees). Only `rating` is updated (reviews, `api.ts:952`), and it defaults to 5.0.
- Trigger: open Drivers after a rider has completed a real delivery in the demo.
- What happens: a rider created or approved in the demo shows Trips 0, Payout ₹0, "No completed trips reported", rating 5.0 (default, not earned) even right after delivering. If the old demo seed riders exist on prod (SEC-09 in the earlier audit: unverified) they show 8 trips and ₹320 "today" forever, as fact.
- Demo impact: the owner has been burned by fabricated "done" claims; a payout figure that is invented is the worst kind. The audience watching a delivery complete sees "Trips today 0".
- Fix (S): hide the Trips/Payouts/Avg-completion tiles and the per-rider Trips/Payout/On-time/Rating until real data exists, or compute trips today from the loaded `orders` (DELIVERED, `driverId === rider.userId`, `deliveredAt` today IST). Show "New" for rating only when the rider has no reviews (needs backend) - otherwise hide.
- OWNER-INPUT: decide whether to hide or compute.

### MEDIUM

**WEB-03 - The dashboard silently loads only the newest 100 orders** - MEDIUM - CONFIRMED
- Where: `services/api.ts` `fetchOrders()` calls `/api/orders` with no params; backend `routes/orders.ts:104-128` gives admins `limit` default 100 (max 200), newest first, with `nextCursor` that the dashboard ignores (`request()` returns only `body.data`). `lib/orders.ts` `mergeOrderLists` then drops any local order older than the newest fetched one that is not in the page.
- Trigger: more than 100 orders newer than some still-open order. Every checkout attempt creates an order (unpaid carts included), so rehearsals plus a spam account make this reachable. Then that older active order vanishes from the pipeline lanes, the Orders tab, the "Active deliveries" KPI and the sidebar badge (it still shows in Needs attention).
- What happens: no warning anywhere. The Orders header subtitle says "Every order, its payment and its live status" (`Header.tsx:21`) and the counter reads "Showing 100 of 100 orders".
- Fix (S): request `?limit=200` and, better, add a "Load older" button using `nextCursor`; word the subtitle "Latest orders". Optionally request `scope=active` for the live map.
- OWNER-INPUT: no.

**WEB-04 - Assigning an offline rider fails with an API-jargon message and there is no way to force it** - MEDIUM - CONFIRMED
- Where: `components/OrderControls.tsx:99-111` offers offline riders (labelled "(offline)"); `services/api.ts` `reassignOrderDriver` never sends `force`; backend `services/orderFlow.ts:603-605` returns 409 `RIDER_OFFLINE`: "That rider is offline. Send force: true to assign them anyway."
- Trigger: admin picks an "(offline)" rider in the lane dropdown or the drawer.
- What happens: optimistic name flashes, rolls back, red toast "Rider not changed - That rider is offline. Send force: true to assign them anyway." The admin cannot follow the advice. Same for an "(on a delivery)" rider: 409 `RIDER_BUSY` (rider limit is 1 active order), where the label invites the click.
- Fix (S): either filter offline/busy riders out of the options (or `disabled`), or on `RIDER_OFFLINE` ask "Assign anyway?" and resend with `force: true`; map both error codes to plain sentences.
- OWNER-INPUT: no.

**WEB-05 - Vendors and the rider roster are never refreshed after login (no poll, no socket event), so some panels go stale** - MEDIUM - CONFIRMED
- Where: `App.tsx:107-118` (`silentRefresh` only refetches orders, rider positions and needs-attention; also run after a socket reconnect, `App.tsx:180`). `fetchVendors` and `fetchDrivers` run only in `fetchBackendData` (login, the Refresh button, after an Applications decision or partner creation). Backend emits no vendor event (`isAcceptingOrders`, location) to admins; `driver_duty_update` exists (`partners.ts:344`, `orderFlow.ts:116`) but is lost while the socket is down.
- Trigger A: a restaurant detects its GPS location from its app (the feature added yesterday) after the dashboard loaded. The "Restaurants without a map location" warning, the Needs attention badge count and the missing map pin stay wrong until someone presses Refresh. Trigger B: a restaurant opens or closes itself in its app: Vendors tab shows the old state. Trigger C: laptop sleeps or Wi-Fi blips: duty changes missed during the gap are never repaired, so "Drivers online", the Drivers tab and the marker states (`riderStates` prefers the roster over the pin) stay wrong.
- Demo impact: "restaurant sets location, admin sees it" does not show up live; the red attention badge stays on.
- Fix (S): in `silentRefresh` (every 15 s and on reconnect) also call `fetchVendors` and `fetchDrivers` and set state only when something changed (or every 60 s).
- OWNER-INPUT: no.

**WEB-06 - Live socket gives up for good after 8 failed reconnects (about 30 s)** - MEDIUM - CONFIRMED
- Where: `App.tsx:164-168`: `reconnectionAttempts: 8`, no `reconnection_failed` handler. After the last attempt socket.io stops; the badge stays red "Offline / Disconnected" until the page is reloaded. (REST polling continues, so data is only 15 s late, but the red badge and slower markers are visible.)
- Trigger: server restart that takes more than half a minute (BE2 even recommends `pm2 restart` before the demo), a campus Wi-Fi outage of one minute, or a laptop lid closed and reopened.
- Fix (S): remove the option (default is unlimited) or set `reconnectionAttempts: Infinity, reconnectionDelayMax: 10000`; also call `socket.connect()` on the `disconnect` reason `"io server disconnect"`.
- OWNER-INPUT: no.

**WEB-07 - Any failure while checking the stored session logs the admin out** - MEDIUM - CONFIRMED
- Where: `App.tsx:147-156`: `validateSession().catch(error => { clearAuthToken(); ... })` runs for every error: no network, API restarting (502/504), 429, timeout. The token is erased.
- Trigger: reload or open the dashboard while the API or Wi-Fi is briefly down.
- What happens: the admin lands on the passcode screen with no explanation, and has to know the passcode (the passcode lock is per IP, BE2-03). A valid 30-day session is destroyed by a blip.
- Fix (S): only clear the token on 401/403; for network/5xx show "Cannot reach the server, retrying" and keep the token (retry in a loop).
- OWNER-INPUT: no.

**WEB-08 - "Avg delivery time" on the live screen disagrees with Analytics (and is inflated)** - MEDIUM - CONFIRMED
- Where: `components/LiveCommandCenter.tsx:95-101` uses `updatedAt - createdAt`. Backend analytics (`api.ts` /analytics, fixed in 4faf04f) uses `deliveredAt - createdAt` because `updatedAt` moves on later writes. A customer review sets `isReviewed` (`api.ts:920`) and a refund or retry touches the row, so `updatedAt` can be hours after delivery. The dashboard `Order` already carries `deliveredAt`. Also only the loaded 100 orders count (WEB-03).
- Trigger: deliver an order, let the customer rate it later; the first KPI row on the main screen then grows, while the Analytics tab shows a different number for the same label.
- Fix (S): use `order.deliveredAt ?? order.updatedAt`.
- OWNER-INPUT: no.

**WEB-10 - "Reactivate" a suspended restaurant leaves it Closed, while the toast says it can start working** - MEDIUM - CONFIRMED
- Where: backend `partners.ts:463` sets `isAcceptingOrders = false` on suspend and does not restore it on approve; `ApplicationsPanel.tsx:77` toasts "`<name>` can start working now." and the card flips to Approved.
- Trigger: demo "suspend then reactivate a restaurant" (the dashboard offers exactly this), then place an order in the customer app.
- What happens: the restaurant shows as closed to customers (Vendors tab shows "Closed"); orders are refused. Nothing tells the admin to flip the switch.
- Fix (S): after approving a VENDOR that was SUSPENDED, offer/auto call `toggleVendorStatus(id, true)` or change the toast to "Approved. It is still Closed: switch it open in Vendors." (a backend change to restore the flag is the clean fix, but the dashboard hint is enough).
- OWNER-INPUT: business rule: should reactivation re-open the restaurant?

### LOW

**WEB-09 - No error boundary except around the map; unguarded localStorage** - LOW - CONFIRMED (absence); no concrete crash input found
- Where: `grep componentDidCatch` finds only `LiveCommandCenter.tsx:24`. `main.tsx` renders `<App/>` with no boundary. `services/api.ts:60-69` calls `localStorage` without try/catch (the Sidebar guards its own use).
- Impact: any exception while rendering a record (a null where a string is expected after a backend change) blanks the entire dashboard on stage; storage blocked (private window, strict cookie settings) throws on the first effect.
- Fix (S): one boundary around `<main>` content keyed by tab, with a "Reload this tab" button; wrap the token helpers in try/catch.

**WEB-11 - Suspended, pending or rejected restaurants are drawn on the live map like live ones** - LOW - CONFIRMED
- `LiveCommandCenter.tsx:144-146` filters only on a real pin; `GET /vendors` returns all statuses to admin. Fix (S): `.filter(v => v.approvalStatus === undefined || v.approvalStatus === 'APPROVED')`. Also the vendor popup keeps the old coordinates after an admin edits the pin (`CampusMap.tsx:156-163` builds the popup once) and the label keeps the old name after a rename.

**WEB-12 - Admin lockout and session expiry give no useful message** - LOW - CONFIRMED
- `ApiError` (`api.ts:35`) drops `retryAfterSeconds`; the 429 text is "Too many admin login attempts. Try again later." with no time (BE2-03 lock is 15 min, per IP). A 401 mid-session (`App.tsx:62-69`) returns to the login screen with no "session expired" notice (`errorMessage` is not shown there). Fix (S): keep `retryAfterSeconds` in `ApiError` and show "Try again in N min"; set a one-line notice on session loss. Ops note from BE2 stands: demo from a hotspot, not shared Wi-Fi.

**WEB-13 - Invalid CSS in the map labels** - LOW - CONFIRMED in the built CSS; visual effect SUSPECTED
- `components/campusMap.css:44` and `:63` use `font: 700 10px/1.4 inherit;` and `font: 800 10px/1.5 inherit;`. `inherit` cannot be the family inside the shorthand, so the whole declaration is dropped (the same text is in `dist/assets/CampusMap-*.css`). Drop-point, restaurant and rider labels then render at the map's 12 px regular weight instead of 10 px extra bold, so BH1..BH8 labels (about 100 m apart) overlap more. Fix (S): `font-family: inherit; font-size: 10px; font-weight: 800; line-height: 1.5;`.

**WEB-14 - Long unbroken text can break the drawer layout** - LOW - SUSPECTED
- `OrderDrawer.tsx` customer name (`:241`, up to 59 letters, no `break-words`/`min-w-0` inside a 2-column grid), `dropoffNotes` (`:245`, up to 300 chars, a pasted URL has no break points), and the cancel reason in the "Cancelled" notice (`:163`). The drawer body is `overflow-y-auto`, so a wide word creates a horizontal scrollbar. Fix (S): add `break-words` (class `[overflow-wrap:anywhere]`) to those paragraphs. Everything is escaped by React, so this is layout only.

**WEB-15 - A page opened before a redeploy cannot load the map** - LOW - SUSPECTED
- `LiveCommandCenter.tsx:19` lazy-loads the map chunk (hash in the name). After a new Vercel deploy the old chunk name is gone; `vercel.json` rewrites every unknown path (including `/assets/CampusMap-xxxx.js`) to `index.html`, so the import fails with a MIME error and `MapBoundary` shows "The map could not be loaded" with no retry button. Fix (S): add a "Reload page" button in `MapBoundary`; ops: hard-reload the dashboard after the last deploy, do not deploy during the demo.

**WEB-16 - "Tracked runners" and "N runners plotted" include every rider that ever sent a position** - LOW - CONFIRMED
- `GET /api/drivers/locations` (`api.ts:73-93`) returns all stored `DriverLocation` rows for admin (rehearsal riders, suspended riders, riders who tested from home); the dashboard plots them all. The subtitle says "riders on duty". Offline ones are dark markers by design (Docs/19), but the count and list look like a crowd. Fix (S): list only `dutyStatus !== 'OFFLINE'` by default with a "Show offline" toggle; clean old rows before the demo (OWNER step).

**WEB-17 - Small misleading signals** - LOW - CONFIRMED
- Header "Synced 14m ago" (`Header.tsx:81`) is set only by the manual refresh (polls are silent), so it looks stale on a live screen. `PAYMENT_FAILED` is informational (tone neutral) but counted in the red Needs-attention sidebar badge and the Orders table "Needs attention" chip (`App.tsx:441`, backend `orders.ts:445` lists every PLACED+FAILED order): a failed test card in the demo turns the badge red. A new paid order produces no toast or sound (`new_order_alert` is handled like `order_updated`, `App.tsx:193-194`). The live "Online/Offline" pill is hidden below 640 px (`Header.tsx:126`). Fix (S) each.

**WEB-18 - Single-click actions with side effects, and unsequenced fetches** - LOW - CONFIRMED
- "Reset OTP lock" (sends the customer a new code), "Retry refund", and closing a restaurant (Switch) run on one click with no confirm. `handleToggleVendor` (`App.tsx:363-377`) has no busy guard: two fast clicks send two requests whose answers can arrive in either order, and a failure restores the whole older vendor list (undoing a pin saved meanwhile). `ApplicationsPanel.load` and `AnalyticsPanel.load` have no request sequence number (CustomersPanel has one): switching filters fast can show the older answer. Fix (S): confirm for OTP reset; disable the Switch while pending; add a `seq` ref like CustomersPanel.

**WEB-19 - Times use the browser clock and zone** - LOW - CONFIRMED
- `dateTime`/`clock` helpers (`OrderDrawer.tsx:37,79`, `CustomersPanel.tsx:22`, `Header.tsx:80`) use the browser time zone; only the pin date forces IST. Stale-rider (2 min), "overdue" and "pay by" logic use `Date.now()` vs server timestamps (`riderMarkers.ts:41`, `orders.ts:minutesSince`). A demo laptop whose clock is a few minutes off makes every rider grey ("Stale") or every order "Not accepted". Fix (S): take the offset from the response `Date` header or `generatedAt`; format with `timeZone: 'Asia/Kolkata'`.

**WEB-20 - Test gaps in the riskiest logic** - LOW - CONFIRMED
- Only 4 test files exist (map, rider markers, campus parsing, vendor location). Nothing tests `lib/orders.ts` (`mergeOrderLists`, `isOlder`, `restoreIfUntouched`, `nextStep`), `normalizeOrderPartial`, `orderProblems`, `api.ts` error handling, App socket wiring/optimistic actions, the login screen, or any panel besides the location bits. WEB-03, WEB-07 and the optimistic-flicker below would be caught by small unit tests.
- Minor related: a poll response issued before an action returns can briefly flip an optimistic non-terminal status back (equal `updatedAt` is not "older", `lib/orders.ts:isOlder`), then the server copy fixes it (flicker only).

**WEB-21 - Performance nits** - LOW - CONFIRMED
- The 505 KB logo PNG is shipped twice (`public/` as favicon and `src/assets/` hashed) and used on login, sidebar and loading screens. The Orders tab renders both the desktop table and the card list for every order (CSS-hidden), including two `NextStepControl` per order. `App` holds all state, so every rider flush (up to 1/s) re-renders the whole tree outside the memoised pipeline. Fine for 100 orders; mention only if the dashboard feels slow on the laptop. Fix (S): shrink the PNG to a 128 px WebP/PNG; render only one layout with `matchMedia`.

**WEB-22 - Contrast** - LOW - SUSPECTED (computed, not measured in a browser)
- `text-kraveo-ink3` (#7C897F) on `surface2` (#1A241C) is about 4.4:1 at 11 px; red `k-btn-danger` text (#E5484D) on its 10 % tinted background is about 4.2:1 at 14 px bold. Slightly under 4.5:1 for small text. Fix (S): lighten ink3 to about #8A9890 and the danger text to #F0686C.

## 4. Looked hard and found nothing

- XSS: every server string (customer name, notes, cancel reason, restaurant name, rider name, drop-off) is rendered as React text; Leaflet popups, divIcons, labels and aria-labels are built with `createElement`/`textContent`/`setAttribute` (`CampusMap.tsx`), covered by a test with an `<img onerror>` name. No `innerHTML`, `dangerouslySetInnerHTML`, `eval` anywhere (grep). `tel:` and Google Maps links are built from validated phone numbers and numeric coordinates; external links use `rel="noopener noreferrer"`.
- CSP vs reality: fonts bundled by fontsource (`assetsInlineLimit: 0` keeps them off `data:`), OSM tiles allowed in `img-src`, API and `wss` allowed in `connect-src` (env hosts are `https://api.kraveo.site`), no inline scripts, Leaflet images are hashed assets. Avatar images from other hosts are blocked by `img-src` and fall back to initials. OSM gets a Referer origin (policy `strict-origin-when-cross-origin`).
- Bundle: no source maps, no secrets in `dist`; only the API host and map URLs. `.env*` are gitignored and untracked.
- Socket: one socket per login, cleaned up (`disconnect`) on logout; listeners are not duplicated (all effect dependencies are stable); rider position events are buffered and applied at most once a second; markers are updated in place and removed when a rider leaves the list (no marker/timer leak found); popups refresh only when open.
- Contracts: rider id mapping (`Order.driverId` = rider user id, `DriverPartner.id` accepted by reassign), `driver_duty_update` payload, `driver_location_update` fields (`driverId`/`id`), needs-attention shape, refund and OTP fields, customers and applications shapes all match the backend code. Admin cancel reason rule (3-200 chars) matches the form. Password policy (min 8) matches the generator (no digit guaranteed, but the server only checks length).
- Authz surface: every call the dashboard makes is an admin-only route; 401/403 logs the admin out; the passcode is only ever sent to `/auth/admin-login`.
- CSV/export: none exists. Hostel analytics cannot get free-text labels (server normalizes drop points).

## 5. Top 5 to fix before the demo

1. WEB-01 and WEB-02: remove or compute the fake "Active orders", "Trips today", "Payouts today", "Avg completion", rating numbers (S, dashboard only).
2. WEB-06 and WEB-05: unlimited socket reconnects, and refetch vendors and riders in `silentRefresh` (S).
3. WEB-08: use `deliveredAt` for the live "Avg delivery time" so both screens agree (S).
4. WEB-04 and WEB-10: make assign-offline-rider explain itself (or force), and tell the admin that a reactivated restaurant is still Closed (S).
5. Ops, no code: hard-reload the dashboard after the last deploy (WEB-15), clean old rider location rows and demo seed riders (WEB-16, WEB-02), demo from a hotspot and keep the passcode handy (WEB-07, WEB-12).

## 6. Only provable on a real browser / device / server

- WEB-13 label rendering and overlap at campus zoom; WEB-14 horizontal scroll in the drawer; WEB-22 contrast; phone-width layout of the map card and lanes; the lane drag/scroll feel.
- Real OSM tile loading and the "map background unavailable" notice on campus Wi-Fi.
- Socket behaviour through nginx (websocket upgrade, idle timeouts), and WEB-06 timing after a real `pm2 restart`.
- Whether stationary on-duty riders keep sending positions (otherwise they turn Stale after 2 minutes; Rider app scope, the dashboard just reflects it).
- Server time zone/clock versus the demo laptop clock (WEB-19), and whether old `DriverLocation`/seed rider rows exist on prod (WEB-02, WEB-16).
- Large-list behaviour (more than 100 orders) and the Vercel stale-chunk case (WEB-03, WEB-15).
