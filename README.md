<div align="center">

  <h1>🛵 Kraveo</h1>
  <p><strong>Avant-Garde Hyper-Local Campus Food Delivery Platform & Logistics Mesh Network for VIT Bhopal University</strong></p>

  <p>
    <a href="https://flutter.dev"><img src="https://img.shields.io/badge/Flutter-3.44.8-02569B?style=for-the-badge&logo=flutter&logoColor=white" alt="Flutter" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
    <a href="https://postgresql.org"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
    <a href="https://firebase.google.com"><img src="https://img.shields.io/badge/Firebase_FCM-Project_kraveo-FFCA28?style=for-the-badge&logo=firebase&logoColor=black" alt="Firebase FCM" /></a>
    <a href="https://cloud.google.com/maps-platform"><img src="https://img.shields.io/badge/Google_Maps-API_SDK-4285F4?style=for-the-badge&logo=googlemaps&logoColor=white" alt="Google Maps" /></a>
    <a href="https://reactjs.org"><img src="https://img.shields.io/badge/React-18.x-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-00450D?style=for-the-badge" alt="License" /></a>
  </p>

  <p>
    <em>Bridging off-campus highway dhabas on the Ashta-Kothri highway directly to student hostel blocks (Blocks 1–6 & Girls Gates 1–2). Built for non-tech kitchen literacy, low-glare night riding, and gate handshake security.</em>
  </p>

</div>

---

## 🌌 Overview

**Kraveo** is a production-ready, full-stack monorepo ecosystem custom-engineered for **VIT Bhopal University**. It tackles two critical hyper-local operational challenges:

1. **Non-Tech Highway Kitchen Literacy**: Dhaba cooks operate in noisy, smoky kitchens. `apps/vendor_app` features a high-volume continuous audio alarm engine, 64px color-coded touch targets (`ACCEPT` / `DECLINE`), and 1-tap grease-proof price steppers (`+10` / `-10`).
2. **Campus Gate Security Logistics**: Vehicles cannot enter student hostel blocks. `apps/driver_app` and `apps/customer_app` enforce a **4-Digit Security Gate Handshake OTP**, real-time GPS rider tracking, and 4-step pipeline status updates.

---

## 🏛️ System Architecture & Cloud Infrastructure

```mermaid
graph TD
    A[🎓 Customer App - Flutter] -->|REST / WebSockets| D(⚡ Node.js Express API & Socket.io Server on AWS EC2)
    B[👨‍🍳 Vendor Dhaba App - Flutter] -->|REST / WebSockets| D
    C[🛵 Driver Partner App - Flutter] -->|REST / WebSockets| D
    E[💻 Super Admin Web Dashboard - React 18] -->|REST / WebSockets| D
    
    D -->|ORM Migration & Queries| F[(🐘 PostgreSQL 16 Database)]
    D -->|Push Alerts| G[🔥 Firebase Cloud Messaging]
    D -->|Live Maps SDK| H[🗺️ Google Maps Platform]
    D -->|UPI Checkout| I[💳 Razorpay Gateway]
```

- **Live Cloud Host**: AWS EC2 Mumbai (`3.110.189.80`) running Node.js 20, PM2 daemon, and Nginx reverse proxy.
- **Database Engine**: PostgreSQL 16 database (`kraveo_db`) managed via Prisma ORM v5.22.0.
- **Push Alerts**: Firebase Admin SDK initialized for project **`kraveo`**.
- **Live Maps**: Google Maps Platform API (`AIzaSyC_C0frKYl-mDTsCU-Wr-wW3uF3YDpeseQ`) integrated across all Android Manifests & Web index.

---

## 📦 Monorepo Structure

```
Kraveo Monorepo/
├── apps/
│   ├── customer_app/        # Flutter Customer App (Hostel Dropdowns, Cart, Promo VITFIRST, Split-Bill)
│   ├── vendor_app/          # Flutter Dhaba Vendor App (Audio Ringing Alarms, KDS Timers, Stock Steppers)
│   └── driver_app/          # Flutter Runner App (Dark Mode #1B1C1C, Swipe/1-Tap Accept, Gate OTP)
├── web/
│   └── super_admin/         # React 18 + Vite + Tailwind CSS Web Command Center (Live Map, Matrix, Analytics)
├── backend/                 # Node.js + Express + TypeScript Server, Socket.io, Prisma PostgreSQL & Firebase Admin
├── Docs/                    # Complete Architectural Specifications & Systems Build Ledgers
├── .gitignore
├── LICENSE
└── README.md
```

---

## ✨ Key Features by Persona

### 🎓 1. VIT Student Customer App (`apps/customer_app`)
- **Pre-Locked Hostel Dropdown**: Upfront selection for `Boys Hostel Block 1–6`, `Girls Gate 1–2`, and `Main Gate`.
- **Item Customization & Cart State**: Dynamic spice level options (`Mild`, `Medium`, `Extra Spicy 🌶️`) and add-on pricing.
- **Promo Code Engine**: Coupon code `VITFIRST` applies 20% discount (max ₹50) with subtotal validation.
- **Roommate Split-Bill Generator**: Formats itemized per-person bill breakdowns with 1-tap WhatsApp clipboard copying.
- **Gate Security Handshake OTP**: Prominent 4-digit PIN card with 1-tap clipboard copy action.

### 👨‍🍳 2. Highway Dhaba Vendor App (`apps/vendor_app`)
- **Continuous Ringing Audio Engine**: High-decibel looping audio alerts with fallback periodic timer chimes (1.2s interval).
- **Fullscreen Alert Modal (`#FDD400`)**: Bright yellow background, customer spice callouts, prep time selector (10, 15, 20 mins), and **giant 64px `ACCEPT` / `DECLINE` CTAs**.
- **Kitchen Display System (KDS)**: Live countdown tickers, dish checklists, and 52px `MARK READY FOR PICKUP` buttons.
- **Grease-Proof Stock Steppers**: 1-tap `+10` / `-10` price stepper buttons and instant `IN STOCK` / `SOLD OUT` toggles.

### 🛵 3. Delivery Partner App (`apps/driver_app`)
- **Low-Glare Night Canvas**: `#1B1C1C` dark background and `#151C2C` surface cards for outdoor night riding.
- **Glove-Friendly Acceptance**: Interactive swipe-to-accept slider and 1-tap double-tap fallback button (`Glove-friendly 1-Tap Accept`).
- **4-Step Delivery Pipeline**: Stepper guidance console (`Dhaba Pickup` ➔ `Hostel Gate Arrival` ➔ `Gate OTP Verification` ➔ `Delivered`).
- **Background Location Permissions**: Configured fine/coarse/background location tracking for real-time runner GPS updates.

### 💻 4. Super Admin Web Dashboard (`web/super_admin`)
- **Live Logistics Canvas Map**: Command center map canvas rendering runner and dhaba node updates.
- **Interactive Dhaba Onboarding Drawer**: Operational modal form (`+ Onboard New Dhaba`) prepending new vendor cards.
- **Orders Matrix & Analytics**: Real-time multi-field search, status override dropdowns, and Recharts analytics.

---

## ⚡ Quick Start & Development Commands

### 1. Launch Backend API Engine (`backend/`)
```bash
cd backend
npm install
npm run dev
# Server running on http://localhost:5000
```

### 2. Launch Super Admin Web Dashboard (`web/super_admin`)
```bash
cd web/super_admin
npm install
npm run dev
# Dashboard running on http://localhost:3000
```

### 3. Run Mobile Apps (`apps/`)
```bash
# Customer App
cd apps/customer_app && flutter run

# Vendor App
cd apps/vendor_app && flutter run

# Driver App
cd apps/driver_app && flutter run
```

---

## 📦 Compiling Release APKs

Build standalone Android `.apk` installers for all 3 apps:

```bash
# Build Customer App Release APK
cd apps/customer_app && flutter build apk --release

# Build Vendor Dhaba App Release APK
cd apps/vendor_app && flutter build apk --release

# Build Driver Partner App Release APK
cd apps/driver_app && flutter build apk --release
```

📍 **Compiled Outputs:**
- `apps/customer_app/build/app/outputs/flutter-apk/app-release.apk` (**51.1 MB**)
- `apps/vendor_app/build/app/outputs/flutter-apk/app-release.apk` (**50.5 MB**)
- `apps/driver_app/build/app/outputs/flutter-apk/app-release.apk` (**48.9 MB**)

---

## 🛡️ Systems Audit & Code Verification

```text
[✓] Live AWS EC2 Cloud API Server : HTTP 200 OK (http://3.110.189.80/api)
[✓] PostgreSQL 16 Cloud Database   : Active & Synced via Prisma ORM v5.22.0
[✓] Firebase FCM Push Engine       : Active (Project: kraveo)
[✓] Google Maps Platform API       : Embedded (AIzaSyC_C0frKYl-mDTsCU-Wr-wW3uF3YDpeseQ)
[✓] Backend Engine (TypeScript API): `tsc` SUCCESS (0 Compilation Errors)
[✓] Super Admin Web (React 18)     : `vite build` SUCCESS (0 Type/Bundle Errors)
[✓] Customer App (Release APK)     : `app-release.apk` BUILT (51.1 MB)
[✓] Vendor App   (Release APK)     : `app-release.apk` BUILT (50.5 MB)
[✓] Driver App   (Release APK)     : `app-release.apk` BUILT (48.9 MB)
```

---

## 📜 License

Distributed under the MIT License. See [`LICENSE`](./LICENSE) for details.
