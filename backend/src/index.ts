import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';
import { verifyToken } from './middleware/auth';
import { prisma } from './db';

dotenv.config();

if (process.env.NODE_ENV === 'production') {
  const requiredProductionConfig = ['JWT_SECRET', 'ADMIN_PASSCODE', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
  const missingConfig = requiredProductionConfig.filter((key) => !process.env[key]);
  if (missingConfig.length > 0) throw new Error(`Missing required production configuration: ${missingConfig.join(', ')}`);
}

// Global Process Crash Protection
process.on('uncaughtException', (err) => {
  console.error('🔥 [Fatal Error Guarded] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Unhandled Promise Rejection Guarded]:', reason);
});

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL, 'http://localhost:3000', 'http://localhost:5173']
  .filter((origin): origin is string => Boolean(origin));
const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
};

const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 5000;

app.use(cors(corsOptions));
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

// Pass socket.io instance to Express app for route handlers
app.set('io', io);

// Mount API routes
app.use('/api', apiRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'Kraveo Campus Delivery Backend Engine',
    timestamp: new Date().toISOString(),
  });
});

// 404 Non-Existent Route Guard
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found.`
  });
});

// Global Express Error Handler (Handles JSON Syntax Errors & Bad Payloads)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && (err.status === 400 || err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or malformed JSON payload.'
    });
  }
  return res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

io.use((socket, next) => {
  try {
    const rawToken = socket.handshake.auth?.token;
    if (typeof rawToken !== 'string' || !rawToken.trim()) return next(new Error('Authentication required.'));
    socket.data.user = verifyToken(rawToken.replace(/^Bearer\s+/i, ''));
    return next();
  } catch {
    return next(new Error('Invalid or expired authentication token.'));
  }
});

// Socket.io Real-time Event Subscriptions
io.on('connection', (socket) => {
  console.log(`⚡ Kraveo Socket Client Connected: ${socket.id}`);
  if (socket.data.user?.role === 'ADMIN') socket.join('admins');

  socket.on('join_room', async (room: string) => {
    const user = socket.data.user;
    let isAllowed = false;
    if (room === 'admins') isAllowed = user?.role === 'ADMIN';
    if (typeof room === 'string' && room.startsWith('order_') && user) {
      const order = await prisma.order.findUnique({ where: { id: room.slice('order_'.length) }, select: { customerId: true, driverId: true, vendor: { select: { userId: true } } } });
      isAllowed = Boolean(order && (user.role === 'ADMIN' || order.customerId === user.id || order.driverId === user.id || order.vendor.userId === user.id));
    }
    if (typeof room === 'string' && room.startsWith('vendor_') && user?.role === 'VENDOR') {
      const vendor = await prisma.vendor.findFirst({ where: { id: room.slice('vendor_'.length), userId: user.id }, select: { id: true } });
      isAllowed = Boolean(vendor);
    }
    if (isAllowed) {
      socket.join(room);
      console.log(`📌 Socket ${socket.id} joined room: ${room}`);
    }
  });

  socket.on('update_driver_location', (data) => {
    if (socket.data.user?.role === 'DRIVER' && data && typeof data === 'object') {
      io.to('admins').emit('driver_location_update', { ...data, driverId: socket.data.user.id });
    }
  });

  socket.on('order_status_change', (data) => {
    if (socket.data.user?.role === 'ADMIN' && data && typeof data === 'object') {
      io.to('admins').emit('order_updated', data);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Kraveo Socket Client Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Kraveo Backend Engine running on http://localhost:${PORT}`);
  console.log(`📡 WebSockets listening for real-time driver tracking & order alerts`);
});
