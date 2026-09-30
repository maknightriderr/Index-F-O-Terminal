// ============================================================
// Fetch India VIX daily closes (read-only), for the SWEEP_CLOSE option-cost
// model's NSE-index volatility input (see research/option-cost.ts).
//
// GET /api/market/historical/99926017?exchange=NSE&interval=ONE_DAY, chunked
// to <= 60 days, >= 2.5s apart (same discipline as fetch-history.ts). Never
// calls anything but this one read-only endpoint. Writes
// apps/server/backtest-data/INDIAVIX.json (gitignored).
//
// Usage: node ./node_modules/tsx/dist/cli.mjs apps/server/src/cli/fetch-india-vix.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
// ============================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HISTORY_BASE_URL, MIN_REQUEST_GAP_MS, formatIst, chunkRange, mergeBars, BACKTEST_DATA_DIR, type HistoryBar } from '../backtest/fetch-history.js';

const INDIA_VIX_TOKEN = '99926017';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON body (${text.slice(0, 200)})`);
  }
  if (!res.ok || body?.success === false) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? 'request failed'}`);
  return body;
}

function parseArg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const baseUrl = process.env.HISTORY_BASE_URL ?? DEFAULT_HISTORY_BASE_URL;
  const from = new Date(`${parseArg('from') ?? '2025-09-01'}T00:00:00+05:30`);
  const to = new Date(`${parseArg('to') ?? new Date().toISOString().slice(0, 10)}T23:59:59+05:30`);
  const windows = chunkRange(from, to, 60);
  console.log(`Fetching India VIX (${INDIA_VIX_TOKEN}) daily closes: ${windows.length} chunk(s) of <=60 days, >=2.5s apart.`);

  const chunks: HistoryBar[][] = [];
  for (const w of windows) {
    const qs = new URLSearchParams({ exchange: 'NSE', interval: 'ONE_DAY', from: formatIst(w.from), to: formatIst(w.to) });
    const url = `${baseUrl}/api/market/historical/${INDIA_VIX_TOKEN}?${qs.toString()}`;
    console.log(`  GET ${url}`);
    const body = await getJson(url);
    const bars = (body.data ?? []) as HistoryBar[];
    console.log(`    -> ${bars.length} bars`);
    chunks.push(bars);
    await sleep(MIN_REQUEST_GAP_MS + 200);
  }

  const merged = mergeBars(chunks);
  const out = { name: 'INDIAVIX', token: INDIA_VIX_TOKEN, exchange: 'NSE', interval: 'ONE_DAY', fetchedAt: new Date().toISOString(), bars: merged };
  const file = join(BACKTEST_DATA_DIR, 'INDIAVIX.json');
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file} (${merged.length} daily bars, ${merged[0]?.timestamp} .. ${merged[merged.length - 1]?.timestamp})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
