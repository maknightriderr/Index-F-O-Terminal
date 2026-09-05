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
//      already poll (`fno-scanner:${exchange}`, see instruments.ts).
//      If that cache is warm this is a pure Redis read; if cold, it
//      triggers one scan (~40 quote requests) — no worse than a user
//      loading any of those pages already does.
//
//   2. Trade Setup closed (SL/target reached) — read-only against the
//      `trade_setup:*` sticky keys market-bias.ts already maintains
//      whenever a user has an asset tab open. This job never calls
//      buildMarketBias itself (that pulls historical candles, which
//      Angel One rate-limits hard) — it only diffs the existing
//      state, so it adds ZERO new broker calls. The trade-off: a
//      symbol nobody has viewed recently won't have a sticky key to
//      diff, so its closes won't be caught until it's viewed again.
//
// Both checks dedupe via Redis so a real condition only alerts once
// (OI/IV: once per symbol per IST day; Trade Setup: once per actual
// state transition) rather than once per scan tick.
// ============================================================

import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { getLiveIndexQuotes } from './indices.js';
import { buildOptionChain } from './option-chain.js';
import { INSTITUTIONAL_SYMBOLS } from './institutional-flow.js';
import type { MarketDataProvider } from '../providers/interface.js';
import type { AlertChannel, BiasDirection, OptionType, SignalType } from '@fno/shared';

const SCAN_INTERVAL_MS = 120_000; // 2 minutes
const INITIAL_DELAY_MS = 30_000; // let the provider/cache warm up after boot before the first tick
const SCANNER_CACHE_TTL_SECONDS = 180; // must match instruments.ts's fno-scanner cache TTL — same key, shared cache

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

interface StoredTradeSetupSnapshot {
  available: boolean;
  side?: OptionType;
  strike?: number;
  entry?: number;
  stopLoss?: number;
  target?: number;
  direction?: BiasDirection;
  day?: string;
  generatedAt?: number;
}

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

async function runAlertScan(provider: MarketDataProvider): Promise<void> {
  await Promise.all([checkOiAndIvAlerts(provider), checkTradeSetupAlerts(), checkInstitutionalFlowAlerts(provider)]);
}

// --- Institutional Flow (Section 8): VIX spike, PCR extreme, unusual
// aggregate OI activity — the subset of the requested alert triggers this
// app can check for real. FII Buying/Selling >₹3,000 Cr triggers are NOT
// implemented: that needs FII cash-flow data, which isn't connected. ---

async function checkInstitutionalFlowAlerts(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const today = istDay();

  const vixQuotes = await getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []);
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
    try {
      const chain = await buildOptionChain(provider, symbol, exchange);
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

  let rows;
  try {
    rows = await cached(`fno-scanner:NSE`, SCANNER_CACHE_TTL_SECONDS, () => scanFnoUniverse(provider, 'NSE'));
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
  if (!provider.isAuthenticated()) return;

  let rows;
  try {
    rows = await cached(`fno-scanner:NSE`, SCANNER_CACHE_TTL_SECONDS, () => scanFnoUniverse(provider, 'NSE'));
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

// --- Trade Setup closed (read-only diff against the sticky key) ---

async function checkTradeSetupAlerts(): Promise<void> {
  let keys: string[];
  try {
    keys = await scanKeys('trade_setup:*');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Alert scan: trade_setup key scan failed');
    return;
  }

  for (const key of keys) {
    try {
      await checkOneTradeSetup(key);
    } catch (err: any) {
      logger.warn({ error: err.message, key }, 'Alert scan: trade setup check failed for one key');
    }
  }
}

async function checkOneTradeSetup(key: string): Promise<void> {
  // key shape: trade_setup:{exchange}:{underlying}:{mode} — INTRADAY and
  // POSITIONAL setups for the same symbol are two independent Redis keys
  // (see market-bias.ts's resolveStickyTradeSetup), so mode must stay in
  // the seen-baseline key too. Dropping it (as this used to) meant both
  // modes shared ONE seenKey slot — whichever mode's key the scanner
  // happened to process first each tick "won" the baseline, and the
  // other mode's every subsequent poll compared its real setup against
  // a snapshot belonging to a DIFFERENT mode (different SL%, different
  // hold horizon), which could spuriously fire or spuriously suppress a
  // TRADE_SETUP_CLOSED alert.
  const [, exchange, underlying, mode] = key.split(':');
  if (!exchange || !underlying || !mode) return;

  const seenKey = `alert_setup_seen:${exchange}:${underlying}:${mode}`;
  const modeLabel = mode === 'POSITIONAL' ? 'POS' : 'INTRA';

  const [currentRaw, seenRaw] = await Promise.all([redis.get(key), redis.get(seenKey)]);
  const current: StoredTradeSetupSnapshot | null = currentRaw ? JSON.parse(currentRaw) : null;
  const seen: StoredTradeSetupSnapshot | null = seenRaw ? JSON.parse(seenRaw) : null;

  // Record the baseline the first time we see this key — don't alert on
  // a setup that already existed before the scanner started watching it.
  if (!seen) {
    if (current) await redis.set(seenKey, JSON.stringify(current), 'EX', 60 * 60 * 24 * 2);
    return;
  }

  if (seen.available) {
    const sameDayAndDirection = current?.available && current.day === seen.day && current.direction === seen.direction;
    const sameSetup = sameDayAndDirection && current!.generatedAt === seen.generatedAt;

    if (!sameSetup) {
      if (sameDayAndDirection) {
        // Same day, same direction, but the setup changed — resolveStickyTradeSetup
        // only regenerates a same-day/same-direction setup when SL or target was hit.
        await maybeFireOnce({
          symbol: underlying,
          exchange,
          alertType: 'TRADE_SETUP_CLOSED',
          severity: 'WARNING',
          message: `🎯 ${underlying} (${modeLabel}): Trade Setup closed — ${seen.side} ${seen.strike} (Entry ₹${seen.entry} · SL ₹${seen.stopLoss} · Target ₹${seen.target}) hit its stop-loss or target`,
          condition: { reason: 'SL_OR_TARGET', side: seen.side, strike: seen.strike, entry: seen.entry, stopLoss: seen.stopLoss, target: seen.target },
        });
      } else {
        // Day rolled over, direction reversed, or bias no longer supports a
        // setup at all — an ended setup, but not necessarily SL/target.
        await maybeFireOnce({
          symbol: underlying,
          exchange,
          alertType: 'TRADE_SETUP_CLOSED',
          severity: 'INFO',
          message: `${underlying} (${modeLabel}): Trade Setup ended — ${seen.side} ${seen.strike} (bias shifted or the session rolled over)`,
          condition: { reason: 'BIAS_OR_DAY_CHANGE', side: seen.side, strike: seen.strike, entry: seen.entry, stopLoss: seen.stopLoss, target: seen.target },
        });
      }
    }
  }

  if (current) {
    await redis.set(seenKey, JSON.stringify(current), 'EX', 60 * 60 * 24 * 2);
  } else {
    await redis.del(seenKey);
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

async function maybeFireOnce(input: {
  symbol: string;
  exchange: string;
  alertType: SignalType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  condition: Record<string, unknown>;
}): Promise<void> {
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

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}
