# 🚀 Kraveo Startup Launch Roadmap: Monorepo to Live Campus Rollout

**Target Location:** VIT Bhopal University Campus & Ashta-Kothri Highway Dhaba Network  
**Goal:** Transition Kraveo from a verified full-stack monorepo to a live operational campus startup generating revenue.

---

## 📅 5-Phase Master Execution Blueprint

```
[Phase 1: Cloud DB & Auth] ➔ [Phase 2: Dhaba & Gate Ops] ➔ [Phase 3: CI/CD & Cloud Hosting] ➔ [Phase 4: Beta & Marketing] ➔ [Phase 5: Revenue & Legal]
```

---

## 🛠️ Phase 1: Database Persistence & Production Backend (Weeks 1–2)

### 1. PostgreSQL Database & Prisma ORM Migration
- **Current State**: `backend/src/store.ts` uses volatile in-memory JavaScript arrays.
- **Action**: Replace `store.ts` with PostgreSQL hosted on **Supabase** / **Neon DB** / **AWS RDS** managed using **Prisma ORM**.
- **Database Tables**:
  - `users` (id, phone, name, role, hostel_block, created_at)
  - `vendors` (id, name, category, rating, is_accepting_orders, address, lat, lng)
  - `menu_items` (id, vendor_id, name, price, category, is_available, is_veg, image_url)
  - `orders` (id, customer_id, vendor_id, driver_id, total_amount, delivery_fee, status, otp_code, dropoff_hostel)
  - `order_items` (id, order_id, item_id, name, quantity, price)
  - `driver_locations` (driver_id, lat, lng, heading, updated_at)

### 2. Real Push Notifications (FCM / OneSignal)
- Integrate **Firebase Cloud Messaging (FCM)** in `apps/vendor_app` and `apps/driver_app`.
- Guarantees dhaba phones ring loudly even when the phone screen is locked or app is in the background.

### 3. Real Payment Gateway (Razorpay / PhonePe PG)
- Replace mock payment sheet with official **Razorpay / PhonePe Payment Gateway SDK**.
- Implement server-side Webhook listeners (`/api/payments/webhook`) to automatically transition order state to `PLACED` upon UPI transaction success.

---

## 🤝 Phase 2: Physical Dhaba Onboarding & Gate Operations (Weeks 3–4)

### 1. Highway Dhaba Onboarding (Ashta-Kothri Highway)
- **Target Dhabas**: Sharma Dhaba, FC Night Mess, Singh Punjabi Kitchen, Highway Treats.
- **Hardware Setup**: Equip each dhaba cash counter with a low-cost Android tablet/phone running `apps/vendor_app` with high-volume speaker connectivity.
- **Dhaba SLA Agreement**: Set max 15-minute food preparation SLA.

### 2. Student Delivery Runner Recruiting
- Recruit 10–15 trustworthy VIT Bhopal hostellers as part-time runners.
- Establish standard runner payouts: **₹35–₹40 per delivery trip** + weekly performance bonuses for >25 deliveries.

### 3. Campus Gate Logistics Protocol
- Establish clear Gate Handshake protocols with hostel wardens and security guards at **Boys Hostel Blocks 1–6** and **Girls Gates 1–2**.

---

## ☁️ Phase 3: Cloud Infrastructure & CI/CD Pipelines (Week 5)

### 1. Backend & Admin Web Cloud Hosting
- **Backend API Engine**: Deploy to **Render** / **Railway** / **AWS EC2** with SSL HTTPS certificate and WSS WebSocket support (`wss://api.kraveo.in`).
- **Super Admin Web Dashboard**: Deploy to **Vercel** / **Netlify** (`https://admin.kraveo.in`).

### 2. Automated Mobile Build Pipeline (GitHub Actions)
- Configure `.github/workflows/build_apps.yml` to automatically compile:
  - `.apk` files for Android testing on every `git push`.
  - `.ipa` files for iOS Apple TestFlight distribution.

---

## 🎯 Phase 4: Student Beta Rollout & Campus Marketing (Weeks 6–7)

### 1. Student Beta Testing (100 Testers)
- Release `customer_app` via Apple TestFlight & Direct Android APK links to 100 student beta testers across hostel blocks.

### 2. Campus Virality Marketing Strategy
- **Promo Code Distribution**: Launch `VITFIRST` promo code (20% OFF) via campus flyers and hostel door drops.
- **WhatsApp Group Virality**: Leverage the **Roommate Split-Bill Generator** tool to drive organic WhatsApp group shares.
- **Campus Ambassadors**: Recruit 1-2 influencers per hostel block for word-of-mouth growth.

---

## 💰 Phase 5: Startup Monetization, Legal & Scale (Week 8+)

### 1. Revenue & Margin Economics

$$\text{Total Order Revenue} = \text{Food Subtotal} + \text{Campus Delivery Fee (₹30)}$$

- **Dhaba Commission**: Kraveo earns 12%–15% commission on dish subtotal from dhabas.
- **Delivery Margin**: ₹30 collected from student ➔ ₹25 paid to runner ➔ ₹5 retained by Kraveo.
- **Unit Economics Example**:
  - Order Subtotal = ₹300
  - Kraveo Dhaba Commission (12%) = ₹36
  - Delivery Fee Retained = ₹5
  - **Kraveo Gross Profit per Order** = **₹41**

### 2. Legal Entity & Compliance Setup
- Register PVT LTD / LLP company entity (**Kraveo Logistics Private Limited**).
- Obtain FSSAI food aggregator license & GST registration.
- Set up company bank account linked to automatic Razorpay vendor split payouts.
