'use client';

// ============================================================
// MARKET WEBSOCKET CLIENT
// ============================================================
// Connects to the server's frontend-facing WS bridge (not
// Angel One directly — the server's SubscriptionManager owns
// that connection). One shared client per tab; components
// subscribe/unsubscribe to just the tokens they're showing.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { useSystemHealthStore } from '@/stores';
import type { Tick, Exchange, ExchangeSegment } from '@fno/shared';

const WS_URL = (process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000') + '/ws';

export interface WsSubscriptionTarget {
  token: string;
  exchange: Exchange;
  exchangeSegment: ExchangeSegment;
}

interface WsHealthMessage {
  connected: boolean;
  subscriptionCount: number;
  clientCount: number;
  reconnectCount: number;
  errorCount: number;
  lastTickAt?: number;
}

type TickHandler = (ticks: Tick[]) => void;
type HealthHandler = (health: WsHealthMessage) => void;

class MarketWebSocketClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickHandlers = new Set<TickHandler>();
  private healthHandlers = new Set<HealthHandler>();
  private activeSubscriptions = new Map<string, WsSubscriptionTarget>();

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const socket = new WebSocket(WS_URL);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.activeSubscriptions.size > 0) {
        this.send('subscribe', Array.from(this.activeSubscriptions.values()));
      }
      this.healthHandlers.forEach((h) => h({ connected: true, subscriptionCount: 0, clientCount: 0, reconnectCount: this.reconnectAttempts, errorCount: 0 }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'tick') this.tickHandlers.forEach((h) => h(msg.data));
        else if (msg.type === 'health') this.healthHandlers.forEach((h) => h(msg.data));
      } catch {
        // Ignore malformed frames
      }
    };

    socket.onclose = () => {
      this.healthHandlers.forEach((h) => h({ connected: false, subscriptionCount: 0, clientCount: 0, reconnectCount: this.reconnectAttempts, errorCount: 0 }));
      this.scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  subscribe(targets: WsSubscriptionTarget[]): void {
    const fresh = targets.filter((t) => !this.activeSubscriptions.has(this.keyFor(t)));
    targets.forEach((t) => this.activeSubscriptions.set(this.keyFor(t), t));
    if (fresh.length > 0) this.send('subscribe', fresh);
  }

  unsubscribe(targets: WsSubscriptionTarget[]): void {
    targets.forEach((t) => this.activeSubscriptions.delete(this.keyFor(t)));
    this.send('unsubscribe', targets);
  }

  onTick(handler: TickHandler): () => void {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }

  onHealth(handler: HealthHandler): () => void {
    this.healthHandlers.add(handler);
    return () => this.healthHandlers.delete(handler);
  }

  private send(type: 'subscribe' | 'unsubscribe', tokens: WsSubscriptionTarget[]): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, tokens }));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private keyFor(t: WsSubscriptionTarget): string {
    return `${t.exchangeSegment}:${t.token}`;
  }
}

let client: MarketWebSocketClient | null = null;
function getClient(): MarketWebSocketClient {
  if (!client) client = new MarketWebSocketClient();
  return client;
}

/** Connects once and keeps System Health's WS/data-freshness state live. Mount at the app shell level. */
export function useMarketWebSocket(): void {
  const updateHealth = useSystemHealthStore((s) => s.updateHealth);

  useEffect(() => {
    const c = getClient();
    c.connect();

    return c.onHealth((health) => {
      updateHealth({
        websocket: {
          status: health.connected ? 'HEALTHY' : 'DOWN',
          connected: health.connected,
          lastTick: health.lastTickAt,
          reconnectCount: health.reconnectCount,
          errorCount: health.errorCount,
          subscriptionCount: health.subscriptionCount,
          queueSize: 0,
        },
        dataFreshness: health.connected
          ? { status: 'LIVE', lastUpdate: health.lastTickAt || Date.now(), missingDataPercent: 0 }
          : { status: 'DISCONNECTED', lastUpdate: health.lastTickAt || 0, missingDataPercent: 0 },
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
  }, []);
}

/** Subscribes to live ticks for a set of tokens for the component's lifetime. */
export function useMarketTicks(targets: WsSubscriptionTarget[]): Record<string, Tick> {
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetsKey = targets.map((t) => `${t.exchangeSegment}:${t.token}`).sort().join(',');

  useEffect(() => {
    const c = getClient();
    c.connect();

    const unsubTick = c.onTick((newTicks) => {
      setTicks((prev) => {
        const next = { ...prev };
        for (const t of newTicks) next[t.token] = t;
        return next;
      });
    });

    if (targetsRef.current.length > 0) c.subscribe(targetsRef.current);

    return () => {
      unsubTick();
      if (targetsRef.current.length > 0) c.unsubscribe(targetsRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);

  return ticks;
}
