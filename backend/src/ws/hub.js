import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import log from '../utils/logger.js';
import { setClientOnline, setClientOffline, decrClientActiveJobs } from '../db/redis.js';
import { handleClientMessage } from './handlers.js';

const clients = new Map();

export function startWebSocketServer(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    const clientId = uuidv4();
    const client = { id: clientId, ws, userId: null, authenticated: false };
    clients.set(clientId, client);

    log.info(`WS client connected: ${clientId}`);

    const authTimeout = setTimeout(() => {
      if (!client.authenticated) {
        ws.close(4001, 'Auth timeout');
      }
    }, 10000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'AUTH') {
        try {
          const payload = jwt.verify(msg.token, config.jwtSecret);
          client.userId = payload.userId;
          client.authenticated = true;
          clearTimeout(authTimeout);
          await setClientOnline(clientId, client.userId);
          send(ws, { type: 'AUTH_OK', clientId });
          log.info(`WS client authenticated: ${clientId} user=${client.userId}`);
        } catch {
          ws.close(4003, 'Invalid token');
        }
        return;
      }

      if (!client.authenticated) return;

      try {
        await handleClientMessage(client, msg);
      } catch (err) {
        log.error(`WS handler error: ${err.message}`);
      }
    });

    ws.on('close', async () => {
      clearTimeout(authTimeout);
      await setClientOffline(clientId);
      clients.delete(clientId);
      log.info(`WS client disconnected: ${clientId}`);
    });

    ws.on('error', (err) => {
      log.error(`WS error for ${clientId}: ${err.message}`);
    });
  });

  log.info(`WebSocket server ready`);
  return wss;
}

export function send(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

export function sendToClient(clientId, msg) {
  const client = clients.get(clientId);
  if (client) send(client.ws, msg);
}

export function sendToUser(userId, msg) {
  for (const client of clients.values()) {
    if (client.userId === userId && client.authenticated) {
      send(client.ws, msg);
    }
  }
}

export function broadcastToAsinWatchers(asin, watcherUserIds, msg) {
  const userSet = new Set(watcherUserIds);
  for (const client of clients.values()) {
    if (client.authenticated && userSet.has(client.userId)) {
      send(client.ws, msg);
    }
  }
}

export function getAuthenticatedClients() {
  const result = [];
  for (const client of clients.values()) {
    if (client.authenticated) {
      result.push({ clientId: client.id, userId: client.userId });
    }
  }
  return result;
}

export function getClientById(clientId) {
  return clients.get(clientId) || null;
}

export function getClientCount() {
  let count = 0;
  for (const c of clients.values()) {
    if (c.authenticated) count++;
  }
  return count;
}
