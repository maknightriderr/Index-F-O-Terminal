// ============================================================
// SUBSCRIPTION MANAGER
// ============================================================
// Single point of truth for what's subscribed on the ONE
// upstream Angel One WebSocket connection. Frontend clients
// (and future scanner/alert workers) register interest here;
// the manager ref-counts tokens so removing one client never
// drops a token another client still needs, and drives a
// single shared upstream connection instead of one per client.
// ============================================================

import { redis } from './redis.js';
import { logger } from './logger.js';
import { computeChangeOi } from './oi-baseline.js';
import type { MarketDataProvider, WebSocketConnection } from '../providers/interface.js';
import type { ExchangeSegment, SubscriptionMode, Tick } from '@fno/shared';

export interface SubscriptionTarget {
  token: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  exchangeSegment: ExchangeSegment;
}

type TickListener = (ticks: Tick[]) => void;

const UPSTREAM_MODE: SubscriptionMode = 'SNAP_QUOTE'; // richest mode; one mode shared for all tokens

export class SubscriptionManager {
  private provider: MarketDataProvider;
  private ws: WebSocketConnection | null = null;
  private connecting: Promise<void> | null = null;

  // key: `${exchangeSegment}:${token}` -> set of clientIds that want it
  private refCounts = new Map<string, Set<string>>();
  // clientId -> keys it holds (for fast teardown on disconnect)
  private clientKeys = new Map<string, Set<string>>();

  private latestQuotes = new Map<string, Tick>(); // key -> latest tick
  private tickListeners: TickListener[] = [];

  private reconnectCount = 0;
  private errorCount = 0;
  private lastTickAt = 0;

  constructor(provider: MarketDataProvider) {
    this.provider = provider;
  }

  async connect(): Promise<void> {
    if (this.ws?.isConnected()) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      this.ws = this.provider.createWebSocketConnection();

      this.ws.onTick((ticks) => this.handleTicks(ticks));
      this.ws.onError((err) => {
        this.errorCount++;
        logger.error({ error: err.message }, 'Subscription manager: upstream WS error');
      });
      this.ws.onDisconnect((code, reason) => {
        logger.warn({ code, reason }, 'Subscription manager: upstream WS disconnected');
      });
      this.ws.onReconnect(() => {
        this.reconnectCount++;
        logger.info('Subscription manager: upstream WS reconnected');
      });

      await this.ws.connect();

      // Re-subscribe everything currently required (e.g. after auth refresh replaced the connection)
      const keys = Array.from(this.refCounts.keys());
      if (keys.length > 0) this.upstreamSubscribe(keys);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  disconnect(): void {
    this.ws?.disconnect();
    this.ws = null;
  }

  onTick(listener: TickListener): void {
    this.tickListeners.push(listener);
  }

  /** Register a client's interest in a set of tokens. Connects upstream lazily. */
  async subscribe(clientId: string, targets: SubscriptionTarget[]): Promise<void> {
    if (targets.length === 0) return;
    if (!this.ws?.isConnected()) await this.connect();

    const held = this.clientKeys.get(clientId) || new Set<string>();
    const newlyNeeded: string[] = [];

    for (const t of targets) {
      const key = this.keyFor(t);
      held.add(key);

      let subscribers = this.refCounts.get(key);
      if (!subscribers) {
        subscribers = new Set();
        this.refCounts.set(key, subscribers);
        newlyNeeded.push(key);
      }
      subscribers.add(clientId);
    }

    this.clientKeys.set(clientId, held);

    if (newlyNeeded.length > 0) this.upstreamSubscribe(newlyNeeded);
  }

  /** Remove a client's interest in a set of tokens (or all, if omitted). */
  unsubscribe(clientId: string, targets?: SubscriptionTarget[]): void {
    const held = this.clientKeys.get(clientId);
    if (!held) return;

    const keysToCheck = targets ? targets.map((t) => this.keyFor(t)) : Array.from(held);
    const noLongerNeeded: string[] = [];

    for (const key of keysToCheck) {
      const subscribers = this.refCounts.get(key);
      if (!subscribers) continue;
      subscribers.delete(clientId);
      held.delete(key);
      if (subscribers.size === 0) {
        this.refCounts.delete(key);
        noLongerNeeded.push(key);
      }
    }

    if (held.size === 0) this.clientKeys.delete(clientId);
    else this.clientKeys.set(clientId, held);

    if (noLongerNeeded.length > 0) this.upstreamUnsubscribe(noLongerNeeded);
  }

  /** Full teardown for a disconnected client. */
  removeClient(clientId: string): void {
    this.unsubscribe(clientId);
  }

  getStatus() {
    return {
      connected: this.ws?.isConnected() ?? false,
      subscriptionCount: this.refCounts.size,
      clientCount: this.clientKeys.size,
      reconnectCount: this.reconnectCount,
      errorCount: this.errorCount,
      lastTickAt: this.lastTickAt || undefined,
    };
  }

  getLatestQuote(exchangeSegment: ExchangeSegment, token: string): Tick | undefined {
    return this.latestQuotes.get(`${exchangeSegment}:${token}`);
  }

  /** Which clients currently want updates for this token (across any exchange segment). */
  getSubscriberIdsForToken(token: string): Set<string> {
    const ids = new Set<string>();
    for (const [key, subscribers] of this.refCounts.entries()) {
      if (key.endsWith(`:${token}`)) {
        subscribers.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }

  // --- Internal ---

  private keyFor(t: SubscriptionTarget): string {
    return `${t.exchangeSegment}:${t.token}`;
  }

  private upstreamSubscribe(keys: string[]): void {
    if (!this.ws) return;
    const tokens = keys.map((k) => {
      const [exchangeSegment, token] = k.split(':') as [ExchangeSegment, string];
      return { token, exchangeSegment, mode: UPSTREAM_MODE };
    });
    this.ws.subscribe(tokens);
  }

  private upstreamUnsubscribe(keys: string[]): void {
    if (!this.ws) return;
    const tokens = keys.map((k) => {
      const [exchangeSegment, token] = k.split(':') as [ExchangeSegment, string];
      return { token, exchangeSegment };
    });
    this.ws.unsubscribe(tokens);
  }

  private async handleTicks(ticks: Tick[]): Promise<void> {
    this.lastTickAt = Date.now();

    await Promise.all(
      ticks
        .filter((t) => t.oi !== undefined)
        .map((t) =>
          computeChangeOi(t.token, t.oi!)
            .then((changeOi) => {
              t.changeOi = changeOi;
            })
            .catch((err) =>
              logger.error({ error: err.message, token: t.token }, 'OI baseline update failed')
            )
        )
    );

    for (const tick of ticks) {
      // We don't know the exchangeSegment purely from a tick (only exchange),
      // so cache under every key that matches this token — cheap given low cardinality per token.
      for (const key of this.refCounts.keys()) {
        if (key.endsWith(`:${tick.token}`)) {
          this.latestQuotes.set(key, tick);
        }
      }

      redis
        .set(`quote:${tick.exchange}:${tick.token}`, JSON.stringify(tick), 'EX', 60)
        .catch((err: Error) => logger.error({ error: err.message }, 'Redis quote cache write failed'));
    }

    this.tickListeners.forEach((l) => l(ticks));
  }
}
