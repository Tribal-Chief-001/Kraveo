# Original User Request

## 2026-08-10T01:47:20+05:30

Transform the Kraveo monorepo codebase at /home/lucifer/Documents/Projects/Kraveo from a functional UI prototype into a production-hardened, real-time campus food delivery platform serving 10,000 students at VIT Bhopal.

Working directory: /home/lucifer/Documents/Projects/Kraveo
Integrity mode: development

## Requirements

### R1. PostgreSQL Database & Prisma ORM Migration
Replace all in-memory data structures (backend/src/store.ts) across all API routes with live Prisma ORM database queries connected to PostgreSQL. Persist all users, vendors, menus, orders, driver records, reviews, and driver locations cleanly.

### R2. End-to-End Real Transactions & Gate OTP Verification
Implement server-authoritative payment flow with Razorpay webhooks (marking orders PLACED only upon signature verification). Generate and enforce server-side 4-digit Gate Handshake OTP verification when drivers deliver orders.

### R3. Authentication, Security & RBAC Guards
Remove universal test OTPs (1234, 4829) and fallback tokens. Enforce JWT authentication and role-based authorization (requireRole) across all vendor, driver, and admin endpoints.

### R4. Real-time Multi-Persona Client Sync & FCM Push
Connect Customer, Vendor, Driver Flutter apps and the React Super Admin Web Portal to live backend Socket.io channels and Firebase Cloud Messaging (FCM) so order status changes and driver locations reflect real-time across all 4 apps.

### R5. Transport Security & Deployment Hardening
Configure production API base URLs, CORS policies, environment configurations, and cleartext traffic guards across client apps and Nginx / Express services.

## Acceptance Criteria

### Security & Data Integrity
- [ ] No in-memory array fallback used for any API route (100% database persistence via Prisma).
- [ ] Universal OTPs (1234, 4829) removed; OTP verification requires valid SMS/service codes.
- [ ] API routes enforce JWT token authentication and role checking for unauthorized access attempts.

### Transaction & Real-time Flow
- [ ] Orders require verified payment status before transitioning to PLACED.
- [ ] Gate Handshake OTP is verified server-side before transitioning order status to DELIVERED.
- [ ] Status updates triggered in Vendor or Driver apps broadcast in real-time to Customer and Admin portals via Socket.io/FCM.

### Code Quality & Build Verification
- [ ] npm run build passes with 0 compilation/type errors in backend/.
- [ ] npm run build passes with 0 errors in web/super_admin/.
- [ ] flutter analyze or unit test suites pass across all 3 mobile applications (customer_app, vendor_app, driver_app).
