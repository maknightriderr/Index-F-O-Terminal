// ============================================================
// Calibrate the SWEEP_CLOSE option-cost model's spread % and lot size from
// the LIVE option chain (read-only), one GET per symbol, per the plan.
//
// GET /api/option-chain/<SYM>?exchange=<EX> (NSE for NIFTY/BANKNIFTY, BSE for
// SENSEX, MCX for CRUDEOIL/GOLD). Spread% = median (ask-bid)/mid of the 3
// strikes nearest ATM (call leg; if the call leg is missing/zero-priced for
// a strike, the put leg is used instead). Never calls anything but this
// endpoint, and never a non-GET route. Writes
// apps/server/backtest-data/option-chain-calibration.json (gitignored).
//
// Usage: node ./node_modules/tsx/dist/cli.mjs apps/server/src/cli/fetch-option-chain-calibration.ts
// ============================================================

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HISTORY_BASE_URL, BACKTEST_DATA_DIR } from '../backtest/fetch-history.js';

const TARGETS: Array<{ symbol: string; exchange: string }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX' },
  { symbol: 'GOLD', exchange: 'MCX' },
];

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

function legSpreadPct(leg: { bid: number; ask: number } | null): number | null {
  if (!leg || !(leg.bid > 0) || !(leg.ask > 0) || leg.ask < leg.bid) return null;
  const mid = (leg.bid + leg.ask) / 2;
  return mid > 0 ? (leg.ask - leg.bid) / mid : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const baseUrl = process.env.HISTORY_BASE_URL ?? DEFAULT_HISTORY_BASE_URL;
  const out: Record<string, { spreadPct: number; lotSize: number; atmStrike: number; sampledAt: string; strikesUsed: number[]; note?: string }> = {};

  for (const t of TARGETS) {
    const url = `${baseUrl}/api/option-chain/${t.symbol}?exchange=${t.exchange}`;
    console.log(`GET ${url}`);
    const body = await getJson(url);
    const chain = body.data;
    const atmStrike: number = chain.atmStrike;
    const lotSize: number = chain.lotSize ?? 1;
    const strikes: Array<{ strike: number; call: any; put: any }> = chain.strikes ?? [];
    const nearest = [...strikes].sort((a, b) => Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike)).slice(0, 3);
    const spreads = nearest.map((s) => legSpreadPct(s.call) ?? legSpreadPct(s.put)).filter((x): x is number => x != null);
    const spreadPct = median(spreads);
    if (spreadPct == null) {
      console.warn(`  WARNING: no usable bid/ask near ATM for ${t.symbol}; leaving unset (report will flag this)`);
      out[t.symbol] = { spreadPct: NaN, lotSize, atmStrike, sampledAt: new Date().toISOString(), strikesUsed: nearest.map((s) => s.strike), note: 'no live bid/ask available at calibration time' };
      continue;
    }
    console.log(`  atmStrike=${atmStrike} lotSize=${lotSize} spreadPct=${(spreadPct * 100).toFixed(2)}% (n=${spreads.length})`);
    out[t.symbol] = { spreadPct, lotSize, atmStrike, sampledAt: new Date().toISOString(), strikesUsed: nearest.map((s) => s.strike) };
  }

  const file = join(BACKTEST_DATA_DIR, 'option-chain-calibration.json');
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
