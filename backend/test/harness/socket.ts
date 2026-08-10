import { io, Socket } from 'socket.io-client';

export const connectTestSocket = (baseUrl: string, options: Record<string, any> = {}): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...options,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Socket connection to ${baseUrl} timed out after 5000ms`));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

export const waitForSocketEvent = <T = any>(
  socket: Socket,
  eventName: string,
  timeoutMs: number = 5000
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName);
      reject(new Error(`Timeout waiting for socket event '${eventName}' after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once(eventName, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
};

export const disconnectTestSocket = (socket: Socket): void => {
  if (socket && socket.connected) {
    socket.disconnect();
  }
};
