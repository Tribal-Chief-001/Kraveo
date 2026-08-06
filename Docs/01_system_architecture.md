# Kraveo - End-to-End System Architecture & Engineering Blueprint

## 1. Executive Summary & Context
**Kraveo** is a hyper-local campus food delivery platform custom-built for **VIT Bhopal University**. 
Due to the geographic isolation of the campus (located near the Ashta/Kothri highway) and campus security restrictions, standard delivery services struggle with vendor onboarding and gate drop-off logistics.

Kraveo solves this by connecting off-campus dhabas and local eateries directly to students in hostel blocks via student delivery runners, powered by a 4-part software ecosystem.

---

## 2. The 4-Part Ecosystem Architecture

```
                                ┌─────────────────────────┐
                                │ Super Admin Web Portal  │
                                │   (React + Tailwind)    │
                                └────────────┬────────────┘
                                             │
                                         ┌───┴───┐
                                         │Backend│ (Node.js/Express API + WebSockets/FCM)
                                         └───┬───┘
                ┌────────────────────────────┼────────────────────────────┐
                ▼                            ▼                            ▼
      ┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
      │  Customer App    │         │   Vendor App     │         │  Delivery App    │
      │ (Flutter iOS/Android)      │ (Flutter Android)│         │(Flutter iOS/Android)
      └──────────────────┘         └──────────────────┘         └──────────────────┘
```

### Component Breakdown
1. **Customer App (Flutter Mobile - iOS/Android)**
   - Target: VIT Bhopal Students.
   - Core Features: Campus drop-off selector (Block 1–6, Girls Gate, Boys Gate), highway dhaba directory, dynamic cart & dish customization, native UPI payment integration (Razorpay/PhonePe), live driver map tracking.

2. **Vendor / Dhaba App (Flutter Mobile - Android Priority)**
   - Target: Highway dhaba owners & local canteen managers.
   - Core Features: Optimized for non-tech-literate users. High-volume persistent ringing audio alerts on incoming orders, giant green/red action targets (`ACCEPT` / `DECLINE`), high-contrast UI, visual dish availability toggles (`IN STOCK` / `SOLD OUT`).

3. **Delivery Partner App (Flutter Mobile - iOS/Android)**
   - Target: Student delivery runners.
   - Core Features: Real-time job broadcast, fee estimator, turn-by-turn route preview to dhaba & hostel drop-off point, one-tap status updates (`Picked Up`, `Arrived at Gate`, `Delivered`).

4. **Super Admin Web Dashboard (React + Tailwind CSS)**
   - Target: Kraveo Operations Team & Founders.
   - Core Features: Live command center map with runner markers, active order monitoring, manual driver reassignment, vendor & menu management, commission split & payout calculations.

---

## 3. Technology Stack

- **Cross-Platform Mobile:** Flutter (Dart) for unified codebase across Customer, Vendor, and Delivery apps.
- **Web Admin Panel:** React, TypeScript, Tailwind CSS, Vite.
- **Backend Services:** Node.js, Express, TypeScript, Socket.io (WebSockets for real-time driver tracking).
- **Database:** PostgreSQL (with Prisma ORM) or Supabase / Firebase Cloud Firestore.
- **Push Notifications & Alarms:** Firebase Cloud Messaging (FCM) + Flutter Local Notifications (for full-screen audio alerts).
- **Payments:** Razorpay / PhonePe SDK (UPI Deep-Linking).
- **Maps & Geolocation:** Google Maps SDK / Mapbox Distance Matrix API.

---

## 4. End-to-End Order Pipeline

```
[1. Student Order & UPI Pay]
          │
          ▼
[2. WebSocket / FCM Push] ──> [Vendor Phone Alarm Rings Loudly]
          │
          ▼
[3. Vendor Taps "Accept"] ──> [Status: Preparing]
          │
          ▼
[4. Dispatch Engine Broadcasts] ──> [Nearest Delivery Runner Accepts]
          │
          ▼
[5. Runner Picks Up Food] ──> [GPS Stream Emits Coordinates every 3s]
          │
          ▼
[6. Student Views Live Bike Marker on Map]
          │
          ▼
[7. Runner Arrives at Hostel Gate] ──> [Gate Handshake & Order Completed]
```

---

## 5. Directory Structure & Monorepo Strategy

```
Kraveo/
├── apps/
│   ├── customer_app/          # Flutter Customer App
│   ├── vendor_app/            # Flutter Vendor App (High-volume audio & simple UI)
│   └── driver_app/            # Flutter Delivery Partner App
├── web/
│   └── super_admin/           # React Web Admin Dashboard
├── backend/                   # Node.js Express API & WebSocket Server
├── Docs/                      # Comprehensive Systems Documentation & Ledger
└── stitch_kraveo_campus_delivery/ # Exported Stitch UI Mockups & Assets
```
