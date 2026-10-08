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
// Connects only during the NSE session (with a few minutes either side) and
// only when DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are set; otherwise its status
// is NOT_CONFIGURED and every order-flow measure stays UNAVAILABLE.
// ============================================================

import axios from 'axios';
import WebSocket from 'ws';
import { inferTradeSide, type TradeSide } from '@fno/analytics';
import { isMarketOpen } from '@fno/shared';
import { logger } from '../lib/logger.js';
import { serviceHeartbeat } from '../lib/service-supervisor.js';
import { DHAN_RESPONSE, DHAN_SEGMENT_CODE, dhanFeedUrl, fullSubscription, parseDhanFrame, resolveNearestFutures, type DhanFullPacket, type DhanSegment } from '../lib/dhan-feed-packets.js';
import { dhanCredentials, ORDER_BLOCK_MODE, ORDER_BLOCK_MODE_REJECTED, OF1_TRADING_REQUESTED, ORDER_FLOW_SUPPORTED, ORDER_FLOW_SYMBOLS, ORDER_FLOW_SYMBOLS_REJECTED } from '../config/order-flow-flags.js';
import { closeFlowBars, recordFlowTrade, registerFlowSymbol, setFlowFeedConnected } from './order-flow-store.js';

export const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const TICK_MS = 10_000;
const SESSION_MARGIN_MS = 5 * 60_000;

interface InstrumentState {
  symbol: string;
  prevVolume: number | null;
  prevLtp: number | null;
  prevSide: TradeSide | null;
  prevQuote: { bid: number | null; ask: number | null } | null;
}

const state = {
  configured: false,
  connected: false,
  ws: null as WebSocket | null,
  /** Keyed `${segmentCode}:${securityId}` (ids are only unique within a segment). */
  instruments: new Map<string, InstrumentState>(),
  resolved: {} as Record<string, { securityId: string; tradingSymbol: string; expiry: string; segment: DhanSegment; exchange: 'NSE' | 'MCX' }>,
  resolvedOn: null as string | null,
  packets: 0,
  trades: 0,
  lastPacketAt: null as number | null,
  lastError: null as string | null,
  reconnectAt: 0,
  backoffMs: 5_000,
};

/**
 * Pure: the FlowTrade (if any) a FULL packet reveals for an instrument, and
 * the instrument's next state. Volume that went DOWN (a feed reset) re-bases
 * without a trade; the first packet only sets the baseline.
 */
export function tradeFromFullPacket(s: InstrumentState, p: Pick<DhanFullPacket, 'ltp' | 'volume' | 'depth'>, at: number): { trade: { time: number; price: number; qty: number; side: TradeSide | null } | null; next: InstrumentState } {
  const best = p.depth[0];
  const quote = best ? { bid: best.bidPrice > 0 ? best.bidPrice : null, ask: best.askPrice > 0 ? best.askPrice : null } : null;
  let trade = null;
  let side = s.prevSide;
  if (s.prevVolume != null && p.volume > s.prevVolume && p.ltp > 0) {
    side = inferTradeSide(p.ltp, s.prevQuote, s.prevLtp, s.prevSide);
    trade = { time: at, price: p.ltp, qty: p.volume - s.prevVolume, side };
  }
  return { trade, next: { ...s, prevVolume: p.volume, prevLtp: p.ltp > 0 ? p.ltp : s.prevLtp, prevSide: side, prevQuote: quote } };
}

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const openNear = (ex: 'NSE' | 'MCX', now: number) => isMarketOpen(ex, now) || isMarketOpen(ex, now + SESSION_MARGIN_MS) || isMarketOpen(ex, now - SESSION_MARGIN_MS);
/** NSE or MCX in session (± a few minutes): the feed's connection window. */
const inSessionWindow = (now: number) => openNear('NSE', now) || openNear('MCX', now);

async function resolveInstruments(now: number): Promise<void> {
  if (state.resolvedOn === istDate(now) && Object.keys(state.resolved).length) return;
  const res = await axios.get<string>(DHAN_SCRIP_MASTER_URL, { responseType: 'text', timeout: 60_000 });
  state.resolved = resolveNearestFutures(res.data, ORDER_FLOW_SYMBOLS.map((symbol) => ({ symbol, exchange: ORDER_FLOW_SUPPORTED[symbol] })), now);
  state.resolvedOn = istDate(now);
  state.instruments.clear();
  for (const [symbol, r] of Object.entries(state.resolved)) {
    state.instruments.set(`${DHAN_SEGMENT_CODE[r.segment]}:${r.securityId}`, { symbol, prevVolume: null, prevLtp: null, prevSide: null, prevQuote: null });
    registerFlowSymbol(symbol, { exchange: r.exchange, instrument: r.tradingSymbol, source: 'DHAN', mode: 'INFERRED', startedAt: now });
  }
  logger.info({ instruments: state.resolved }, 'Dhan feed: index futures resolved for order flow');
}

function onFrame(data: WebSocket.RawData): void {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  for (const p of parseDhanFrame(buf)) {
    state.packets++;
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
    const { trade, next } = tradeFromFullPacket(s, p, Date.now());
    state.instruments.set(ikey, next);
    if (trade) {
      state.trades++;
      recordFlowTrade(s.symbol, trade);
    }
  }
  serviceHeartbeat('orderFlowFeed');
}

function connect(creds: { clientId: string; accessToken: string }): void {
  const ws = new WebSocket(dhanFeedUrl(creds.clientId, creds.accessToken));
  state.ws = ws;
  ws.on('open', () => {
    state.connected = true;
    setFlowFeedConnected(true);
    state.backoffMs = 5_000;
    state.lastError = null;
    const ids = Object.values(state.resolved).map((r) => ({ securityId: r.securityId, segment: r.segment }));
    if (ids.length) ws.send(fullSubscription(ids));
    logger.info({ instruments: ids.length }, 'Dhan feed: connected and subscribed (FULL packets, data only)');
  });
  ws.on('message', onFrame);
  ws.on('error', (err) => {
    // The URL carries the token: log the message only, never the request.
    state.lastError = err.message;
    logger.warn({ error: err.message }, 'Dhan feed: socket error');
  });
  ws.on('close', (code) => {
    state.connected = false;
    setFlowFeedConnected(false);
    state.ws = null;
    state.reconnectAt = Date.now() + state.backoffMs;
    state.backoffMs = Math.min(60_000, state.backoffMs * 2);
    logger.info({ code }, 'Dhan feed: closed');
  });
}

async function tick(): Promise<void> {
  const creds = dhanCredentials();
  if (!creds) return;
  const now = Date.now();
  if (!inSessionWindow(now)) {
    if (state.ws) state.ws.close();
    return;
  }
  try {
    await resolveInstruments(now);
  } catch (err: any) {
    state.lastError = `instrument master: ${err.message}`;
    logger.warn({ error: err.message }, 'Dhan feed: instrument master unavailable — order flow UNAVAILABLE');
  }
  if (!state.ws && now >= state.reconnectAt && Object.keys(state.resolved).length) connect(creds);
  await closeFlowBars(now, state.connected).catch((err: any) => logger.warn({ error: err.message }, 'Order flow: bar close failed'));
}

let started = false;
export function startOrderFlowFeed(): void {
  if (started) return;
  started = true;
  if (ORDER_BLOCK_MODE_REJECTED) logger.warn({ asked: ORDER_BLOCK_MODE_REJECTED, using: ORDER_BLOCK_MODE }, 'ORDER_BLOCK_MODE: only SHADOW or OFF — OB-2.0 enters the live vote by a code change, never a setting');
  if (OF1_TRADING_REQUESTED) logger.warn('OF1_TRADING=true ignored: OF1_ENABLED is false');
  if (ORDER_FLOW_SYMBOLS_REJECTED.length) logger.warn({ rejected: ORDER_FLOW_SYMBOLS_REJECTED }, 'ORDER_FLOW_SYMBOLS: not verified for Dhan order flow (MCX pending) — ignored');
  state.configured = dhanCredentials() != null;
  if (!state.configured) {
    logger.info('Dhan feed: NOT_CONFIGURED (DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set) — order flow UNAVAILABLE, OF1 records nothing');
    return;
  }
  setInterval(() => void tick(), TICK_MS);
  void tick();
}

export function orderFlowFeedStatus() {
  return {
    status: !state.configured ? 'NOT_CONFIGURED' : state.connected ? 'CONNECTED' : 'DISCONNECTED',
    deltaMode: 'INFERRED' as const,
    deltaModeReason: 'Dhan FULL packets carry cumulative volume, last price and best bid / ask, not the aggressor side of each trade: sides are inferred (quote rule, then tick rule).',
    instruments: state.resolved,
    packets: state.packets,
    trades: state.trades,
    lastPacketAt: state.lastPacketAt,
    lastError: state.lastError,
    symbols: ORDER_FLOW_SYMBOLS,
  };
}

/** Whether the supervisor should expect heartbeats right now. */
export const orderFlowFeedActive = (now: number) => dhanCredentials() != null && (isMarketOpen('NSE', now) || isMarketOpen('MCX', now));
