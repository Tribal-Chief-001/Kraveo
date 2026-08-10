import express, { Express } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import supertest from 'supertest';
import { apiRouter } from '../../src/routes/api';

export interface TestServerInstance {
  app: Express;
  server: http.Server;
  io: SocketIOServer;
  port: number;
  baseUrl: string;
}

export const createTestApp = (): { app: Express; server: http.Server; io: SocketIOServer } => {
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    },
  });

  app.use(cors());
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
      service: 'Kraveo Campus Delivery Backend Engine (Test Harness)',
      timestamp: new Date().toISOString(),
    });
  });

  // Socket.io Real-time Event Subscriptions
  io.on('connection', (socket) => {
    socket.on('join_room', (room: string) => {
      if (room && typeof room === 'string') {
        socket.join(room);
      }
    });

    socket.on('update_driver_location', (data) => {
      if (data && typeof data === 'object') {
        io.emit('driver_location_update', data);
      }
    });

    socket.on('order_status_change', (data) => {
      if (data && typeof data === 'object') {
        io.emit('order_updated', data);
      }
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

  return { app, server, io };
};

export const startTestServer = async (port: number = 0): Promise<TestServerInstance> => {
  const { app, server, io } = createTestApp();

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const baseUrl = `http://localhost:${actualPort}`;
      resolve({ app, server, io, port: actualPort, baseUrl });
    });
  });
};

export const stopTestServer = async (instance: TestServerInstance): Promise<void> => {
  return new Promise((resolve) => {
    instance.io.close();
    instance.server.close(() => {
      resolve();
    });
  });
};

export const getTestClient = (app: Express) => {
  return supertest(app);
};
