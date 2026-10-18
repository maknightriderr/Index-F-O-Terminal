// ============================================================
// OPS MONITOR — functional health and alerts (audit 2026-10-18, OBS-1)
// ============================================================
// /api/health said HEALTHY with 0 tick subscriptions during a session while
// trades were open (16 Oct 13:14-13:28), and the only operational alert was
// the broker auth refresh. This checks, every minute, the things that change
// what happens to a paper trade:
//
//   FEED_COVERAGE   an open trade in session that no tick subscription watches
//   FEED_DOWN       the broker tick feed down in session while trades are open
//   FEED_GAP        an open trade's token silent for 5+ minutes in session
//   ENGINE_STALE    an expected symbol the engine has not computed for 15+
//                   minutes in session (a decision record is NOT the signal:
//                   a symbol holding a trade records none for hours)
//   OPEN_PAST_EXPIRY an open trade whose option has expired
//   RECORD_MISMATCH a trade row that disagrees with its plan (record-
//                   reconciliation.ts; it alerts itself, so this only reports)
//
// A check failing for its grace period opens an INCIDENT: /api/health turns
// DEGRADED (a WARN reports without degrading), and Telegram gets ONE alert.
// Recovery sends one "resolved" note. Read-only: it never changes a trade.
// The rules are pure; the IO shell only gathers their inputs.
// ============================================================

import { isMarketOpen, minutesSinceSessionOpen, type Exchange, type TradingMode } from '@fno/shared';
import { redis, scanKeys } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { SubscriptionManager } from '../lib/subscription-manager.js';
import type { FeedState } from '../lib/feed-freshness.js';
import { notifyOperationalAlert } from './telegram.js';
import { lastBiasComputedAt } from './market-bias.js';
import { watchedSetups } from './trade-setup-monitor.js';
import { readReconciliationReport } from './record-reconciliation.js';
import { BACKGROUND_BIAS_SYMBOLS, COVERAGE_LAG_FLAGS } from '../config/trading-flags.js';

export type OpsCheckId = 'FEED_COVERAGE' | 'FEED_DOWN' | 'FEED_GAP' | 'ENGINE_STALE' | 'OPEN_PAST_EXPIRY' | 'RECORD_MISMATCH';
export type OpsSeverity = 'DEGRADES' | 'WARN';

export interface OpsFinding {
  /** Stable per incident: the check, plus the symbol / exchange it is about. */
  key: string;
  check: OpsCheckId;
  severity: OpsSeverity;
  detail: string;
}

/** How long a finding must persist before it is an incident. */
export const GRACE_MS: Record<OpsCheckId, number> = {
  FEED_COVERAGE: 2 * 60_000,
  FEED_DOWN: 2 * 60_000,
  FEED_GAP: 0, // the token state itself means 5 silent minutes
  ENGINE_STALE: 0, // the threshold is already 15 minutes
  OPEN_PAST_EXPIRY: 45 * 60_000, // the lost-trade sweep closes these every 30 minutes
  RECORD_MISMATCH: 0,
};

export const ENGINE_STALE_MS = 15 * 60_000;
/** An exchange must have been open this long (and the process up this long) before a missing computation counts. */
const ENGINE_SESSION_WARMUP_MIN = 20;
const ENGINE_BOOT_WARMUP_MS = 15 * 60_000;

export interface OpenSlot {
  exchange: Exchange;
  underlying: string;
  mode: TradingMode;
  naked: boolean;
  expiry: string | null;
}

export interface OpsInputs {
  now: number;
  today: string;
  uptimeMs: number;
  inSession: (exchange: Exchange) => boolean;
  minutesSinceOpen: (exchange: Exchange) => number | null;
  slots: readonly OpenSlot[];
  /** setupKey `${exchange}:${underlying}:${mode}` → the token the monitor watches for it. */
  watched: ReadonlyMap<string, string>;
  feedConnected: boolean;
  feedUpstreamDown: boolean;
  feedStateOf: (token: string) => FeedState | null;
  expectedSymbols: ReadonlyArray<{ symbol: string; exchange: Exchange; mode: TradingMode }>;
  computedAt: (exchange: Exchange, symbol: string, mode: TradingMode) => number | undefined;
  /** Open rows in PostgreSQL whose option has expired (checked every 15 min), or null when unknown. */
  pastExpiryRows: number | null;
  reconciliationMismatches: number | null;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const slotKey = (s: Pick<OpenSlot, 'exchange' | 'underlying' | 'mode'>) => `${s.exchange}:${s.underlying}:${s.mode}`;

/** Pure: everything wrong right now (before grace periods). */
export function evaluateOpsChecks(i: OpsInputs): OpsFinding[] {
  const out: OpsFinding[] = [];
  const live = i.slots.filter((s) => s.naked && i.inSession(s.exchange) && !(s.expiry && isoDate.test(s.expiry) && s.expiry < i.today));

  const unwatched = live.filter((s) => !i.watched.has(slotKey(s)));
  if (unwatched.length > 0) {
    out.push({
      key: 'FEED_COVERAGE',
      check: 'FEED_COVERAGE',
      severity: 'DEGRADES',
      detail: `${unwatched.length} open trade(s) in session have no live tick subscription (${unwatched.map(slotKey).join(', ')}); stops and targets are checked only every 90 s.`,
    });
  }

  const feedDown = !i.feedConnected || i.feedUpstreamDown;
  if (live.length > 0 && feedDown) {
    out.push({ key: 'FEED_DOWN', check: 'FEED_DOWN', severity: 'DEGRADES', detail: `The broker tick feed is down in session with ${live.length} open trade(s).` });
  }

  // While the whole feed is down every token is silent; that is FEED_DOWN, not one gap per trade.
  for (const s of feedDown ? [] : live) {
    const token = i.watched.get(slotKey(s));
    if (token && i.feedStateOf(token) === 'DATA_GAP') {
      out.push({ key: `FEED_GAP:${slotKey(s)}`, check: 'FEED_GAP', severity: 'DEGRADES', detail: `No tick for 5+ minutes on the open ${s.underlying} ${s.mode} trade's contract (token ${token}).` });
    }
  }

  if (i.uptimeMs >= ENGINE_BOOT_WARMUP_MS) {
    for (const e of i.expectedSymbols) {
      const opened = i.minutesSinceOpen(e.exchange);
      if (!i.inSession(e.exchange) || opened == null || opened < ENGINE_SESSION_WARMUP_MIN) continue;
      const at = i.computedAt(e.exchange, e.symbol, e.mode);
      if (at == null || i.now - at > ENGINE_STALE_MS) {
        out.push({
          key: `ENGINE_STALE:${e.exchange}:${e.symbol}`,
          check: 'ENGINE_STALE',
          severity: 'DEGRADES',
          detail: `${e.symbol} (${e.exchange}) has not been evaluated ${at == null ? 'since the server started' : `for ${Math.round((i.now - at) / 60_000)} minutes`} while its market is open.`,
        });
      }
    }
  }

  const expiredSlots = i.slots.filter((s) => s.expiry && isoDate.test(s.expiry) && s.expiry < i.today);
  const pastExpiry = Math.max(expiredSlots.length, i.pastExpiryRows ?? 0);
  if (pastExpiry > 0) {
    out.push({ key: 'OPEN_PAST_EXPIRY', check: 'OPEN_PAST_EXPIRY', severity: 'DEGRADES', detail: `${pastExpiry} open trade(s) hold an option that has already expired.` });
  }

  if ((i.reconciliationMismatches ?? 0) > 0) {
    out.push({ key: 'RECORD_MISMATCH', check: 'RECORD_MISMATCH', severity: 'WARN', detail: `${i.reconciliationMismatches} trade row(s) disagree with the close their plan recorded (see Diagnostics: reconciliation).` });
  }
  return out;
}

export interface OpsIncident extends OpsFinding {
  since: number;
}

export interface OpsTransition {
  opened: OpsIncident[];
  resolved: OpsIncident[];
}

/** Pure: fold one evaluation into the running state. A finding becomes an incident after its grace period; an incident resolves when its finding is gone. */
export function stepIncidents(state: Map<string, { firstSeen: number; incident: OpsIncident | null }>, findings: readonly OpsFinding[], now: number): OpsTransition {
  const opened: OpsIncident[] = [];
  const resolved: OpsIncident[] = [];
  const seen = new Set(findings.map((f) => f.key));
  for (const f of findings) {
    const s = state.get(f.key) ?? { firstSeen: now, incident: null };
    if (s.incident) s.incident = { ...s.incident, detail: f.detail };
    else if (now - s.firstSeen >= GRACE_MS[f.check]) {
      s.incident = { ...f, since: s.firstSeen };
      opened.push(s.incident);
    }
    state.set(f.key, s);
  }
  for (const [key, s] of [...state]) {
    if (seen.has(key)) continue;
    if (s.incident) resolved.push(s.incident);
    state.delete(key);
  }
  return { opened, resolved };
}

// ---------------- IO shell ----------------

const TICK_MS = 60_000;
const PAST_EXPIRY_EVERY_MS = 15 * 60_000;
const ALERT_KEY = (key: string) => `ops:incident:${key}`;
const bootAt = Date.now();
const state = new Map<string, { firstSeen: number; incident: OpsIncident | null }>();
let lastRunAt: number | null = null;
let pastExpiryRows: number | null = null;
let pastExpiryCheckedAt = 0;

/** What /api/health reports: the open incidents (DEGRADES ones degrade the overall status). */
export function opsStatus(): { at: number | null; incidents: OpsIncident[] } {
  return { at: lastRunAt, incidents: [...state.values()].flatMap((s) => (s.incident ? [s.incident] : [])) };
}

/** The symbols the engine is expected to compute in session: the scanner's indices and the background list. */
export function expectedEngineSymbols(): Array<{ symbol: string; exchange: Exchange; mode: TradingMode }> {
  const nse = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'].map((symbol) => ({ symbol, exchange: 'NSE' as Exchange, mode: 'INTRADAY' as TradingMode }));
  const background = COVERAGE_LAG_FLAGS.BACKGROUND_BIAS ? BACKGROUND_BIAS_SYMBOLS.map((s) => ({ symbol: s.symbol, exchange: s.exchange, mode: 'INTRADAY' as TradingMode })) : [];
  return [...nse, ...background];
}

async function openSlots(): Promise<OpenSlot[]> {
  const out: OpenSlot[] = [];
  for (const key of await scanKeys('trade_setup:*')) {
    const [, exchange, underlying, mode] = key.split(':');
    if (mode !== 'INTRADAY' && mode !== 'POSITIONAL') continue;
    try {
      const raw = await redis.get(key);
      const v = raw ? JSON.parse(raw) : null;
      if (v?.available) out.push({ exchange: exchange as Exchange, underlying, mode, naked: v.structureType !== 'SPREAD', expiry: typeof v.expiry === 'string' ? v.expiry : null });
    } catch {
      /* an unreadable slot is not an open trade we can judge */
    }
  }
  return out;
}

async function countPastExpiryRows(today: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM signals
    WHERE signal_type = 'TRADE_SETUP' AND (inputs->>'outcome') IS NULL AND time > NOW() - INTERVAL '60 days'
      AND (inputs->>'expiry') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND (inputs->>'expiry') < ${today}
  `;
  return Number(r?.n ?? 0);
}

export async function runOpsChecks(subscriptions: SubscriptionManager, now = Date.now()): Promise<OpsTransition> {
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (now - pastExpiryCheckedAt >= PAST_EXPIRY_EVERY_MS) {
    pastExpiryCheckedAt = now;
    pastExpiryRows = await countPastExpiryRows(today).catch(() => pastExpiryRows);
  }
  const report = await readReconciliationReport().catch(() => null);
  const watched = new Map(watchedSetups().map((w) => [`${w.exchange}:${w.underlying}:${w.mode}`, w.token]));
  const status = subscriptions.getStatus();
  const findings = evaluateOpsChecks({
    now,
    today,
    uptimeMs: now - bootAt,
    inSession: (ex) => isMarketOpen(ex, now),
    minutesSinceOpen: (ex) => minutesSinceSessionOpen(ex, now),
    slots: await openSlots(),
    watched,
    feedConnected: status.connected,
    feedUpstreamDown: status.feed.upstreamDown,
    feedStateOf: (token) => subscriptions.feedStateOfToken(token),
    expectedSymbols: expectedEngineSymbols(),
    computedAt: lastBiasComputedAt,
    pastExpiryRows,
    reconciliationMismatches: report ? report.mismatches.length : null,
  });
  const t = stepIncidents(state, findings, now);
  lastRunAt = now;
  for (const inc of t.opened) {
    logger.warn({ incident: inc.key, detail: inc.detail }, 'Ops incident opened');
    // RECORD_MISMATCH is alerted by the reconciliation job itself; a WARN never pages.
    if (inc.severity !== 'DEGRADES') continue;
    // One alert per incident, across restarts too.
    if (await redis.set(ALERT_KEY(inc.key), String(inc.since), 'EX', 12 * 3600, 'NX').catch(() => 'OK')) {
      await notifyOperationalAlert(`⚠️ ${inc.detail}`);
    }
  }
  for (const inc of t.resolved) {
    logger.info({ incident: inc.key }, 'Ops incident resolved');
    if (inc.severity !== 'DEGRADES') continue;
    const alerted = await redis.del(ALERT_KEY(inc.key)).catch(() => 0);
    if (alerted) await notifyOperationalAlert(`✅ Resolved after ${Math.max(1, Math.round((now - inc.since) / 60_000))} min: ${inc.detail}`);
  }
  return t;
}

let started = false;
export function startOpsMonitor(subscriptions: SubscriptionManager): void {
  if (started) return;
  started = true;
  const tick = () => void runOpsChecks(subscriptions).catch((err: any) => logger.warn({ error: err.message }, 'Ops monitor: check failed (retried next minute)'));
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, 60_000);
  logger.info({ intervalMs: TICK_MS }, 'Ops monitor started (functional health and alerts)');
}
