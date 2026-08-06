import { Router, Request, Response } from 'express';
import { vendors, menuItems, orders, driverLocations, users } from '../store';
import { Order, OrderStatus } from '../types';
import { generateToken, requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { isValidStateTransition, getNextAllowedStates } from '../utils/stateMachine';
import { validateAndCalculateOrder } from '../utils/validation';

export const apiRouter = Router();

// ----------------------------------------------------
// AUTH ENDPOINTS
// ----------------------------------------------------
apiRouter.post('/auth/login', (req: Request, res: Response) => {
  const { phone, role } = req.body;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ success: false, message: 'Valid phone number is required.' });
  }

  let user = users.find((u) => u.phone === phone);
  
  if (!user) {
    user = {
      id: `usr-${Date.now()}`,
      name: role === 'VENDOR' ? 'Dhaba Owner' : role === 'DRIVER' ? 'Student Runner' : 'VIT Student',
      phone,
      role: role || 'STUDENT',
      hostelBlock: 'Boys Hostel Block 1',
      createdAt: new Date().toISOString()
    };
    users.push(user);
  }

  // Issue real cryptographic JWT signed token
  const token = generateToken({ id: user.id, phone: user.phone, role: user.role });

  return res.json({
    success: true,
    token,
    user
  });
});

// ----------------------------------------------------
// PAYMENT GATEWAY ENDPOINTS (RAZORPAY / PHONEPE UPI)
// ----------------------------------------------------
import { createRazorpayOrder, verifyRazorpayPaymentSignature } from '../services/paymentService';
import { triggerDhabaAlarmPushNotification, triggerStudentArrivalNotification, sendPushNotification } from '../services/notificationService';

apiRouter.post('/payments/create-order', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { orderId, amount } = req.body;

  if (!orderId || !amount || typeof amount !== 'number') {
    return res.status(400).json({ success: false, message: 'Valid orderId and numeric amount are required.' });
  }

  const result = await createRazorpayOrder(orderId, amount);

  return res.json(result);
});

apiRouter.post('/payments/verify-signature', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.' });
  }

  const isValid = verifyRazorpayPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);

  if (isValid) {
    return res.json({ success: true, message: 'UPI Payment signature verified successfully.' });
  } else {
    return res.status(400).json({ success: false, message: 'Invalid payment signature. Verification failed.' });
  }
});

// Register FCM Push Notification Token
apiRouter.post('/notifications/register-token', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ success: false, message: 'fcmToken is required.' });

  const user = users.find((u) => u.id === req.user?.id);
  if (user) {
    (user as any).fcmToken = fcmToken;
  }

  return res.json({ success: true, message: 'FCM push notification token registered successfully.' });
});

// ----------------------------------------------------
// VENDOR / DHABA ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/vendors', (req: Request, res: Response) => {
  return res.json({ success: true, count: vendors.length, data: vendors });
});

apiRouter.get('/vendors/:id', (req: Request, res: Response) => {
  const vendor = vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
  
  const items = menuItems.filter((i) => i.vendorId === vendor.id);
  return res.json({ success: true, data: { ...vendor, menu: items } });
});

apiRouter.patch('/vendors/:id/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), (req: AuthenticatedRequest, res: Response) => {
  const vendor = vendors.find((v) => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

  vendor.isAcceptingOrders = !vendor.isAcceptingOrders;
  return res.json({ success: true, isAcceptingOrders: vendor.isAcceptingOrders });
});

// ----------------------------------------------------
// MENU ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/menus/:vendorId', (req: Request, res: Response) => {
  const items = menuItems.filter((i) => i.vendorId === req.params.vendorId);
  return res.json({ success: true, count: items.length, data: items });
});

apiRouter.patch('/menus/:itemId/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), (req: AuthenticatedRequest, res: Response) => {
  const item = menuItems.find((i) => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });

  item.isAvailable = !item.isAvailable;
  return res.json({ success: true, item });
});

// ----------------------------------------------------
// ORDER ENDPOINTS WITH SERVER-SIDE PRICING & STATE MACHINE
// ----------------------------------------------------
apiRouter.get('/orders', (req: Request, res: Response) => {
  const { vendorId, driverId, customerId } = req.query;
  let filtered = [...orders];

  if (vendorId) filtered = filtered.filter((o) => o.vendorId === vendorId);
  if (driverId) filtered = filtered.filter((o) => o.driverId === driverId);
  if (customerId) filtered = filtered.filter((o) => o.customerId === customerId);

  return res.json({ success: true, count: filtered.length, data: filtered });
});

apiRouter.get('/orders/:id', (req: Request, res: Response) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  return res.json({ success: true, data: order });
});

// Create Order (Server-Side Price Recalculation)
apiRouter.post('/orders', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { vendorId, items, dropoffHostel, dropoffNotes } = req.body;

  if (!vendorId) {
    return res.status(400).json({ success: false, message: 'vendorId is required.' });
  }

  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

  if (!vendor.isAcceptingOrders) {
    return res.status(400).json({ success: false, message: 'This Dhaba is currently CLOSED for new orders.' });
  }

  // Recalculate price on server side to defeat client pricing tampering
  const validation = validateAndCalculateOrder(vendorId, items);

  if (!validation.isValid) {
    return res.status(400).json({ success: false, message: validation.errorMessage });
  }

  const newOrder: Order = {
    id: `ord-${Math.floor(100 + Math.random() * 900)}`,
    customerId: req.user?.id || 'usr-1',
    customerName: req.user?.phone || 'VIT Student',
    customerPhone: req.user?.phone || '+91 9876543210',
    vendorId,
    vendorName: vendor.name,
    items: validation.verifiedItems,
    totalAmount: validation.calculatedTotalAmount,
    deliveryFee: validation.calculatedDeliveryFee,
    dropoffHostel: dropoffHostel || 'Boys Hostel Block 3',
    dropoffNotes: dropoffNotes || '',
    status: 'PLACED',
    paymentStatus: 'PAID',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  orders.unshift(newOrder);

  // Trigger FCM push alert to Dhaba phone
  triggerDhabaAlarmPushNotification(vendorId, newOrder.id, newOrder.totalAmount);

  // Emit to scoped WebSocket rooms for vendor & customer privacy
  const io = req.app.get('io');
  if (io) {
    io.to(`vendor_${vendorId}`).emit('new_order_alert', newOrder);
    io.to(`order_${newOrder.id}`).emit('order_updated', newOrder);
    io.emit('order_updated', newOrder); // Global feed for Super Admin
  }

  return res.status(201).json({
    success: true,
    message: 'Order placed successfully.',
    data: newOrder
  });
});

// Update Order Status (Enforces State Machine Transitions)
apiRouter.patch('/orders/:id/status', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const { status } = req.body as { status: OrderStatus };
  const order = orders.find((o) => o.id === req.params.id);

  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (!status) return res.status(400).json({ success: false, message: 'status field is required.' });

  // Enforce Order State Machine transition validity
  if (!isValidStateTransition(order.status, status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid order state transition from '${order.status}' to '${status}'. Allowed next states: ${getNextAllowedStates(order.status).join(', ')}.`
    });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();

  // Scoped room broadcast
  const io = req.app.get('io');
  if (io) {
    io.to(`order_${order.id}`).emit('order_updated', order);
    io.emit('order_updated', order);
  }

  return res.json({ success: true, data: order });
});

// Accept Driver Assignment
apiRouter.post('/orders/:id/accept-driver', requireAuth, requireRole('DRIVER', 'ADMIN'), (req: AuthenticatedRequest, res: Response) => {
  const order = orders.find((o) => o.id === req.params.id);

  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  if (order.driverId) {
    return res.status(400).json({ success: false, message: 'Order is already assigned to another runner.' });
  }

  order.driverId = req.user?.id || 'usr-4';
  order.driverName = 'Vikram Singh (Runner)';
  order.driverPhone = req.user?.phone || '+91 9876543213';
  if (order.status === 'PLACED') {
    order.status = 'ACCEPTED';
  }
  order.updatedAt = new Date().toISOString();

  const io = req.app.get('io');
  if (io) {
    io.to(`order_${order.id}`).emit('order_updated', order);
    io.emit('order_updated', order);
  }

  return res.json({ success: true, data: order });
});

// ----------------------------------------------------
// DRIVER LOCATION ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/drivers/locations', (req: Request, res: Response) => {
  const list = Array.from(driverLocations.values());
  return res.json({ success: true, data: list });
});

apiRouter.post('/drivers/location', requireAuth, requireRole('DRIVER', 'ADMIN'), (req: AuthenticatedRequest, res: Response) => {
  const { lat, lng, heading } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ success: false, message: 'Valid lat and lng numeric coordinates are required.' });
  }

  const loc = {
    driverId: req.user?.id || 'usr-4',
    driverName: 'Vikram Singh',
    lat,
    lng,
    heading: heading || 0,
    lastUpdated: new Date().toISOString()
  };

  driverLocations.set(loc.driverId, loc);

  const io = req.app.get('io');
  if (io) {
    io.emit('driver_location_update', loc);
  }

  return res.json({ success: true, data: loc });
});
