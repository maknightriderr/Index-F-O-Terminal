// ============================================================
// ORDER BLOCK (OB1) / ORDER FLOW / OF1 — switches (2026-10-09)
// ============================================================
// Kept apart from trading-flags.ts: the existing strategies' own logic and
// the decision config hash are untouched. While OB1 / OF1 may paper-trade the
// live logic stamp carries orderFlowLogicSuffix() (the candidate pool changed).
//
//   ORDER_BLOCK_MODE  PAPER (default, user decision 2026-10-09) — OB-2.0 is
//                     also a paper candidate source (OB1) in the slot
//                     arbitration, through the same chain as every trigger
//                     family. SHADOW — recorded only, never traded (rollback
//                     without a deploy). OFF — nothing recorded. In every mode
//                     the INDICATOR ENGINE's own structure vote keeps the frozen
//                     legacy detector (the indicator is unchanged); LIVE (OB-2.0
//                     inside the indicator vote) is not a setting.
//   OF1_ENABLED       true (default) — OF1 candidates are evaluated and recorded.
//   OF1_TRADING       true (default, user decision 2026-10-09) — OF1 is a paper
//                     candidate source in the slot arbitration; false = shadow
//                     only (rollback without a deploy). Paper only: nothing
//                     here, or anywhere in the terminal, places a broker order.
//   ORDER_FLOW_SYMBOLS  NIFTY,BANKNIFTY,CRUDEOIL,GOLD,SILVER,NATURALGAS
//                     (default; MCX added 2026-10-09 at the user's request). Each
//                     symbol's flow is read from its nearest-expiry future on
//                     Dhan (NSE_FNO / MCX_COMM). Symbols outside the supported
//                     list are refused.
//   DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN  the Dhan market-feed credentials (data
//                     only — no order API is ever called). Absent → the feed is
//                     NOT_CONFIGURED and every order-flow measure UNAVAILABLE.
// ============================================================

// Local copy of trading-flags' parseFlag: trading-flags imports this file (the logic-stamp suffix).
function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(v)) return true;
  if (['false', '0', 'off', 'no'].includes(v)) return false;
  return fallback;
}

export type OrderBlockMode = 'PAPER' | 'SHADOW' | 'OFF';
export const ORDER_BLOCK_MODE_DEFAULT: OrderBlockMode = 'PAPER';

export function parseOrderBlockMode(raw: string | undefined): { value: OrderBlockMode; rejected: string | null } {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === '') return { value: ORDER_BLOCK_MODE_DEFAULT, rejected: null };
  if (v === 'PAPER' || v === 'SHADOW' || v === 'OFF') return { value: v, rejected: null };
  return { value: ORDER_BLOCK_MODE_DEFAULT, rejected: raw ?? null };
}
const parsedObMode = parseOrderBlockMode(process.env.ORDER_BLOCK_MODE);
export const ORDER_BLOCK_MODE: OrderBlockMode = parsedObMode.value;
/** A rejected ORDER_BLOCK_MODE value (e.g. LIVE) — logged at boot. */
export const ORDER_BLOCK_MODE_REJECTED = parsedObMode.rejected;

export const OF1_ENABLED: boolean = parseFlag(process.env.OF1_ENABLED, true);
export const OF1_TRADING_DEFAULT = true;
/** OF1 paper trades (needs OF1_ENABLED). */
export const OF1_TRADING: boolean = OF1_ENABLED && parseFlag(process.env.OF1_TRADING, OF1_TRADING_DEFAULT);
/** Kept for the boot log (an OF1_TRADING=true with OF1_ENABLED=false cannot trade). */
export const OF1_TRADING_REQUESTED: boolean = parseFlag(process.env.OF1_TRADING, OF1_TRADING_DEFAULT) && !OF1_ENABLED;
/** OB1 paper trades. */
export const OB1_TRADING: boolean = ORDER_BLOCK_MODE === 'PAPER';

/** Paper-trading candidate sources added 2026-10-09 and the version each trades under. */
export const ORDER_FLOW_SOURCE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({ OB1: 'OB-2.0', OF1: 'OF1-1.0' });

/**
 * Live logic-stamp suffix while OB1 / OF1 may take the paper slot: the
 * candidate pool every other source competes in changed, so trades minted
 * with them on are never pooled with trades minted before.
 */
export function orderFlowLogicSuffix(ob1: boolean = OB1_TRADING, of1: boolean = OF1_TRADING): string {
  return `${ob1 ? '+ob1-paper.1' : ''}${of1 ? '+of1-paper.1' : ''}`;
}

export const ORDER_FLOW_DEFAULT_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS'] as const;
/** Symbols with a Dhan futures mapping, and their exchange (NSE index futures, MCX commodity futures). */
export const ORDER_FLOW_SUPPORTED: Readonly<Record<string, 'NSE' | 'MCX'>> = Object.freeze({
  NIFTY: 'NSE', BANKNIFTY: 'NSE', FINNIFTY: 'NSE', MIDCPNIFTY: 'NSE',
  CRUDEOIL: 'MCX', CRUDEOILM: 'MCX', GOLD: 'MCX', GOLDM: 'MCX', SILVER: 'MCX', SILVERM: 'MCX', NATURALGAS: 'MCX', NATGASMINI: 'MCX',
});
export const ORDER_FLOW_VERIFIED_SYMBOLS: ReadonlySet<string> = new Set(Object.keys(ORDER_FLOW_SUPPORTED));

export function parseOrderFlowSymbols(raw: string | undefined): { symbols: string[]; rejected: string[] } {
  const asked = (raw == null || raw.trim() === '' ? [...ORDER_FLOW_DEFAULT_SYMBOLS] : raw.split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return { symbols: asked.filter((s) => ORDER_FLOW_VERIFIED_SYMBOLS.has(s)), rejected: asked.filter((s) => !ORDER_FLOW_VERIFIED_SYMBOLS.has(s)) };
}
const parsedSymbols = parseOrderFlowSymbols(process.env.ORDER_FLOW_SYMBOLS);
export const ORDER_FLOW_SYMBOLS: readonly string[] = Object.freeze(parsedSymbols.symbols);
export const ORDER_FLOW_SYMBOLS_REJECTED: readonly string[] = Object.freeze(parsedSymbols.rejected);

/** Volume-by-price bucket (index points) per symbol. */
// Sized to roughly 1/20th of a typical 15m range (CRUDEOIL ≈ 40, GOLD ≈ 230, SILVER ≈ 570 points).
export const ORDER_FLOW_PRICE_STEP: Readonly<Record<string, number>> = Object.freeze({
  NIFTY: 5, BANKNIFTY: 10, FINNIFTY: 5, MIDCPNIFTY: 5,
  CRUDEOIL: 2, CRUDEOILM: 2, GOLD: 10, GOLDM: 10, SILVER: 25, SILVERM: 25, NATURALGAS: 0.2, NATGASMINI: 0.2,
});

export function dhanCredentials(env: NodeJS.ProcessEnv = process.env): { clientId: string; accessToken: string } | null {
  const clientId = env.DHAN_CLIENT_ID?.trim();
  const accessToken = env.DHAN_ACCESS_TOKEN?.trim();
  return clientId && accessToken ? { clientId, accessToken } : null;
}
