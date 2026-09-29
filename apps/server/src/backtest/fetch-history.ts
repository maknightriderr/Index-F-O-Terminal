// ============================================================
// BACKTEST HISTORY SNAPSHOT (read-only)
// ============================================================
// Snapshots 15m (default) or 5m candles for the backtests into
// apps/server/backtest-data/ (gitignored; re-run this to reproduce).
// 15m snapshots are NAME.json; 5m snapshots are NAME.5m.json, so a 5m fetch
// never overwrites the 15m history the shipped reports were computed on.
//
// It talks to a running server's read-only history endpoint
// (GET /api/market/historical/:token), not to the broker, so it needs no
// broker credentials. The base URL is configurable with HISTORY_BASE_URL.
//
// Rules this file keeps on purpose:
//   - GET only. It never calls /api/market/bias/* (a bias read mints trade
//     setups) or any non-GET endpoint.
//   - Chunks of at most 60 days (5m on MCX: 40 days). The broker silently
//     truncates long ranges to the newest bars (~200 days of 15m; ~100 days
//     or ~8000 bars of 5m, and an MCX day is ~174 five-minute bars), so one
//     long request looks like success and quietly drops the oldest history.
//     Every chunk's first bar is checked against the chunk start and a late
//     start is reported as SUSPECT_TRUNCATED (never silently accepted).
//   - At least 2.5s between requests, because the broker's historical
//     endpoint is its most rate-limited one and the server shares it.
//
// Usage (from the repo root):
//   node ./node_modules/tsx/dist/cli.mjs apps/server/src/backtest/fetch-history.ts [--interval=5m] [--months=N] [NAME ...]
// With no names it fetches every target below. --interval defaults to 15m.
// --months overrides every target's months (the 5m fetch uses 6).
// ============================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HISTORY_BASE_URL = 'https://backend-production-59fe.up.railway.app';
export const MAX_CHUNK_DAYS = 60;
/** 5m chunk on MCX: a ~174-bar session × 40 days stays under the broker's ~8000-bar cap. */
export const MCX_5M_CHUNK_DAYS = 40;
export const MIN_REQUEST_GAP_MS = 2500;

export type FetchInterval = 'FIFTEEN_MINUTE' | 'FIVE_MINUTE';

/** CLI spelling → broker interval. */
export const INTERVAL_ALIASES: Record<string, FetchInterval> = { '15m': 'FIFTEEN_MINUTE', '5m': 'FIVE_MINUTE' };

/**
 * Chunk size per exchange and interval. 15m keeps its shipped 60 days
 * everywhere; 5m is 60 days on NSE/BSE (the broker allows ~100) and 40 on MCX,
 * whose longer session would otherwise hit the ~8000-bar cap.
 */
export function chunkDaysFor(exchange: FetchTarget['exchange'], interval: FetchInterval): number {
  if (interval === 'FIVE_MINUTE' && exchange === 'MCX') return MCX_5M_CHUNK_DAYS;
  return MAX_CHUNK_DAYS;
}

/** Snapshot file name: NAME.json for 15m (unchanged), NAME.5m.json for 5m. */
export function snapshotFileName(name: string, interval: FetchInterval = 'FIFTEEN_MINUTE'): string {
  return interval === 'FIVE_MINUTE' ? `${name}.5m.json` : `${name}.json`;
}

/**
 * A chunk whose first bar starts well after the chunk's own start is what a
 * silent broker truncation looks like (the broker keeps the NEWEST bars of a
 * too-long range). Weekends and holiday stretches are allowed for with
 * maxLeadDays. The caller reports it; it is never silently accepted.
 */
export function chunkLooksTruncated(chunkFrom: Date, firstBar: string | null, count: number, maxLeadDays = 5): boolean {
  if (count === 0 || !firstBar) return false;
  return Date.parse(firstBar) - chunkFrom.getTime() > maxLeadDays * 24 * 60 * 60 * 1000;
}

export interface HistoryBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FetchTarget {
  /** File name stem and report label, e.g. NIFTY_INDEX. */
  name: string;
  token: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  /** 'FO' for futures (NFO/BFO/MCX derivatives); omitted for index spot. */
  segment?: 'FO';
  months: number;
  /** Why this series is in the snapshot. */
  role: string;
}

export interface HistorySnapshot {
  name: string;
  token: string;
  exchange: string;
  segment: string | null;
  interval: FetchInterval;
  role: string;
  sourceBaseUrl: string;
  fetchedAt: string;
  requestedFrom: string;
  requestedTo: string;
  firstBar: string | null;
  lastBar: string | null;
  count: number;
  chunks: Array<{ from: string; to: string; count: number; firstBar?: string | null; lastBar?: string | null; suspectTruncated?: boolean; error?: string }>;
  /** Chunks whose first bar started suspiciously late (see chunkLooksTruncated). */
  suspectTruncatedChunks?: number;
  bars: HistoryBar[];
}

// Index spot series carry price but no volume; the live engine borrows the
// nearest future's volume bar for bar (withBorrowedVolume), and the backtest
// does the same, so each index has its near-month future alongside it.
// Exchange/segment follow the live code: index spot on NSE/BSE with no
// segment (loadBiasCandles), futures with segment FO (NFO/BFO), MCX with FO.
export const FETCH_TARGETS: FetchTarget[] = [
  { name: 'NIFTY_FUT', token: '68407', exchange: 'NSE', segment: 'FO', months: 12, role: 'NIFTY volume (Sep future, expires 29 Sep)' },
  { name: 'BANKNIFTY_FUT', token: '68390', exchange: 'NSE', segment: 'FO', months: 12, role: 'BANKNIFTY volume (Sep future, expires 29 Sep)' },
  { name: 'SENSEX_FUT', token: '864571', exchange: 'BSE', segment: 'FO', months: 12, role: 'SENSEX volume (near-month future)' },
  { name: 'CRUDEOIL', token: '569900', exchange: 'MCX', segment: 'FO', months: 12, role: 'CRUDEOIL price and volume (stitched near-month)' },
  { name: 'NIFTY_INDEX', token: '99926000', exchange: 'NSE', months: 12, role: 'NIFTY price' },
  { name: 'BANKNIFTY_INDEX', token: '99926009', exchange: 'NSE', months: 12, role: 'BANKNIFTY price' },
  { name: 'SENSEX_INDEX', token: '99919000', exchange: 'BSE', months: 12, role: 'SENSEX price' },
];

const IST_OFFSET_MS = 330 * 60 * 1000;

/** "YYYY-MM-DD HH:MM" in IST, the format the history endpoint expects. */
export function formatIst(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`;
}

/** Split [from, to] into consecutive windows of at most maxDays each. */
export function chunkRange(from: Date, to: Date, maxDays = MAX_CHUNK_DAYS): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  const span = maxDays * 24 * 60 * 60 * 1000;
  let start = from.getTime();
  while (start < to.getTime()) {
    const end = Math.min(start + span, to.getTime());
    out.push({ from: new Date(start), to: new Date(end) });
    // One minute past the previous window's end, so the same bar is never
    // requested twice (duplicates are dropped anyway, see mergeBars).
    start = end + 60 * 1000;
  }
  return out;
}

/** Merge chunk results: dedupe by timestamp and sort ascending. */
export function mergeBars(chunks: HistoryBar[][]): HistoryBar[] {
  const byTs = new Map<string, HistoryBar>();
  for (const chunk of chunks) for (const bar of chunk) byTs.set(bar.timestamp, bar);
  return [...byTs.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await fn();
  } finally {
    lastRequestAt = Date.now();
  }
}

async function getJson(url: string): Promise<any> {
  return paced(async () => {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}: non-JSON body (${text.slice(0, 120)})`);
    }
    if (!res.ok || body?.success === false) {
      throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? 'request failed'}`);
    }
    return body;
  });
}

async function fetchChunk(baseUrl: string, t: FetchTarget, from: Date, to: Date, interval: FetchInterval): Promise<HistoryBar[]> {
  const qs = new URLSearchParams({ exchange: t.exchange, interval, from: formatIst(from), to: formatIst(to) });
  if (t.segment) qs.set('segment', t.segment);
  const url = `${baseUrl}/api/market/historical/${encodeURIComponent(t.token)}?${qs.toString()}`;
  // An empty window is a legitimate answer (a holiday stretch, or before the
  // series starts), but it is also what a broker rate-limit looks like, so
  // one retry after a longer pause before believing it.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = await getJson(url);
      const bars = (body.data ?? []) as HistoryBar[];
      if (bars.length > 0 || attempt >= 2) return bars;
      console.warn(`  ${t.name} ${formatIst(from)} → ${formatIst(to)}: empty, retrying once`);
    } catch (err: any) {
      console.warn(`  ${t.name} ${formatIst(from)} → ${formatIst(to)}: attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 3) throw err;
    }
    await sleep(MIN_REQUEST_GAP_MS * 2);
  }
  return [];
}

export async function fetchTarget(baseUrl: string, t: FetchTarget, now = new Date(), interval: FetchInterval = 'FIFTEEN_MINUTE'): Promise<HistorySnapshot> {
  const from = new Date(now.getTime() - t.months * 30.5 * 24 * 60 * 60 * 1000);
  const chunks = chunkRange(from, now, chunkDaysFor(t.exchange, interval));
  const results: HistoryBar[][] = [];
  const chunkMeta: HistorySnapshot['chunks'] = [];
  // Newest first, so if the run is interrupted the most recent (and, for
  // expiring contracts, most perishable) history is already on disk.
  for (const c of [...chunks].reverse()) {
    try {
      const bars = await fetchChunk(baseUrl, t, c.from, c.to, interval);
      results.push(bars);
      if (interval === 'FIFTEEN_MINUTE') {
        // The shipped 15m snapshot format, unchanged.
        chunkMeta.push({ from: formatIst(c.from), to: formatIst(c.to), count: bars.length });
        console.log(`  ${t.name} ${formatIst(c.from)} → ${formatIst(c.to)}: ${bars.length} bars`);
        continue;
      }
      const firstBar = bars[0]?.timestamp ?? null;
      const lastBar = bars[bars.length - 1]?.timestamp ?? null;
      const suspectTruncated = chunkLooksTruncated(c.from, firstBar, bars.length);
      chunkMeta.push({ from: formatIst(c.from), to: formatIst(c.to), count: bars.length, firstBar, lastBar, suspectTruncated });
      console.log(`  ${t.name} ${formatIst(c.from)} → ${formatIst(c.to)}: ${bars.length} bars (${firstBar ?? '—'} → ${lastBar ?? '—'})`);
      if (suspectTruncated) console.error(`  ${t.name} ${formatIst(c.from)} → ${formatIst(c.to)}: SUSPECT_TRUNCATED — first bar ${firstBar} is more than 5 days after the chunk start`);
    } catch (err: any) {
      chunkMeta.push({ from: formatIst(c.from), to: formatIst(c.to), count: 0, error: err.message });
      console.error(`  ${t.name} ${formatIst(c.from)} → ${formatIst(c.to)}: FAILED ${err.message}`);
    }
  }
  const bars = mergeBars(results);
  return {
    name: t.name,
    token: t.token,
    exchange: t.exchange,
    segment: t.segment ?? null,
    interval,
    role: t.role,
    sourceBaseUrl: baseUrl,
    fetchedAt: now.toISOString(),
    requestedFrom: formatIst(from),
    requestedTo: formatIst(now),
    firstBar: bars[0]?.timestamp ?? null,
    lastBar: bars[bars.length - 1]?.timestamp ?? null,
    count: bars.length,
    chunks: chunkMeta.reverse(),
    ...(interval === 'FIFTEEN_MINUTE' ? {} : { suspectTruncatedChunks: chunkMeta.filter((c) => c.suspectTruncated).length }),
    bars,
  };
}

/**
 * GOLD is included only if its near-month future resolves read-only through
 * the futures panel endpoint (GET /api/futures/GOLD?exchange=MCX).
 */
export async function resolveGoldTarget(baseUrl: string, months = 12): Promise<{ target?: FetchTarget; reason: string }> {
  try {
    const body = await getJson(`${baseUrl}/api/futures/GOLD?exchange=MCX`);
    const contracts = (body?.data?.contracts ?? []) as Array<{ token: string; symbol: string; expiryLabel: string; expiry: string }>;
    const near = contracts.find((c) => c.expiryLabel === 'current') ?? contracts[0];
    if (!near?.token) return { reason: 'futures endpoint returned no GOLD contracts' };
    return {
      target: { name: 'GOLD', token: near.token, exchange: 'MCX', segment: 'FO', months, role: `GOLD price and volume (${near.symbol}, expiry ${near.expiry})` },
      reason: `resolved ${near.symbol} token ${near.token}`,
    };
  } catch (err: any) {
    return { reason: `GOLD futures did not resolve: ${err.message}` };
  }
}

export const BACKTEST_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../backtest-data');

/** `--interval=5m`, `--months=6` and target names, from argv. */
export function parseFetchArgs(argv: readonly string[]): { interval: FetchInterval; months: number | null; names: Set<string> } {
  let interval: FetchInterval = 'FIFTEEN_MINUTE';
  let months: number | null = null;
  const names = new Set<string>();
  for (const a of argv) {
    const m = /^--(interval|months)=(.+)$/.exec(a);
    if (m?.[1] === 'interval') {
      const iv = INTERVAL_ALIASES[m[2].toLowerCase()] ?? (m[2] === 'FIFTEEN_MINUTE' || m[2] === 'FIVE_MINUTE' ? m[2] : null);
      if (!iv) throw new Error(`unknown --interval ${m[2]} (use 15m or 5m)`);
      interval = iv;
    } else if (m?.[1] === 'months') {
      const n = Number(m[2]);
      if (!(n > 0 && n <= 12)) throw new Error(`--months must be in (0, 12], got ${m[2]}`);
      months = n;
    } else names.add(a.toUpperCase());
  }
  return { interval, months, names };
}

async function main() {
  const baseUrl = (process.env.HISTORY_BASE_URL ?? DEFAULT_HISTORY_BASE_URL).replace(/\/+$/, '');
  const { interval, months, names: wanted } = parseFetchArgs(process.argv.slice(2));
  mkdirSync(BACKTEST_DATA_DIR, { recursive: true });

  const targets = FETCH_TARGETS.filter((t) => wanted.size === 0 || wanted.has(t.name)).map((t) => (months != null ? { ...t, months } : t));
  if (wanted.size === 0 || wanted.has('GOLD')) {
    const gold = await resolveGoldTarget(baseUrl, months ?? 12);
    console.log(`GOLD: ${gold.reason}`);
    // A 5m run keeps its own resolve record; the 15m one is left untouched.
    const resolveFile = interval === 'FIFTEEN_MINUTE' ? 'GOLD.resolve.json' : 'GOLD.resolve.5m.json';
    writeFileSync(join(BACKTEST_DATA_DIR, resolveFile), JSON.stringify({ at: new Date().toISOString(), ...gold }, null, 2));
    if (gold.target) targets.push(gold.target);
  }

  for (const t of targets) {
    console.log(`Fetching ${t.name} (token ${t.token}, ${t.exchange}${t.segment ? '/' + t.segment : ''}, ${t.months} months, ${interval}, ${chunkDaysFor(t.exchange, interval)}-day chunks)`);
    const snap = await fetchTarget(baseUrl, t, new Date(), interval);
    const file = join(BACKTEST_DATA_DIR, snapshotFileName(t.name, interval));
    writeFileSync(file, JSON.stringify(snap));
    console.log(`  saved ${snap.count} bars (${snap.firstBar} → ${snap.lastBar}) to ${file}`);
    if (snap.suspectTruncatedChunks) console.error(`  ${t.name}: ${snap.suspectTruncatedChunks} chunk(s) SUSPECT_TRUNCATED — re-fetch with smaller chunks before using this file`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('History snapshot failed:', err);
    process.exit(1);
  });
}
