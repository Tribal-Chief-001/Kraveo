import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';

dotenv.config();

// Global Process Crash Protection
process.on('uncaughtException', (err) => {
  console.error('🔥 [Fatal Error Guarded] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Unhandled Promise Rejection Guarded]:', reason);
});

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  },
});

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

// Socket.io Real-time Event Subscriptions
io.on('connection', (socket) => {
  console.log(`⚡ Kraveo Socket Client Connected: ${socket.id}`);

  socket.on('join_room', (room: string) => {
    socket.join(room);
    console.log(`📌 Socket ${socket.id} joined room: ${room}`);
  });

  socket.on('update_driver_location', (data) => {
    io.emit('driver_location_update', data);
  });

  socket.on('order_status_change', (data) => {
    io.emit('order_updated', data);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Kraveo Socket Client Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Kraveo Backend Engine running on http://localhost:${PORT}`);
  console.log(`📡 WebSockets listening for real-time driver tracking & order alerts`);
});
