// ============================================================
// FRONTEND-FACING WEBSOCKET BRIDGE
// ============================================================
// Browser clients connect here (not to Angel One directly).
// Each client's requested tokens are registered with the
// SubscriptionManager, which owns the single upstream Angel
// One connection. Ticks are fanned out only to clients that
// asked for that token.
//
// Phase 7: upgrades are authorised (allowed origin and/or WS_AUTH_TOKEN),
// messages are bounded and validated, and each client may hold at most
// WS_MAX_SUBSCRIPTIONS_PER_CLIENT tokens (ws-guard.ts).
// ============================================================

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';
import { SubscriptionManager, type SubscriptionTarget } from '../lib/subscription-manager.js';
import type { Tick } from '@fno/shared';
import { config } from '../lib/config.js';
import { WS_MAX_PAYLOAD_BYTES, admitSubscriptions, authorizeWsUpgrade, parseMaxSubscriptions, validTargets } from './ws-guard.js';

const MAX_SUBSCRIPTIONS_PER_CLIENT = parseMaxSubscriptions(process.env.WS_MAX_SUBSCRIPTIONS_PER_CLIENT);
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN?.trim() || null;

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  tokens: SubscriptionTarget[];
}

const HEALTH_INTERVAL_MS = 5000;

export function createMarketWebSocketServer(
  httpServer: Server,
  subscriptionManager: SubscriptionManager
): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    verifyClient: (info, done) => {
      const verdict = authorizeWsUpgrade({ origin: info.origin, url: info.req.url, allowedOrigins: config.cors.origins, token: WS_AUTH_TOKEN });
      if (verdict.ok) return done(true);
      logger.warn({ origin: info.origin, reason: verdict.reason }, 'WS upgrade refused');
      done(false, verdict.status, verdict.reason);
    },
  });
  const clients = new Map<string, WebSocket>();

  wss.on('connection', (socket) => {
    const clientId = randomUUID();
    clients.set(clientId, socket);
    const held = new Set<string>();
    logger.info({ clientId, total: clients.size }, 'WS client connected');

    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const targets = validTargets(msg?.tokens);
      if (targets.length === 0) return;

      if (msg.type === 'subscribe') {
        const { admitted, rejected } = admitSubscriptions(held, targets, MAX_SUBSCRIPTIONS_PER_CLIENT);
        if (rejected > 0) {
          logger.warn({ clientId, rejected, limit: MAX_SUBSCRIPTIONS_PER_CLIENT }, 'WS subscription limit reached');
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', data: { code: 'SUBSCRIPTION_LIMIT', limit: MAX_SUBSCRIPTIONS_PER_CLIENT, rejected } }));
        }
        if (admitted.length === 0) return;
        for (const t of admitted) held.add(`${t.exchangeSegment}:${t.token}`);
        subscriptionManager.subscribe(clientId, admitted as SubscriptionTarget[]).catch((err) =>
          logger.error({ error: err.message, clientId }, 'WS subscribe failed')
        );
      } else if (msg.type === 'unsubscribe') {
        for (const t of targets) held.delete(`${t.exchangeSegment}:${t.token}`);
        subscriptionManager.unsubscribe(clientId, targets as SubscriptionTarget[]);
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
      // Not every subscriber is a browser socket — server-side consumers
      // (the trade-setup monitor) subscribe tokens too. The old check
      // `socket?.readyState === socket?.OPEN` was `undefined === undefined`
      // (true) for those, and send() on no socket crashed the process.
      const socket = clients.get(clientId);
      if (socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'tick', data: clientTicks }));
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
