// ============================================================
// ORDER BLOCK SHADOW / ORDER FLOW / OF1 — switches (2026-10-09)
// ============================================================
// Kept apart from trading-flags.ts on purpose: nothing here changes what the
// live strategies decide, so the live logic stamp and the decision config
// hash are untouched.
//
//   ORDER_BLOCK_MODE  SHADOW (default) — the indicator's live vote keeps the
//                     frozen legacy detector; OB-2.0 is computed and recorded
//                     beside it. OFF — nothing recorded. LIVE is not a setting:
//                     putting OB-2.0 into the vote is a code change made only
//                     on its forward evidence; a LIVE request is logged and
//                     ignored (SHADOW).
//   OF1_ENABLED       true (default) — OF1 candidates are evaluated and recorded.
//   OF1_TRADING       false — OF1 never creates a paper trade. A request for
//                     true is logged and ignored: trading needs a code-level
//                     promotion on forward evidence, like every trigger family.
//   ORDER_FLOW_SYMBOLS  NIFTY,BANKNIFTY (default). MCX symbols are refused
//                     until the Dhan MCX feed has been verified.
//   DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN  the Dhan market-feed credentials (data
//                     only — no order API is ever called). Absent → the feed is
//                     NOT_CONFIGURED and every order-flow measure UNAVAILABLE.
// ============================================================

import { parseFlag } from './trading-flags.js';

export type OrderBlockMode = 'SHADOW' | 'OFF';

export function parseOrderBlockMode(raw: string | undefined): { value: OrderBlockMode; rejected: string | null } {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === '' || v === 'SHADOW') return { value: 'SHADOW', rejected: null };
  if (v === 'OFF') return { value: 'OFF', rejected: null };
  return { value: 'SHADOW', rejected: raw ?? null };
}
const parsedObMode = parseOrderBlockMode(process.env.ORDER_BLOCK_MODE);
export const ORDER_BLOCK_MODE: OrderBlockMode = parsedObMode.value;
/** A rejected ORDER_BLOCK_MODE value (e.g. LIVE) — logged at boot. */
export const ORDER_BLOCK_MODE_REJECTED = parsedObMode.rejected;

export const OF1_ENABLED: boolean = parseFlag(process.env.OF1_ENABLED, true);
/** Shadow only: OF1 never trades in this release, whatever the environment says. */
export const OF1_TRADING = false as const;
export const OF1_TRADING_REQUESTED: boolean = parseFlag(process.env.OF1_TRADING, false);

export const ORDER_FLOW_DEFAULT_SYMBOLS = ['NIFTY', 'BANKNIFTY'] as const;
/** Symbols whose Dhan order flow has been verified (NSE index futures). */
export const ORDER_FLOW_VERIFIED_SYMBOLS: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);

export function parseOrderFlowSymbols(raw: string | undefined): { symbols: string[]; rejected: string[] } {
  const asked = (raw == null || raw.trim() === '' ? [...ORDER_FLOW_DEFAULT_SYMBOLS] : raw.split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return { symbols: asked.filter((s) => ORDER_FLOW_VERIFIED_SYMBOLS.has(s)), rejected: asked.filter((s) => !ORDER_FLOW_VERIFIED_SYMBOLS.has(s)) };
}
const parsedSymbols = parseOrderFlowSymbols(process.env.ORDER_FLOW_SYMBOLS);
export const ORDER_FLOW_SYMBOLS: readonly string[] = Object.freeze(parsedSymbols.symbols);
export const ORDER_FLOW_SYMBOLS_REJECTED: readonly string[] = Object.freeze(parsedSymbols.rejected);

/** Volume-by-price bucket (index points) per symbol. */
export const ORDER_FLOW_PRICE_STEP: Readonly<Record<string, number>> = Object.freeze({ NIFTY: 5, BANKNIFTY: 10, FINNIFTY: 5, MIDCPNIFTY: 5 });

export function dhanCredentials(env: NodeJS.ProcessEnv = process.env): { clientId: string; accessToken: string } | null {
  const clientId = env.DHAN_CLIENT_ID?.trim();
  const accessToken = env.DHAN_ACCESS_TOKEN?.trim();
  return clientId && accessToken ? { clientId, accessToken } : null;
}
