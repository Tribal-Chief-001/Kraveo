---
name: Campus Pulse
colors:
  surface: '#fcf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fcf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae7e7'
  surface-container-highest: '#e5e2e1'
  on-surface: '#1b1c1c'
  on-surface-variant: '#41493e'
  inverse-surface: '#303030'
  inverse-on-surface: '#f3f0ef'
  outline: '#717a6d'
  outline-variant: '#c0c9bb'
  surface-tint: '#2a6b2c'
  primary: '#00450d'
  on-primary: '#ffffff'
  primary-container: '#1b5e20'
  on-primary-container: '#90d689'
  inverse-primary: '#91d78a'
  secondary: '#705d00'
  on-secondary: '#ffffff'
  secondary-container: '#fdd400'
  on-secondary-container: '#6f5c00'
  tertiary: '#393b3b'
  on-tertiary: '#ffffff'
  tertiary-container: '#505252'
  on-tertiary-container: '#c4c5c5'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#acf4a4'
  primary-fixed-dim: '#91d78a'
  on-primary-fixed: '#002203'
  on-primary-fixed-variant: '#0c5216'
  secondary-fixed: '#ffe170'
  secondary-fixed-dim: '#e9c400'
  on-secondary-fixed: '#221b00'
  on-secondary-fixed-variant: '#544600'
  tertiary-fixed: '#e2e2e2'
  tertiary-fixed-dim: '#c6c6c7'
  on-tertiary-fixed: '#1a1c1c'
  on-tertiary-fixed-variant: '#454747'
  background: '#fcf9f8'
  on-background: '#1b1c1c'
  surface-variant: '#e5e2e1'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '800'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-bold:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 32px
  xl: 48px
  margin-mobile: 16px
  gutter-mobile: 12px
---

## Brand & Style

The brand personality is energetic, dependable, and community-centric. It captures the fast-paced life of a university student while providing the grounding reliability of a high-quality food service. The design style follows a **Corporate Modern** approach with **High-Contrast** accents. 

This style prioritizes functional clarity for vendors working in high-heat, high-activity kitchen environments, while maintaining a fresh, optimistic aesthetic for students. The UI uses generous white space and bold primary color blocks to guide the eye toward action, ensuring the app feels like a utility that understands the urgency of a hunger craving.

## Colors

The palette is derived directly from the brand's core identity:
- **Primary (Deep Forest Green):** Used for primary actions, navigation headers, and success states. It communicates health, freshness, and reliability.
- **Secondary (Sun-Yellow):** Used sparingly for high-attention callouts, ratings, and highlighting active selections. It adds the "energy" and "appetite" trigger to the UI.
- **Backgrounds:** A clean, neutral light mode is the default to ensure maximum legibility under various lighting conditions on campus.
- **Semantic Colors:** Use a standard red (#D32F2F) for errors or "out of stock" items, and a soft blue (#1976D2) for information/tracking updates.

## Typography

**Plus Jakarta Sans** is the sole typeface for this design system to maintain a cohesive, modern, and friendly tone. 

- **Headlines:** Use heavy weights (700-800) to create a clear visual hierarchy. This is essential for students scanning menus and vendors reading order tickets.
- **Body Text:** Use a 16px base for standard reading to ensure accessibility.
- **Labels:** Small, all-caps bold labels are used for categories (e.g., "VEG", "NON-VEG", "PENDING") to maximize space efficiency without losing readability.

## Layout & Spacing

The design system utilizes a **Fluid Grid** model optimized for mobile devices. 

- **Mobile:** A 4-column grid with 16px side margins and 12px gutters. This provides enough breathing room for "touch-friendly" targets.
- **Desktop/Web (Vendor Portal):** A 12-column grid with a max-width of 1200px.
- **Rhythm:** All spacing (padding, margins) must be a multiple of the 4px base unit. 
- **Density:** The vendor interface uses "Medium" density to show more orders on one screen, while the student interface uses "Low" density (more whitespace) to feel premium and inviting.

## Elevation & Depth

This design system uses **Tonal Layers** supplemented by **Ambient Shadows**.

- **Level 0 (Background):** Flat #F5F5F5 or White.
- **Level 1 (Cards):** White background with a very subtle 1px border (#E0E0E0) and no shadow. Used for list items.
- **Level 2 (Active/Floating):** White background with a soft, diffused shadow (0px 4px 12px rgba(0,0,0,0.05)). Used for the bottom navigation bar and "Add to Cart" floating buttons.
- **Overlays:** Use a 40% opacity black tint for modals to focus the user on the task at hand.

## Shapes

The design system uses a **Rounded** (8px) corner radius as the standard. This strikes a balance between the organic "food" aesthetic and the structured "tech" aesthetic.

- **Buttons & Inputs:** 8px (standard roundedness).
- **Cards:** 16px (rounded-lg) to create a friendly, containerized look for food items.
- **Status Chips:** Full pill-shape (rounded-xl) to distinguish them from actionable buttons.

## Components

- **Buttons:** 
    - *Primary:* Forest Green background, White text. High-contrast and bold.
    - *Secondary:* Sun-Yellow background, Dark Green text. Used for "Special Offers" or "Add to Cart".
- **Food Cards:** Feature a large 1:1 aspect ratio image, bold title, and a prominent yellow "Add" button in the bottom right corner.
- **Status Chips:** 
    - *Preparing:* Yellow background with dark text.
    - *Ready:* Green background with white text.
    - *Out for Delivery:* Light grey background with dark text.
- **Input Fields:** Large tap targets (min 48px height) with 1px neutral borders that turn Forest Green on focus.
- **Order Tracker:** A vertical step-indicator using the primary green to show progress, ensuring students feel the "reliability" of the service.
- **Vendor Order Card:** High-density card showing Order ID in bold, item list, and a large "Mark as Ready" primary button.