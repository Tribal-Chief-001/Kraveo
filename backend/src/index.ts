import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';
import { attachRealtime } from './realtime';
import { startOrderMaintenance } from './services/orderMaintenance';
import { globalErrorHandler } from './middleware/errorHandler';
import { assertRuntimeConfig } from './config/runtimeConfig';
import { initPushProvider, getPushProvider } from './services/push/provider';

dotenv.config();

// Anything that is not the test runner must have its secrets; GOOGLE_WEB_CLIENT_ID is only a warning.
if (process.env.NODE_ENV !== 'test') {
  for (const warning of assertRuntimeConfig(process.env).warnings) console.warn(`⚠️  ${warning}`);
}

// Push (FCM): reads FIREBASE_KEY_PATH / FIREBASE_SERVICE_ACCOUNT now so a missing key shows ONE warning at boot; never fails the boot.
if (process.env.NODE_ENV !== 'test') {
  try {
    if (initPushProvider()) {
      console.log('push notifications are ON (FCM): checking the credentials with FCM...');
      // A dry-run send (nothing is delivered) proves FCM accepts the key and project; a revoked or wrong key is visible at boot, not at the first order.
      getPushProvider().verify?.()
        .then((r) => (r.ok ? console.log('push credentials verified with FCM') : console.error(`push credentials NOT accepted by FCM (${r.code ?? 'error'}): check FIREBASE_KEY_PATH and the Firebase project`)))
        .catch(() => console.error('push credential check could not run (network?)'));
    }
  } catch { console.warn('push notifications are OFF: could not start the push provider.'); }
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
// Production runs behind exactly one proxy (nginx), which sets X-Forwarded-For: req.ip is the real client address.
app.set('trust proxy', 1);
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
    return callback(Object.assign(new Error('Origin is not allowed by CORS.'), { status: 403, code: 'CORS_NOT_ALLOWED' }));
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

// Global Express Error Handler (body-parser errors keep their status; nothing internal reaches the client).
app.use(globalErrorHandler);

// Socket.io: token auth, server-checked rooms, per-viewer order events (src/realtime.ts).
attachRealtime(io);

// Order housekeeping every 60 s: expire unpaid orders, auto-cancel unaccepted paid orders, retry refunds.
if (process.env.NODE_ENV !== 'test') startOrderMaintenance();

server.listen(PORT, () => {
  console.log(`🚀 Kraveo Backend Engine running on http://localhost:${PORT}`);
  console.log(`📡 WebSockets listening for real-time driver tracking & order alerts`);
});
