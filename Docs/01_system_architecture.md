# Kraveo - End-to-End System Architecture & Engineering Blueprint

## 1. Executive Summary & Context
**Kraveo** is a hyper-local campus food delivery platform custom-built for **VIT Bhopal University**. 
Due to the geographic isolation of the campus (located near the Ashta/Kothri highway) and strict campus security restrictions preventing delivery vehicles from entering hostel blocks, standard delivery aggregators (Swiggy/Zomato) fail to operate effectively on campus.

Kraveo solves this by connecting off-campus highway dhabas directly to students in hostel blocks via student delivery runners, powered by a 4-part software monorepo ecosystem.

---

## 2. Implemented vs. Production Architecture

### Implemented Runtime Architecture (Current Prototype State)

```
  Customer App (Flutter)    Vendor App (Flutter)    Driver App (Flutter)    Super Admin (React)
           │                         │                        │                     │
           └─────────────────────────┼────────────────────────┴─────────────────────┘
                                     │
                                     ▼
                     Node.js Express API & Socket.io
                    (http://3.110.189.80 / localhost:5000)
                                     │
                                     ▼
                    In-Memory JavaScript Store (store.ts)
```

### Intended Target Production Architecture (P1 Target)

```
  Customer App (Flutter)    Vendor App (Flutter)    Driver App (Flutter)    Super Admin (React)
           │                         │                        │                     │
           └─────────────────────────┼────────────────────────┴─────────────────────┘
                                     │ (HTTPS / WSS SSL)
                                     ▼
                     Node.js Express API & Socket.io Server
                        (Nginx Reverse Proxy on AWS EC2)
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
   PostgreSQL 16 DB         Firebase Admin FCM         Razorpay Gateway
    (via Prisma ORM)        (Push Notifications)       (Webhook Listeners)
```

---

## 3. The 4-Part Ecosystem Architecture

### 1. Customer App (`apps/customer_app`)
- **Target Audience**: 10,000+ VIT Bhopal Students.
- **Tech Stack**: Flutter 3.x (Dart), Provider state management, HTTP REST client, Google Fonts.
- **Core Modules**:
  - Pre-locked Hostel Dropdown selection (`Boys Hostel Blocks 1–6`, `Girls Gate 1–2`, `Main Gate`).
  - Highway dhaba directory & dynamic menu catalog with dish customization (spice levels, add-ons).
  - Cart provider with coupon engine (`VITFIRST` flat discount, Kraveo Coins loyalty system).
  - Split-Bill modal generator formatting itemized per-person breakdowns for WhatsApp sharing.
  - Live order tracking screen displaying gate handshake OTP card.

### 2. Dhaba Vendor App (`apps/vendor_app`)
- **Target Audience**: Highway dhaba cooks & canteen managers (optimized for non-tech literacy).
- **Tech Stack**: Flutter 3.x (Dart), `audioplayers` continuous alarm engine, `permission_handler`.
- **Core Modules**:
  - Continuous ringing audio engine playing high-decibel alarm loop on incoming orders.
  - Fullscreen yellow modal (`#FDD400`) with 64px color-coded touch targets (`ACCEPT` / `DECLINE`).
  - Kitchen Display System (KDS) queue with preparation timers (10, 15, 20 mins) and dish checklists.
  - 1-tap grease-proof price steppers (`+10` / `-10`) and stock availability toggles (`IN STOCK` / `SOLD OUT`).

### 3. Delivery Partner App (`apps/driver_app`)
- **Target Audience**: Student delivery runners riding bikes/scooters on campus.
- **Tech Stack**: Flutter 3.x (Dart), dark mode design tokens (`#1B1C1C` surface), location permissions.
- **Core Modules**:
  - Low-glare dark UI optimized for night riding under campus streetlights.
  - Glove-friendly acceptance via interactive swipe slider or 1-tap double-tap button.
  - 4-step pipeline status console (`Dhaba Pickup` ➔ `Hostel Gate Arrival` ➔ `Gate OTP Verification` ➔ `Delivered`).
  - Gate Handshake 4-digit OTP verification screen.
  - Runner ID card display with QR code for gate security guards.

### 4. Super Admin Web Dashboard (`web/super_admin`)
- **Target Audience**: Kraveo Operations Team & Campus Dispatchers.
- **Tech Stack**: React 18, TypeScript, Vite, Tailwind CSS, Recharts, Lucide icons, Socket.io client.
- **Core Modules**:
  - Live Command Center rendering logistics map canvas with active runner markers.
  - Orders matrix table with multi-field search and manual status overrides.
  - Dhaba onboarding drawer (`+ Onboard New Dhaba`) for registering new highway vendors.
  - Driver manager tab showing active runners, payout balances, and shift toggles.
  - Operations analytics panel displaying order volume, dhaba revenue, and delivery SLAs.

---

## 4. End-to-End Operational Pipeline

```
[1. Student Order Placement] ──> Selects items, inputs dropoff hostel, places order via app
          │
          ▼
[2. Payment Processing] ──> Customer completes payment (Razorpay UPI / Webhook confirmation)
          │
          ▼
[3. Real-time Alerting] ──> Backend emits Socket.io / FCM alert ──> Vendor phone alarm rings
          │
          ▼
[4. Dhaba Acceptance] ──> Dhaba cook taps 64px "ACCEPT" ──> State transitions to PREPARING
          │
          ▼
[5. Driver Dispatch] ──> Job broadcast to active runners ──> Runner swipes "ACCEPT JOB"
          │
          ▼
[6. Dhaba Pickup & Transit] ──> Driver picks up order ──> State: PICKED_UP ──> GPS location updates
          │
          ▼
[7. Hostel Gate Handshake] ──> Driver arrives at gate ──> Student provides 4-digit OTP
          │
          ▼
[8. Verification & Completion] ──> Driver enters OTP ──> Server verifies PIN ──> Status: DELIVERED
```

---

## 5. Technology Stack & Dependencies Specifications

| Layer | Component | Technologies Used |
| :--- | :--- | :--- |
| **Mobile Apps** | Cross-Platform Client | Flutter 3.24.x / Dart 3.5.x, Provider, HTTP, AudioPlayers |
| **Web Admin** | Single Page Application | React 18.3, TypeScript 5.x, Vite 5.x, Tailwind CSS 3.4, Recharts |
| **Backend Core** | REST API & Real-time WebSockets | Node.js 20.x, Express 4.x, TypeScript 5.x, Socket.io 4.x, JWT |
| **Database** | Object Relational Mapper | Prisma ORM 5.22.0, PostgreSQL 16 (Schema defined in `prisma/schema.prisma`) |
| **Services** | Push & Payment SDKs | Firebase Admin SDK, Razorpay Node SDK, Google Maps Platform APIs |

---

## 6. Monorepo Directory Layout

```
Kraveo/
├── apps/
│   ├── customer_app/          # Flutter Customer App
│   ├── vendor_app/            # Flutter Vendor App (High-volume audio & simple UI)
│   └── driver_app/            # Flutter Delivery Partner App
├── web/
│   └── super_admin/           # React Web Admin Dashboard
├── backend/                   # Node.js Express API & WebSocket Server
│   ├── src/
│   │   ├── routes/            # REST API endpoints (api.ts)
│   │   ├── middleware/        # Authentication & Role guards (auth.ts)
│   │   ├── services/          # Razorpay & Firebase integrations
│   │   ├── utils/             # State machine & pricing validation rules
│   │   ├── store.ts           # In-memory runtime data store (for dev mode)
│   │   └── index.ts           # Express server entry point & Socket.io setup
│   └── prisma/
│       └── schema.prisma      # Production PostgreSQL relational schema
└── Docs/                      # Comprehensive Systems Documentation & Ledgers
```
