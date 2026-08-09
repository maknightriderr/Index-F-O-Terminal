// ============================================================
// FRONTEND-FACING WEBSOCKET BRIDGE
// ============================================================
// Browser clients connect here (not to Angel One directly).
// Each client's requested tokens are registered with the
// SubscriptionManager, which owns the single upstream Angel
// One connection. Ticks are fanned out only to clients that
// asked for that token.
// ============================================================

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';
import { SubscriptionManager, type SubscriptionTarget } from '../lib/subscription-manager.js';
import type { Tick } from '@fno/shared';

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  tokens: SubscriptionTarget[];
}

const HEALTH_INTERVAL_MS = 5000;

export function createMarketWebSocketServer(
  httpServer: Server,
  subscriptionManager: SubscriptionManager
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Map<string, WebSocket>();

  wss.on('connection', (socket) => {
    const clientId = randomUUID();
    clients.set(clientId, socket);
    logger.info({ clientId, total: clients.size }, 'WS client connected');

    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg.tokens?.length) return;

      if (msg.type === 'subscribe') {
        subscriptionManager.subscribe(clientId, msg.tokens).catch((err) =>
          logger.error({ error: err.message, clientId }, 'WS subscribe failed')
        );
      } else if (msg.type === 'unsubscribe') {
        subscriptionManager.unsubscribe(clientId, msg.tokens);
      }
    });

    socket.on('close', () => {
      subscriptionManager.removeClient(clientId);
      clients.delete(clientId);
      logger.info({ clientId, total: clients.size }, 'WS client disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ error: err.message, clientId }, 'WS client error');
    });
  });

  subscriptionManager.onTick((ticks: Tick[]) => {
    // Group ticks per subscriber so each client gets one message per batch.
    const perClient = new Map<string, Tick[]>();

    for (const tick of ticks) {
      const subscriberIds = subscriptionManager.getSubscriberIdsForToken(tick.token);
      for (const id of subscriberIds) {
        if (!perClient.has(id)) perClient.set(id, []);
        perClient.get(id)!.push(tick);
      }
    }

    for (const [clientId, clientTicks] of perClient.entries()) {
      const socket = clients.get(clientId);
      if (socket?.readyState === socket?.OPEN) {
        socket!.send(JSON.stringify({ type: 'tick', data: clientTicks }));
      }
    }
  });

  // Periodic health broadcast so the frontend can show live WS/data-freshness status.
  setInterval(() => {
    const status = subscriptionManager.getStatus();
    const payload = JSON.stringify({ type: 'health', data: status });
    for (const socket of clients.values()) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }, HEALTH_INTERVAL_MS);

  return wss;
}
