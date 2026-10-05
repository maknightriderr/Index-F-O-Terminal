// ============================================================
// SUBSCRIPTION MANAGER
// ============================================================
// Single point of truth for what's subscribed on the ONE
// upstream Angel One WebSocket connection. Frontend clients
// (and future scanner/alert workers) register interest here;
// the manager ref-counts tokens so removing one client never
// drops a token another client still needs, and drives a
// single shared upstream connection instead of one per client.
//
// Phase 5: every subscribed token's data state (feed-freshness.ts) —
// duplicate / out-of-order ticks are dropped by exchange timestamp, partial
// batches flagged, a dropped socket puts in-session tokens in DATA_GAP, and a
// reconnect (or the new connection after an auth refresh) re-subscribes every
// token, sets RECOVERING and hands the gaps to the gap checkers.
// ============================================================

import { redis } from './redis.js';
import { logger } from './logger.js';
import { computeChangeOi } from './oi-baseline.js';
import { FeedTracker, type FeedState, type TokenFeedView } from './feed-freshness.js';
import type { MarketDataProvider, WebSocketConnection } from '../providers/interface.js';
import type { ExchangeSegment, SubscriptionMode, Tick } from '@fno/shared';

export interface SubscriptionTarget {
  token: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  exchangeSegment: ExchangeSegment;
}

type TickListener = (ticks: Tick[]) => void;
/** A gap to check after the feed came back: [from, to] for one token. */
export interface FeedGap {
  key: string;
  token: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  from: number;
  to: number;
}
type RecoveryListener = (gaps: FeedGap[]) => void;

/** How often the time-driven freshness transitions run. */
const FRESHNESS_EVALUATE_MS = 15_000;

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

  readonly feed = new FeedTracker('angel-one:ws');
  private recoveryListeners: RecoveryListener[] = [];
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(provider: MarketDataProvider) {
    this.provider = provider;
  }

  /** Called with the gaps to check whenever the feed comes back. */
  onRecovering(listener: RecoveryListener): void {
    this.recoveryListeners.push(listener);
  }

  /** The state of a token on the feed (null when nobody subscribes to it). */
  feedStateOfToken(token: string): FeedState | null {
    return this.feed.stateOfToken(token);
  }

  /** Every token's data state (asOf / source / status as in Phase 2 dataQuality). */
  getFeedStates(now = Date.now()): TokenFeedView[] {
    return this.feed.view(now);
  }

  /** A gap checker finished: the token is fresh again with its outcome on record. */
  markRecovered(key: string, outcome: string, detail: string): void {
    this.feed.markRecovered(key, outcome, detail, Date.now());
  }

  private emitRecovering(gaps: FeedGap[]): void {
    if (gaps.length === 0) return;
    logger.info({ tokens: gaps.length }, 'Subscription manager: feed back — tokens RECOVERING until their gap is checked');
    if (this.recoveryListeners.length === 0) {
      // Nothing checks gaps: say so rather than leave the tokens RECOVERING forever.
      for (const g of gaps) this.feed.markRecovered(g.key, 'NOT_CHECKED', 'No gap checker is registered.', Date.now());
      return;
    }
    for (const l of this.recoveryListeners) {
      try {
        l(gaps);
      } catch (err: any) {
        logger.error({ error: err.message }, 'Subscription manager: recovery listener threw');
      }
    }
  }

  private startFreshnessTimer(): void {
    if (this.freshnessTimer) return;
    this.freshnessTimer = setInterval(() => this.feed.evaluate(Date.now()), FRESHNESS_EVALUATE_MS);
    this.freshnessTimer.unref?.();
  }

  async connect(): Promise<void> {
    if (this.ws?.isConnected()) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      this.ws = this.provider.createWebSocketConnection();

      const ws = this.ws;
      this.ws.onTick((ticks, meta) => this.handleTicks(ticks, meta));
      this.ws.onError((err) => {
        this.errorCount++;
        logger.error({ error: err.message }, 'Subscription manager: upstream WS error');
      });
      this.ws.onDisconnect((code, reason) => {
        logger.warn({ code, reason }, 'Subscription manager: upstream WS disconnected');
        // Only the live connection's drop is a gap (a replaced one closing is not).
        if (this.ws === ws) this.feed.markUpstreamDown(Date.now());
      });
      this.ws.onReconnect(() => {
        this.reconnectCount++;
        logger.info('Subscription manager: upstream WS reconnected');
        // Re-subscribe every token still wanted, then check what was missed.
        const keys = Array.from(this.refCounts.keys());
        if (keys.length > 0) this.upstreamSubscribe(keys);
        this.emitRecovering(this.feed.markRecovering(Date.now()) as FeedGap[]);
      });
      this.startFreshnessTimer();

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
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
  }

  /**
   * After an auth refresh: a new upstream connection with the new tokens,
   * every wanted token re-subscribed, and every token RECOVERING until the
   * switchover window is checked.
   */
  async refreshConnection(): Promise<void> {
    const old = this.ws;
    this.ws = null;
    old?.disconnect();
    await this.connect();
    this.emitRecovering(this.feed.markRecovering(Date.now(), true) as FeedGap[]);
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
      this.feed.track(key, t.token, t.exchange);

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
        this.feed.untrack(key);
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
      feed: this.feed.summary(Date.now()),
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

  /**
   * Pure-ish filter (no IO): drops duplicate and out-of-order ticks per token
   * by exchange timestamp (then sequence) and refreshes each token's state.
   */
  filterTicks(ticks: Tick[], now: number): Tick[] {
    const out: Tick[] = [];
    for (const tick of ticks) {
      let accepted = false;
      let tracked = false;
      for (const key of this.refCounts.keys()) {
        if (!key.endsWith(`:${tick.token}`)) continue;
        tracked = true;
        if (this.feed.acceptTick(key, tick, now).accept) accepted = true;
      }
      if (accepted || !tracked) out.push(tick);
    }
    return out;
  }

  private async handleTicks(raw: Tick[], meta?: { partial: boolean }): Promise<void> {
    const now = Date.now();
    this.lastTickAt = now;
    if (meta?.partial) {
      this.feed.flagPartialBatch(now);
      logger.warn({ ticks: raw.length }, 'Subscription manager: partial tick batch (truncated / unknown packet) — complete ticks kept, the rest flagged');
    }
    const ticks = this.filterTicks(raw, now);
    if (ticks.length === 0) return;

    await Promise.all(
      ticks
        .filter((t) => t.oi !== undefined)
        .map((t) =>
          computeChangeOi(t.token, t.oi!, t.exchange)
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

    // handleTicks runs un-awaited off the upstream socket, so a throw here
    // is an unhandled rejection — which terminates the Node process. One
    // listener's bug must not take the whole server down with it.
    for (const listener of this.tickListeners) {
      try {
        listener(ticks);
      } catch (err: any) {
        logger.error({ error: err.message }, 'Subscription manager: tick listener threw — skipped');
      }
    }
  }
}
