# Adversarial review: Home banners (A), dashboard Banners (B), fluid nav (C)

Reviewer: read-only, 28 Oct 2026. Scope: commits 1f06541 (backend), 82f9c82 (dashboard), a0b72ff (Flutter shell + kraveo_ui). The carousel files being written by another agent were NOT reviewed. Nothing was run except `node -e` style one-liners on the pure link-validation logic. CONFIRMED = traced in code. SUSPECTED = needs a real browser or phone.

Verdict: no BLOCKER found. No money, auth or data-loss path was found in the three changes. The link validator is strong (I fuzzed 23 extra spellings: IDN, fullwidth digits, percent-encoded dots, `%2f@`, trailing dot, `https:///host`, all rejected or normalised safely). The real risks are: weak forensics if the admin account is abused (M1), a silent schedule loss in the date pickers (M2), unauthenticated counter inflation and DB write amplification (M3), and several UX/perf issues in the swipe shell that only a phone can confirm (M4-M6).

## Summary table (ranked)

| # | Sev | Status | Area | One line |
|---|-----|--------|------|----------|
| M1 | MEDIUM | CONFIRMED | A | Audit rows never contain the link/image URL or who acted, and the test enforces that; a hijacked admin pushing a phishing link leaves no usable trail |
| M2 | MEDIUM | SUSPECTED (browser) | B | A half-filled `datetime-local` reads as `''`, Save then silently drops the schedule: banner goes live now / never ends |
| M3 | MEDIUM | CONFIRMED | A | Public events endpoint: anyone can inflate views/clicks of any live banner (ids are public); per-IP limit only; 2 row-locking UPDATEs per call can starve the DB pool from many IPs |
| M4 | MEDIUM | SUSPECTED (phone) | C | Every swipe start/end and every page crossing calls `setState` on the whole shell, rebuilding the full Home feed mid-gesture |
| M5 | MEDIUM | SUSPECTED (phone) | C | Pages 1-3 are now built lazily during the first swipe (Google map platform view, order history, profile): first-visit jank; IndexedStack built them at start |
| M6 | MEDIUM | CONFIRMED (cost) | C | Track tab `visible` drops to false at the start of ANY pager drag, even one that springs back: unwatch + socket leave, then HTTP refresh + rejoin on settle |
| L1 | LOW | CONFIRMED | C | Two-tab tap gives 3 haptic ticks and an icon pop on the tab it passes through |
| L2 | LOW | CONFIRMED | C | `onPageChanged` overwrites `_currentTab` with intermediate pages during a programmatic multi-hop; back in the first ~130 ms leaves the app; re-tapping restarts the animation |
| L3 | LOW | SUSPECTED | C | Android edge-swipe (system back gesture) from the right edge of Home exits the app instead of going to the next tab |
| L4 | LOW | CONFIRMED | B | Dashboard shows "Live" for an 11th live banner that the app will never show (cap is 10) |
| L5 | LOW | CONFIRMED | A/B | "Changes reach customers within about a minute" is not true for an app that stays in the foreground; no global kill switch, no host allow-list; image host unrestricted (tracking pixel to every customer) |
| L6 | LOW | SUSPECTED | B | Enter in title/button text submits during IME composition (Safari, some Android IMEs); Hindi titles are explicitly allowed |
| L7 | LOW | CONFIRMED | B | Drawer closes on Esc/backdrop/X with unsaved edits and also while a save is in flight (Cancel is disabled, the other three are not); stale `onSaved` then closes a newly opened drawer |
| L8 | LOW | SUSPECTED | B | Reload race: a list fetched before a delete lands after it and puts the deleted row back (ghost row) |
| L9 | LOW | CONFIRMED | C | `KTabPagerHandoff` sign is LTR-only (`-n.overscroll`); `KFluidNav` geometry and label alignment are LTR-only; app has no RTL locales so dormant |
| L10 | LOW | CONFIRMED | A | Rate limits are per process / per address: one student can use 10 req/s to blank the carousel for a whole campus NAT address; IPv6 /64 rotation bypasses the limit |
| L11 | LOW | CONFIRMED | C | Cosmetic/maintenance: `kraveo_ui` pubspec says Flutter >=3.24 but uses `SemanticsRole.tab` (3.32+); tab semantics hard-code English "tab 1 of 4" and have no tab-bar container role; the Track order switcher chips are not wired to the hand-off |

## Findings in detail

### M1 (MEDIUM, CONFIRMED) Audit trail cannot answer "what link was pushed, and by whom"
- `backend/src/services/audit.ts:8-10` `writeAudit(action, targetType, targetId, summary)` has no actor field and `AdminAuditLog` (schema.prisma:409) has no actor column. `banners.ts` takes `actor` in every function but never records it except `createdByUserId` on create (banners.ts:283, 405). Edits and deletes carry no actor at all.
- `banners.ts:287` (create) logs only "with link / no link". `banners.ts:328-333` (patch) logs `linkUrl changed` and `imageUrl changed` with no old/new value. `test/e2e/home_banners.test.ts:686` asserts "no links or secrets in it", i.e. the gap is pinned by a test as if it were a feature. A URL is not a secret.
- Trigger: admin session stolen (token is in localStorage, `web/super_admin/src/services/api.ts:101`), attacker sets any https link on a live banner. Every customer sees a tap target. Afterwards the only evidence is "linkUrl changed". The previous link is overwritten and gone.
- Fix: put the new `linkUrl` and `imageUrl` (truncate to ~120 chars; the summary limit is 300) into the BANNER_CREATED/BANNER_EDITED summary, plus old link for edits. Optional: add `actorId` to the audit table later. Size S (about 10 lines + test change).
- Also consider (hardening, S): an optional env allow-list `BANNER_LINK_HOSTS` (play.google.com, forms.gle, docs.google.com, kraveo.site) so a stolen session cannot push an arbitrary host; and `BANNERS_ENABLED=false` as a global kill switch read in `listPublicBanners`.

### M2 (MEDIUM, SUSPECTED) Partial date-time silently removes the schedule
- `web/super_admin/src/components/BannerDrawer.tsx:182` controlled `<input type="datetime-local">`. In Chrome a half-typed value (date without time, or one segment backspaced) reports `value === ''` and fires no useful change. State becomes `''`.
- `lib/bannerParse.ts:261-270` `createBody` omits `startsAt`/`endsAt` when the text is `''`; `changesOf` (lines 286-287) sends `null` when the text is `''` and the saved value exists. `validateSchedule` treats `''` as "no schedule". The Clear button is disabled when the value is `''`, so the admin cannot even see/clear the half-typed text.
- Result: admin types "1 Nov" in Starts but no time, presses Save: the banner is created live immediately. Or edits an End segment badly: the End is cleared and the banner never ends. The only cue is the grey line "Always on" under the pickers.
- Fix: read `e.target.validity.badInput` in `onChange` and keep a `badInput` flag per picker; if set, show "Enter the time too, or press Clear" and block Save. Size S. Needs a browser to confirm (jsdom cannot).

### M3 (MEDIUM, CONFIRMED) Public events endpoint: inflation and write amplification
- `routes/banners.ts:30-33` + `services/banners.ts:234-248`. No auth. Banner ids are returned by the public list, so anyone can POST `{"views":[10 ids],"clicks":[5 ids]}`. Each call = 2 `UPDATE ... FOR UPDATE` statements locking up to 15 rows. Limit is 300/min per IP (`rateLimit.ts:134`).
- Impact 1 (data): the dashboard shows views/clicks/CTR as truth ("no invented numbers"); the owner may judge campaigns by it. One script makes a banner CTR anything. No per-device dedupe; "once per session" is only client-side.
- Impact 2 (availability): many IPv4 or IPv6 addresses (a /64 gives unlimited keys, `clientIp` uses the full address) can keep the same 10 rows locked in series and occupy the Prisma pool that orders also use. `recordBannerEvents` awaits the DB in the request path (routes/banners.ts:31).
- Fix (M, optional before launch): accumulate counts in memory (`Map<id, {v,c}>`) and flush every 5-10 s in one UPDATE per table; cap flushed increments per interval per banner; treat the numbers as "approximate". Cheaper S step: drop the `await` (fire and forget with the existing catch) and cap total events per minute globally.

### M4 (MEDIUM, SUSPECTED) Rebuild of the whole shell on every swipe
- `apps/customer_app/lib/screens/home_screen.dart` (a0b72ff) `_onPagerScroll` lines 113-127 calls `setState` at ScrollStart and ScrollEnd; `onPageChanged` line 165 calls `setState` at every page crossing (3 extra for a 0-to-3 tap). Each `setState` rebuilds `Scaffold`, all four `_TabPage` children, including `Builder(_buildHomeFeed)` (the full feed with kitchens and chips).
- The first rebuild happens on the very first frame of a drag, which is when jank is most visible on a low-end phone.
- Fix: keep `_currentTab`/`_settledTab` in `ValueNotifier`s; make `_TabPage` and `PopScope` listen to them, so the feed is not rebuilt. Size M. Measure first with the profile build on a 3-4 GB phone.

### M5 (MEDIUM, SUSPECTED) Lazy building of tabs during the gesture
- `PageView(children: [...])` builds only the visible pages (default no cache extent). `AutomaticKeepAlive` keeps them after the first visit. `IndexedStack` built all four at start. So the first swipe/tap to Track builds `LiveTrackingScreen` and, with a live order, creates the `GoogleMap` platform view while the page is moving; Orders and Me build their lists the same way.
- Fix options: `allowImplicitScrolling: true` (builds neighbours), or a post-first-frame warm-up that jumps nothing but calls `precache` by wrapping pages in a `Visibility(maintainState)` for one frame; or build map lazily on `visible` only (it already should be). Size S/M. Phone needed.

### M6 (MEDIUM, CONFIRMED cost) Track watch churn on aborted drags
- `home_screen.dart:116` ScrollStart sets `_settledTab = null`, `LiveTrackingScreen(visible: _settledTab == 1)` (line ~172) so `visible` becomes false. `live_tracking_screen.dart:90-98` `_syncWatch(null)` calls `OrderProvider.unwatch` (order_provider.dart:907) which re-runs `_syncRealtime()` (socket room leave). When the drag springs back to Track, `watch` (line 900) does `refreshOrder` (one HTTP GET) plus rejoin.
- Trigger: any horizontal wobble on the Track tab (slop 18 px). Each is 1 GET + socket leave/join. While swiping, `isWatching` is false, so an in-app order banner may show for the order the user is looking at.
- Fix: S. Only set `_settledTab = null` when the drag has actually moved the page by >= some threshold, or keep `visible` true until the page has left Track (`_pager.page` differs from 1 by > 0.5). Alternatively debounce `unwatch` by ~400 ms.

### L1 (LOW, CONFIRMED) Haptic spam on multi-hop tap
- `packages/kraveo_ui/lib/src/widgets/fluid_nav.dart:148-156` and 191-199. Tap 0 to 2: `_tap` sets `_tapTarget=2` + tick #1. At page 0.5 `_selected` becomes 1: `_tapTarget(2) != 1` so tick #2, `_tapTarget = null`, and an icon pop on tab 1. At 1.5 `_selected=2`, `_tapTarget` is null so tick #3. A slow finger drag around x.5 also ticks repeatedly (and restarts `_pop`). Contract said "one haptic per settled change".
- Fix: S. Keep `_tapTarget` until `sel == _tapTarget`, skip haptic and pop for intermediate selections while `_tapTarget != null`; for finger drags fire on the settled index only (hysteresis or ScrollEnd).

### L2 (LOW, CONFIRMED) `_currentTab` flips through intermediate pages
- `home_screen.dart:88-110` sets `_currentTab = target` at tap, but `PageView.onPageChanged` (line 165) reports every rounded page it crosses, so tapping Me from Home gives `_currentTab` 3,1,2,3. `PopScope(canPop: _currentTab == 0)` (line 146) therefore is true for the first ~100-150 ms of Me-to-Home: a back press there leaves the app. A repeated tap on the target while `_currentTab` is an intermediate page restarts `animateToPage` (visible hitch).
- Fix: S. Ignore `onPageChanged` while `_settledTab == null && _animatingTo != null`, or derive back behaviour from the target tab stored separately.

### L3 (LOW, SUSPECTED) Android system back gesture vs edge swipes
- With Android 10+ gesture navigation, a swipe that starts within roughly 24 dp of the right edge is the system back gesture. On Home `canPop` is true, so it minimises the app. It is the natural thumb swipe for "next tab". Device-only. Mitigation: none cheap; mention in release notes or keep `canPop:false` on Home with a "press back again to exit" pattern if complaints come.

### L4 (LOW, CONFIRMED) Status says "Live" for banners the app will not show
- `services/banners.ts:217` shows only the first 10 live rows; `statusOf` (line 171) and dashboard `STATUS` (BannersPanel.tsx:54) have no notion of the cap. An 11th live banner is chip-labelled Live, "Customers see it now." Fix S: dashboard computes the position among live rows and shows "Live (not shown, limit 10)".

### L5 (LOW, CONFIRMED) Kill-switch latency and reach
- Dashboard text (BannersPanel.tsx) promises about a minute. Server cache 30 s (banners.ts:49-53) + `Cache-Control: public, max-age=30` (routes/banners.ts:22) + whatever the app does (spec: refresh on resume and pull-to-refresh only, and "keep last good list"). A foregrounded app can show a switched-off banner for hours. Fix: reword the text ("next time the app is opened or refreshed") and have the carousel refresh every ~10 min while visible (other agent).
- `imageUrl` accepts any https host (banners.ts:113): an attacker-controlled host receives IP, user agent and timing of every customer who opens Home. Same trust level as the link, but silent. Allow-list as in M1.

### L6 (LOW, SUSPECTED) Enter during IME composition submits
- `BannerDrawer.tsx:114` Enter handler fires for `type=text` inputs without checking `event.nativeEvent.isComposing` / `keyCode 229`. Chrome swallows composition Enter, Safari fires it after `compositionend`. Hindi titles are allowed by the contract. Fix: S, add the check.

### L7 (LOW, CONFIRMED) Drawer discard paths
- `Drawer.tsx` closes on Esc (own handler), backdrop click and X regardless of `saving`/`uploading`. Cancel is disabled while saving (BannerDrawer.tsx:105) but the others are not. Typed text is lost with no confirm. If closed mid-save, `onSaved` (BannersPanel.tsx:226-240) still runs: it calls `setDrawer(null)`, which closes a drawer the admin may have reopened. Fix: S, ignore `onClose` while `saving`, confirm on dirty.

### L8 (LOW, SUSPECTED) Stale fetch after delete
- BannersPanel.tsx effect (lines 123-143) has a `seq` guard only for effect re-runs. `onSaved` calls `reload()`; a delete issued while that fetch is in flight and finishing earlier than the fetch's snapshot leaves the deleted row in `setList(rows)`. The row then fails with 404 on action and reloads. Also the `setOrder` updater (line 131) reads `serverOrderRef.current` which is mutated on the next line; it is only correct because React evaluates the updater eagerly here. Fix: S, build the next order outside the updater.

### L9 (LOW, CONFIRMED) RTL
- `tab_pager_scope.dart:83` `finger = -n.overscroll` assumes a non-reversed axis (for `AxisDirection.left` the sign must not be flipped). `fluid_nav.dart` uses `Alignment.centerLeft`, `EdgeInsets.only(left:)`, `lefts[]` in LTR order while a RTL `PageView` is reversed, so the blob would move against the finger. Dormant: no `supportedLocales`/RTL in the customer app.

### L10 (LOW, CONFIRMED) Limits on a campus NAT
- 600/min per address for GET /banners (rateLimit.ts:133). Normal use is far below. But one student scripting 10 req/s from campus wifi makes everyone on that address get 429 and no carousel (harmless to ordering; separate rule names). `SlidingWindow` is per process (single instance now).

### L11 (LOW) Smaller items
- `packages/kraveo_ui/pubspec.yaml` `flutter: ">=3.24.0"` but `fluid_nav.dart:365` needs Flutter 3.32+ (`SemanticsRole.tab`). Local SDK is 3.44, so only matters for an older CI.
- Semantics label hard-codes English `tab 1 of 4` (fluid_nav.dart:362) and the group has no `SemanticsRole.tabBar` parent; TalkBack may announce the role plus the label.
- Track tab order switcher (`live_tracking_screen.dart:263`) is not wrapped in `KTabPagerHandoff`: a swipe there is stuck at its ends.
- Blur: `BackdropFilter(sigma 24)` plus a 34 dp blurred shadow plus a blob shadow repaint every pager frame; no `RepaintBoundary`. Probably fine on mid-range, unknown on a 3 GB phone.

## What I checked and found safe

Backend (A)
- Link/image validation: raw checks before `new URL` (tabs/newlines, backslash, `https:host`, `https:/host`, uppercase scheme accepted and normalised), credentials (`user@`, `%2f@`), ports (default 443 normalises away), IPv4 in decimal/hex/octal/fullwidth/circled digits, trailing-dot IPs, IPv6 incl. mapped, `localhost`, `.localhost`, `localhost%2e`, `[`, underscore hosts, 500-char cap before and after normalisation. `https://host#@evil` and `?@evil` keep host `host` (harmless). Punycode/IDN homographs are accepted by documented design (admin-level risk, see M1).
- No server-side fetch of `linkUrl`/`imageUrl` anywhere: no SSRF.
- Text fields: `<`/`>` refused, control/bidi/zero-width refused, NFC, code-point lengths, `raw.length > max*8` guard before normalising. No `dangerouslySetInnerHTML`/`innerHTML` anywhere in web/super_admin (grep); preview renders as React text.
- Strict bodies: `Object.keys` catches own `__proto__`; every unknown key 400. `placement` only HOME. Dates: ISO with zone, impossible dates rolled out explicitly, 2000-2100, `24:00`/`:60` refused, 1970/9999 refused.
- Locks: create/duplicate/delete/reorder take the advisory lock first, patch takes only its row; events lock ids ascending; no cycle possible. 30-cap is exact under parallel creates (advisory lock + count inside the tx). Reorder locks all rows in id order. Delete idempotent.
- Cache: invalidation runs after commit and a read that began before a write cannot store (generation check); schedule is evaluated per request so start/end are exact (start inclusive, end exclusive) and there is no cache-boundary window. Single process today.
- Events: body parser is route-local with `limit: 2kb`, `inflate:false` (compressed bodies 415), global 100 KB parser skips the path (regex is case-insensitive, trailing slash ok, rate-limit path is lowercased/normalised), `text/plain` bodies are never parsed (no counting), invalid JSON 400, errors swallowed. `LEAST(x+1, INT_MAX)` cap (an int4 overflow at exactly INT_MAX is unreachable in practice).
- Authz: all `/admin/banners*` routes use `requireAuth` + `requireRole('ADMIN')`; params validated; uploads route unchanged except `promo` in the allow-list, `FILE_PATH_RE`, still raw body with magic-byte check, nosniff, immutable, unique 128-bit names, no path input.
- Migration: additive, `IF NOT EXISTS`, `lock_timeout 5s`, same BEGIN/COMMIT pattern as 20261012; name sorts after the latest. Rollback = drop the table.
- Error leakage: `fail()` path; errors carry only the controlled messages.

Dashboard (B)
- IST maths is a fixed +05:30 offset with `Date.UTC` only; browser time zone/DST cannot change the result (`istToInstant`, `instantToIst`, `formatIst`). Round trip is minute precision; `changesOf` compares IST text, so seconds in an API-created date do not create false edits.
- Only changed fields are patched, so a stale drawer cannot overwrite another admin's concurrent edits to other fields.
- Test link: only the validated, normalised URL, `target=_blank rel="noopener noreferrer"`. Preview `<img>` uses `referrerPolicy="no-referrer"`, and the dashboard CSP (`vercel.json`) limits `img-src` to self, data:, OSM tiles, api.kraveo.site, kraveo.site, images.unsplash.com, so arbitrary hosts cannot be fetched from the admin browser; `script-src 'self'`. javascript:/data: in `<img src>` do nothing in current browsers.
- Double submit guarded by `busy` ref; upload and save mutually exclusive; 401/403 go to `handleSessionError` from fetch, save, toggle, reorder, duplicate, delete and upload. 429 and server `field` errors reach the right input. Reorder buttons disabled while saving; `ImageUploadField` change is behaviour-neutral for old callers (I traced the three branches).
- Focus trap/restore, Esc, aria-modal, labels, `aria-live` announcements, 44 px targets present.

Flutter (C)
- Rider app: `glass_nav.dart` untouched; the only change to the shared package is two exports. No same-named classes in apps (grep). `KGlassNav` still used by `driver_app`.
- Lifecycle: `KPagePosition`, `_pos` listener, ticker, `_pop`, `_stretch` all disposed in the right order; `KTabPagerHandoff` cancels an active `Drag` in dispose; replaced `PageController` in `_goToTab` is disposed post-frame after the PageView detached it; `AppLifecycleListener` disposed; child-first unmount makes `_pager.dispose()` safe.
- Keep-alive: `AutomaticKeepAliveClientMixin` under the default `SliverChildListDelegate` keep-alive wrapper works; hidden pages have tickers off (`TickerMode`) like the old IndexedStack; engine hides off-frame platform views.
- Gesture arena: the map approach matches Flutter's documented model (platform view recognisers join a team; a deeper recogniser that crosses its slop first wins, and the map's `HorizontalDragGestureRecognizer` is deeper than the pager's, so it routes first). Vertical map drags are deliberately left to the page, same as before the change (map is a 220 dp card inside a ListView). Pull-to-refresh uses depth-0 notifications of the inner ListView, so pager notifications never reach it. Hand-off velocity/sign convention is consistent for LTR (finger frame in, finger frame out, ScrollEnd carries the DragEndDetails).
- Drag-start races: ScrollEnd always arrives (including `jumpToPage` and a cancelled animation), so `_settledTab` cannot stay null in the paths I traced; `animateToPage` to the current page is excluded by the guard in practice.
- No Android predictive-back regression found: `PopScope` logic is unchanged apart from L2.
- Label fit: widths come from `TextPainter` with the live `TextScaler`; 2x text drops the label to icon-only per tab; targets stay at least 52 x 68 dp.

## Test gaps
- Backend: no test that audit rows carry the link (the opposite is asserted, M1); no test of events with many distinct IPs or IPv6 keys; no test for a body sent with `Transfer-Encoding: chunked` over 2 KB (body-parser should reject but it is unproven here); no test for 11 live banners status vs public list (L4); no test that `startsAt == endsAt` boundary and a patch on an OFF banner with a past `endsAt` plus `isActive:true, endsAt:null`.
- Dashboard: nothing exercises `datetime-local` badInput (jsdom cannot), IME Enter, drawer closed during save, delete during reload, 11th live banner, or CSP in a real browser.
- Flutter: the map tests use `_MapStandIn` (a `RawGestureDetector`), not a platform view; haptic count is not asserted across a two-hop tap (L1); no test of the `!_pager.hasClients` controller-swap branch with `KFluidNav` rebinding; no test that Track `visible` stays true on an aborted drag (M6); no RTL, no 1.5-2x text with a badge, no tablet width.

## Only provable on a real phone or browser
1. Android (hybrid composition and texture mode) and iOS: horizontal drag on the Google map pans the map and does not swipe tabs; diagonal and two-finger pinch on the 220 dp map card inside the vertical ListView; map not frozen or offset while the PageView is moving; first-visit map creation during the swipe (M5). iOS also depends on the platform-view gesture blocking policy.
2. Edge swipes with Android gesture navigation and predictive back (L3), including back during an animation (L2).
3. Frame times: swipe with the blur pill and shadow, shell rebuilds on swipe start (M4), on a 3-4 GB phone in profile mode. Battery with the Track tab hidden.
4. Haptic feel and count (L1), TalkBack reading of the tab items and focus order, 2x font in system settings, split-screen and tablet width, rotation during a swipe.
5. Browser: partially typed `datetime-local` in Chrome, Safari and Firefox (M2); IME Enter with Hindi (L6); drawer focus trap while saving; real CSP behaviour for off-list image hosts.
6. Production: the migration, restart, and the `/api/banners` caching headers through nginx or any CDN in front (does anything cache for longer than 30 s?).
