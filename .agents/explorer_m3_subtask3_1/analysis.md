# Milestone 3 Subtask 3 Investigation Report: Server-Side Gate OTP Enforcement on Delivery

## Executive Summary
This report presents a comprehensive investigation of the backend implementation for **Server-Side Gate OTP Enforcement on Delivery** in Kraveo. The codebase currently implements basic OTP generation on `ARRIVED_AT_GATE` status transition and OTP validation during `DELIVERED` status transition across two API endpoints (`PATCH /api/orders/:id/status` and `POST /api/orders/:id/verify-gate-otp`). However, several key gaps in payload flexibility, error format standardization, role-based authorization, and idempotency handling were identified. Recommended enhancements are detailed below for implementation by the Worker agent.

---

## 1. Direct Codebase Observations

### A. Prisma Database Schema (`backend/prisma/schema.prisma`)
- **File**: `backend/prisma/schema.prisma`
- **Lines 103–125**: `model Order` definition.
- **Line 114**: `otpCode String @default("1234")`
  - *Observation*: The model field storing the 4-digit handshake OTP is named `otpCode` (type `String`). `SCOPE.md` references `Order.gateOtp` conceptually, but the active database column in Prisma is `otpCode`.
- **Lines 19–28**: `enum OrderStatus` definition including `ARRIVED_AT_GATE` (Line 25) and `DELIVERED` (Line 26).

### B. Order State Machine (`backend/src/utils/stateMachine.ts`)
- **File**: `backend/src/utils/stateMachine.ts`
- **Lines 4–13**: `VALID_TRANSITIONS` object.
  - **Line 9**: `PICKED_UP: ['ARRIVED_AT_GATE', 'CANCELLED']`
  - **Line 10**: `ARRIVED_AT_GATE: ['DELIVERED']`
  - **Line 11**: `DELIVERED: []`
- **Lines 15–19**: `isValidStateTransition(currentStatus, newStatus)` function returns `true` if `currentStatus === newStatus` (idempotent) or `newStatus` is in `VALID_TRANSITIONS[currentStatus]`.

### C. Notification Service (`backend/src/services/notificationService.ts`)
- **File**: `backend/src/services/notificationService.ts`
- **Lines 96–106**: `triggerStudentArrivalNotification(studentPhone, orderId, otpCode)`
  - Formats FCM push payload title `"🛵 RUNNER ARRIVED AT HOSTEL GATE!"` and includes the 4-digit `otpCode` in `body` and `data`.

### D. API Routes & Controller (`backend/src/routes/api.ts`)

#### 1. Status Update Route (`PATCH /api/orders/:id/status`)
- **File**: `backend/src/routes/api.ts`, Lines 499–569.
- **Role Verification (Lines 505–516)**:
  - `DRIVER` is restricted to `['PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED']`.
  - `STUDENT` is restricted to `['CANCELLED']`.
- **State Machine Check (Lines 525–530)**: Validates transition using `isValidStateTransition`.
- **Arrival Trigger (Lines 535–539)**:
  - When `status === 'ARRIVED_AT_GATE'`, generates a random 4-digit OTP:
    `const generatedGateOtp = Math.floor(1000 + Math.random() * 9000).toString();`
  - Sets `updateData.otpCode = generatedGateOtp` and triggers FCM push notification to student.
- **Delivery OTP Validation (Lines 542–551)**:
  - Line 543: `const providedOtp = req.body.otpCode;`
  - Line 544: `if (!providedOtp || providedOtp !== dbOrder.otpCode || dbOrder.otpCode === 'USED')`
  - Lines 545–548: Returns HTTP 400 with `{ success: false, message: 'Invalid or expired 4-digit Gate Handshake OTP code.' }`.
  - Line 550: Sets `updateData.otpCode = 'USED'` (Single-use invalidation).
- **Prisma Persistence & Socket Event (Lines 553–564)**:
  - Updates order in DB with `updateData`.
  - Emits `order_updated` WebSocket event.

#### 2. Dedicated Gate OTP Verification Route (`POST /api/orders/:id/verify-gate-otp`)
- **File**: `backend/src/routes/api.ts`, Lines 572–607.
- **Middleware**: `requireAuth` (Line 572).
- **Validation (Lines 573–585)**:
  - Line 573: `const { otpCode } = req.body;`
  - Checks if `!otpCode || typeof otpCode !== 'string'` -> Returns HTTP 400.
  - Checks `if (dbOrder.otpCode !== otpCode || dbOrder.otpCode === 'USED')` -> Returns HTTP 400.
- **Persistence & Notification (Lines 587–597)**:
  - Sets status to `DELIVERED` and `otpCode` to `'USED'`. Emits `order_updated`.

---

## 2. Gap Analysis & Edge Cases

| Area | Current Behavior | Target Requirement / Gap | Recommended Fix |
|---|---|---|---|
| **Payload Key Acceptance** | Only accepts `req.body.otpCode` | Clients might submit `{ otp: "1234" }` or `{ otpCode: "1234" }` or numeric integers | Coerce and support both `otpCode` and `otp`: `String(req.body.otpCode \|\| req.body.otp \|\| '').trim()` |
| **Error Response Format** | Returns `{ success: false, message: '...' }` | Scope requires HTTP 400 Bad Request with explicit `{ error: 'Invalid Gate OTP' }` | Include both `error` and `message` properties in 400 responses |
| **RBAC Authorization** | `POST /orders/:id/verify-gate-otp` uses only `requireAuth` | Missing role restriction (DRIVER / ADMIN only) | Add `requireRole('DRIVER', 'ADMIN')` middleware to line 572 |
| **Idempotency on DELIVERED** | If status is already `DELIVERED`, sending status update fails because `otpCode === 'USED'` | If order is already `DELIVERED`, idempotent status update should succeed or return current state | Skip OTP re-verification if `dbOrder.status === 'DELIVERED'` and status in payload is `'DELIVERED'` |
| **Numeric OTP Input Type** | `typeof otpCode !== 'string'` rejects integer payloads (e.g. `{ otpCode: 1234 }`) | Should handle numeric inputs gracefully | Convert input to string before length and equality checks |

---

## 3. Recommended Implementation Strategy for Worker

### Step 1: Update `PATCH /api/orders/:id/status` (Lines 542–551 in `backend/src/routes/api.ts`)
```typescript
// Require valid 4-digit Gate Handshake OTP for DELIVERED status transition
if (status === 'DELIVERED') {
  // If order is already DELIVERED, maintain idempotency without re-checking single-use OTP
  if (dbOrder.status === 'DELIVERED') {
    return res.json({ success: true, message: 'Order is already marked DELIVERED.', data: dbOrder });
  }

  const rawOtp = req.body.otpCode ?? req.body.otp;
  const providedOtp = rawOtp !== undefined && rawOtp !== null ? String(rawOtp).trim() : '';

  if (!providedOtp || providedOtp !== dbOrder.otpCode || dbOrder.otpCode === 'USED') {
    return res.status(400).json({
      success: false,
      error: 'Invalid Gate OTP',
      message: 'Invalid or expired 4-digit Gate Handshake OTP code.'
    });
  }
  updateData.otpCode = 'USED'; // Single-use OTP invalidation
}
```

### Step 2: Update `POST /api/orders/:id/verify-gate-otp` (Lines 572–586 in `backend/src/routes/api.ts`)
```typescript
// Dedicated Gate Handshake OTP Verification Endpoint
apiRouter.post('/orders/:id/verify-gate-otp', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const rawOtp = req.body.otpCode ?? req.body.otp;
  const otpCode = rawOtp !== undefined && rawOtp !== null ? String(rawOtp).trim() : '';

  if (!otpCode) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Gate OTP',
      message: 'Valid 4-digit Gate Handshake OTP code is required.'
    });
  }

  try {
    const dbOrder = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!dbOrder) return res.status(404).json({ success: false, message: 'Order not found' });

    if (dbOrder.status === 'DELIVERED') {
      return res.json({
        success: true,
        message: 'Order is already marked DELIVERED.',
        data: dbOrder
      });
    }

    if (dbOrder.otpCode !== otpCode || dbOrder.otpCode === 'USED') {
      return res.status(400).json({
        success: false,
        error: 'Invalid Gate OTP',
        message: 'Invalid or expired 4-digit Gate Handshake OTP code.'
      });
    }

    const updated = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'DELIVERED', otpCode: 'USED' },
      include: { items: true, vendor: true, customer: true, driver: true }
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${updated.id}`).emit('order_updated', updated);
      io.emit('order_updated', updated);
    }

    return res.json({
      success: true,
      message: 'Gate Handshake OTP verified successfully. Order DELIVERED!',
      data: updated
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error verifying Gate OTP' });
  }
});
```

---

## 4. Verification Method
1. **TypeScript Build Verification**:
   ```bash
   cd /home/lucifer/Documents/Projects/Kraveo/backend && npm run build
   ```
2. **Empirical Verification Scenarios**:
   - Issue `PATCH /api/orders/:id/status` with `{ status: "DELIVERED" }` without OTP -> Expect 400 Bad Request with `{ error: "Invalid Gate OTP" }`.
   - Issue `PATCH /api/orders/:id/status` with `{ status: "DELIVERED", otp: "WRONG" }` -> Expect 400 Bad Request with `{ error: "Invalid Gate OTP" }`.
   - Issue `PATCH /api/orders/:id/status` with `{ status: "DELIVERED", otpCode: "<valid_otp>" }` -> Expect 200 OK, status `DELIVERED`, DB `otpCode` set to `'USED'`.
   - Re-issue `PATCH /api/orders/:id/status` with `{ status: "DELIVERED", otpCode: "<valid_otp>" }` -> Expect 200 OK (idempotent).
