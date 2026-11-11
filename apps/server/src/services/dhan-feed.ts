// ============================================================
// DHAN FEED — market data only, for Order Flow (2026-10-09)
// ============================================================
// Dhan WebSocket (FULL packets) → this adapter → normalized FlowTrades
// (order-flow-store.ts) → footprints → OF1 (shadow). Angel One stays the
// system's data provider for everything else; no Dhan order API is called.
//
// The index itself does not trade, so its order flow is read from the
// nearest-expiry index future (resolved daily from Dhan's public instrument
// master). Each FULL packet carries the cumulative day volume, the last
// price and the best bid / ask, NOT the aggressor side of the trades: the
// volume added since the previous packet is one trade at the last price, its
// side INFERRED from the quote that prevailed before it (quote rule, then
// tick rule). Delta mode is therefore INFERRED — never EXACT.
//
// Connects only during the NSE / MCX sessions (with a few minutes either side)
// and only when DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are set; otherwise its
// status is NOT_CONFIGURED and every order-flow measure stays UNAVAILABLE.
//
// 2026-10-09: Dhan accepts the socket and drops it at once when the account's
// Data API plan is not active (profile dataPlan "Deactive") — and the old
// 10-second reconnect loop then drew HTTP 429 (Dhan warns repeated requests can
// block the user). Now: the plan is checked once a day (GET /v2/profile) and
// no connection is attempted while it is inactive; failures back off
// exponentially to RECONNECT_MAX_MS (RATE_LIMIT_BACKOFF_MS after a 429), and
// the backoff resets only once real data has arrived.
// ============================================================

import axios from 'axios';
import WebSocket from 'ws';
import { inferTradeSide, type TradeSide } from '@fno/analytics';
import { isMarketOpen } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { serviceHeartbeat } from '../lib/service-supervisor.js';
import { DHAN_RESPONSE, DHAN_SEGMENT_CODE, DHAN_MAX_INSTRUMENTS_PER_CONNECTION, dhanFeedUrl, fullSubscriptions, parseDhanFrame, resolveFlowContracts, type DhanFullPacket, type ResolvedFlowContract } from '../lib/dhan-feed-packets.js';
import { ORDER_BLOCK_MODE, ORDER_BLOCK_MODE_REJECTED, OF1_TRADING_REQUESTED, ORDER_FLOW_SUPPORTED, ORDER_FLOW_SYMBOLS, ORDER_FLOW_SYMBOLS_REJECTED, DHAN_FLOW_V2, DHAN_FLOW_V2_SYMBOLS, DHAN_FLOW_STOCKS, DHAN_ENGINE_SHADOW } from '../config/order-flow-flags.js';
import { dhanConfigured, dhanSession, dhanSessionStatus, ensureDhanSession, markDhanTokenRejected } from './dhan-session.js';
import { flowClosedFiveCount, checkpointOpenFlowBars, OPEN_BAR_CHECKPOINT_MS, closeFlowBars, flowClosedBarCount, flowContractBars, hydrateFlowSymbols, recordFlowTrade, recordFlowUnreconciled, registerFlowSymbol, setFlowFeedConnected } from './order-flow-store.js';
import { dhanShadowBusy, evaluateDhanShadow, dhanShadowFiveBusy, evaluateDhanShadowFive } from './dhan-engine-shadow.js';

export const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const TICK_MS = 10_000;
const SESSION_MARGIN_MS = 5 * 60_000;
export const DHAN_PROFILE_URL = 'https://api.dhan.co/v2/profile';
export const RECONNECT_MIN_MS = 30_000;
export const RECONNECT_MAX_MS = 15 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
/** After Dhan rejects the token (401/403): it will not start working by itself, so ask again only every 30 minutes. */
export const PROFILE_AUTH_BACKOFF_MS = 30 * 60_000;
/** After any other failed profile check (network, 5xx). */
export const PROFILE_RETRY_MS = 5 * 60_000;
/** v2: no packet at all for this long while connected in session -> reconnect (Dhan itself drops a client silent > 40 s). */
export const FEED_SILENCE_MS = 60_000;
/** v2: an instrument with no packet for this long in its open session reads STALE. */
export const INSTRUMENT_STALE_MS = 120_000;
/** v2: the per-instrument data-quality summary is logged this often in session. */
export const QUALITY_LOG_MS = 15 * 60_000;

/**
 * Pure: how long to wait before the next profile check after one failed (2026-10-16). It used to be retried on the
 * very next 10-second tick: an expired token drew a 401 every 10 s (38 in 16 minutes), the repeated-request pattern
 * Dhan warns can block the account.
 */
export function profileRetryDelay(status: number | null | undefined): number {
  if (status === 401 || status === 403) return PROFILE_AUTH_BACKOFF_MS;
  if (status === 429) return RATE_LIMIT_BACKOFF_MS;
  return PROFILE_RETRY_MS;
}

/** Pure: the next reconnect delay — doubles after a failed connection (no data), resets after real data; a 429 waits RATE_LIMIT_BACKOFF_MS. */
export function nextReconnectDelay(prevMs: number, outcome: 'GOT_DATA' | 'NO_DATA' | 'RATE_LIMITED'): number {
  if (outcome === 'GOT_DATA') return RECONNECT_MIN_MS;
  if (outcome === 'RATE_LIMITED') return RATE_LIMIT_BACKOFF_MS;
  return Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, prevMs * 2));
}

/** Pure: whether a Dhan profile says the Data API (market feed) plan is active. */
export function dataPlanActive(profile: { dataPlan?: unknown } | null | undefined): boolean | null {
  const v = typeof profile?.dataPlan === 'string' ? profile.dataPlan.trim().toLowerCase() : null;
  return v == null ? null : v === 'active';
}

interface InstrumentState {
  symbol: string;
  prevVolume: number | null;
  prevLtp: number | null;
  prevSide: TradeSide | null;
  prevQuote: { bid: number | null; ask: number | null } | null;
}

/** v2 per-instrument data quality since the process started (reset daily with the instrument map). */
export interface InstrumentQuality { packets: number; lastPacketAt: number | null; tradedQty: number; unreconciledQty: number; ltqInvalid: number }

let checkpointAt = 0, checkpointBusy = false;
const state = {
  /** flowClosedBarCount() at the last Dhan shadow pass. */
  shadowSeenClosed: -1,
  shadowSeenClosedFive: -1,
  configured: false,
  connected: false,
  ws: null as WebSocket | null,
  /** Keyed `${segmentCode}:${securityId}` (ids are only unique within a segment). */
  instruments: new Map<string, InstrumentState>(),
  quality: new Map<string, InstrumentQuality>(),
  qualityLoggedAt: 0,
  /** When the current connection opened (the silence watchdog never fires before packets could arrive). */
  connectedAt: 0,
  resolved: {} as Record<string, ResolvedFlowContract>,
  resolvedOn: null as string | null,
  packets: 0,
  trades: 0,
  lastPacketAt: null as number | null,
  lastError: null as string | null,
  reconnectAt: 0,
  backoffMs: RECONNECT_MIN_MS,
  /** Packets received on the current connection (decides the backoff when it closes). */
  packetsThisConnection: 0,
  rateLimited: false,
  failedConnections: 0,
  dataPlan: 'UNKNOWN' as 'ACTIVE' | 'INACTIVE' | 'UNKNOWN',
  dataPlanCheckedOn: null as string | null,
  dataPlanCheckedAt: 0,
  /** No profile check before this instant (set after a failed one). */
  profileRetryAt: 0,
  /** Dhan answered 401/403 to the last profile check: no connection is attempted until a check succeeds. */
  tokenRejected: false,
  /** The token the open socket was opened with: a refreshed token reconnects it. */
  wsToken: null as string | null,
  /** The token the last failed profile check used: a new one is checked right away. */
  rejectedToken: null as string | null,
};

/**
 * Pure: what a FULL packet reveals for an instrument, and its next state. The first packet only sets the baseline;
 * volume that went DOWN (a feed reset) re-bases without a trade.
 *
 * v2 reconciliation (master prompt 4.1): the cumulative volume may rise by more than the packet's last-trade quantity
 * when several trades happened between packets. Only the last trade is observed (LTQ at LTP, side inferred from the
 * quote that prevailed before it); the rest is UNRECONCILED volume, never given a price level or a side. LTQ is an
 * int16 on the wire: a zero / negative value (overflow or missing) makes the whole rise unreconciled.
 */
export function tradeFromFullPacket(
  s: InstrumentState,
  p: Pick<DhanFullPacket, 'ltp' | 'volume' | 'depth'> & { ltq?: number },
  at: number
): { trade: { time: number; price: number; qty: number; side: TradeSide | null } | null; unreconciled: number; ltqInvalid: boolean; next: InstrumentState } {
  const best = p.depth[0];
  const quote = best ? { bid: best.bidPrice > 0 ? best.bidPrice : null, ask: best.askPrice > 0 ? best.askPrice : null } : null;
  let trade = null, unreconciled = 0, ltqInvalid = false;
  let side = s.prevSide;
  if (s.prevVolume != null && p.volume > s.prevVolume && p.ltp > 0) {
    const rise = p.volume - s.prevVolume;
    // A packet without an LTQ field (older callers / tests) keeps the pre-v2 meaning: the whole rise is one trade.
    const ltq = p.ltq === undefined ? rise : p.ltq;
    ltqInvalid = !(Number.isSafeInteger(ltq) && ltq > 0);
    const observed = ltqInvalid ? 0 : Math.min(rise, ltq);
    unreconciled = rise - observed;
    if (observed > 0) {
      side = inferTradeSide(p.ltp, s.prevQuote, s.prevLtp, s.prevSide);
      trade = { time: at, price: p.ltp, qty: observed, side };
    }
  }
  return { trade, unreconciled, ltqInvalid, next: { ...s, prevVolume: p.volume, prevLtp: p.ltp > 0 ? p.ltp : s.prevLtp, prevSide: side, prevQuote: quote } };
}

/** Pure: an instrument's data status now (VERIFIED is never claimed for inferred flow: it is ESTIMATED at best). */
export function instrumentStatus(q: InstrumentQuality | undefined, now: number, sessionOpen: boolean): 'ESTIMATED' | 'STALE' | 'UNAVAILABLE' {
  if (!q || q.lastPacketAt == null) return 'UNAVAILABLE';
  return sessionOpen && now - q.lastPacketAt > INSTRUMENT_STALE_MS ? 'STALE' : 'ESTIMATED';
}

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const openNear = (ex: 'NSE' | 'MCX' | 'BSE', now: number) => isMarketOpen(ex, now) || isMarketOpen(ex, now + SESSION_MARGIN_MS) || isMarketOpen(ex, now - SESSION_MARGIN_MS);
/** NSE or MCX in session (± a few minutes): the feed's connection window. */
const inSessionWindow = (now: number) => openNear('NSE', now) || openNear('MCX', now);

async function resolveInstruments(now: number): Promise<void> {
  if (state.resolvedOn === istDate(now) && Object.keys(state.resolved).length) return;
  const res = await axios.get<string>(DHAN_SCRIP_MASTER_URL, { responseType: 'text', timeout: 60_000 });
  const wants = [
    ...ORDER_FLOW_SYMBOLS.map((symbol) => ({ symbol, exchange: ORDER_FLOW_SUPPORTED[symbol] })),
    ...(DHAN_FLOW_V2 ? Object.entries(DHAN_FLOW_V2_SYMBOLS).map(([symbol, exchange]) => ({ symbol, exchange })) : []),
  ];
  const resolved = resolveFlowContracts(res.data, wants, now, { allStocks: DHAN_FLOW_STOCKS });
  // Within one connection's limit (Dhan v2: 5,000); the legacy symbols first, then the rest in master order.
  const legacy = new Set<string>(ORDER_FLOW_SYMBOLS);
  const ordered = Object.entries(resolved).sort(([a], [b]) => Number(!legacy.has(a)) - Number(!legacy.has(b))).slice(0, DHAN_MAX_INSTRUMENTS_PER_CONNECTION);
  state.resolved = Object.fromEntries(ordered);
  state.resolvedOn = istDate(now);
  state.instruments.clear();
  state.quality.clear();
  for (const [symbol, r] of Object.entries(state.resolved)) {
    state.instruments.set(`${DHAN_SEGMENT_CODE[r.segment]}:${r.securityId}`, { symbol, prevVolume: null, prevLtp: null, prevSide: null, prevQuote: null });
    registerFlowSymbol(symbol, { exchange: r.exchange, instrument: r.tradingSymbol, source: 'DHAN', mode: 'INFERRED', startedAt: now, kind: r.kind, tickSize: r.tickSize });
  }
  const kinds = Object.values(state.resolved).reduce<Record<string, number>>((n, r) => ({ ...n, [r.kind]: (n[r.kind] ?? 0) + 1 }), {});
  logger.info({ total: ordered.length, kinds, legacy: Object.fromEntries(Object.entries(state.resolved).filter(([k]) => legacy.has(k))), v2: DHAN_FLOW_V2, stocks: DHAN_FLOW_STOCKS }, 'Dhan feed: futures resolved for order flow');
  // Engine v2 (8 Nov): rebuild today's and the previous session's closed bars from the recorded events (background).
  const started = Date.now();
  void hydrateFlowSymbols(now).then(
    (r) => r.schemaReady
      ? logger.info({ event: 'orderFlowHydration', ...r, seconds: Math.round((Date.now() - started) / 1000) }, 'Order flow: closed bars rebuilt from recorded trade events after start')
      : logger.warn({ event: 'orderFlowHydration', ...r }, 'Order flow: restart hydration skipped (order_flow_events schema not confirmed)'),
    (err: any) => logger.warn({ error: err.message }, 'Order flow: restart hydration failed'),
  );
}

/** The per-instrument data-quality summary (status counts, reconciled share, the weakest instruments). */
export function dhanFeedQuality(now: number = Date.now()) {
  const rows = Object.entries(state.resolved).map(([symbol, r]) => {
    const q = state.quality.get(`${DHAN_SEGMENT_CODE[r.segment]}:${r.securityId}`);
    const total = (q?.tradedQty ?? 0) + (q?.unreconciledQty ?? 0);
    return { symbol, exchange: r.exchange, kind: r.kind, status: instrumentStatus(q, now, isMarketOpen(r.exchange, now)), packets: q?.packets ?? 0, reconciledShare: total > 0 ? Math.round(((q?.tradedQty ?? 0) / total) * 1000) / 1000 : null, ltqInvalid: q?.ltqInvalid ?? 0 };
  });
  const status = rows.reduce<Record<string, number>>((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {});
  const traded = [...state.quality.values()].reduce((n, q) => n + q.tradedQty, 0), unrec = [...state.quality.values()].reduce((n, q) => n + q.unreconciledQty, 0);
  return {
    instruments: rows.length,
    status,
    reconciledShare: traded + unrec > 0 ? Math.round((traded / (traded + unrec)) * 1000) / 1000 : null,
    ltqInvalid: rows.reduce((n, r) => n + r.ltqInvalid, 0),
    weakest: rows.filter((r) => r.reconciledShare != null).sort((a, b) => a.reconciledShare! - b.reconciledShare!).slice(0, 10),
    stale: rows.filter((r) => r.status === 'STALE').slice(0, 20).map((r) => r.symbol),
  };
}

function onFrame(data: WebSocket.RawData): void {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  for (const p of parseDhanFrame(buf)) {
    state.packets++;
    state.packetsThisConnection++;
    state.lastPacketAt = Date.now();
    if (p.kind === 'DISCONNECT') {
      state.lastError = `Dhan disconnect code ${p.reason}`;
      logger.warn({ reason: p.reason }, 'Dhan feed: server disconnect');
      continue;
    }
    if (p.kind !== 'FULL' || p.header.code !== DHAN_RESPONSE.FULL) continue;
    const ikey = `${p.header.segment}:${p.header.securityId}`;
    const s = state.instruments.get(ikey);
    if (!s) continue;
    const at = Date.now(), { trade, unreconciled, ltqInvalid, next } = tradeFromFullPacket(s, p, at);
    state.instruments.set(ikey, next);
    const q = state.quality.get(ikey) ?? { packets: 0, lastPacketAt: null, tradedQty: 0, unreconciledQty: 0, ltqInvalid: 0 };
    q.packets++;
    q.lastPacketAt = at;
    if (ltqInvalid) q.ltqInvalid++;
    state.quality.set(ikey, q);
    if (trade) {
      state.trades++;
      q.tradedQty += trade.qty;
      recordFlowTrade(s.symbol, trade);
    }
    if (unreconciled > 0) {
      q.unreconciledQty += unreconciled;
      recordFlowUnreconciled(s.symbol, at, unreconciled);
    }
  }
  serviceHeartbeat('orderFlowFeed');
}

function connect(creds: { clientId: string; accessToken: string }): void {
  const ws = new WebSocket(dhanFeedUrl(creds.clientId, creds.accessToken));
  state.ws = ws;
  state.wsToken = creds.accessToken;
  state.packetsThisConnection = 0;
  state.rateLimited = false;
  ws.on('open', () => {
    state.connected = true;
    state.connectedAt = Date.now();
    setFlowFeedConnected(true);
    const ids = Object.values(state.resolved).map((r) => ({ securityId: r.securityId, segment: r.segment }));
    // Dhan v2: at most 100 instruments per subscription message.
    const messages = fullSubscriptions(ids);
    for (const m of messages) ws.send(m);
    logger.info({ instruments: ids.length, messages: messages.length }, 'Dhan feed: connected and subscribed (FULL packets, data only)');
  });
  ws.on('message', onFrame);
  ws.on('error', (err) => {
    // The URL carries the token: log the message only, never the request.
    state.lastError = err.message;
    if (/\b429\b/.test(err.message)) state.rateLimited = true;
    logger.warn({ error: err.message }, 'Dhan feed: socket error');
  });
  ws.on('close', (code) => {
    state.connected = false;
    setFlowFeedConnected(false);
    state.ws = null;
    const outcome = state.rateLimited ? 'RATE_LIMITED' : state.packetsThisConnection > 0 ? 'GOT_DATA' : 'NO_DATA';
    state.failedConnections = outcome === 'GOT_DATA' ? 0 : state.failedConnections + 1;
    state.backoffMs = nextReconnectDelay(state.backoffMs, outcome);
    state.reconnectAt = Date.now() + state.backoffMs;
    if (outcome !== 'GOT_DATA') {
      state.lastError = outcome === 'RATE_LIMITED' ? 'Dhan rate-limited the connection (HTTP 429) — waiting before retrying' : `Dhan closed the connection (code ${code}) before any data — check the Data API plan`;
      // A failed connection may mean the plan lapsed: re-check it before the next attempt.
      state.dataPlanCheckedOn = null;
    }
    logger.warn({ code, outcome, retryInSeconds: Math.round(state.backoffMs / 1000), failedConnections: state.failedConnections }, 'Dhan feed: closed');
  });
}

async function tick(): Promise<void> {
  if (!dhanConfigured()) return;
  const now = Date.now();
  // Kept alive around the clock: a renewal must happen before the token expires, in session or not.
  await ensureDhanSession(now);
  if (!inSessionWindow(now)) {
    if (state.ws) state.ws.close();
    return;
  }
  const creds = dhanSession();
  if (creds && state.tokenRejected && creds.accessToken !== state.rejectedToken) {
    // A new token (TOTP login or a pasted one): check it now instead of waiting out the back-off.
    state.tokenRejected = false;
    state.profileRetryAt = 0;
  }
  if (state.ws && creds && state.wsToken !== creds.accessToken) state.ws.close(); // reconnects with the new token
  if (!creds) {
    state.tokenRejected = true;
    state.lastError = dhanSessionStatus().lastError ?? 'No valid Dhan access token';
    if (state.ws) state.ws.close();
    await closeFlowBars(now, false, 'TOKEN_REJECTED').catch((err: any) => logger.warn({ error: err.message }, 'Order flow: bar close failed'));
    return;
  }
  try {
    await resolveInstruments(now);
  } catch (err: any) {
    state.lastError = `instrument master: ${err.message}`;
    logger.warn({ error: err.message }, 'Dhan feed: instrument master unavailable — order flow UNAVAILABLE');
  }
  // Data API plan: checked once a day (and after a failed connection). No connection while inactive.
  // Re-checked every 30 minutes while inactive, so activating the plan takes effect the same day.
  const due = state.dataPlanCheckedOn !== istDate(now) || (state.dataPlan === 'INACTIVE' && now - state.dataPlanCheckedAt >= 30 * 60_000);
  if (due && now >= state.profileRetryAt) {
    try {
      const res = await axios.get(DHAN_PROFILE_URL, { headers: { 'access-token': creds.accessToken, Accept: 'application/json' }, timeout: 15_000 });
      const active = dataPlanActive(res.data);
      state.dataPlan = active === true ? 'ACTIVE' : active === false ? 'INACTIVE' : 'UNKNOWN';
      state.dataPlanCheckedOn = istDate(now);
      state.dataPlanCheckedAt = now;
      state.tokenRejected = false;
      state.profileRetryAt = 0;
      if (state.dataPlan === 'INACTIVE') {
        state.lastError = 'Dhan Data API plan is not active (profile dataPlan: Deactive) — the market feed needs the Data API subscription in Dhan';
        logger.warn('Dhan feed: Data API plan not active — no connection attempted today (order flow stays UNAVAILABLE)');
      }
    } catch (err: any) {
      const status: number | null = typeof err?.response?.status === 'number' ? err.response.status : null;
      const waitMs = profileRetryDelay(status);
      state.profileRetryAt = now + waitMs;
      state.tokenRejected = status === 401 || status === 403;
      if (state.tokenRejected) {
        state.rejectedToken = creds.accessToken;
        markDhanTokenRejected(creds.accessToken);
      }
      state.lastError = state.tokenRejected
        ? `Dhan rejected the access token (HTTP ${status}): refresh DHAN_ACCESS_TOKEN. Next check in ${Math.round(waitMs / 60_000)} minutes.`
        : `Dhan profile check failed: ${err.message}. Next check in ${Math.round(waitMs / 60_000)} minutes.`;
      logger.warn({ error: err.message, status, retryInMinutes: Math.round(waitMs / 60_000) }, 'Dhan feed: profile check failed');
      if (status === 429) state.reconnectAt = now + RATE_LIMIT_BACKOFF_MS;
    }
  }
  if (state.dataPlan === 'INACTIVE' || state.tokenRejected) {
    await closeFlowBars(now, false, state.tokenRejected ? 'TOKEN_REJECTED' : 'DATA_PLAN_INACTIVE').catch((err: any) => logger.warn({ error: err.message }, 'Order flow: bar close failed'));
    return;
  }
  // v2 silence watchdog: connected, a market open, yet no packet at all for FEED_SILENCE_MS -> reconnect.
  const anyOpen = isMarketOpen('NSE', now) || isMarketOpen('BSE', now) || isMarketOpen('MCX', now);
  const heardAt = Math.max(state.lastPacketAt ?? 0, state.connectedAt);
  if (state.ws && state.connected && anyOpen && heardAt > 0 && now - heardAt > FEED_SILENCE_MS) {
    logger.warn({ silentSeconds: Math.round((now - heardAt) / 1000) }, 'Dhan feed: no packets while connected in session; reconnecting');
    state.ws.close();
  }
  if (anyOpen && now - state.qualityLoggedAt >= QUALITY_LOG_MS && Object.keys(state.resolved).length) {
    state.qualityLoggedAt = now;
    logger.info({ event: 'dhanFeedQuality', ...dhanFeedQuality(now) }, 'Dhan feed: data quality (flow sides are ESTIMATED, never exchange-verified)');
  }
  if (!state.ws && now >= state.reconnectAt && Object.keys(state.resolved).length) connect(creds);
  await closeFlowBars(now, state.connected).catch((err: any) => { logger.warn({ error: err.message }, 'Order flow: bar close failed'); return 0; });
  // F-08: once a minute, save each contract's open bar so a restart inside the bar does not lose it (background).
  if (anyOpen && !checkpointBusy && now - checkpointAt >= OPEN_BAR_CHECKPOINT_MS) {
    checkpointAt = now; checkpointBusy = true;
    void checkpointOpenFlowBars(now).finally(() => { checkpointBusy = false; });
  }
  // 9 Nov: footprintsFor() (fresh-start readers) also closes bars, so this tick's own count was often 0 and the shadow
  // pass skipped that bar. Evaluate whenever any bar closed since the last pass, whoever closed it.
  const closed = flowClosedBarCount();
  if (closed !== state.shadowSeenClosed && DHAN_ENGINE_SHADOW && !dhanShadowBusy()) {
    state.shadowSeenClosed = closed;
    void evaluateDhanShadow(now, dhanInstrumentHealth).catch((err: any) => logger.warn({ error: err.message }, 'Dhan engine shadow: pass failed'));
  }
  // 11 Nov: the 5-minute order-flow shadow (index and commodity futures; recorded only, never traded).
  const closedFive = flowClosedFiveCount();
  if (closedFive !== state.shadowSeenClosedFive && DHAN_ENGINE_SHADOW && !dhanShadowFiveBusy()) {
    state.shadowSeenClosedFive = closedFive;
    void evaluateDhanShadowFive(now, dhanInstrumentHealth).catch((err: any) => logger.warn({ error: err.message }, 'Dhan engine 5-minute shadow: pass failed'));
  }
}

/** Engine v2 setups: is the contract's feed live, and is the flow series the contract the feed resolved? */
export function dhanInstrumentHealth(symbol: string, now: number): { stale: boolean; mappingValid: boolean } {
  const r = state.resolved[symbol];
  if (!r) return { stale: true, mappingValid: false };
  const q = state.quality.get(`${DHAN_SEGMENT_CODE[r.segment]}:${r.securityId}`);
  return { stale: instrumentStatus(q, now, isMarketOpen(r.exchange, now)) !== 'ESTIMATED', mappingValid: flowContractBars(symbol)?.instrument === r.tradingSymbol };
}

let started = false;
export function startOrderFlowFeed(): void {
  if (started) return;
  started = true;
  if (ORDER_BLOCK_MODE_REJECTED) logger.warn({ asked: ORDER_BLOCK_MODE_REJECTED, using: ORDER_BLOCK_MODE }, 'ORDER_BLOCK_MODE: PAPER, SHADOW or OFF only — OB-2.0 never enters the indicator vote by a setting');
  if (OF1_TRADING_REQUESTED) logger.warn('OF1_TRADING=true ignored: OF1_ENABLED is false');
  if (ORDER_FLOW_SYMBOLS_REJECTED.length) logger.warn({ rejected: ORDER_FLOW_SYMBOLS_REJECTED }, 'ORDER_FLOW_SYMBOLS: no Dhan futures mapping for these symbols — ignored');
  state.configured = dhanConfigured();
  if (!state.configured) {
    logger.info('Dhan feed: NOT_CONFIGURED (DHAN_CLIENT_ID with DHAN_ACCESS_TOKEN, or DHAN_PIN + DHAN_TOTP_SECRET, not set) — order flow UNAVAILABLE, OF1 records nothing');
    return;
  }
  setInterval(() => void tick(), TICK_MS);
  void tick();
}

export function orderFlowFeedStatus() {
  return {
    status: !state.configured ? 'NOT_CONFIGURED' : state.tokenRejected ? 'TOKEN_REJECTED' : state.dataPlan === 'INACTIVE' ? 'DATA_PLAN_INACTIVE' : state.connected ? 'CONNECTED' : 'DISCONNECTED',
    dataPlan: state.dataPlan,
    failedConnections: state.failedConnections,
    nextAttemptAt: state.ws ? null : state.reconnectAt || null,
    deltaMode: 'INFERRED' as const,
    deltaModeReason: 'Dhan FULL packets carry cumulative volume, last price and best bid / ask, not the aggressor side of each trade: sides are inferred (quote rule, then tick rule).',
    instruments: state.resolved,
    packets: state.packets,
    trades: state.trades,
    lastPacketAt: state.lastPacketAt,
    lastError: state.lastError,
    session: dhanSessionStatus(),
    symbols: ORDER_FLOW_SYMBOLS,
    quality: dhanFeedQuality(),
  };
}

/** Whether the supervisor should expect heartbeats right now. */
export const orderFlowFeedActive = (now: number) => dhanConfigured() && (isMarketOpen('NSE', now) || isMarketOpen('MCX', now));
