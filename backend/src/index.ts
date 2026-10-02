import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';
import { attachRealtime } from './realtime';
import { startOrderMaintenance } from './services/orderMaintenance';

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

const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  // The deployed Super Admin portal uses this Vercel origin when the optional
  // CLIENT_URL/ADMIN_URL environment variables are not present on EC2.
  'https://kraveo.vercel.app',
  'https://admin.kraveo.site',
  'http://localhost:3000',
  'http://localhost:5173',
]
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

// Socket.io: token auth, server-checked rooms, per-viewer order events (src/realtime.ts).
attachRealtime(io);

// Order housekeeping every 60 s: expire unpaid orders, auto-cancel unaccepted paid orders, retry refunds.
if (process.env.NODE_ENV !== 'test') startOrderMaintenance();

if (process.env.NODE_ENV === 'production' && !process.env.GOOGLE_WEB_CLIENT_ID) {
  console.warn('⚠️  GOOGLE_WEB_CLIENT_ID is not set: student Google sign-in will answer 503 until it is configured.');
}

server.listen(PORT, () => {
  console.log(`🚀 Kraveo Backend Engine running on http://localhost:${PORT}`);
  console.log(`📡 WebSockets listening for real-time driver tracking & order alerts`);
});
