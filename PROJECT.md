# Project: Kraveo Platform Upgrade

## Architecture
Monorepo architecture serving 10,000 students at VIT Bhopal:
- `backend/`: Node.js, Express, TypeScript, Prisma ORM (PostgreSQL), Socket.io, Firebase Admin (FCM), Razorpay SDK.
- `web/super_admin/`: Vite, React 18, TypeScript, Tailwind CSS, Recharts, Socket.io client.
- `apps/customer_app/`: Flutter (Dart), Razorpay integration, Socket.io client, FCM, secure storage.
- `apps/vendor_app/`: Flutter (Dart), Socket.io client, FCM, order management, audio alerts.
- `apps/driver_app/`: Flutter (Dart), Gate OTP handshake dialog, Socket.io client, FCM, location tracking.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | E2E Testing Suite (Dual Track) | Opaque-box requirements-driven test suite (Tiers 1-4) | none | IN_PROGRESS |
| 2 | Backend Prisma ORM & PostgreSQL Persistence | Extend schema.prisma (DriverPartner, ReviewRecord, user/vendor/order fields), replace store.ts across all 25 routes | none | DONE |
| 3 | Payment Gateway & Server-Authoritative Gate OTP | Razorpay webhook POST /api/payments/webhook, order status PLACED condition, dynamic 4-digit Gate OTP generation, student arrival push trigger, server-side OTP enforcement on DELIVERED | Milestone 2 | PLANNED |
| 4 | Authentication, JWT & RBAC Hardening | Remove static universal OTPs (1234, 4829), enforce JWT middleware & requireRole across vendor/driver/admin routes, deprecate unauthenticated login | Milestone 2 | PLANNED |
| 5 | Real-Time Sync & FCM Push Messaging | Wire Socket.io rooms (order_${id}, vendor_${id}), FCM push triggers on status changes, update Web Super Admin & 3 Flutter apps with live sockets/FCM & secure storage | Milestones 2, 3, 4 | PLANNED |
| 6 | Transport Security, Environment Config & Code Cleanup | Configure production API base URLs (HTTPS/env vars), CORS policies, Android cleartext traffic config, resolve build/lint issues (0 errors in backend, super_admin, flutter analyze) | Milestones 2, 3, 4, 5 | PLANNED |
| 7 | Final Milestone: E2E Verification & Adversarial Hardening | Pass 100% of E2E test suite (Tiers 1-4) + Tier 5 white-box adversarial coverage hardening | Milestones 1-6 | PLANNED |

## Interface Contracts
### Backend ↔ Clients (HTTP REST & Auth)
- Header: `Authorization: Bearer <jwt_token>`
- Roles: `CUSTOMER`, `VENDOR`, `DRIVER`, `ADMIN`
- Auth verification: `POST /api/auth/verify-otp` returns `{ token, user }`. No master OTP bypass allowed.
- Payment Webhook: `POST /api/payments/webhook` with header `x-razorpay-signature` and raw JSON body.
- Order Gate OTP: `PATCH /api/orders/:id/status` transitioning to `DELIVERED` requires `{ status: "DELIVERED", otpCode: "XXXX" }` (or `POST /api/orders/:id/verify-gate-otp`).

### Backend ↔ Clients (Socket.io Real-Time Rooms)
- Rooms: `order_${orderId}`, `vendor_${vendorId}`
- Event `order_updated`: `{ id, status, paymentStatus, driverId, ... }`
- Event `driver_location_update`: `{ driverId, driverName, lat, lng, heading }`

## Code Layout
- Backend: `backend/src/`, `backend/prisma/schema.prisma`, `backend/src/routes/api.ts`, `backend/src/middleware/auth.ts`, `backend/src/services/`
- Web Super Admin: `web/super_admin/src/`, `web/super_admin/src/services/api.ts`
- Mobile Apps: `apps/customer_app/lib/`, `apps/vendor_app/lib/`, `apps/driver_app/lib/`
