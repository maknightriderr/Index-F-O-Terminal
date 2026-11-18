// ============================================================
// COMMAND LINE — "<SYMBOL> <FUNCTION>" or a page code, typed in the top bar
// ============================================================
// One parser for the terminal's command bar (components/layout/command-bar.tsx). A symbol command opens the
// Workspace on that underlying with one panel in focus; a page code opens that page. Pure, so it is unit-tested.
//
//   NIFTY            → Workspace on NIFTY (chart in focus)
//   BANKNIFTY OC     → Workspace on BANKNIFTY, option chain in focus
//   CRUDEOIL CH      → Workspace on MCX CRUDEOIL, chart in focus
//   TRADES / HEALTH  → that page
// ============================================================

import { NAV_GROUPS, type PageId } from './nav';

export type WorkspaceExchange = 'NSE' | 'BSE' | 'MCX';
export type WorkspaceFocus = 'chart' | 'chain' | 'quote' | 'radar' | 'trades';

export type ParsedCommand =
  | { kind: 'workspace'; symbol: string; exchange: WorkspaceExchange; focus: WorkspaceFocus }
  | { kind: 'page'; tab: PageId }
  | { kind: 'error'; message: string };

/** Functions that act on a symbol inside the Workspace. */
export const SYMBOL_FUNCTIONS: Readonly<Record<string, { focus: WorkspaceFocus; label: string }>> = Object.freeze({
  CH: { focus: 'chart', label: 'Chart' },
  OC: { focus: 'chain', label: 'Option chain' },
  QT: { focus: 'quote', label: 'Quote (top of book)' },
  RADAR: { focus: 'radar', label: 'Engine radar' },
});

/** Codes that open a page: generated from the one navigation registry (lib/nav.ts), so every page has one. */
export const PAGE_CODES: Readonly<Record<string, { tab: PageId; label: string }>> = Object.freeze(
  Object.fromEntries(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.code, { tab: i.id, label: i.label }])))
);

/** Underlyings the palette recognises by name alone (any other symbol needs a function word, e.g. RELIANCE OC). */
export const KNOWN_UNDERLYINGS: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'CRUDEOIL', 'CRUDEOILM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'NATURALGAS', 'NATGASMINI']);

const BSE_INDICES = new Set(['SENSEX', 'BANKEX']);
const MCX_PRODUCTS = new Set(['CRUDEOIL', 'CRUDEOILM', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'NATURALGAS', 'NATGASMINI']);

/** The exchange an underlying trades on: BSE indices, MCX commodities, everything else NSE. */
export function exchangeFor(symbol: string): WorkspaceExchange {
  return BSE_INDICES.has(symbol) ? 'BSE' : MCX_PRODUCTS.has(symbol) ? 'MCX' : 'NSE';
}

const SYMBOL = /^[A-Z][A-Z0-9&-]{0,19}$/;

export function parseCommand(raw: string): ParsedCommand {
  const words = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'error', message: 'Type a symbol (NIFTY), a symbol and a function (NIFTY OC), or a page code (TRADES).' };
  if (words.length > 2) return { kind: 'error', message: 'Use at most two words: SYMBOL FUNCTION, e.g. BANKNIFTY OC.' };
  const [first, second] = words;
  if (words.length === 1 && PAGE_CODES[first]) return { kind: 'page', tab: PAGE_CODES[first].tab };
  // "OC NIFTY" reads the same as "NIFTY OC".
  const [symbol, fn] = SYMBOL_FUNCTIONS[first] && second ? [second, first] : [first, second];
  if (!SYMBOL.test(symbol)) return { kind: 'error', message: `"${symbol}" is not a symbol.` };
  if (fn && !SYMBOL_FUNCTIONS[fn]) return { kind: 'error', message: `Unknown function "${fn}". Try ${Object.keys(SYMBOL_FUNCTIONS).join(', ')}.` };
  return { kind: 'workspace', symbol, exchange: exchangeFor(symbol), focus: fn ? SYMBOL_FUNCTIONS[fn].focus : 'chart' };
}

/** Layout presets (Alt+1…4 and the buttons under the Workspace). */
export type WorkspaceLayout = 'morning' | 'expiry' | 'mcx' | 'review';
export const WORKSPACE_PRESETS: ReadonlyArray<{ id: WorkspaceLayout; key: string; label: string; symbol: string; exchange: WorkspaceExchange }> = [
  { id: 'morning', key: '1', label: 'Morning', symbol: 'NIFTY', exchange: 'NSE' },
  { id: 'expiry', key: '2', label: 'Expiry day', symbol: 'NIFTY', exchange: 'NSE' },
  { id: 'mcx', key: '3', label: 'MCX evening', symbol: 'CRUDEOIL', exchange: 'MCX' },
  { id: 'review', key: '4', label: 'Review', symbol: 'NIFTY', exchange: 'NSE' },
];
