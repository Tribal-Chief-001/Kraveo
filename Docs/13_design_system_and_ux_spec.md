# Kraveo Design System & UX Spec (v1, 2026-09-30)

One design language across customer app, vendor app, driver app and admin dashboard.
Code: `packages/kraveo_ui` (Flutter) + Tailwind tokens in `web/super_admin` (same hex values, same fonts, same status colours).

## 1. Brand DNA (from the bowl logo)
- Forest green `#075219` (brand, g800) + electric yellow `#FFD600` (accent). Yellow is *seasoning*, used for the single most important CTA / highlight per screen - never as a background wash.
- Warm cream `#FAF7F0` (customer) / high-contrast paper (vendor) / OLED green-black `#080D09` (driver, admin).
- Tone: confident, warm, fast. Big type, generous space, rounded shapes, soft green-tinted shadows, springy motion.

## 2. Tokens (see package source for exact values)
- **Type:** Bricolage Grotesque (display, headlines, numerals) + Plus Jakarta Sans (UI/body). Bundled offline. Scale: displayLg 44, displayMd 34, headline 26, headlineSm 22, titleLg 19, titleMd 16, body 15, bodySm 13, label 12 (caps tracking), numeric 40.
- **Radius:** 12 / 16 / 20 / 24 (cards) / 32 (sheets) / pill. **Spacing:** 4-pt grid, 20 page gutter.
- **Elevation:** soft tinted shadows only (`KShadow.soft/lift/glow`). No grey drop shadows, no 1px borders as the only separator on light surfaces.
- **Motion:** 140/260/480 ms. `easeOutCubic` default, `easeOutBack` (slight overshoot) only for key moments. Every tap = `KPressable` (scale + haptic). Lists reveal with `KReveal(index)`. Loading = `KSkeleton`, never a blank screen or a fake spinner-forever. Numbers count up (`KAnimatedNumber`).
- **Icons:** Lucide only (`lucide_icons_flutter`, `lucide-react` on web). No Material icons mixed in.
- **Status language (identical everywhere):** placed amber, accepted teal, preparing orange, ready lime, on-the-way blue, at-gate violet, delivered green, cancelled red. Use `KStatusPill` / `KStatus`.

## 3. Personalities (same DNA, different density)
| Surface | Theme | Principle |
|---|---|---|
| Customer | `KraveoTheme.customer()` warm cream | Appetite + speed. Image-led, 3-tap order, always show "what happens next". |
| Vendor | `KraveoTheme.vendor()` high-contrast light, 64px targets, 1.12x type | Zero reading. A cook with greasy hands in a loud kitchen. One obvious action per state. Hindi + English (`sublabel`) on primary actions. |
| Driver | `KraveoTheme.driver()` OLED dark, 64px targets | Glanceable on a bike at night. One huge action per step. Slide-to-confirm for irreversible steps. |
| Admin | dark command-center (Tailwind tokens) | Dense but calm. Status colours carry meaning. Keyboard + mobile-drawer friendly. |

## 4. UX principles (first-principles, role-driven)
- **Customer:** reduce taps to first order; always-visible hostel drop point; price transparency (bill breakdown before pay); after paying show a live timeline + the gate OTP prominently (`KOtpDisplay`); empty/error states explain what to do next.
- **Vendor:** the incoming-order screen is the product. Full-screen, pulsing, total + items + note, prep-time chips (10/15/20/30), ACCEPT / DECLINE at >=64px with Hindi sublabels. Queue sorted by urgency with a visible countdown. Sold-out toggle is a single big tap with instant feedback. Analytics = 3 honest numbers + 1 simple chart + 1 plain-language insight, no jargon.
- **Driver:** home = duty state + today's earnings. Job offer = price, distance, pickup, drop, slide to accept. Active delivery = a horizontal step tracker + ONE primary action for the current step + call/navigate secondary. OTP entry = big numeric keypad. Never show a demo PIN or fake order text.
- **Admin:** live KPIs at top, orders table with pills + filters, real empty states (never fake data), responsive down to 390px with a drawer nav.

## 5. Hard rules for implementers
1. **UI only.** Do NOT change API calls, sockets, providers' business logic, models' fields, routing contracts or backend. Restyle/restructure widgets around them. Keep every existing feature reachable.
2. Use `package:kraveo_ui/kraveo_ui.dart`; read colours via `context.k`, never hardcode hex in screens. Do not edit `packages/kraveo_ui` - if a new shared component is needed, build it under `lib/widgets/ui/` in your app and report it.
3. Remove `google_fonts` usage (fonts are bundled). Remove leftover Material `Icons.*` in favour of Lucide.
4. No new heavy dependencies. No `flutter build`. Verify with `nice -n 10 flutter analyze` (0 errors) and `flutter test` if tests exist (update tests that assert old widget text/structure, don't delete them).
5. Must not overflow at 360x640 dp or at 1.3x system font scale. Add `Semantics`/labels to icon-only buttons. Contrast >= 4.5:1.
6. No placeholder lorem, no emoji-as-icons in UI chrome, no gradients on text, no more than one accent-yellow element per viewport.
