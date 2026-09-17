// ============================================================
// ALERT SCANNER
// ============================================================
// The first background (non-request-driven) job in this server.
// Runs on a timer, evaluates live state for conditions worth
// surfacing, and persists+delivers anything new. Two independent
// checks, both designed to add zero or near-zero extra Angel One
// load on top of what the app already does:
//
//   1. OI / IV extremes — reads the SAME Redis-cached F&O universe
//      scan the F&O Stocks / IV & Greeks / OI Intelligence pages
//      already poll (getFnoScan in fno-scanner.ts).
//      If that cache is warm this is a pure Redis read; if cold, it
//      triggers one scan (~40 quote requests) — no worse than a user
//      loading any of those pages already does.
//
//   2. Trade Setup closed — MOVED to trade-setup-close-notifier.ts,
//      which fires the moment an outcome is recorded. Diffing the
//      sticky keys here only caught a close once the next setup for
//      the same symbol appeared (hours late) and couldn't tell a
//      stop-loss from a bias reversal.
//
// Alerts dedupe via Redis so a real condition only alerts once (once
// per symbol per IST day) rather than once per scan tick.
// ============================================================

import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram.js';
import { getFnoScan } from './fno-scanner.js';
import { getLiveIndexQuotes } from './indices.js';
import { buildOptionChain } from './option-chain.js';
import { INSTITUTIONAL_SYMBOLS } from './institutional-flow.js';
import type { MarketDataProvider } from '../providers/interface.js';
import { minutesSinceSessionOpen, SETUP_OPENING_SETTLE_MINUTES } from '@fno/shared';
import type { AlertChannel, Exchange, SignalType } from '@fno/shared';

const SCAN_INTERVAL_MS = 120_000; // 2 minutes
const INITIAL_DELAY_MS = 30_000; // let the provider/cache warm up after boot before the first tick

// Raised from 8/85/15 after a real-world complaint: at the old bar these
// fired for dozens of the ~180-stock F&O universe on an ordinary day —
// common enough to be noise, not "unusual." These are meant to be the
// genuinely rare tail, not routine intraday moves.
const OI_CHANGE_PCT_THRESHOLD = 15;
const IV_RANK_SPIKE_THRESHOLD = 92;
const IV_RANK_CRUSH_THRESHOLD = 8;

// --- Institutional Flow (Section 8) thresholds ---
const VIX_SPIKE_LEVEL = 20; // conventional India VIX "elevated" band
const VIX_SPIKE_DAY_CHANGE_PCT = 10; // a double-digit % move in VIX itself, regardless of level
const PCR_EXTREME_HIGH = 1.5;
const PCR_EXTREME_LOW = 0.6;
const UNUSUAL_ACTIVITY_BUILDUP_SHARE_PCT = 35; // % of the F&O universe on the same side of OI buildup

let scannerStarted = false;

export function startAlertScanner(provider: MarketDataProvider): void {
  if (scannerStarted) return;
  scannerStarted = true;

  const tick = () => {
    runAlertScan(provider).catch((err) => logger.error({ error: err.message }, 'Alert scan tick failed'));
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'Alert scanner started');
}

/**
 * True once the exchange has been trading for a few minutes this session.
 * Every check below reads live quotes, so outside a session it only sees the
 * last close frozen in place — and because de-duplication is per IST day,
 * the first tick after midnight used to re-send the previous session's
 * digests (IV-rank alerts at 00:00 on a Sunday and on a holiday). The
 * opening minutes are skipped for the same reason the setup engine skips them.
 */
function sessionLive(exchange: Exchange): boolean {
  const minutes = minutesSinceSessionOpen(exchange);
  return minutes != null && minutes >= SETUP_OPENING_SETTLE_MINUTES;
}

async function runAlertScan(provider: MarketDataProvider): Promise<void> {
  await Promise.all([checkOiAndIvAlerts(provider), checkInstitutionalFlowAlerts(provider)]);
}

// --- Institutional Flow (Section 8): VIX spike, PCR extreme, unusual
// aggregate OI activity — the subset of the requested alert triggers this
// app can check for real. FII Buying/Selling >₹3,000 Cr triggers are NOT
// implemented: that needs FII cash-flow data, which isn't connected. ---

async function checkInstitutionalFlowAlerts(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const today = istDay();

  const nseLive = sessionLive('NSE');
  const vixQuotes = nseLive ? await getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []) : [];
  const vix = vixQuotes[0];
  if (vix && (vix.ltp >= VIX_SPIKE_LEVEL || Math.abs(vix.changePercent) >= VIX_SPIKE_DAY_CHANGE_PCT)) {
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:VIX_SPIKE:INDIAVIX:${today}`,
      symbol: 'INDIAVIX',
      exchange: 'NSE',
      alertType: 'VIX_SPIKE',
      severity: 'WARNING',
      message: `🌡️ India VIX at ${vix.ltp.toFixed(2)} (${vix.changePercent >= 0 ? '+' : ''}${vix.changePercent.toFixed(2)}% today) — elevated volatility, expect wider intraday swings`,
      condition: { level: vix.ltp, changePercent: vix.changePercent, levelThreshold: VIX_SPIKE_LEVEL, changeThreshold: VIX_SPIKE_DAY_CHANGE_PCT },
    });
  }

  for (const { symbol, exchange } of INSTITUTIONAL_SYMBOLS) {
    if (!sessionLive(exchange)) continue;
    try {
      const chain = await buildOptionChain(provider, symbol, exchange);
      // An empty or one-sided chain reads PCR 0 — a data gap, not "extreme
      // call buildup". It fired exactly that for BANKNIFTY on 8 and 9 Sep.
      const { callOi, putOi } = chain.positionMomentum;
      if (!(callOi > 0 && putOi > 0 && chain.pcr > 0)) continue;
      if (chain.pcr >= PCR_EXTREME_HIGH || chain.pcr <= PCR_EXTREME_LOW) {
        await maybeFireDailyAlert({
          dedupeKey: `alert_sent:PCR_EXTREME:${symbol}:${today}`,
          symbol,
          exchange,
          alertType: 'PCR_EXTREME',
          severity: 'INFO',
          message: `⚖️ ${symbol} PCR at ${chain.pcr.toFixed(2)} — ${chain.pcr >= PCR_EXTREME_HIGH ? 'extreme put buildup' : 'extreme call buildup'}, often a contrarian reversal zone`,
          condition: { pcr: chain.pcr, highThreshold: PCR_EXTREME_HIGH, lowThreshold: PCR_EXTREME_LOW },
        });
      }
    } catch (err: any) {
      logger.warn({ error: err.message, symbol }, 'Alert scan: PCR extreme check unavailable this tick');
    }
  }

  if (!nseLive) return;

  let rows;
  try {
    rows = await getFnoScan(provider, 'NSE');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Alert scan: unusual activity check unavailable this tick');
    return;
  }
  if (rows.length === 0) return;

  const longBuildupShare = (rows.filter((r) => r.oiInterpretation === 'LONG_BUILDUP').length / rows.length) * 100;
  const shortBuildupShare = (rows.filter((r) => r.oiInterpretation === 'SHORT_BUILDUP').length / rows.length) * 100;

  if (longBuildupShare >= UNUSUAL_ACTIVITY_BUILDUP_SHARE_PCT) {
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:INSTITUTIONAL_ACTIVITY:LONG_BUILDUP:${today}`,
      symbol: 'NSE_FNO_UNIVERSE',
      exchange: 'NSE',
      alertType: 'INSTITUTIONAL_ACTIVITY',
      severity: 'WARNING',
      message: `🟢 ${Math.round(longBuildupShare)}% of the F&O universe (${rows.length} stocks) is in long buildup — broad-based bullish futures OI activity`,
      condition: { longBuildupSharePct: Math.round(longBuildupShare), threshold: UNUSUAL_ACTIVITY_BUILDUP_SHARE_PCT, universeSize: rows.length },
    });
  } else if (shortBuildupShare >= UNUSUAL_ACTIVITY_BUILDUP_SHARE_PCT) {
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:INSTITUTIONAL_ACTIVITY:SHORT_BUILDUP:${today}`,
      symbol: 'NSE_FNO_UNIVERSE',
      exchange: 'NSE',
      alertType: 'INSTITUTIONAL_ACTIVITY',
      severity: 'WARNING',
      message: `🔴 ${Math.round(shortBuildupShare)}% of the F&O universe (${rows.length} stocks) is in short buildup — broad-based bearish futures OI activity`,
      condition: { shortBuildupSharePct: Math.round(shortBuildupShare), threshold: UNUSUAL_ACTIVITY_BUILDUP_SHARE_PCT, universeSize: rows.length },
    });
  }
}

// --- OI / IV extremes (universe scan) ---
//
// Digested, not per-symbol: on a genuinely volatile day, a dozen-plus
// stocks can cross these thresholds in the same scan. Firing one alert
// row per stock (the original behavior) is exactly what produced "100s
// of alerts a day" — this collects everyone who qualifies THIS tick and
// fires a single summary alert per type per day instead, with the full
// list preserved in `condition.symbols` for the UI to expand on demand.
const DIGEST_PREVIEW_COUNT = 3; // how many symbols the message text itself names before "+N more"

function summarizeDigest(items: string[]): string {
  const preview = items.slice(0, DIGEST_PREVIEW_COUNT).join(', ');
  const rest = items.length - DIGEST_PREVIEW_COUNT;
  return rest > 0 ? `${preview} +${rest} more` : preview;
}

async function checkOiAndIvAlerts(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated() || !sessionLive('NSE')) return;

  let rows;
  try {
    rows = await getFnoScan(provider, 'NSE');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Alert scan: F&O universe scan unavailable this tick');
    return;
  }

  const today = istDay();

  const oiSpikes = rows.filter((r) => r.futuresOi > 0 && Math.abs(r.futuresChangeOiPercent) >= OI_CHANGE_PCT_THRESHOLD);
  const ivSpikes = rows.filter((r) => r.ivRank != null && r.ivRank >= IV_RANK_SPIKE_THRESHOLD);
  const ivCrushes = rows.filter((r) => r.ivRank != null && r.ivRank <= IV_RANK_CRUSH_THRESHOLD);

  if (oiSpikes.length > 0) {
    const sorted = [...oiSpikes].sort((a, b) => Math.abs(b.futuresChangeOiPercent) - Math.abs(a.futuresChangeOiPercent));
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:FUTURES_OI_SPIKE_DIGEST:${today}`,
      symbol: 'NSE_FNO_UNIVERSE',
      exchange: 'NSE',
      alertType: 'FUTURES_OI_SPIKE',
      severity: 'WARNING',
      message: `⚡ ${oiSpikes.length} stock${oiSpikes.length === 1 ? '' : 's'} showed unusual futures OI activity (≥${OI_CHANGE_PCT_THRESHOLD}%) today: ${summarizeDigest(sorted.map((r) => `${r.symbol} ${r.futuresChangeOiPercent >= 0 ? '+' : ''}${r.futuresChangeOiPercent.toFixed(1)}%`))}`,
      condition: {
        threshold: OI_CHANGE_PCT_THRESHOLD,
        symbols: sorted.map((r) => ({ symbol: r.symbol, exchange: r.exchange, changePercent: r.futuresChangeOiPercent, oiInterpretation: r.oiInterpretation })),
      },
    });
  }

  if (ivSpikes.length > 0) {
    const sorted = [...ivSpikes].sort((a, b) => (b.ivRank ?? 0) - (a.ivRank ?? 0));
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:IV_SPIKE_DIGEST:${today}`,
      symbol: 'NSE_FNO_UNIVERSE',
      exchange: 'NSE',
      alertType: 'IV_SPIKE',
      severity: 'WARNING',
      message: `📈 ${ivSpikes.length} stock${ivSpikes.length === 1 ? ' has' : 's have'} unusually expensive IV (rank ≥${IV_RANK_SPIKE_THRESHOLD}) today: ${summarizeDigest(sorted.map((r) => `${r.symbol} (IVR ${r.ivRank})`))}`,
      condition: {
        threshold: IV_RANK_SPIKE_THRESHOLD,
        symbols: sorted.map((r) => ({ symbol: r.symbol, exchange: r.exchange, ivRank: r.ivRank, atmIv: r.atmIv })),
      },
    });
  }

  if (ivCrushes.length > 0) {
    const sorted = [...ivCrushes].sort((a, b) => (a.ivRank ?? 0) - (b.ivRank ?? 0));
    await maybeFireDailyAlert({
      dedupeKey: `alert_sent:IV_CRUSH_DIGEST:${today}`,
      symbol: 'NSE_FNO_UNIVERSE',
      exchange: 'NSE',
      alertType: 'IV_CRUSH',
      severity: 'INFO',
      message: `📉 ${ivCrushes.length} stock${ivCrushes.length === 1 ? ' has' : 's have'} unusually cheap IV (rank ≤${IV_RANK_CRUSH_THRESHOLD}) today: ${summarizeDigest(sorted.map((r) => `${r.symbol} (IVR ${r.ivRank})`))}`,
      condition: {
        threshold: IV_RANK_CRUSH_THRESHOLD,
        symbols: sorted.map((r) => ({ symbol: r.symbol, exchange: r.exchange, ivRank: r.ivRank, atmIv: r.atmIv })),
      },
    });
  }
}

// --- Shared alert plumbing ---

async function maybeFireDailyAlert(input: {
  dedupeKey: string;
  symbol: string;
  exchange: string;
  alertType: SignalType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  condition: Record<string, unknown>;
}): Promise<void> {
  try {
    const claimed = await redis.set(input.dedupeKey, '1', 'EX', 60 * 60 * 24, 'NX');
    if (claimed !== 'OK') return; // already fired today
  } catch (err: any) {
    logger.warn({ error: err.message, key: input.dedupeKey }, 'Alert dedupe check failed — skipping to avoid a duplicate spam risk');
    return;
  }

  await fireAlert(input);
}

async function fireAlert(input: {
  symbol: string;
  exchange: string;
  alertType: SignalType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  condition: Record<string, unknown>;
}): Promise<void> {
  const channels: AlertChannel[] = isTelegramConfigured() ? ['TERMINAL', 'TELEGRAM'] : ['TERMINAL'];

  try {
    await sql`
      INSERT INTO alerts (symbol, alert_type, message, severity, channels, condition, triggered, triggered_at)
      VALUES (${input.symbol}, ${input.alertType}, ${input.message}, ${input.severity}, ${sql.json(channels)}, ${sql.json({ exchange: input.exchange, ...input.condition })}, true, NOW())
    `;
  } catch (err: any) {
    logger.error({ error: err.message, symbol: input.symbol, alertType: input.alertType }, 'Failed to persist alert');
  }

  logger.info({ symbol: input.symbol, alertType: input.alertType, severity: input.severity }, input.message);

  if (channels.includes('TELEGRAM')) {
    await sendTelegramMessage(input.message);
  }
}

// --- Helpers ---

function istDay(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
