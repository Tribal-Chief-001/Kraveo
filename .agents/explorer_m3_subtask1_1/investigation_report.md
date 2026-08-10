# Comprehensive Investigation Report: Payment Gateway Webhook & Order Placement
**Milestone 3 - Subtask 1**

---

## Executive Summary
This report presents a thorough investigation of the backend payment processing and order placement architecture in the Kraveo monorepo. It details current implementation mechanics, security vulnerabilities, body parser raw stream issues in Express, payment status order guards, and a concrete implementation strategy for the Worker agent.

---

## Key Findings & Line-by-Line Code Analysis

### 1. Express Body Parser & Webhook Raw Body Handling
- **File**: `backend/src/index.ts`
- **Line 33**: `app.use(express.json());`
- **Current Behavior**:
  Express parses incoming HTTP requests with `express.json()` prior to routing to `/api/payments/webhook`. Standard JSON body parsing consumes the request stream and parses JSON into a JavaScript object (`req.body`).
- **Impact on Razorpay Signature Verification**:
  Razorpay computes `x-razorpay-signature` as an HMAC-SHA256 hash over the **exact raw request body bytes** sent in the HTTP payload. When Express parses JSON and a developer re-stringifies `req.body` with `JSON.stringify(req.body)`, white spaces, line breaks, property ordering, or escaped characters are altered. This causes signature verification to fail even for valid webhooks.
- **Recommended Remedy**:
  Modify line 33 of `backend/src/index.ts` to attach a `verify` callback to `express.json()`:
  ```ts
  app.use(express.json({
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    }
  }));
  ```
  This cleanly preserves the raw request payload as a `Buffer` (`req.rawBody`) without interrupting standard JSON body parsing for other endpoints.

---

### 2. Payment Service & Webhook Signature Verification
- **File**: `backend/src/services/paymentService.ts`
- **Lines 58–73**:
  ```ts
  export const verifyRazorpayPaymentSignature = (
    razorpayOrderId: string,
    razorpayPaymentId: string,
    signature: string
  ): boolean => {
    if (process.env.NODE_ENV !== 'production' && razorpayOrderId.startsWith('rzp_order_sim_')) {
      return true; // Auto-pass simulation signatures in development mode
    }

    const generatedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    return generatedSignature === signature;
  };
  ```
- **Current Behavior & Gaps**:
  1. `paymentService.ts` contains `verifyRazorpayPaymentSignature` for client checkout signatures (`razorpayOrderId|razorpayPaymentId`), but **completely lacks** a function for verifying Razorpay Webhook signatures (`verifyRazorpayWebhookSignature`).
  2. `RAZORPAY_WEBHOOK_SECRET` environment variable is not defined or configured in `paymentService.ts`.
- **Recommended Remedy**:
  Add `verifyRazorpayWebhookSignature` in `paymentService.ts`:
  ```ts
  const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'kraveo_webhook_secret_2026';

  export const verifyRazorpayWebhookSignature = (
    rawBody: string | Buffer,
    signature: string
  ): boolean => {
    if (!signature) return false;
    if (process.env.NODE_ENV !== 'production' && signature === 'valid_test_wh_signature') {
      return true;
    }
    const expectedSignature = crypto
      .createHmac('sha256', razorpayWebhookSecret)
      .update(rawBody)
      .digest('hex');

    return expectedSignature === signature;
  };
  ```

---

### 3. Razorpay Webhook Endpoint (`POST /api/payments/webhook`)
- **File**: `backend/src/routes/api.ts`
- **Lines 262–306**:
  ```ts
  apiRouter.post('/payments/webhook', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      const body = req.body;

      const event = body?.event || 'payment.captured';
      const razorpayOrderId = body?.payload?.payment?.entity?.order_id || body?.razorpayOrderId;
      const orderId = body?.payload?.payment?.entity?.notes?.orderId || body?.orderId;

      if (razorpayOrderId || orderId) {
        ...
  ```
- **Current Behavior & Gaps**:
  1. **No Signature Validation**: Line 264 reads `const signature = req.headers['x-razorpay-signature'] as string;`, but `signature` is **never checked**. An attacker can send unauthenticated POST requests with any `orderId` to mark payments as `PAID`.
  2. **Missing HTTP 400 Response**: The endpoint does not reject invalid/missing signatures with HTTP 400 Bad Request.
  3. **Order Status Transition to `PLACED` Missing**: When payment is verified, the endpoint updates `paymentStatus` to `'PAID'`, but fails to explicitly update `order.status` to `'PLACED'` or emit Socket.io notifications (`order_updated`, `new_order_alert`) and FCM push alerts.

---

### 4. Order Creation & Payment Status Guard
- **File**: `backend/src/routes/api.ts`
- **Lines 454–475**:
  ```ts
  const createdDbOrder = await prisma.order.create({
    data: {
      customerId,
      vendorId,
      totalAmount: validation.calculatedTotalAmount,
      deliveryFee: validation.calculatedDeliveryFee,
      dropoffHostel: dropoffHostel || 'Boys Hostel Block 3',
      dropoffNotes: dropoffNotes || '',
      status: 'PLACED',
      paymentStatus: 'PAID', // <--- Hardcoded PAID
      otpCode: Math.floor(1000 + Math.random() * 9000).toString(),
      items: { ... }
    }
  });
  ```
- **Current Behavior & Gaps**:
  `POST /api/orders` hardcodes `paymentStatus: 'PAID'` upon order creation before any payment has been processed. Per `SCOPE.md`, `paymentStatus` must start as `'PENDING'`, and order status transition to `'PLACED'` must occur ONLY after payment status is verified as `'PAID'` / `'COMPLETED'`.
- **Order Status Patch Guard (Lines 499–569)**:
  `PATCH /api/orders/:id/status` permits order status progression (e.g. `ACCEPTED`, `PREPARING`) without checking if `paymentStatus` is `'PAID'`. Unpaid orders (`paymentStatus: 'PENDING'`) should be blocked from advancing in the fulfillment pipeline.

---

## Recommended Implementation Strategy for Worker

1. **Update `backend/src/index.ts`**:
   Attach `verify` option to `express.json()` to save `req.rawBody`.
2. **Update `backend/src/services/paymentService.ts`**:
   Implement and export `verifyRazorpayWebhookSignature(rawBody, signature)`.
3. **Update `backend/src/routes/api.ts`**:
   - In `POST /api/payments/webhook`:
     - Validate `x-razorpay-signature` header using `verifyRazorpayWebhookSignature`.
     - Reject missing or invalid signatures with `res.status(400).json({ success: false, message: 'Invalid or missing Razorpay webhook signature.' })`.
     - On valid payment event (`payment.captured` / `order.paid`), update DB: `paymentStatus: 'PAID'`, `status: 'PLACED'`.
     - Emit Socket.io real-time events (`order_updated`, `new_order_alert`) and trigger FCM push notification to Dhaba.
   - In `POST /api/payments/verify-signature`:
     - Ensure order `status` is updated to `'PLACED'` along with `paymentStatus: 'PAID'`, and emit real-time events.
   - In `POST /api/orders`:
     - Initialize `paymentStatus` as `'PENDING'` by default when creating an order expecting online payment.
   - In `PATCH /api/orders/:id/status` & `/accept-driver`:
     - Guard status progression to ensure order `paymentStatus === 'PAID'` before allowing vendor/driver transitions.
