import express, { Express } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import supertest from 'supertest';
import { apiRouter } from '../../src/routes/api';
import { attachRealtime } from '../../src/realtime';
import { securityHeaders } from '../../src/middleware/securityHeaders';
import { globalErrorHandler } from '../../src/middleware/errorHandler';

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
  app.set('trust proxy', 1); // same as src/index.ts (nginx is one hop)
  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    },
  });

  app.use(securityHeaders);
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

  // The real Socket.io setup (token auth, room checks, per-viewer events), same as production.
  attachRealtime(io);

  // 404 Non-Existent Route Guard
  app.use((req: express.Request, res: express.Response) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.method} ${req.originalUrl} not found.`
    });
  });

  // Same handler as src/index.ts.
  app.use(globalErrorHandler);

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
