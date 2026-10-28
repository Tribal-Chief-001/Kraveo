# Home banners (promo slideshow) + fluid swipeable navigation - contract (28 Oct 2026)

Binding for backend, dashboard, shared UI package and customer app. Builds on Docs/23 (uploads, admin patterns). Nothing here may change orders, payments, pricing, settlements, groups, categories or any existing screen's behaviour; no existing test may break (list every test you change and why).

## 0. Owner asks (28 Oct 2026)
1. A modern, sleek, "sexy" promo slideshow at the top of the customer Home for launches and events. The admin controls it from the dashboard: image, title (+ optional subtitle and button text), a link and a schedule. Tapping a banner opens its link: a web page, a Play Store link or a Google Form (any https URL).
2. The customer app's bottom bar feels dated: switching tabs only works by tapping, the highlight is an awkward green outline pill. Make it modern, fluid and buttery: swipe left/right between tabs, a highlight that glides with the finger, micro animations and transitions everywhere they add polish, never gimmicky.
3. End to end, production hardened, no regression.

## 1. Banners: data model (additive migration `20261013_home_banners`)
`HomeBanner`: `id uuid`, `title String` (2..60), `subtitle String?` (<= 120), `imageUrl String` (https, <= 500), `linkUrl String?` (https, <= 500), `ctaLabel String?` (<= 20), `theme String` default `DARK` (`DARK` = light text on a dark gradient, `LIGHT` = dark text on a light gradient), `placement String` default `HOME` (only HOME exists today; the column is for later), `isActive Boolean default true`, `startsAt DateTime?`, `endsAt DateTime?`, `sortOrder Int`, `viewCount Int default 0`, `clickCount Int default 0`, `createdAt`, `updatedAt`, `createdByUserId String?`. Index on (`placement`, `isActive`, `sortOrder`). At most 30 rows in total (409 `BANNER_LIMIT`), at most 10 shown at once.
Text rules: trimmed, collapsed whitespace, NFC, no control / bidi / zero-width characters (reuse `utils/labels.ts`), Hindi/emoji allowed (these fields are NOT restricted to ASCII).
Link rules (security): `linkUrl` must parse as a URL with scheme exactly `https`, a real host (with a dot, not an IP literal, not `localhost`), no username/password, no whitespace, <= 500 chars; normalise with `new URL().toString()`. Everything else (`http`, `javascript:`, `data:`, `intent:`, `market:`, `mailto:`, `tel:`, `file:`, custom schemes) -> 400 `BANNER_LINK_INVALID` with a plain message. Play Store `https://play.google.com/...`, `https://forms.gle/...`, `https://docs.google.com/forms/...`, any https page are fine. A banner may have no link (display only).
`imageUrl`: https URL (our own uploads `https://api.kraveo.site/uploads/promo/...` or any https host, same check as dish images).

## 2. Banners: API
- **Public** `GET /api/banners` (no auth, `Cache-Control: public, max-age=30`, in-memory server cache 30 s dropped by every banner write, rate limited): banners with `isActive`, `placement = HOME`, (`startsAt` null or <= now) and (`endsAt` null or > now), ordered by `sortOrder` then `createdAt`, max 10 -> `{ success, data:[{ id, title, subtitle, imageUrl, linkUrl, ctaLabel, theme }] }` (no counters, no schedule, no internal fields).
- **Events** `POST /api/banners/events` (no auth needed, rate limited per IP and per body size, body <= 2 KB): `{ views?: [id,...] (<= 10), clicks?: [id,...] (<= 5) }` -> `{success:true}` always fast; unknown/inactive ids ignored silently; increments `viewCount`/`clickCount` with one atomic `UPDATE ... SET x = x + 1` per id; never errors the client.
- **Admin** (ADMIN only, audit-logged, rate limited, validated): `GET /api/admin/banners` (all rows with counters, `status` per row computed server-side: `LIVE | SCHEDULED | EXPIRED | OFF`, plus `ctr` = clicks/views rounded to 1 decimal or null), `POST /api/admin/banners`, `PATCH /api/admin/banners/:id` (partial; `startsAt`/`endsAt` may be set to `null`; `endsAt` must be after `startsAt`; `endsAt` already in the past is allowed only with `isActive:false`), `DELETE /api/admin/banners/:id`, `POST /api/admin/banners/reorder` `{ids:[...]}` (renumber 10,20,...; unknown ids -> 400), `POST /api/admin/banners/:id/duplicate` (copy as OFF, title + " (copy)"). Idempotent where natural; row lock on edit; responses `{success, data, message?}`; errors `{success:false, code, message, field?}`.
- **Image upload**: extend the existing `POST /api/admin/uploads/image?purpose=` with `purpose=promo` (stored under `promo/`); same checks as today (magic bytes, size <= 1 MB, 200..2400 px). Recommended banner size 1200 x 600 (2:1); the server does NOT enforce the aspect ratio (the app crops with cover), but warns nothing; the dashboard shows the crop preview.

## 3. Dashboard: "Banners" section (sidebar item, icon image/megaphone)
- List: thumbnail, title, status chip (Live / Scheduled / Expired / Off), schedule in IST, views, clicks, CTR, active switch, up/down reorder (Save order), edit, duplicate, delete (confirm). Empty state explains what banners are. Search not needed (<= 30).
- Create/Edit drawer: image upload with the existing compression helper (<= 1200 px wide, WebP/JPEG, <= 1 MB) and a live **phone preview** that renders the banner exactly like the app card (2:1 crop with the chosen theme, title, subtitle, CTA pill) updating as the admin types; title, subtitle, button text, link URL (inline validation = https only, with a "Test link" button that opens it in a new tab with `rel=noopener noreferrer`), theme toggle, start and end date-time pickers in IST (stored as UTC instants, shown with the IST label, clear buttons), active switch. Per-field server errors, "nothing changed" state, plain words, 360 px usable, keyboard accessible, no invented numbers.
- Counters are read-only. Dates default empty (= always on).

## 4. Customer app: Home banner carousel (section 4) and fluid navigation (section 5)

### 4.1 Carousel behaviour and look (Home tab, between the greeting/search/drop-point header and the category chips; the existing first-order promo card stays below it)
- Source `GET /api/banners`, loaded in the background with the other Home data (never blocks Home, no spinner, no layout jump: until the first success the area takes NO space; after success cards animate in with a gentle fade/slide). On failure/empty list keep the last good list from memory; if none, show nothing. Refresh on pull-to-refresh and on app resume.
- Look: rounded (use the design tokens' xl radius) 2:1 cards in a `PageView` with `viewportFraction` ~0.9 so the next card peeks; the centre card is full size, neighbours scale/fade slightly; image has a subtle parallax drift against the swipe; a soft gradient overlay chosen by `theme`; title (bold, max 2 lines), subtitle (max 2 lines), optional CTA pill ("Order now"-style, uses `ctaLabel`, only shown when `linkUrl` exists); text enters with a short staggered fade/slide when its card becomes current; image fades in over a soft shimmer placeholder and falls back to a branded gradient with the title if the image fails; unified shadow and 1 px border like other cards.
- Indicator: small animated dots; the active dot stretches into a pill and fills with the brand colour as the page moves (driven by the page position, not just the settled index).
- Motion: auto-advance every ~5 s with a smooth emphasized curve; pauses while the user touches/drags, while the Home tab is not the visible tab, while the app is in the background, and when the platform asks to reduce motion (`MediaQuery.disableAnimations`); resumes after ~3 s idle. Single banner = no auto-advance, no dots. Looping is allowed (infinite feel) only if tap targets and indices stay correct.
- Tap: press-scale feedback (`KPressable`), then if `linkUrl` exists open it with `url_launcher` in `LaunchMode.externalApplication` (web page, Play Store app, Google Form); on failure a friendly snackbar ("Couldn't open this link"); never crash, never navigate inside the app. A tap/view sends a fire-and-forget event to `POST /api/banners/events` (views once per banner per app session, clicks on each tap; failures ignored; batched).
- Gesture rules: horizontal drags on the carousel belong to the carousel; at the first/last card an overscroll hands the swipe to the tab pager (section 5) so the tab swipe is never "stuck" behind the banner; vertical scrolling of the Home feed is never blocked by the carousel.
- Accessibility: each card has a semantics label "Title, subtitle. Opens link" and is a button when it has a link; dots hidden from the semantics tree; text scales to 2x without overflow (card height grows or text clamps); dark mode and light mode both look intentional; images use a decode cap (`cacheWidth` ~ 1200) like `KImage`.
- Performance: images decoded at display size, only neighbours pre-cached, timers and controllers disposed, no rebuild storms (the page position feeds an `AnimatedBuilder`/`ValueListenable`, not `setState`).

## 5. Fluid navigation (shared package `packages/kraveo_ui` + customer app shell)
- **Do not modify `KGlassNav`** (the rider app uses it). Add a new widget `KFluidNav` (+ small helper if needed) to `kraveo_ui`, exported next to the others, with its own widget tests. The customer app switches to it; the rider app is untouched.
- **Swipeable tabs**: the customer shell (`home_screen.dart`) replaces the `IndexedStack` by a `PageView` controlled by a `PageController`; swiping left/right anywhere on a tab's body moves to the neighbouring tab with the page following the finger; tapping a tab animates the pager (about 320-380 ms, emphasized curve; a jump across two tabs animates through without building every page in between visibly more than needed); all four tabs stay alive (keep-alive: Home feed scroll position, order history, profile state and the live tracking screen state survive swipes, same as with `IndexedStack`); the tracking screen's `visible` flag must be true only when its tab is the settled page (it controls timers/maps). Existing behaviour must stay: back button on a non-Home tab returns to Home first; `_goToTab(...)` calls from other screens/push taps still work (animate when visible, jump when the target is far or the app is resuming); the nav badge/active-order bar logic stays.
- **Visual language** (use design tokens, light and dark): floating glass pill like today but refined: slightly taller (about 64-68 dp), soft blur, a 1 px hairline inner border, a layered soft shadow; NO heavy green outline. One highlight "blob" (brand colour, subtle top-light gradient, soft glow) that GLIDES between tabs and follows the pager position continuously (it stretches a little while moving fast, then settles with a spring); icons cross-fade/scale and tint between the faint and the selected colour as the page position passes them; the label of the selected tab slides/fades in next to the icon (clipped, never overflows at 2x text: fall back to icon only when it does not fit); a short icon "pop"/bounce on selection; light `HapticFeedback.selectionClick()` when the settled tab changes; the unread/active-order badge pops in with a scale animation; pressed state scales to ~0.94. Respect `MediaQuery.disableAnimations` (instant, no bounce). Minimum 48 dp tap targets, semantics: each item is a selectable tab with label, `selected` state and position ("Home, tab 1 of 4").
- **Gesture conflicts**: nested horizontal scrollables (banner carousel, category chips row, any horizontal list) take their own drags; the tab pager receives drags on the rest of the screen and the overscroll handoff described in 4.1; vertical scrolling is unaffected; the Google Map on the tracking tab must still pan (give the map the gesture priority, so a horizontal drag on the map pans the map, while a horizontal drag on the surrounding card/area swipes tabs; document the rule).
- Provide a `KFluidNav` API that takes the `PageController` (or an `Animation<double>`/`ValueListenable<double>` page position) + items + `onTap(index)`; no business logic inside.

## 6. Rules for every part
- No regression: backend (1039), dashboard (790), customer (433), restaurant (514), rider (394) and `kraveo_ui` tests keep passing; the rider app still builds against `kraveo_ui`. Old customer app builds keep working against the new server (new endpoints are additive). Migration additive.
- Tests with real Postgres for banners (validation incl. every bad link scheme, schedule logic with a fake clock, status computation, ordering, caps, cache invalidation, events counting atomically under parallel calls, rate limits, role checks (customer/owner/driver/anonymous cannot use admin endpoints), idempotent reorder, delete), dashboard component/API tests with REAL response shapes, widget tests for the carousel (auto-advance with fake time, pause on touch/hidden tab, dots follow the page, tap opens link via a mocked launcher, failure snackbar, hidden when empty, 2x text, 360x640, dark mode) and for `KFluidNav` + the swipeable shell (swipe changes tab, tap animates, keep-alive state survives, back button, badge, reduce-motion, semantics).
- Deploy order: backend (migration + restart), dashboard, then the app build (the app hides the carousel on old servers: 404 -> nothing).

## 7. Implementation notes (backend, 28 Oct 2026) - exact shapes for the dashboard and the apps
Built in `backend/`: migration `prisma/migrations/20261013_home_banners` (one new table + one index, idempotent, verified to match `schema.prisma`), `src/services/banners.ts`, `src/routes/banners.ts`, rate-limit rules in `middleware/rateLimit.ts`, a 2 KB parser for the events call (`middleware/bodyLimits.ts`), `purpose=promo` in `routes/uploads.ts`. Tests: `test/e2e/home_banners.test.ts` (real Postgres, real HTTP). The JSON below was copied from those tests (dates come from a fake clock where noted).

### 7.1 Decisions where this document was ambiguous (safest option taken)
- **Link / image address**: raw text must start with `https://` (case-insensitive); outer spaces are trimmed, any inner whitespace, control, hidden or bidi character or backslash is refused; no explicit port (not even 8443), no username/password, host must be a DNS name with a dot (IPv4 in any spelling such as `2130706433`, `0x7f.0.0.1`, IPv6 and `localhost`/`*.localhost` refused); stored as `new URL().toString()` (host lower-cased, IDN punycoded, `https://example.com` becomes `https://example.com/`); <= 500 chars. `imageUrl` uses the same check (error code `BANNER_IMAGE_INVALID`, always required). Empty / blank / `null` link = display-only banner.
- **Text** (title 2..60, subtitle <= 120, button text <= 20; lengths count characters, an emoji is one): NFC, white space collapsed. Hindi and emoji are allowed. Refused: control, bidi and zero-width characters (ZWJ/ZWNJ are allowed because Devanagari and emoji sequences need them) and `<` / `>` (no markup is ever stored). Blank subtitle / button text is stored as `null`.
- **Strict bodies**: unknown keys (including `__proto__`, `constructor`, `viewCount`, `sortOrder`, `id`, `status`) -> 400. Allowed keys on create AND patch: `title, subtitle, imageUrl, linkUrl, ctaLabel, theme, placement, isActive, startsAt, endsAt` (`placement` can only be `HOME`). Order is changed ONLY through reorder.
- **Dates**: ISO 8601 with a zone (`...Z` or `+05:30`), years 2000..2100, impossible calendar dates refused; stored and returned as UTC `.toISOString()`. `null` clears. `endsAt <= startsAt` -> 400 `BANNER_SCHEDULE_INVALID` (field `endsAt`).
- **Expired rule**: an ACTIVE banner may not end in the past when this request turns it on (`isActive:true`) or sets `endsAt`; so an OFF banner with a past end needs a new `endsAt` (or `null`) in the same patch to be switched on. A request that touches neither (for example fixing a title of a banner that expired by itself) is allowed. Create follows the same rule.
- **`ctr`** is a percentage with one decimal (`12.5` = 12.5 %), `null` while `viewCount` is 0; it can pass 100 (clicks are counted without a matching view).
- **status**: `OFF` (switch off, whatever the dates) > `EXPIRED` (`endsAt <= now`) > `SCHEDULED` (`startsAt > now`) > `LIVE`. Start is inclusive, end exclusive. The public list uses the same clock on every request, even when its 30 s cache is warm.
- **Events**: ids that are listed twice count once; at most 10 views and 5 clicks per call (extra ids are ignored); rows are updated in ascending id order (no deadlocks); only `isActive` banners count (a scheduled or expired but switched-on banner still counts). Garbage in the body, wrong types and unknown ids all answer `200 {"success":true}`; a database error is logged and also answers 200. Only transport problems answer an error: 413 (> 2 KB, refused before reading), 400 (broken JSON), 415 (compressed body), 429.
- **Delete is idempotent**: second delete answers 200 with `deleted:false`. **Duplicate** is not idempotent (each call makes a copy, at the end of the list, OFF, counters 0, same schedule and link; title cut so that "(copy)" fits 60 chars). **Reorder** with unknown ids -> 400 `BANNER_UNKNOWN` and nothing changes; repeated identical reorder -> `changed:false`. Reorder renumbers EVERY row 10, 20, 30 ...; a new banner gets max + 10.
- **Rate limits** (429 `RATE_LIMITED`): public list 600/min/IP, events 300/min/IP, admin banner writes 120 per 10 min per admin (reads unlimited), uploads keep their 60/hour rule.
- Only the ADMIN role can use `/api/admin/banners*` (customer / owner / driver 403, no token 401).

### 7.2 Endpoints and real responses
**Public list** `GET /api/banners` (no auth, `Cache-Control: public, max-age=30`; max 10; empty list = `{"success":true,"data":[]}`):
```json
{
  "success": true,
  "data": [
    {
      "id": "3a6fef14-70ff-47de-b0c2-1d328e4b597e",
      "title": "Second",
      "subtitle": null,
      "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
      "linkUrl": null,
      "ctaLabel": null,
      "theme": "DARK"
    },
    {
      "id": "dc939b34-9465-4318-a3cf-7b40dd25a208",
      "title": "First",
      "subtitle": "Sub",
      "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
      "linkUrl": "https://forms.gle/AbC123",
      "ctaLabel": "Join now",
      "theme": "LIGHT"
    }
  ]
}
```

**Events** `POST /api/banners/events` (no auth, body <= 2 KB, `Content-Type: application/json`), request then response:
```json
{
  "views": [
    "f08d08b3-ae9b-42c9-94a2-f6844f4a9e41"
  ],
  "clicks": [
    "f08d08b3-ae9b-42c9-94a2-f6844f4a9e41"
  ]
}
```
```json
{
  "success": true
}
```

**Admin list** `GET /api/admin/banners` (all rows incl. OFF / expired, ordered by `sortOrder`, `createdAt`; second row omitted here; this sample ran with a fake clock before the schedule, hence `SCHEDULED`):
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": "dd002330-7627-4565-8199-a55a758f1411",
      "title": "One",
      "subtitle": null,
      "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
      "linkUrl": "https://forms.gle/x1",
      "ctaLabel": "Go",
      "theme": "DARK",
      "placement": "HOME",
      "isActive": true,
      "startsAt": "2026-11-01T09:50:00.000Z",
      "endsAt": "2026-11-01T10:10:00.000Z",
      "sortOrder": 10,
      "viewCount": 40,
      "clickCount": 5,
      "ctr": 12.5,
      "status": "SCHEDULED",
      "createdByUserId": "usr-5",
      "createdAt": "2026-10-28T17:30:38.940Z",
      "updatedAt": "2026-10-28T17:30:38.954Z"
    }
  ]
}
```

**Create** `POST /api/admin/banners` -> 201 (body: `title` and `imageUrl` required, the rest optional; defaults `theme:"DARK"`, `isActive:true`):
```json
{
  "success": true,
  "message": "Banner created.",
  "data": {
    "id": "33341894-b6d3-4f67-91fa-a908eca24823",
    "title": "Diwali Dhamaka",
    "subtitle": null,
    "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
    "linkUrl": null,
    "ctaLabel": null,
    "theme": "DARK",
    "placement": "HOME",
    "isActive": true,
    "startsAt": null,
    "endsAt": null,
    "sortOrder": 10,
    "viewCount": 0,
    "clickCount": 0,
    "ctr": null,
    "status": "LIVE",
    "createdByUserId": "usr-5",
    "createdAt": "2026-10-28T17:30:38.920Z",
    "updatedAt": "2026-10-28T17:30:38.920Z"
  }
}
```

**Patch** `PATCH /api/admin/banners/:id` -> 200 (partial; answers the full row; `changed:false` + message `Nothing to change.` when nothing differs):
```json
{
  "success": true,
  "changed": true,
  "message": "Banner saved.",
  "data": {
    "id": "95e9a4f1-b283-4903-b816-b39618a306de",
    "title": "Renamed",
    "subtitle": "Sub",
    "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
    "linkUrl": "https://play.google.com/store/apps/details?id=x",
    "ctaLabel": "Order now",
    "theme": "LIGHT",
    "placement": "HOME",
    "isActive": true,
    "startsAt": null,
    "endsAt": null,
    "sortOrder": 10,
    "viewCount": 0,
    "clickCount": 0,
    "ctr": null,
    "status": "LIVE",
    "createdByUserId": "usr-5",
    "createdAt": "2026-10-28T17:30:38.975Z",
    "updatedAt": "2026-10-28T17:30:38.984Z"
  }
}
```

**Reorder** `POST /api/admin/banners/reorder`, request then response (`data` is the FULL admin list in the new order, shortened to its first row here; `changed:false` and message `The order was already like this.` when nothing moved):
```json
{
  "ids": [
    "6d7f3ff8-7bb0-4add-94e9-4f8aabe6639e",
    "2d86dabf-8289-48de-b75e-0fe4affd5760"
  ]
}
```
```json
{
  "success": true,
  "changed": true,
  "message": "Order saved.",
  "data": [
    {
      "id": "6d7f3ff8-7bb0-4add-94e9-4f8aabe6639e",
      "title": "Gamma",
      "subtitle": null,
      "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
      "linkUrl": null,
      "ctaLabel": null,
      "theme": "DARK",
      "placement": "HOME",
      "isActive": true,
      "startsAt": null,
      "endsAt": null,
      "sortOrder": 10,
      "viewCount": 0,
      "clickCount": 0,
      "ctr": null,
      "status": "LIVE",
      "createdByUserId": "usr-5",
      "createdAt": "2026-10-28T17:30:39.921Z",
      "updatedAt": "2026-10-28T17:30:39.938Z"
    }
  ]
}
```

**Duplicate** `POST /api/admin/banners/:id/duplicate` -> 201:
```json
{
  "success": true,
  "message": "Banner duplicated. The copy is switched off.",
  "data": {
    "id": "f380a834-5b4e-4fa1-b906-45b2dc91f99f",
    "title": "Launch (copy)",
    "subtitle": "Sub",
    "imageUrl": "https://api.kraveo.site/uploads/promo/2026/0123456789abcdef0123456789abcdef.jpg",
    "linkUrl": "https://forms.gle/z",
    "ctaLabel": "Join",
    "theme": "LIGHT",
    "placement": "HOME",
    "isActive": false,
    "startsAt": "2026-11-01T11:00:00.000Z",
    "endsAt": "2026-11-01T12:00:00.000Z",
    "sortOrder": 30,
    "viewCount": 0,
    "clickCount": 0,
    "ctr": null,
    "status": "OFF",
    "createdByUserId": "usr-5",
    "createdAt": "2026-10-28T17:30:40.103Z",
    "updatedAt": "2026-10-28T17:30:40.103Z"
  }
}
```

**Delete** `DELETE /api/admin/banners/:id` -> 200 (already deleted: `data:{"id":"...","deleted":false}`, message `The banner was already deleted.`):
```json
{
  "success": true,
  "message": "Banner deleted.",
  "data": {
    "id": "ad014502-4efe-4931-8e69-a4cce3fb969f",
    "title": "Doomed",
    "deleted": true
  }
}
```

**Upload** `POST /api/admin/uploads/image?purpose=promo` (raw body, `Content-Type: image/jpeg|png|webp`, <= 1 MB, 200..2400 px; stored under `promo/`; served at the returned URL). In production the host is `https://api.kraveo.site`; the test environment's host is shown here. Use `data.url` as `imageUrl`:
```json
{
  "success": true,
  "data": {
    "url": "https://api.test.kraveo/uploads/promo/2026/e04403271c142510261d74e738ff1852.png",
    "width": 1200,
    "height": 600,
    "bytes": 68
  }
}
```

### 7.3 Errors (all `{ "success": false, "code": "...", "message": "...", "field": "..." }`)
| Status | code | When | field |
|---|---|---|---|
| 400 | `BAD_REQUEST` | wrong type / length / enum / unknown key / empty patch / bad `ids` list / bad id in the path | the field (`title`, `subtitle`, `ctaLabel`, `theme`, `isActive`, `placement`, `ids`, `id`, `body`) |
| 400 | `BANNER_LINK_INVALID` | `linkUrl` is not an allowed https address (message explains) | `linkUrl` |
| 400 | `BANNER_IMAGE_INVALID` | `imageUrl` missing or not an allowed https address | `imageUrl` |
| 400 | `BANNER_SCHEDULE_INVALID` | bad date format, end not after start, active banner with a past end | `startsAt` or `endsAt` |
| 400 | `BANNER_UNKNOWN` | reorder lists an id that does not exist (maybe just deleted): reload the list | `ids` |
| 401 / 403 | (auth) | no token / not an ADMIN | - |
| 404 | `NOT_FOUND` | patch or duplicate of a banner that does not exist | - |
| 409 | `BANNER_LIMIT` | 30 banners already (create and duplicate) | - |
| 413 | `PAYLOAD_TOO_LARGE` | body over 100 KB (events: over 2 KB) | - |
| 429 | `RATE_LIMITED` | see 7.1; has `retryAfterSeconds` | - |
Example: `{"success":false,"code":"BANNER_LINK_INVALID","message":"The link must start with https:// (http, javascript:, data:, intent:, market:, mailto:, tel:, file: and app links are not allowed).","field":"linkUrl"}`. Upload errors keep the codes of Docs/23 section 8 (`IMAGE_TOO_SMALL`, `UNSUPPORTED_IMAGE_TYPE`, ...); an unknown `purpose` is still 400 with `field:"purpose"`.

### 7.4 Deploy note
Migration is additive (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`): run it, restart the backend. Rolling back = drop the table `"HomeBanner"`; nothing else references it. Uploaded promo files live in `UPLOAD_DIR/promo/` (part of the same nightly backup as the other purposes). The 30 s caches are per process (single instance today).
