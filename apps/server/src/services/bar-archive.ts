// ============================================================
// BAR ARCHIVE — persisted 15-minute and daily bars (2026-10-15)
// ============================================================
// Research only. Nothing in the decision path reads bar_archive (migration
// 041); this job only writes it.
//
// Why: the 2026-10-15 audit found no stored price history, so no strategy or
// gate could be tested on more than a few weeks of forward paper trades. The
// bars the engines read every day were fetched, cached for minutes and lost.
//
// What: after a session is over, the closed 15-minute bars and the daily bar
// of every symbol the engines evaluated that day (decision_snapshots) plus the
// main indices, from the broker's own history endpoint, one row per bar.
//
// When: only while NO exchange is trading (after the MCX close, before the
// NSE open), so the broker's rate-limited history endpoint is never shared
// with a live decision. Requests are spaced like the backtest fetcher's, a
// pass is capped, and a symbol-day archived once is never fetched again.
// A failure is logged and retried next pass; it never touches trading.
// ============================================================

import { getSessionWindow, isMarketOpen, type Exchange, type OHLCV } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { resolveSpotToken } from './option-chain.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const BAR_ARCHIVE_MIGRATION = '041_bar_archive.sql';

const TICK_MS = 30 * 60_000;
const INITIAL_DELAY_MS = 15 * 60_000;
/** Spacing between broker history requests (the backtest fetcher's own rule). */
const REQUEST_SPACING_MS = 2_500;
/** Symbol-days per pass: keeps one pass to about ten minutes of broker calls. */
const MAX_SYMBOL_DAYS_PER_PASS = 120;
/** How many IST calendar days back a pass looks for sessions not yet archived. */
export const ARCHIVE_PENDING_DAYS = 3;
/** Always archived, whatever was evaluated that day. */
export const ALWAYS_ARCHIVED: ReadonlyArray<{ symbol: string; exchange: Exchange }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'FINNIFTY', exchange: 'NSE' },
  { symbol: 'MIDCPNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX' },
  { symbol: 'GOLD', exchange: 'MCX' },
];

const istDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Pure: true while no exchange is in session, the only time the archive may call the broker. */
export function archiveWindowOpen(now: number, open: (exchange: Exchange, at: number) => boolean = (e, at) => isMarketOpen(e, at)): boolean {
  return !(['NSE', 'BSE', 'MCX'] as Exchange[]).some((e) => open(e, now));
}

/** Pure: IST dates in the last ARCHIVE_PENDING_DAYS whose session on `exchange` existed and is over. Oldest first. */
export function archivableDates(exchange: Exchange, now: number, days = ARCHIVE_PENDING_DAYS): string[] {
  const out: string[] = [];
  for (let back = days; back >= 0; back--) {
    const date = istDate(now - back * 86_400_000);
    const w = getSessionWindow(exchange, date);
    if (w && now > w.close) out.push(date);
  }
  return [...new Set(out)];
}

export interface ArchiveRow {
  symbol: string;
  exchange: Exchange;
  interval: '15m' | '1d';
  bar_time: Date;
  token: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** Pure: the broker candles of one IST date as archive rows; malformed bars (non-finite, high < low) are dropped. */
export function archiveRowsOf(symbol: string, exchange: Exchange, interval: '15m' | '1d', token: string, date: string, candles: readonly OHLCV[]): ArchiveRow[] {
  return candles
    .map((c) => ({ c, t: Date.parse(c.timestamp) }))
    .filter(({ c, t }) => Number.isFinite(t) && istDate(t) === date && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= c.low)
    .map(({ c, t }) => ({ symbol, exchange, interval, bar_time: new Date(t), token, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number.isFinite(c.volume) ? c.volume : null }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const angelTime = (d: Date) => {
  const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
};

/** The symbols worth archiving for one IST date: everything the engines evaluated that day, plus the fixed list. */
async function symbolsFor(date: string): Promise<Array<{ symbol: string; exchange: Exchange }>> {
  const rows = await sql<{ symbol: string; exchange: string }[]>`
    SELECT DISTINCT symbol, exchange FROM decision_snapshots
    WHERE time >= ${new Date(`${date}T00:00:00+05:30`)} AND time < ${new Date(`${date}T23:59:59+05:30`)}
  `;
  const all = [...ALWAYS_ARCHIVED, ...rows.map((r) => ({ symbol: r.symbol, exchange: r.exchange as Exchange }))];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(`${s.exchange}:${s.symbol}`) ? false : (seen.add(`${s.exchange}:${s.symbol}`), true)));
}

async function archivedFor(date: string): Promise<Set<string>> {
  const rows = await sql<{ symbol: string; exchange: string }[]>`
    SELECT DISTINCT symbol, exchange FROM bar_archive
    WHERE interval = '15m' AND bar_time >= ${new Date(`${date}T00:00:00+05:30`)} AND bar_time < ${new Date(`${date}T23:59:59+05:30`)}
  `;
  return new Set(rows.map((r) => `${r.exchange}:${r.symbol}`));
}

async function insertRows(rows: readonly ArchiveRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await sql`
    INSERT INTO bar_archive ${sql(rows as ArchiveRow[], 'symbol', 'exchange', 'interval', 'bar_time', 'token', 'open', 'high', 'low', 'close', 'volume')}
    ON CONFLICT (symbol, exchange, interval, bar_time) DO NOTHING
  `;
  return inserted.count ?? 0;
}

/** One archive pass. Exported for the job and for an operator's manual run. */
export async function runBarArchivePass(provider: MarketDataProvider, now = Date.now()): Promise<{ symbolDays: number; bars: number; skipped: string | null }> {
  if (!schemaFileReady(BAR_ARCHIVE_MIGRATION)) return { symbolDays: 0, bars: 0, skipped: 'SCHEMA_NOT_READY' };
  if (!archiveWindowOpen(now)) return { symbolDays: 0, bars: 0, skipped: 'SESSION_OPEN' };
  if (!provider.isAuthenticated()) return { symbolDays: 0, bars: 0, skipped: 'NOT_AUTHENTICATED' };
  let symbolDays = 0;
  let bars = 0;
  const dates = [...new Set((['NSE', 'BSE', 'MCX'] as Exchange[]).flatMap((e) => archivableDates(e, now)))].sort();
  for (const date of dates) {
    const done = await archivedFor(date);
    for (const s of await symbolsFor(date)) {
      if (symbolDays >= MAX_SYMBOL_DAYS_PER_PASS || !archiveWindowOpen(Date.now())) return { symbolDays, bars, skipped: null };
      const w = getSessionWindow(s.exchange, date);
      if (!w || Date.now() <= w.close || done.has(`${s.exchange}:${s.symbol}`)) continue;
      try {
        const token = await resolveSpotToken(provider, s.symbol, s.exchange);
        const from = new Date(`${date}T00:00:00+05:30`);
        const to = new Date(`${date}T23:59:00+05:30`);
        const m15 = await provider.getHistoricalData({ exchange: s.exchange, token, interval: 'FIFTEEN_MINUTE', fromDate: angelTime(from), toDate: angelTime(to) });
        await sleep(REQUEST_SPACING_MS);
        const d1 = await provider.getHistoricalData({ exchange: s.exchange, token, interval: 'ONE_DAY', fromDate: angelTime(from), toDate: angelTime(to) });
        await sleep(REQUEST_SPACING_MS);
        bars += await insertRows([...archiveRowsOf(s.symbol, s.exchange, '15m', token, date, m15), ...archiveRowsOf(s.symbol, s.exchange, '1d', token, date, d1)]);
        symbolDays++;
      } catch (err: any) {
        logger.warn({ error: err.message, symbol: s.symbol, exchange: s.exchange, date }, 'Bar archive: symbol-day failed (retried next pass)');
        await sleep(REQUEST_SPACING_MS);
      }
    }
  }
  return { symbolDays, bars, skipped: null };
}

let started = false;

export function startBarArchive(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runBarArchivePass(provider)
      .then((r) => {
        if (r.symbolDays > 0) logger.info(r, 'Bar archive pass complete');
      })
      .catch((err: any) => logger.warn({ error: err.message }, 'Bar archive: pass failed'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);
  logger.info({ intervalMinutes: TICK_MS / 60_000 }, 'Bar archive started (writes only while no exchange is trading)');
}
