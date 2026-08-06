# Kraveo Complete Technical Stack Specifications

This document outlines the full end-to-end technology stack for **Kraveo**, covering the mobile apps, web dashboard, backend API, real-time engines, database schemas, payment integrations, maps, and infrastructure.

---

## 📱 1. Mobile Apps (Customer, Vendor, Delivery Partner)

| Layer | Technology Choice | Rationale / Purpose |
| :--- | :--- | :--- |
| **Framework** | **Flutter 3.x (Dart)** | Single cross-platform codebase for iOS & Android with high-performance 60fps UI. |
| **State Management** | **Riverpod / Provider** | Predictable state handling, reactive streams, and clean separation of business logic. |
| **Networking** | **Dio + HTTP** | Interceptors for JWT auth headers, auto-retry mechanisms, and payload parsing. |
| **Maps & GPS** | `google_maps_flutter`, `geolocator` | Real-time map rendering and 3-second background GPS coordinate emission for delivery runners. |
| **Vendor Audio Engine** | `audioplayers`, `flutter_ringtone_player` | Triggers high-volume persistent ringing audio alarms on incoming orders for non-tech dhaba owners. |
| **Local Storage** | `hive` / `shared_preferences` | Caches auth tokens, user preferences, and offline shopping cart items. |

---

## 🖥️ 2. Web Admin Dashboard (Super Admin Command Center)

| Layer | Technology Choice | Rationale / Purpose |
| :--- | :--- | :--- |
| **Framework** | **React 18 + Vite + TypeScript** | Blazing fast build times, strict type safety, and rich component ecosystem. |
| **Styling** | **Tailwind CSS + Vanilla CSS** | Custom sleek dark-mode glassmorphism command center aesthetic. |
| **Data Fetching** | **TanStack Query (React Query)** | Auto-refetching, cached server state, and seamless WebSocket state updates. |
| **Interactive Map** | **Mapbox GL JS / Google Maps JS API** | Live interactive command map showing runner pins, dhaba nodes, and hostel drop-off clusters. |
| **Charts** | **Recharts** | Dynamic peak-hour order metrics, dhaba revenue distributions, and delivery ETAs. |

---

## ⚙️ 3. Backend Engine & API Server

| Layer | Technology Choice | Rationale / Purpose |
| :--- | :--- | :--- |
| **Runtime & Server** | **Node.js (v20 LTS) + Express + TypeScript** | Concurrent non-blocking I/O, ideal for real-time WebSocket traffic and API endpoints. |
| **ORM & Database Client** | **Prisma ORM** | Type-safe database queries, automatic migrations, and schema modeling. |
| **Real-Time WebSockets** | **Socket.io** | Low-latency bidirectional communication for driver location feeds and instant order updates. |
| **Authentication** | **JWT + Firebase Auth (Phone OTP)** | Mobile OTP verification for students, vendors, and delivery runners. |
| **Job Queue** | **BullMQ + Redis** | Background tasks for payout calculations, FCM notification dispatching, and order timeout triggers. |

---

## 🛢️ 4. Data & Storage Tier

| Layer | Technology Choice | Rationale / Purpose |
| :--- | :--- | :--- |
| **Primary Database** | **PostgreSQL (via Supabase / Neon / Managed Cloud)** | Relational integrity for Users, Vendors, Menus, Orders, and Payout transactions. |
| **In-Memory Cache** | **Redis** | High-speed caching for active driver `lat, long` coordinates and active order state lookups. |
| **Media Storage** | **Cloudinary / AWS S3** | Cloud image optimization and CDN delivery for dish photos and dhaba banners. |

---

## 💳 5. Payments & External Services

| Service | Integration | Purpose |
| :--- | :--- | :--- |
| **Payments** | **Razorpay / PhonePe SDK** | Native Indian UPI Intent deep-linking (GPay, PhonePe, Paytm, BHIM) for instant checkout. |
| **Push Notifications** | **Firebase Cloud Messaging (FCM)** | High-priority background alerts for vendor phones and student order status updates. |
| **Location / Routing API**| **Google Distance Matrix / Mapbox Direction API**| Distance and ETA estimation between highway dhabas and campus hostel blocks. |

---

## 🌐 6. DevOps, Monorepo & Infrastructure

```
Kraveo Root Monorepo
├── apps/
│   ├── customer_app/          # Flutter Customer Mobile App
│   ├── vendor_app/            # Flutter Vendor Mobile App (Loud Alarms)
│   └── driver_app/            # Flutter Delivery Partner Mobile App
├── web/
│   └── super_admin/           # React Web Command Center Dashboard
├── backend/                   # Node.js Express REST API & Socket.io Server
└── Docs/                      # Comprehensive Specifications & Build Ledger
```

- **Version Control:** Private GitHub Monorepo.
- **Backend Hosting:** Railway / Render / DigitalOcean.
- **Web Admin Hosting:** Vercel / Netlify (CI/CD auto-deploy on `main` push).
- **Database Hosting:** Supabase PostgreSQL / Cloud Database.
