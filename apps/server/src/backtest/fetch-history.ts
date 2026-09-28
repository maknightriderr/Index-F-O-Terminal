// ============================================================
// BACKTEST HISTORY SNAPSHOT (read-only)
// ============================================================
// Snapshots 15m candles for the momentum-break backtest into
// apps/server/backtest-data/ (gitignored; re-run this to reproduce).
//
// It talks to a running server's read-only history endpoint
// (GET /api/market/historical/:token), not to the broker, so it needs no
// broker credentials. The base URL is configurable with HISTORY_BASE_URL.
//
// Rules this file keeps on purpose:
//   - GET only. It never calls /api/market/bias/* (a bias read mints trade
//     setups) or any non-GET endpoint.
//   - Chunks of at most 60 days. The broker silently truncates long ranges
//     to the newest ~200 days of 15m bars, so one long request looks like
//     success and quietly drops the oldest history.
//   - At least 2.5s between requests, because the broker's historical
//     endpoint is its most rate-limited one and the server shares it.
//
// Usage (from the repo root):
//   node ./node_modules/tsx/dist/cli.mjs apps/server/src/backtest/fetch-history.ts [NAME ...]
// With no names it fetches every target below.
// ============================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HISTORY_BASE_URL = 'https://backend-production-59fe.up.railway.app';
export const MAX_CHUNK_DAYS = 60;
export const MIN_REQUEST_GAP_MS = 2500;

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
  interval: 'FIFTEEN_MINUTE';
  role: string;
  sourceBaseUrl: string;
  fetchedAt: string;
  requestedFrom: string;
  requestedTo: string;
  firstBar: string | null;
  lastBar: string | null;
  count: number;
  chunks: Array<{ from: string; to: string; count: number; error?: string }>;
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

async function fetchChunk(baseUrl: string, t: FetchTarget, from: Date, to: Date): Promise<HistoryBar[]> {
  const qs = new URLSearchParams({ exchange: t.exchange, interval: 'FIFTEEN_MINUTE', from: formatIst(from), to: formatIst(to) });
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

export async function fetchTarget(baseUrl: string, t: FetchTarget, now = new Date()): Promise<HistorySnapshot> {
  const from = new Date(now.getTime() - t.months * 30.5 * 24 * 60 * 60 * 1000);
  const chunks = chunkRange(from, now);
  const results: HistoryBar[][] = [];
  const chunkMeta: HistorySnapshot['chunks'] = [];
  // Newest first, so if the run is interrupted the most recent (and, for
  // expiring contracts, most perishable) history is already on disk.
  for (const c of [...chunks].reverse()) {
    try {
      const bars = await fetchChunk(baseUrl, t, c.from, c.to);
      results.push(bars);
      chunkMeta.push({ from: formatIst(c.from), to: formatIst(c.to), count: bars.length });
      console.log(`  ${t.name} ${formatIst(c.from)} → ${formatIst(c.to)}: ${bars.length} bars`);
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
    interval: 'FIFTEEN_MINUTE',
    role: t.role,
    sourceBaseUrl: baseUrl,
    fetchedAt: now.toISOString(),
    requestedFrom: formatIst(from),
    requestedTo: formatIst(now),
    firstBar: bars[0]?.timestamp ?? null,
    lastBar: bars[bars.length - 1]?.timestamp ?? null,
    count: bars.length,
    chunks: chunkMeta.reverse(),
    bars,
  };
}

/**
 * GOLD is included only if its near-month future resolves read-only through
 * the futures panel endpoint (GET /api/futures/GOLD?exchange=MCX).
 */
export async function resolveGoldTarget(baseUrl: string): Promise<{ target?: FetchTarget; reason: string }> {
  try {
    const body = await getJson(`${baseUrl}/api/futures/GOLD?exchange=MCX`);
    const contracts = (body?.data?.contracts ?? []) as Array<{ token: string; symbol: string; expiryLabel: string; expiry: string }>;
    const near = contracts.find((c) => c.expiryLabel === 'current') ?? contracts[0];
    if (!near?.token) return { reason: 'futures endpoint returned no GOLD contracts' };
    return {
      target: { name: 'GOLD', token: near.token, exchange: 'MCX', segment: 'FO', months: 12, role: `GOLD price and volume (${near.symbol}, expiry ${near.expiry})` },
      reason: `resolved ${near.symbol} token ${near.token}`,
    };
  } catch (err: any) {
    return { reason: `GOLD futures did not resolve: ${err.message}` };
  }
}

export const BACKTEST_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../backtest-data');

async function main() {
  const baseUrl = (process.env.HISTORY_BASE_URL ?? DEFAULT_HISTORY_BASE_URL).replace(/\/+$/, '');
  const wanted = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
  mkdirSync(BACKTEST_DATA_DIR, { recursive: true });

  const targets = FETCH_TARGETS.filter((t) => wanted.size === 0 || wanted.has(t.name));
  if (wanted.size === 0 || wanted.has('GOLD')) {
    const gold = await resolveGoldTarget(baseUrl);
    console.log(`GOLD: ${gold.reason}`);
    writeFileSync(join(BACKTEST_DATA_DIR, 'GOLD.resolve.json'), JSON.stringify({ at: new Date().toISOString(), ...gold }, null, 2));
    if (gold.target) targets.push(gold.target);
  }

  for (const t of targets) {
    console.log(`Fetching ${t.name} (token ${t.token}, ${t.exchange}${t.segment ? '/' + t.segment : ''}, ${t.months} months)`);
    const snap = await fetchTarget(baseUrl, t);
    const file = join(BACKTEST_DATA_DIR, `${t.name}.json`);
    writeFileSync(file, JSON.stringify(snap));
    console.log(`  saved ${snap.count} bars (${snap.firstBar} → ${snap.lastBar}) to ${file}`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('History snapshot failed:', err);
    process.exit(1);
  });
}
