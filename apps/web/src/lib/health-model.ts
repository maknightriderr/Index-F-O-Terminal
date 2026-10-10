// ============================================================
// SYSTEM HEALTH MODEL — truthful statuses from the evidence we have
// ============================================================
// The System Health page used to show:
//   * services that were never built as red "Down"
//   * Redis "Down — Start with: docker-compose up -d" and the database "Down",
//     the Angel One provider "Not authenticated", when the real fact was only
//     "the browser could not reach the API"
//   * the WebSocket "Healthy" because a socket was open, with no sign ticks arrive
//   * tokens "DATA_FRESH" whose last tick was nine hours old
//
// This turns the /api/health response (plus what the browser itself knows) into
// rows with one of a small set of distinct statuses, each with its evidence. It
// invents nothing: where the response lacks the evidence, the status is
// UNAVAILABLE and the detail says why.
// ============================================================

import { formatAge, formatIstDateTime } from './format';
import { classifyFreshness, FRESH_WITHIN_MS, type Freshness } from './freshness';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'STALE' | 'DISCONNECTED' | 'UNAVAILABLE' | 'NOT_IMPLEMENTED' | 'API_UNREACHABLE' | 'MARKET_CLOSED';

/** The /api/health `data` object — only the fields this reads, all optional. */
export interface HealthResponse {
  status?: string;
  uptime?: number;
  timestamp?: number;
  version?: string;
  services?: {
    provider?: { name?: string; authenticated?: boolean };
    redis?: { status?: string; latencyMs?: number; error?: string };
    database?: { status?: string; latencyMs?: number; error?: string };
    websocket?: { status?: string; connected?: boolean; subscriptionCount?: number; lastTickAt?: number; reconnectCount?: number; errorCount?: number };
  };
  feed?: {
    tokens?: number;
    upstreamDown?: boolean;
    perToken?: Array<{ token: string; exchange: string; state?: string; lastTickTime: number | null; asOf?: number | null; source?: string; lastGapOutcome?: { outcome?: string; detail?: string } | null }>;
  };
  supervisor?: {
    services?: Array<{ name: string; critical: boolean; state: string; lastSuccessAt: number | null; lastFailureAt: number | null; lastError: string | null; note: string | null }>;
    degradedCritical?: string[];
  };
  sessions?: Array<{ exchange: string; open: boolean }>;
  orderFlow?: { status?: string; dataPlan?: string; lastPacketAt?: number | null; lastError?: string | null; deltaMode?: string; deltaModeReason?: string; failedConnections?: number };
}

export interface HealthRow {
  id: string;
  name: string;
  status: HealthStatus;
  /** One line of evidence for the status. */
  detail: string;
  /** When the evidence was observed (epoch ms), when known. */
  observedAt?: number | null;
  /** A critical service degrades the overall status; a non-critical one (e.g. the optional order-flow feed) does not. */
  critical?: boolean;
}

export interface FeedRow {
  token: string;
  exchange: string;
  status: HealthStatus;
  freshness: Freshness;
  lastTickAt: number | null;
  detail: string;
}

export interface HealthModel {
  overall: HealthStatus;
  headline: string;
  apiReachable: boolean;
  rows: HealthRow[];
  planned: HealthRow[];
  feed: FeedRow[];
  sessions: Array<{ exchange: string; open: boolean }>;
}

export interface HealthInputs {
  /** The latest /api/health data, or null when the request failed. */
  data: HealthResponse | null;
  /** The browser's own error when it could not reach the API. */
  apiError: string | null;
  now: number;
  /** The browser's own socket to the terminal server (independent evidence). */
  browserSocket: { connected: boolean; lastTickAt?: number | null };
}

/** Services the page used to list that do not exist; shown as planned, never as "Down". */
export const PLANNED_SERVICES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'analytics-worker', name: 'Analytics Worker' },
  { id: 'strategy-worker', name: 'Strategy Worker' },
  { id: 'alert-worker', name: 'Alert Worker' },
  { id: 'ai-service', name: 'AI Service' },
];

const ORDER: HealthStatus[] = ['HEALTHY', 'MARKET_CLOSED', 'NOT_IMPLEMENTED', 'UNAVAILABLE', 'STALE', 'DEGRADED', 'DISCONNECTED', 'API_UNREACHABLE'];
const severity = (s: HealthStatus) => ORDER.indexOf(s);

const FRESH_TO_STATUS: Record<Freshness, HealthStatus> = { FRESH: 'HEALTHY', STALE: 'STALE', DISCONNECTED: 'DISCONNECTED', UNAVAILABLE: 'UNAVAILABLE', MARKET_CLOSED: 'MARKET_CLOSED' };

const sessionOf = (sessions: Array<{ exchange: string; open: boolean }>, exchange: string): boolean | null => {
  const s = sessions.find((x) => x.exchange === exchange);
  return s ? s.open : null;
};

export function buildHealthModel(i: HealthInputs): HealthModel {
  const planned: HealthRow[] = PLANNED_SERVICES.map((p) => ({ id: p.id, name: p.name, status: 'NOT_IMPLEMENTED', detail: 'Planned; not built yet. Not a failure.' }));
  const frontend: HealthRow = { id: 'frontend', name: 'Frontend', status: 'HEALTHY', detail: 'This page is running in your browser.' };

  if (!i.data) {
    const why = `The browser could not reach the API${i.apiError ? ` (${i.apiError})` : ''}.`;
    const unknown = (id: string, name: string): HealthRow => ({ id, name, status: 'UNAVAILABLE', detail: 'Cannot be checked while the API is unreachable. This is not evidence that it is down.' });
    return {
      overall: 'API_UNREACHABLE',
      headline: why,
      apiReachable: false,
      rows: [
        frontend,
        { id: 'api', name: 'API Server', status: 'API_UNREACHABLE', detail: why },
        {
          id: 'browser-socket',
          name: 'Browser socket',
          status: i.browserSocket.connected ? 'DEGRADED' : 'DISCONNECTED',
          detail: i.browserSocket.connected ? 'The socket is open, but with no server health nothing confirms ticks are arriving.' : 'The browser socket to the terminal server is not connected.',
        },
        unknown('redis', 'Redis'),
        unknown('database', 'Database'),
        unknown('provider', 'Angel One provider'),
        unknown('order-flow', 'Dhan order-flow feed'),
      ],
      planned,
      feed: [],
      sessions: [],
    };
  }

  const d = i.data;
  const sessions = d.sessions ?? [];
  const anyOpen = sessions.some((s) => s.open);
  const rows: HealthRow[] = [frontend];

  rows.push({ id: 'api', name: 'API Server', status: 'HEALTHY', detail: `Responding${typeof d.uptime === 'number' ? `, up ${Math.round(d.uptime)} s` : ''}${d.version ? `, v${d.version}` : ''}.`, observedAt: d.timestamp ?? i.now });

  const store = (id: string, name: string, s?: { status?: string; latencyMs?: number; error?: string }): HealthRow =>
    !s
      ? { id, name, status: 'UNAVAILABLE', detail: 'The health response did not include this service.' }
      : s.status === 'HEALTHY'
        ? { id, name, status: 'HEALTHY', detail: `Responding${typeof s.latencyMs === 'number' ? ` in ${s.latencyMs} ms` : ''}.` }
        : { id, name, status: 'DISCONNECTED', detail: s.error ? `The API cannot reach it: ${s.error}` : 'The API cannot reach it.' };
  rows.push(store('redis', 'Redis', d.services?.redis));
  rows.push(store('database', 'Database', d.services?.database));

  const prov = d.services?.provider;
  rows.push(
    !prov
      ? { id: 'provider', name: 'Angel One provider', status: 'UNAVAILABLE', detail: 'The health response did not include the provider.' }
      : prov.authenticated
        ? { id: 'provider', name: `${prov.name ?? 'Angel One'} provider`, status: 'HEALTHY', detail: 'Authenticated.' }
        : { id: 'provider', name: `${prov.name ?? 'Angel One'} provider`, status: 'DISCONNECTED', detail: 'Not authenticated; quotes and chains cannot be fetched.' }
  );

  // Market-data tick feed: evidence = a recent tick WHILE a session is open.
  const ws = d.services?.websocket;
  if (!ws) {
    rows.push({ id: 'tick-feed', name: 'Market-data tick feed', status: 'UNAVAILABLE', detail: 'The health response did not include the feed.' });
  } else {
    const f = classifyFreshness({ observedAt: ws.lastTickAt ?? null, now: i.now, sessionOpen: sessions.length ? anyOpen : null, transportConnected: !!ws.connected, freshWithinMs: FRESH_WITHIN_MS.quote });
    const status: HealthStatus = f.state === 'FRESH' ? 'HEALTHY' : f.state === 'MARKET_CLOSED' ? 'MARKET_CLOSED' : f.state === 'STALE' ? 'STALE' : f.state === 'DISCONNECTED' ? 'DISCONNECTED' : ws.connected ? 'DEGRADED' : 'UNAVAILABLE';
    const sockets = `${ws.connected ? 'Connected' : 'Not connected'} to the broker feed, ${ws.subscriptionCount ?? 0} subscriptions.`;
    rows.push({
      id: 'tick-feed',
      name: 'Market-data tick feed',
      status,
      detail: `${sockets} ${ws.lastTickAt ? `Last tick ${formatIstDateTime(ws.lastTickAt, i.now)} (${formatAge(i.now - ws.lastTickAt)}).` : 'No tick has been received since the server started.'}${d.feed?.upstreamDown ? ' Upstream feed is down.' : ''}`,
      observedAt: ws.lastTickAt ?? null,
    });
  }

  rows.push({
    id: 'browser-socket',
    name: 'Browser socket',
    status: i.browserSocket.connected ? 'HEALTHY' : 'DISCONNECTED',
    detail: i.browserSocket.connected ? 'This browser is connected to the terminal server.' : 'This browser is not connected to the terminal server; prices come from polling.',
    observedAt: i.browserSocket.lastTickAt ?? null,
  });

  // Dhan order flow
  const of = d.orderFlow;
  if (!of) {
    rows.push({ id: 'order-flow', name: 'Dhan order-flow feed', status: 'UNAVAILABLE', detail: 'The health response did not include the order-flow feed.' });
  } else {
    const map: Record<string, { status: HealthStatus; detail: string }> = {
      CONNECTED: { status: 'HEALTHY', detail: 'Connected.' },
      DISCONNECTED: { status: anyOpen ? 'DISCONNECTED' : 'MARKET_CLOSED', detail: anyOpen ? 'Not connected while a session is open.' : 'Not connected; it connects only during a session.' },
      DATA_PLAN_INACTIVE: { status: 'UNAVAILABLE', detail: 'The Dhan Data API plan is not active; order flow is unavailable until it is.' },
      NOT_CONFIGURED: { status: 'UNAVAILABLE', detail: 'Dhan credentials are not configured; order flow is unavailable.' },
    };
    const m = map[of.status ?? ''] ?? { status: 'UNAVAILABLE' as HealthStatus, detail: `Unrecognised status ${of.status ?? 'unknown'}.` };
    rows.push({
      id: 'order-flow',
      name: 'Dhan order-flow feed',
      status: m.status,
      detail: `${m.detail}${of.lastError ? ` Last error: ${of.lastError}` : ''}${of.lastPacketAt ? ` Last packet ${formatIstDateTime(of.lastPacketAt, i.now)}.` : ''}`,
      observedAt: of.lastPacketAt ?? null,
    });
  }

  // Supervised internal services, each with its own state.
  for (const s of d.supervisor?.services ?? []) {
    const status: HealthStatus = s.state === 'RUNNING' ? 'HEALTHY' : s.state === 'STARTING' ? 'DEGRADED' : s.state === 'STOPPED' ? (s.critical ? 'DEGRADED' : 'MARKET_CLOSED') : 'DEGRADED';
    rows.push({
      id: `svc-${s.name}`,
      name: s.name,
      critical: s.critical,
      status,
      detail: `${s.state}${s.critical ? ' (critical)' : ''}${s.lastError ? `: ${s.lastError}` : s.note ? `: ${s.note}` : ''}${s.lastSuccessAt ? `. Last success ${formatIstDateTime(s.lastSuccessAt, i.now)}.` : ''}`,
      observedAt: s.lastSuccessAt,
    });
  }

  // Per-token feed rows, re-derived from the tick time and the token's own exchange session.
  const feed: FeedRow[] = (d.feed?.perToken ?? []).map((t) => {
    const lastTickAt = t.lastTickTime ?? t.asOf ?? null;
    const f = classifyFreshness({ observedAt: lastTickAt, now: i.now, sessionOpen: sessionOf(sessions, t.exchange), transportConnected: ws?.connected ?? null, freshWithinMs: FRESH_WITHIN_MS.quote });
    return { token: t.token, exchange: t.exchange, status: FRESH_TO_STATUS[f.state], freshness: f.state, lastTickAt, detail: f.detail };
  });

  const critical = rows.filter((r) => ['redis', 'database', 'provider', 'tick-feed'].includes(r.id) || r.critical === true);
  const worst = critical.reduce<HealthStatus>((w, r) => (severity(r.status) > severity(w) ? r.status : w), 'HEALTHY');
  const overall: HealthStatus = worst === 'MARKET_CLOSED' || worst === 'NOT_IMPLEMENTED' ? 'HEALTHY' : worst === 'UNAVAILABLE' ? 'DEGRADED' : worst;
  const bad = critical.filter((r) => severity(r.status) >= severity('STALE'));
  const headline =
    overall === 'HEALTHY'
      ? anyOpen
        ? 'All checked services are healthy.'
        : 'All checked services are healthy. Markets are closed, so feeds are idle, not failing.'
      : `${bad.map((r) => r.name).join(', ') || 'Some services'} ${bad.length === 1 ? 'needs' : 'need'} attention.`;

  return { overall, headline, apiReachable: true, rows, planned, feed, sessions };
}

/** Display label for a status ("MARKET_CLOSED" → "MARKET CLOSED"). */
export const statusLabel = (s: HealthStatus): string => s.replace(/_/g, ' ');
