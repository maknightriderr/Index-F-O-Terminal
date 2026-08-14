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
import type { MarketDataProvider } from '../providers/interface.js';
import type { AlertChannel, BiasDirection, OptionType, SignalType } from '@fno/shared';

const SCAN_INTERVAL_MS = 120_000; // 2 minutes
const INITIAL_DELAY_MS = 30_000; // let the provider/cache warm up after boot before the first tick
const SCANNER_CACHE_TTL_SECONDS = 180; // must match instruments.ts's fno-scanner cache TTL — same key, shared cache

const OI_CHANGE_PCT_THRESHOLD = 8;
const IV_RANK_SPIKE_THRESHOLD = 85;
const IV_RANK_CRUSH_THRESHOLD = 15;

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
  await Promise.all([checkOiAndIvAlerts(provider), checkTradeSetupAlerts()]);
}

// --- OI / IV extremes (universe scan) ---

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

  for (const row of rows) {
    if (row.futuresOi > 0 && Math.abs(row.futuresChangeOiPercent) >= OI_CHANGE_PCT_THRESHOLD) {
      const direction = row.futuresChangeOiPercent > 0 ? 'built up' : 'unwound';
      await maybeFireDailyAlert({
        dedupeKey: `alert_sent:FUTURES_OI_SPIKE:${row.symbol}:${today}`,
        symbol: row.symbol,
        exchange: row.exchange,
        alertType: 'FUTURES_OI_SPIKE',
        severity: 'WARNING',
        message: `⚡ ${row.symbol}: futures OI ${direction} ${row.futuresChangeOiPercent >= 0 ? '+' : ''}${row.futuresChangeOiPercent.toFixed(1)}% today (${row.oiInterpretation.replace(/_/g, ' ').toLowerCase()})`,
        condition: { threshold: OI_CHANGE_PCT_THRESHOLD, futuresChangeOiPercent: row.futuresChangeOiPercent, oiInterpretation: row.oiInterpretation },
      });
    }

    if (row.ivRank != null) {
      if (row.ivRank >= IV_RANK_SPIKE_THRESHOLD) {
        await maybeFireDailyAlert({
          dedupeKey: `alert_sent:IV_SPIKE:${row.symbol}:${today}`,
          symbol: row.symbol,
          exchange: row.exchange,
          alertType: 'IV_SPIKE',
          severity: 'WARNING',
          message: `📈 ${row.symbol}: IV Rank at ${row.ivRank} — options unusually expensive vs its own recent range (ATM IV ${row.atmIv.toFixed(1)}%)`,
          condition: { threshold: IV_RANK_SPIKE_THRESHOLD, ivRank: row.ivRank, atmIv: row.atmIv },
        });
      } else if (row.ivRank <= IV_RANK_CRUSH_THRESHOLD) {
        await maybeFireDailyAlert({
          dedupeKey: `alert_sent:IV_CRUSH:${row.symbol}:${today}`,
          symbol: row.symbol,
          exchange: row.exchange,
          alertType: 'IV_CRUSH',
          severity: 'INFO',
          message: `📉 ${row.symbol}: IV Rank at ${row.ivRank} — options unusually cheap vs its own recent range (ATM IV ${row.atmIv.toFixed(1)}%)`,
          condition: { threshold: IV_RANK_CRUSH_THRESHOLD, ivRank: row.ivRank, atmIv: row.atmIv },
        });
      }
    }
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
  // key shape: trade_setup:{exchange}:{underlying}
  const [, exchange, underlying] = key.split(':');
  if (!exchange || !underlying) return;

  const seenKey = `alert_setup_seen:${exchange}:${underlying}`;

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
          message: `🎯 ${underlying}: Trade Setup closed — ${seen.side} ${seen.strike} (Entry ₹${seen.entry} · SL ₹${seen.stopLoss} · Target ₹${seen.target}) hit its stop-loss or target`,
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
          message: `${underlying}: Trade Setup ended — ${seen.side} ${seen.strike} (bias shifted or the session rolled over)`,
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
