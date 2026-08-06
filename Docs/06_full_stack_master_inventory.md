# Kraveo Full-Stack Master File & Component Inventory

This document provides a detailed, file-by-file inventory of every module, component, route, model, widget, and configuration file in the **Kraveo Monorepo**.

---

## 1. Backend Engine Directory (`/backend`)

| File Path | Module Type | Description & Functionality |
| :--- | :--- | :--- |
| `backend/src/index.ts` | Server Bootstrap | Initializes Express app, HTTP server, and Socket.io WebSockets instance on port 5000. Mounts `/api` routes and listens for socket connections. |
| `backend/src/routes/api.ts` | REST API Router | Endpoint controller for Auth (`/api/auth/login`), Vendors (`/api/vendors`), Menus (`/api/menus`), Orders (`/api/orders`), and Driver Locations (`/api/drivers/location`). |
| `backend/src/middleware/auth.ts` | Security Middleware | Handles cryptographic JWT token generation (`jsonwebtoken`), Bearer header verification (`requireAuth`), and Role-Based Access Control (`requireRole`). |
| `backend/src/utils/validation.ts` | Pricing Engine | Server-side cart validation and price recalculation (`validateAndCalculateOrder()`). Calculates subtotal + ₹30 delivery fee to prevent payload pricing tampering. |
| `backend/src/utils/stateMachine.ts` | Transition Guard | Enforces valid Order State Machine flows (`PLACED` ➔ `ACCEPTED` ➔ `PREPARING` ➔ `READY_FOR_PICKUP` ➔ `PICKED_UP` ➔ `ARRIVED_AT_GATE` ➔ `DELIVERED`). |
| `backend/src/store.ts` | Initial Data Store | Provides initial mock data records for VIT Bhopal dhabas (Sharma Dhaba, FC Night Mess, Singh Punjabi Kitchen), menus, users, and drivers. |
| `backend/src/types.ts` | TypeScript Interfaces | Domain interface definitions (`User`, `Vendor`, `MenuItem`, `Order`, `OrderItem`, `DriverLocation`, `OrderStatus`, `UserRole`). |
| `backend/package.json` | Package Config | Dependencies: `express`, `socket.io`, `jsonwebtoken`, `cors`, `dotenv`, `typescript`, `ts-node-dev`. |
| `backend/tsconfig.json` | Compiler Config | TypeScript ES2022 output configuration targetting `dist/`. |

---

## 2. Super Admin Web Dashboard Directory (`/web/super_admin`)

| File Path | Module Type | Description & Functionality |
| :--- | :--- | :--- |
| `web/super_admin/src/App.tsx` | Main React App | Tab router (`map`, `orders`, `vendors`, `analytics`), data state management, and real-time backend API synchronization. |
| `web/super_admin/src/main.tsx` | DOM Root Render | Mounts `App` component into HTML `#root`. |
| `web/super_admin/src/types.ts` | Admin Interfaces | TypeScript interfaces for dashboard state (`TabType`, `Order`, `Vendor`, `DriverPin`). |
| `web/super_admin/src/index.css` | Global Styling | Tailwind CSS directives, glassmorphism styles (`.stitch-card`), pulse animation keyframes, and scrollbar rules. |
| `web/super_admin/src/components/Header.tsx` | Header Component | Sticky top app bar displaying tab titles, live Socket.io connection indicators, notification badge, and admin avatar. |
| `web/super_admin/src/components/Sidebar.tsx` | Sidebar Component | Vertical navigation bar featuring Kraveo brand identity, tab navigation buttons, and system engine status card. |
| `web/super_admin/src/components/LiveCommandCenter.tsx` | Logistics Canvas | Interactive logistics map visualizer displaying dhaba nodes, hostel drop-off pins, SVG highway route path, and live runner location marker. |
| `web/super_admin/src/components/OrdersTable.tsx` | Matrix Component | High-density data table with multi-field search, status filtering, and quick manual status override selectors. |
| `web/super_admin/src/components/VendorManager.tsx` | Dhaba Manager | Dhaba onboarding interface and operational OPEN/CLOSED toggle controls. |
| `web/super_admin/src/components/AnalyticsPanel.tsx` | Analytics Views | Recharts visualizations for late-night peak order hours and hostel block delivery volume. |
| `web/super_admin/tailwind.config.js` | Tailwind Config | Configures Stitch color palette tokens (`#00450d` Emerald, `#fdd400` Sunshine Gold, `#1b1c1c` Dark). |

---

## 3. Customer Mobile App Directory (`/apps/customer_app`)

| File Path | Module Type | Description & Functionality |
| :--- | :--- | :--- |
| `apps/customer_app/lib/main.dart` | Application Entry | Clean 20-line MaterialApp bootstrap. |
| `apps/customer_app/lib/theme/app_theme.dart` | Theme Tokens | Defines Google Stitch color tokens (`#00450d` Emerald, `#fdd400` Gold, `#fcf9f8` Surface) and ThemeData. |
| `apps/customer_app/lib/models/dhaba.dart` | Dhaba Model | JSON deserialization model for Dhaba vendors. |
| `apps/customer_app/lib/models/menu_item.dart` | Menu Model | JSON deserialization model for dish menu items. |
| `apps/customer_app/lib/screens/home_screen.dart` | Home Screen | Main student landing screen with search bar, category navigation, and dhaba listings. |
| `apps/customer_app/lib/screens/dhaba_menu_screen.dart` | Menu Screen | Dish list with quantity incrementors, cart drawer, and "PAY VIA UPI" checkout bar. |
| `apps/customer_app/lib/screens/live_tracking_screen.dart` | Tracker Screen | Order status progress bar, runner phone call action, and gate dropoff handshake indicator. |
| `apps/customer_app/lib/widgets/hostel_dropdown.dart` | Header Widget | Campus drop-off selector (`Block 1–6`, `Girls Gate`, `Main Gate`). |
| `apps/customer_app/lib/widgets/category_pills.dart` | Category Widget | Horizontal scrollable rounded category filter pills. |
| `apps/customer_app/lib/widgets/dhaba_card.dart` | Card Widget | Dhaba listing card with rating pill, ETA badge, cuisine text, and Gold Order CTA. |

---

## 4. Vendor Dhaba Mobile App Directory (`/apps/vendor_app`)

| File Path | Module Type | Description & Functionality |
| :--- | :--- | :--- |
| `apps/vendor_app/lib/main.dart` | Application Entry | Clean application bootstrap entry. |
| `apps/vendor_app/lib/services/audio_alert_service.dart` | Audio Engine | Fires persistent high-volume ringing alarm loops on incoming order payloads. |
| `apps/vendor_app/lib/screens/vendor_home_screen.dart` | Main Dashboard | Kitchen order queue list with prep timers and dish stock toggle grid. |
| `apps/vendor_app/lib/widgets/incoming_order_dialog.dart` | Alert Overlay | Fullscreen pulsing gold overlay with 4px emerald border, item list, customer spice note, and giant 64px `ACCEPT`/`DECLINE` touch targets. |

---

## 5. Delivery Partner Mobile App Directory (`/apps/driver_app`)

| File Path | Module Type | Description & Functionality |
| :--- | :--- | :--- |
| `apps/driver_app/lib/main.dart` | Application Entry | Clean application bootstrap entry. |
| `apps/driver_app/lib/screens/driver_home_screen.dart` | Main Screen | High-contrast Dark Mode (`#1b1c1c`) runner interface featuring `DUTY ONLINE` header, today's earnings overview (`₹420`), swipe-to-accept job request card (`Earn ₹40`), customer call action, and 4-step delivery pipeline. |
