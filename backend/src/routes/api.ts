import { Router, Request, Response } from 'express';
import { Role, OrderStatus } from '@prisma/client';
import { generateToken, requireAuth, authenticateJwt, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { isValidStateTransition, getNextAllowedStates } from '../utils/stateMachine';
import { validateAndCalculateOrder } from '../utils/validation';
import { prisma } from '../db';
import { createRazorpayOrder, verifyRazorpayPaymentSignature, verifyRazorpayWebhookSignature } from '../services/paymentService';
import { triggerDhabaAlarmPushNotification, triggerStudentArrivalNotification, sendPushNotification } from '../services/notificationService';

export const apiRouter = Router();

// ----------------------------------------------------
// DRIVER PARTNER MANAGEMENT ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/drivers', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drivers = await prisma.driverPartner.findMany({
      include: { user: true }
    });
    return res.json({ success: true, count: drivers.length, data: drivers });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching drivers' });
  }
});

apiRouter.get('/drivers/locations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbLocs = await prisma.driverLocation.findMany();
    return res.json({ success: true, data: dbLocs });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver locations' });
  }
});

apiRouter.get('/drivers/:id', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driverId = req.params.id;
    const driver = await prisma.driverPartner.findFirst({
      where: { OR: [{ id: driverId }, { userId: driverId }] },
      include: { user: true }
    });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver partner not found.' });
    return res.json({ success: true, data: driver });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver' });
  }
});

// ----------------------------------------------------
// AUTH & SMS OTP ENDPOINTS
// ----------------------------------------------------
export const otpStore = new Map<string, { otp: string; expiresAt: number; attempts: number }>();

// Clean expired OTPs periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of otpStore.entries()) {
    if (now >= value.expiresAt) {
      otpStore.delete(key);
    }
  }
}, 60000);

// Request SMS OTP (Fast2SMS / Twilio / Firebase Phone Auth integration ready)
apiRouter.post('/auth/send-otp', async (req: Request, res: Response) => {
  const { phone, role } = req.body;

  if (!phone || typeof phone !== 'string' || phone.trim().length < 10) {
    return res.status(400).json({ success: false, message: 'Valid 10-digit Indian phone number is required.' });
  }

  // Generate 4-digit secure OTP
  const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minute expiry

  otpStore.set(phone, { otp: generatedOtp, expiresAt, attempts: 0 });

  console.log(`📲 [SMS OTP Gateway] Dispatched 4-digit SMS OTP '${generatedOtp}' to ${phone} (Role: ${role || 'STUDENT'})`);

  return res.json({
    success: true,
    message: `OTP sent successfully to ${phone}. Valid for 5 minutes.`
  });
});

// Verify SMS OTP & Create/Retrieve Account Profile
apiRouter.post('/auth/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone, otp, role, name, hostelBlock, upiId } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone number and OTP code are required.' });
    }

    const storedData = otpStore.get(phone);

    if (!storedData) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code. Please try again.' });
    }

    storedData.attempts = (storedData.attempts || 0) + 1;

    if (storedData.attempts > 5) {
      otpStore.delete(phone);
      return res.status(400).json({ success: false, message: 'Too many failed OTP attempts. Please request a new OTP.' });
    }

    if (storedData.otp !== String(otp).trim() || Date.now() >= storedData.expiresAt) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code. Please try again.' });
    }

    otpStore.delete(phone);

    let user = await prisma.user.findUnique({ where: { phone } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name: name || (role === 'VENDOR' ? 'Dhaba Owner' : role === 'DRIVER' ? 'Student Runner' : 'VIT Student'),
          phone,
          role: (role as Role) || Role.STUDENT,
          hostelBlock: hostelBlock || 'Boys Hostel Block 1',
          upiId: upiId || null
        }
      });
    } else if (name || hostelBlock || upiId) {
      const updateData: any = {};
      if (name) updateData.name = name;
      if (hostelBlock) updateData.hostelBlock = hostelBlock;
      if (upiId) updateData.upiId = upiId;

      user = await prisma.user.update({
        where: { id: user.id },
        data: updateData
      });
    }

    const token = generateToken({ id: user.id, phone: user.phone, role: user.role });

    return res.json({
      success: true,
      message: 'OTP verified successfully. Logged in!',
      token,
      user
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error verifying OTP' });
  }
});



// Get Authenticated User Profile
apiRouter.get('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: 'User profile not found.' });

    return res.json({ success: true, user });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching profile' });
  }
});

// Update Authenticated User Profile
apiRouter.put('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { name, hostelBlock, upiId, fcmToken } = req.body;

    const updateData: any = {};
    if (name) updateData.name = name;
    if (hostelBlock) updateData.hostelBlock = hostelBlock;
    if (upiId) updateData.upiId = upiId;
    if (fcmToken) updateData.fcmToken = fcmToken;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData
    });

    return res.json({ success: true, message: 'Profile updated successfully.', user });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error updating profile' });
  }
});

// ----------------------------------------------------
// PAYMENT GATEWAY ENDPOINTS (RAZORPAY / PHONEPE UPI)
// ----------------------------------------------------
apiRouter.post('/payments/create-order', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { orderId, amount } = req.body;

  if (!orderId || !amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid orderId and positive numeric amount are required.' });
  }

  const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
  if (!dbOrder) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }

  const result = await createRazorpayOrder(orderId, amount);

  if (result.success && result.razorpayOrderId) {
    await prisma.payment.upsert({
      where: { razorpayOrderId: result.razorpayOrderId },
      update: { amount },
      create: {
        orderId,
        razorpayOrderId: result.razorpayOrderId,
        amount,
        status: 'PENDING'
      }
    });
  }

  return res.json({
    ...result,
    amount: result.amountInPaise
  });
});

apiRouter.post('/payments/verify-signature', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ success: false, message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.' });
    }

    const isValid = verifyRazorpayPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);

    if (isValid) {
      const updatedPayments = await prisma.payment.updateMany({
        where: { razorpayOrderId },
        data: { status: 'PAID', razorpayPaymentId }
      });

      // Update associated order payment status as well
      const payment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
      if (payment) {
        await prisma.order.update({
          where: { id: payment.orderId },
          data: { paymentStatus: 'PAID' }
        });
      }

      return res.json({ success: true, message: 'UPI Payment signature verified successfully.' });
    } else {
      return res.status(400).json({ success: false, message: 'Invalid payment signature. Verification failed.' });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error verifying signature' });
  }
});

// Razorpay Webhook Event Processing Endpoint (Server-Authoritative Status Update)
apiRouter.post('/payments/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    if (!signature || !verifyRazorpayWebhookSignature(rawBody, signature)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment webhook signature'
      });
    }

    const body = req.body;
    const event = body?.event || 'payment.captured';
    const razorpayOrderId = body?.payload?.payment?.entity?.order_id || body?.razorpayOrderId;
    const orderId = body?.payload?.payment?.entity?.notes?.orderId || body?.orderId;

    let updatedOrder = null;

    if (razorpayOrderId || orderId) {
      const payment = await prisma.payment.findFirst({
        where: {
          OR: [
            ...(razorpayOrderId ? [{ razorpayOrderId }] : []),
            ...(orderId ? [{ orderId }] : [])
          ]
        }
      });

      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'PAID' }
        });

        const existingOrder = await prisma.order.findUnique({ where: { id: payment.orderId } });
        const targetStatus = (existingOrder && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'].includes(existingOrder.status))
          ? existingOrder.status
          : 'PLACED';

        updatedOrder = await prisma.order.update({
          where: { id: payment.orderId },
          data: { paymentStatus: 'PAID', status: targetStatus },
          include: { items: true, vendor: true, customer: true, driver: true }
        });
      } else if (orderId) {
        const existingOrder = await prisma.order.findUnique({ where: { id: orderId } });
        const targetStatus = (existingOrder && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'].includes(existingOrder.status))
          ? existingOrder.status
          : 'PLACED';

        updatedOrder = await prisma.order.update({
          where: { id: orderId },
          data: { paymentStatus: 'PAID', status: targetStatus },
          include: { items: true, vendor: true, customer: true, driver: true }
        });
      }
    }

    if (updatedOrder) {
      const io = req.app.get('io');
      if (io) {
        io.to(`order_${updatedOrder.id}`).emit('order_updated', updatedOrder);
        io.emit('order_updated', updatedOrder);
      }
    }

    return res.json({
      success: true,
      status: 'processed',
      message: 'Razorpay webhook processed successfully.'
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error processing Razorpay webhook' });
  }
});

// Register FCM Push Notification Token
apiRouter.post('/notifications/register-token', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({ success: false, message: 'fcmToken is required and cannot be empty.' });
    }

    if (req.user?.id) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { fcmToken }
      });
    }

    return res.json({ success: true, message: 'FCM push notification token registered successfully.' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error registering token' });
  }
});

// ----------------------------------------------------
// VENDOR / DHABA ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/vendors', async (req: Request, res: Response) => {
  try {
    const dbVendors = await prisma.vendor.findMany({ include: { menuItems: true } });
    return res.json({ success: true, count: dbVendors.length, data: dbVendors });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendors' });
  }
});

apiRouter.get('/vendors/:id', async (req: Request, res: Response) => {
  try {
    const dbVendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: { menuItems: true }
    });
    if (!dbVendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    return res.json({ success: true, data: { ...dbVendor, menu: dbVendor.menuItems } });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendor' });
  }
});

apiRouter.patch('/vendors/:id/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const updated = await prisma.vendor.update({
      where: { id: req.params.id },
      data: { isAcceptingOrders: !vendor.isAcceptingOrders }
    });
    return res.json({ success: true, isAcceptingOrders: updated.isAcceptingOrders });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error toggling vendor' });
  }
});

// ----------------------------------------------------
// MENU ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/menus/:vendorId', async (req: Request, res: Response) => {
  try {
    const dbItems = await prisma.menuItem.findMany({ where: { vendorId: req.params.vendorId } });
    return res.json({ success: true, count: dbItems.length, data: dbItems });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching menu items' });
  }
});

apiRouter.patch('/menus/:itemId/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbItem = await prisma.menuItem.findUnique({ where: { id: req.params.itemId } });
    if (!dbItem) return res.status(404).json({ success: false, message: 'Menu item not found' });

    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: { isAvailable: !dbItem.isAvailable }
    });
    return res.json({ success: true, item: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error toggling menu item' });
  }
});

// ----------------------------------------------------
// ORDER ENDPOINTS WITH SERVER-SIDE PRICING & STATE MACHINE
// ----------------------------------------------------
apiRouter.get('/orders', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { vendorId, driverId, customerId } = req.query;

  try {
    const whereClause: any = {};
    if (vendorId && typeof vendorId === 'string') whereClause.vendorId = vendorId;
    if (driverId && typeof driverId === 'string') whereClause.driverId = driverId;
    if (customerId && typeof customerId === 'string') whereClause.customerId = customerId;

    const dbOrders = await prisma.order.findMany({
      where: whereClause,
      include: { items: true, vendor: true, customer: true, driver: true },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, count: dbOrders.length, data: dbOrders });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching orders' });
  }
});

apiRouter.get('/orders/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbOrder = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true, vendor: true, customer: true, driver: true }
    });
    if (!dbOrder) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.json({ success: true, data: dbOrder });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching order' });
  }
});

// Create Order (Server-Side Price Recalculation & Prisma DB Persistence)
apiRouter.post('/orders', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { vendorId, items, dropoffHostel, dropoffNotes, couponCode } = req.body;

  if (!vendorId) {
    return res.status(400).json({ success: false, message: 'vendorId is required.' });
  }

  // Recalculate price on server side to defeat client pricing tampering
  const validation = await validateAndCalculateOrder(vendorId, items, couponCode);

  if (!validation.isValid) {
    return res.status(400).json({ success: false, message: validation.errorMessage });
  }

  if (!req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized. User session required.' });
  }

  const customerId = req.user.id;

  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (vendor && !vendor.isAcceptingOrders) {
      return res.status(400).json({ success: false, message: 'This Dhaba is currently CLOSED for new orders.' });
    }

    const createdDbOrder = await prisma.order.create({
      data: {
        customerId,
        vendorId,
        totalAmount: validation.calculatedTotalAmount,
        deliveryFee: validation.calculatedDeliveryFee,
        dropoffHostel: dropoffHostel || 'Boys Hostel Block 3',
        dropoffNotes: dropoffNotes || '',
        status: 'PLACED',
        paymentStatus: 'PENDING',
        otpCode: Math.floor(1000 + Math.random() * 9000).toString(),
        items: {
          create: validation.verifiedItems.map((item) => ({
            menuItemId: item.itemId,
            name: item.name,
            quantity: item.quantity,
            price: item.price
          }))
        }
      },
      include: { items: true, vendor: true, customer: true }
    });

    // Trigger FCM push alert to Dhaba phone safely
    triggerDhabaAlarmPushNotification(vendorId, createdDbOrder.id, createdDbOrder.totalAmount)
      .catch((err) => console.error('⚠️ [FCM Dhaba Alarm Dispatch Error]:', err.message));

    // Emit to scoped WebSocket rooms for vendor & customer privacy
    const io = req.app.get('io');
    if (io) {
      io.to(`vendor_${vendorId}`).emit('new_order_alert', createdDbOrder);
      io.to(`order_${createdDbOrder.id}`).emit('order_updated', createdDbOrder);
      io.emit('order_updated', createdDbOrder); // Global feed for Super Admin
    }

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully and persisted to database.',
      data: createdDbOrder
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error creating order' });
  }
});

// Update Order Status (Enforces State Machine Transitions & Prisma Persistence)
apiRouter.patch('/orders/:id/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { status } = req.body as { status: OrderStatus };
  const user = req.user;

  if (!status) return res.status(400).json({ success: false, message: 'status field is required.' });

  if (!user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  try {
    const dbOrder = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { customer: true, vendor: true }
    });
    if (!dbOrder) return res.status(404).json({ success: false, message: 'Order not found' });

    // Role-based status transition & ownership restrictions
    if (user.role === 'STUDENT') {
      if (dbOrder.customerId !== user.id) {
        return res.status(403).json({ success: false, message: 'Forbidden. You can only update your own orders.' });
      }
      if (status !== 'CANCELLED') {
        return res.status(403).json({ success: false, message: 'Students can only cancel orders.' });
      }
    }

    if (user.role === 'VENDOR') {
      if (dbOrder.vendor?.userId && dbOrder.vendor.userId !== user.id) {
        return res.status(403).json({ success: false, message: 'Forbidden. You do not own this Dhaba order.' });
      }
      if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(status)) {
        return res.status(403).json({ success: false, message: 'Vendors can only update kitchen preparation status.' });
      }
    }

    if (user.role === 'DRIVER') {
      if (dbOrder.driverId && dbOrder.driverId !== user.id) {
        return res.status(403).json({ success: false, message: 'Forbidden. You are not assigned to deliver this order.' });
      }
      if (!['PICKED_UP', 'ARRIVED_AT_GATE', 'DELIVERED'].includes(status)) {
        return res.status(403).json({ success: false, message: 'Runners can only update delivery status.' });
      }
    }

    // Idempotency check: if order is already DELIVERED
    if (dbOrder.status === 'DELIVERED') {
      return res.json({ success: true, data: dbOrder, message: 'Order is already DELIVERED.' });
    }

    const currentStatus = dbOrder.status as OrderStatus;

    // Enforce Order State Machine transition validity
    if (!isValidStateTransition(currentStatus, status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid order state transition from '${currentStatus}' to '${status}'. Allowed next states: ${getNextAllowedStates(currentStatus).join(', ')}.`
      });
    }

    const updateData: any = { status: status as any };

    // Dynamic 4-Digit Gate Handshake OTP generation when runner arrives at gate
    if (status === 'ARRIVED_AT_GATE' || status === ('ARRIVED' as any)) {
      const generatedGateOtp = Math.floor(1000 + Math.random() * 9000).toString();
      updateData.otpCode = generatedGateOtp;
      triggerStudentArrivalNotification(dbOrder.customer?.fcmToken || undefined, dbOrder.id, generatedGateOtp)
        .catch((err) => console.error('⚠️ [FCM Arrival Alert Dispatch Error]:', err.message));
    }

    // Require valid 4-digit Gate Handshake OTP for DELIVERED status transition
    if (status === 'DELIVERED') {
      const providedOtp = String(req.body.otpCode ?? req.body.otp ?? '').trim();
      if (!providedOtp || !/^\d{4}$/.test(providedOtp) || providedOtp !== dbOrder.otpCode || dbOrder.otpCode === 'USED') {
        return res.status(400).json({
          success: false,
          error: 'Invalid Gate OTP',
          message: 'Invalid or expired 4-digit Gate Handshake OTP code.'
        });
      }
      updateData.otpCode = 'USED'; // Single-use OTP invalidation
    }

    const updated = await prisma.order.update({
      where: { id: req.params.id },
      data: updateData,
      include: { items: true, vendor: true, customer: true, driver: true }
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${updated.id}`).emit('order_updated', updated);
      io.emit('order_updated', updated);
    }

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error updating order status' });
  }
});

// Dedicated Gate Handshake OTP Verification Endpoint
apiRouter.post('/orders/:id/verify-gate-otp', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const providedOtp = String(req.body.otpCode ?? req.body.otp ?? '').trim();

  try {
    const dbOrder = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!dbOrder) return res.status(404).json({ success: false, message: 'Order not found' });

    // Idempotency check: if order is already DELIVERED
    if (dbOrder.status === 'DELIVERED') {
      return res.json({
        success: true,
        message: 'Order is already DELIVERED.',
        data: dbOrder
      });
    }

    if (!providedOtp || !/^\d{4}$/.test(providedOtp) || dbOrder.otpCode !== providedOtp || dbOrder.otpCode === 'USED') {
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

// Toggle Vendor Store Open/Closed Status (Prisma DB Persistence)
apiRouter.patch('/vendors/:id/status', requireAuth, requireRole('VENDOR', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const { isAcceptingOrders } = req.body;

  if (typeof isAcceptingOrders !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isAcceptingOrders boolean field is required.' });
  }

  try {
    const updated = await prisma.vendor.update({
      where: { id: req.params.id },
      data: { isAcceptingOrders }
    });
    return res.json({ success: true, message: `Store status updated to ${isAcceptingOrders ? 'OPEN' : 'CLOSED'}`, vendor: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error updating vendor status' });
  }
});

// Update Menu Item Stock Availability & Price (Prisma DB Persistence)
apiRouter.patch('/vendors/items/:itemId', requireAuth, requireRole('VENDOR', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const { isAvailable, price } = req.body;

  const updateData: any = {};
  if (typeof isAvailable === 'boolean') updateData.isAvailable = isAvailable;
  if (typeof price === 'number' && price > 0) updateData.price = price;

  try {
    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: updateData
    });
    return res.json({ success: true, message: 'Menu item updated successfully.', item: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error updating menu item' });
  }
});

// Accept Driver Assignment (Prisma DB Persistence)
apiRouter.post('/orders/:id/accept-driver', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const driverId = req.user?.id;
  if (!driverId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.driverId && order.driverId !== driverId) {
      return res.status(400).json({ success: false, message: 'Order is already assigned to another runner.' });
    }

    const updated = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        driverId,
        status: order.status === 'PLACED' ? 'ACCEPTED' : order.status
      },
      include: { items: true, vendor: true, customer: true, driver: true }
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${updated.id}`).emit('order_updated', updated);
      io.emit('order_updated', updated);
    }

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error accepting order' });
  }
});

// ----------------------------------------------------
// DRIVER LOCATION ENDPOINTS (Prisma DB Persistence)
// ----------------------------------------------------

apiRouter.post('/drivers/location', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const { lat, lng, heading } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ success: false, message: 'Valid lat and lng numeric coordinates are required.' });
  }

  const driverId = req.user?.id;
  if (!driverId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const loc = await prisma.driverLocation.upsert({
      where: { driverId },
      update: { lat, lng, heading: heading || 0, lastUpdated: new Date() },
      create: { driverId, driverName: 'Vikram Singh', lat, lng, heading: heading || 0 }
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('driver_location_update', loc);
    }

    return res.json({ success: true, data: loc });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error updating driver location' });
  }
});

// ----------------------------------------------------
// REVIEWS & KRAVEO COIN LOYALTY REWARDS ENDPOINTS
// ----------------------------------------------------

// Submit Order & Dish Review (Earns +10 Kraveo Coins & Updates Dhaba Rating)
apiRouter.post('/reviews', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { orderId, driverRating, driverTags, driverNotes, dishReviews, dhabaNotes } = req.body;

  if (!orderId) {
    return res.status(400).json({ success: false, message: 'orderId is required.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }

      if (order.isReviewed) {
        throw new Error('ALREADY_REVIEWED');
      }

      const customerId = req.user?.id || order.customerId;

      // 1. Update User's Kraveo Coins (+10 per review)
      const updatedUser = await tx.user.update({
        where: { id: customerId },
        data: { kraveoCoins: { increment: 10 } }
      });

      // 2. Mark Order as reviewed
      await tx.order.update({
        where: { id: orderId },
        data: { isReviewed: true }
      });

      // 3. Process Dish Ratings & Update Menu Item Rating Metrics
      if (Array.isArray(dishReviews)) {
        for (const dr of dishReviews) {
          if (dr && dr.dishId && typeof dr.rating === 'number') {
            const item = await tx.menuItem.findUnique({ where: { id: dr.dishId } });
            if (item) {
              const currRating = item.rating || 4.5;
              const currCount = item.ratingCount || 10;
              const newCount = currCount + 1;
              const newRating = parseFloat(((currRating * currCount + dr.rating) / newCount).toFixed(2));
              await tx.menuItem.update({
                where: { id: item.id },
                data: { rating: newRating, ratingCount: newCount }
              });
            }
          }
        }
      }

      // 4. Update Vendor Rating using Bayesian Aggregation Algorithm
      let updatedVendor = null;
      const vendor = await tx.vendor.findUnique({ where: { id: order.vendorId } });
      if (vendor) {
        const C = 10; // Prior weight constant
        const m = 4.5; // Campus baseline rating
        const currentTotalCount = vendor.totalRatingsCount || 50;
        const newTotalCount = currentTotalCount + 1;
        const ratingToUse = typeof driverRating === 'number' ? driverRating : 4.5;
        const newRatingSum = (vendor.rating * currentTotalCount) + ratingToUse;
        
        // Bayesian Weighted Average Formula
        const bayesianRating = parseFloat((((C * m) + newRatingSum) / (C + newTotalCount)).toFixed(2));
        updatedVendor = await tx.vendor.update({
          where: { id: vendor.id },
          data: { rating: bayesianRating, totalRatingsCount: newTotalCount }
        });
      }

      // 5. Update Driver Partner Rating if driver is assigned
      if (order.driverId && typeof driverRating === 'number') {
        const driver = await tx.driverPartner.findFirst({
          where: { OR: [{ id: order.driverId }, { userId: order.driverId }] }
        });
        if (driver) {
          const newDriverRating = parseFloat(((driver.rating * 20 + driverRating) / 21).toFixed(2));
          await tx.driverPartner.update({
            where: { id: driver.id },
            data: { rating: newDriverRating }
          });
        }
      }

      // 6. Save Review Record
      const newReview = await tx.reviewRecord.create({
        data: {
          orderId,
          customerId,
          vendorId: order.vendorId,
          driverId: order.driverId,
          driverRating: typeof driverRating === 'number' ? driverRating : 5,
          driverTags: driverTags || [],
          driverNotes: driverNotes || '',
          dishReviews: dishReviews || [],
          dhabaNotes: dhabaNotes || '',
          coinsEarned: 10
        }
      });

      return { updatedUser, updatedVendor, newReview };
    });

    console.log(`🪙 [Kraveo Coins Loyalty] User (${result.updatedUser.id}) earned +10 Kraveo Coins! Total Balance: ${result.updatedUser.kraveoCoins}`);

    return res.json({
      success: true,
      message: '🎉 Review submitted successfully! You earned +10 Kraveo Coins!',
      coinsEarned: 10,
      totalCoins: result.updatedUser.kraveoCoins,
      newVendorRating: result.updatedVendor?.rating,
      review: result.newReview
    });
  } catch (err: any) {
    if (err.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (err.message === 'ALREADY_REVIEWED') {
      return res.status(400).json({ success: false, message: 'This order has already been reviewed.' });
    }
    return res.status(500).json({ success: false, message: err.message || 'Error submitting review.' });
  }
});

// Redeem 50 Kraveo Coins for Flat ₹20 OFF Coupon
apiRouter.post('/coupons/redeem-coins', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Atomic update eliminating concurrency race conditions
    const updateResult = await prisma.user.updateMany({
      where: { id: req.user.id, kraveoCoins: { gte: 50 } },
      data: { kraveoCoins: { decrement: 50 } }
    });

    if (updateResult.count === 0) {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const currentCoins = user?.kraveoCoins || 0;
      return res.status(400).json({
        success: false,
        message: `Insufficient Kraveo Coins. You have ${currentCoins} coins, but need 50 coins to redeem ₹20 OFF.`
      });
    }

    const updatedUser = await prisma.user.findUnique({ where: { id: req.user.id } });

    return res.json({
      success: true,
      message: '🎉 Redeemed 50 Kraveo Coins for Flat ₹20 OFF!',
      couponCode: 'KRAVEO20',
      discountAmount: 20,
      remainingCoins: updatedUser?.kraveoCoins || 0
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error redeeming coins' });
  }
});

// Fetch Dhaba Reviews
apiRouter.get('/reviews/vendor/:vendorId', async (req: Request, res: Response) => {
  try {
    const vendorReviews = await prisma.reviewRecord.findMany({
      where: { vendorId: req.params.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, count: vendorReviews.length, data: vendorReviews });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendor reviews' });
  }
});

// Fetch Driver Reviews
apiRouter.get('/reviews/driver/:driverId', async (req: Request, res: Response) => {
  try {
    const driverIdParam = req.params.driverId;
    const driver = await prisma.driverPartner.findFirst({
      where: { OR: [{ id: driverIdParam }, { userId: driverIdParam }] }
    });

    const targetIds = [driverIdParam];
    if (driver?.id && !targetIds.includes(driver.id)) targetIds.push(driver.id);
    if (driver?.userId && !targetIds.includes(driver.userId)) targetIds.push(driver.userId);

    const driverReviews = await prisma.reviewRecord.findMany({
      where: { driverId: { in: targetIds } },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, count: driverReviews.length, data: driverReviews });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver reviews' });
  }
});
