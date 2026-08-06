# 🧪 Kraveo Interactive Step-by-Step Functional Testing Guide

**Workspace:** Kraveo Monorepo (`apps/customer_app`, `apps/vendor_app`, `apps/driver_app`, `web/super_admin`, `backend/`)  
**Purpose:** Comprehensive, step-by-step walkthrough to manually test every single feature, workflow, button, socket update, audio alert, and security handshake across all 4 applications.

---

## 🚀 Part 1: Starting the Local Development Servers

Open 3 terminal windows to launch the local servers:

### 1. Terminal 1: Backend Engine API (`backend/`)
```bash
cd /home/lucifer/Documents/Projects/Kraveo/backend
npm run dev
```
- **Target URL:** `http://localhost:5000`
- **Output:** `🚀 [Kraveo Server] Running on http://localhost:5000`

### 2. Terminal 2: Super Admin Web Command Center (`web/super_admin`)
```bash
cd /home/lucifer/Documents/Projects/Kraveo/web/super_admin
npm run dev
```
- **Target URL:** `http://localhost:3000`
- **Output:** `Vite dev server running at http://localhost:3000`

### 3. Terminal 3: Flutter Mobile Apps (`apps/`)
```bash
# Customer App
cd /home/lucifer/Documents/Projects/Kraveo/apps/customer_app
~/.flutter-sdk/bin/flutter run

# Vendor App (in a separate terminal)
cd /home/lucifer/Documents/Projects/Kraveo/apps/vendor_app
~/.flutter-sdk/bin/flutter run

# Driver App (in a separate terminal)
cd /home/lucifer/Documents/Projects/Kraveo/apps/driver_app
~/.flutter-sdk/bin/flutter run
```

---

## 📋 Part 2: Step-by-Step Interactive Test Workflows

---

### 🛍️ Test Suite 1: Customer App (`apps/customer_app`)

#### Scenario 1.1: Pre-Locked Hostel Selection & Dhaba Browsing
1. Launch Customer App.
2. At the top of the Home Screen, tap the hostel dropdown menu.
3. Select **`Boys Hostel Block 3`**. Verify the delivery destination pill updates immediately.
4. Type `"Sharma"` in the top search bar. Verify the list filters to display **Sharma Dhaba**.
5. Tap on **Sharma Dhaba** card to open the dhaba menu.

#### Scenario 1.2: Dish Customization & Cart State
1. Scroll to **Paneer Butter Masala** (₹180).
2. Tap the **`Customise`** button.
3. In the modal bottom sheet, select:
   - Spiciness: **`Extra Spicy 🌶️`**
   - Add-on: **`Extra Cheese (+₹30)`**
4. Tap **`ADD TO CART (₹210)`**.
5. Verify the floating cart bar appears at the bottom displaying `1 ITEM | ₹210`.

#### Scenario 1.3: Promo Code Engine (`VITFIRST`)
1. Tap the floating cart bar to open the Cart sheet.
2. In the coupon code input box, type **`VITFIRST`**.
3. Tap **`APPLY`**.
4. **Expected Result**: Banner displays `VITFIRST Applied! (20% OFF)`. Check bill details: a **₹42 discount** is subtracted from the subtotal.

#### Scenario 1.4: Checkout & Order Placement
1. Tap **`PROCEED TO CHECKOUT`**.
2. Select **`UPI Payment`** option.
3. Tap **`PLACE ORDER`**.
4. **Expected Result**: App transitions to the **Live Order Tracking Screen** displaying order status `Order Placed` and a 4-digit Gate Handshake OTP PIN card (e.g. `1234`).

#### Scenario 1.5: Roommate Split-Bill Generator
1. On `LiveTrackingScreen`, tap **`Split Bill with Roommates on WhatsApp`**.
2. In the modal drawer, tap the `+` stepper button to set **`3 Roommates`**.
3. Observe the calculated per-person share (e.g. `₹66 per person`).
4. Tap **`COPY BILL SUMMARY TO PASTE IN WHATSAPP`**.
5. **Expected Result**: SnackBar confirms `Itemized Split Bill copied to clipboard!`.

---

### 👨‍🍳 Test Suite 2: Vendor Dhaba App (`apps/vendor_app`)

#### Scenario 2.1: Fullscreen Ringing Audio Alert & 64px CTAs
1. Keep Vendor App open while placing an order in Customer App.
2. **Expected Result**: Vendor App instantly launches a **fullscreen yellow alert modal (`#FDD400`)** and fires continuous looping audio alarm ringers!
3. View the customer note: `"Make it extra spicy please!"`.
4. Tap prep time chip **`15 MINS`**.
5. Tap giant 64px green button **`[ACCEPT ORDER]`**.
6. **Expected Result**: Audio alarm stops ringing immediately. Order moves into the Kitchen Display System (KDS) queue.

#### Scenario 2.2: Kitchen Display System (KDS) Queue & Timers
1. Navigate to the **Kitchen Queue** tab.
2. View the order card with a live countdown timer starting at `15:00`.
3. Check the dish checklist items as cooks prepare food.
4. Tap the 52px button **`[MARK READY FOR PICKUP]`**.
5. **Expected Result**: Status updates to `READY_FOR_PICKUP` and broadcasts to Customer & Driver apps.

#### Scenario 2.3: Grease-Proof Stock & Price Steppers
1. Navigate to the **Stock Manager** tab.
2. Locate the **Butter Naan** card (Price: ₹30).
3. Tap the **`+10`** stepper button twice. Verify price increases to `₹50` without opening keyboard popups.
4. Tap the **`-10`** stepper button once to adjust price to `₹40`.
5. Tap the **`IN STOCK`** toggle button to switch item to **`SOLD OUT`** (Red).

---

### 🛵 Test Suite 3: Delivery Partner App (`apps/driver_app`)

#### Scenario 3.1: Duty Toggle & Job Alert Card
1. Launch Driver App (verify low-glare dark mode `#1B1C1C`).
2. Toggle the **`ON DUTY`** switch in the top app bar to Active (Green).
3. View the incoming job request card displaying `EARN ₹40` payout badge and 1.8 km trip distance.

#### Scenario 3.2: Glove-Friendly Swipe/1-Tap Acceptance
1. Option A: Drag the gold slider thumb across to 75% threshold.
2. Option B: Tap **`Glove-friendly 1-Tap Accept`** button below the slider.
3. **Expected Result**: Job is accepted and app launches the **4-Step Delivery Pipeline Guidance Screen**.

#### Scenario 3.3: 4-Step Pipeline Guidance & Gate OTP Verification
1. Step 1: Tap **`Navigate to Sharma Dhaba`**.
2. Step 2: Tap **`Confirm Pickup at Dhaba`**. Status updates to `PICKED_UP`.
3. Step 3: Tap **`Arrived at Boys Hostel Block 3 Gate`**. Status updates to `ARRIVED_AT_GATE`.
4. Step 4: Tap **`Verify Gate Handshake OTP`**.
5. Type the 4-digit PIN code displayed on the Customer App (e.g. `1234`).
6. Tap **`VERIFY HANDSHAKE`**.
7. **Expected Result**: Order is marked `DELIVERED` and ₹40 payout is added to the driver's earnings console.

---

### 💻 Test Suite 4: Super Admin Web Command Center (`web/super_admin`)

#### Scenario 4.1: Live Logistics Canvas Map
1. Open browser to `http://localhost:3000`.
2. View **Live Command Center** tab.
3. Observe live SVG route lines connecting Sharma Dhaba to Boys Hostel Block 3.
4. Verify runner pins are placed dynamically across non-stacking canvas offsets.

#### Scenario 4.2: Interactive Dhaba Onboarding Drawer
1. Navigate to **Dhaba & Vendor Network Manager** tab.
2. Click **`+ Onboard New Dhaba`** button.
3. In the modal drawer, enter:
   - Name: `Rajputana Highway Dhaba`
   - Cuisine: `Rajasthani Thali • Parathas`
   - Location: `Ashta Highway km 3.5`
4. Click **`Onboard Dhaba`**.
5. **Expected Result**: Modal closes and new Dhaba card appears in the grid.

#### Scenario 4.3: Orders Matrix & Analytics Panel
1. Navigate to **Orders Matrix** tab.
2. Use the search input to filter orders by customer name or hostel block.
3. Use quick inline status dropdown to override order status.
4. Navigate to **Analytics Panel** tab.
5. Inspect the Recharts late-night surge area chart and hostel block delivery bar chart.

---

## 🧪 Part 3: Automated CLI Verification Commands

Run these automated verification commands in your terminal to verify codebase health at any time:

```bash
# 1. Verify Backend Engine Compilation
cd /home/lucifer/Documents/Projects/Kraveo/backend && npm run build

# 2. Verify Super Admin Web Dashboard Build
cd /home/lucifer/Documents/Projects/Kraveo/web/super_admin && npm run build

# 3. Verify Customer App Static Analysis
cd /home/lucifer/Documents/Projects/Kraveo/apps/customer_app && ~/.flutter-sdk/bin/flutter analyze

# 4. Verify Vendor App Static Analysis
cd /home/lucifer/Documents/Projects/Kraveo/apps/vendor_app && ~/.flutter-sdk/bin/flutter analyze

# 5. Verify Driver App Static Analysis
cd /home/lucifer/Documents/Projects/Kraveo/apps/driver_app && ~/.flutter-sdk/bin/flutter analyze
```
