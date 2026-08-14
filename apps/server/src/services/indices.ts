// ============================================================
// LIVE INDEX QUOTES
// ============================================================
// Spot quotes for the well-known indices shown in the TopBar and
// Dashboard header — grouped by exchange since NIFTY-family
// indices are NSE and SENSEX/BANKEX are BSE.
// ============================================================

import { KNOWN_INDEX_TOKENS, CM_SEGMENT } from '@fno/shared';
import type { Exchange, MarketQuote } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';

const INDEX_LIST: Array<{ symbol: string; exchange: Exchange }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'FINNIFTY', exchange: 'NSE' },
  { symbol: 'MIDCPNIFTY', exchange: 'NSE' },
];

// Every index this terminal has a confirmed, live-quotable token for
// (see KNOWN_INDEX_TOKENS) — broad market + sectoral on NSE/BSE, plus
// MCX's commodity benchmark indices. Angel One's own instrument master
// doesn't reliably flag these as instrumentType 'INDEX' (mixed in with
// ETFs/EQ rows that merely contain the same name), so this list — like
// KNOWN_INDEX_TOKENS itself — was built from verified live lookups
// rather than filtering the raw feed.
export const ALL_INDEX_LIST: Array<{ symbol: string; exchange: Exchange }> = [
  ...INDEX_LIST,
  { symbol: 'NIFTYNEXT50', exchange: 'NSE' },
  { symbol: 'NIFTY100', exchange: 'NSE' },
  { symbol: 'NIFTY500', exchange: 'NSE' },
  { symbol: 'INDIAVIX', exchange: 'NSE' },
  { symbol: 'NIFTYIT', exchange: 'NSE' },
  { symbol: 'NIFTYAUTO', exchange: 'NSE' },
  { symbol: 'NIFTYPHARMA', exchange: 'NSE' },
  { symbol: 'NIFTYFMCG', exchange: 'NSE' },
  { symbol: 'NIFTYMETAL', exchange: 'NSE' },
  { symbol: 'NIFTYREALTY', exchange: 'NSE' },
  { symbol: 'NIFTYENERGY', exchange: 'NSE' },
  { symbol: 'NIFTYPSUBANK', exchange: 'NSE' },
  { symbol: 'NIFTYPVTBANK', exchange: 'NSE' },
  { symbol: 'NIFTYMEDIA', exchange: 'NSE' },
  { symbol: 'NIFTYINFRA', exchange: 'NSE' },
  { symbol: 'BANKEX', exchange: 'BSE' },
  { symbol: 'BSE100', exchange: 'BSE' },
  { symbol: 'BSE200', exchange: 'BSE' },
  { symbol: 'BSE500', exchange: 'BSE' },
  { symbol: 'BSEMIDCAP', exchange: 'BSE' },
  { symbol: 'BSESMALLCAP', exchange: 'BSE' },
  { symbol: 'BSEIT', exchange: 'BSE' },
  { symbol: 'MCXBULLDEX', exchange: 'MCX' },
  { symbol: 'MCXMETLDEX', exchange: 'MCX' },
  { symbol: 'MCXCOMPDEX', exchange: 'MCX' },
  { symbol: 'MCXCRUDEX', exchange: 'MCX' },
  { symbol: 'MCXCOPRDEX', exchange: 'MCX' },
  { symbol: 'MCXSILVDEX', exchange: 'MCX' },
  { symbol: 'MCXGOLDEX', exchange: 'MCX' },
];

export async function getLiveIndexQuotes(
  provider: MarketDataProvider,
  list: Array<{ symbol: string; exchange: Exchange }> = INDEX_LIST
): Promise<MarketQuote[]> {
  const byExchange = new Map<Exchange, Array<{ symbol: string; token: string }>>();

  for (const idx of list) {
    const token = KNOWN_INDEX_TOKENS[idx.symbol];
    if (!token) continue;
    if (!byExchange.has(idx.exchange)) byExchange.set(idx.exchange, []);
    byExchange.get(idx.exchange)!.push({ symbol: idx.symbol, token });
  }

  const now = Date.now();
  const results: MarketQuote[] = [];

  await Promise.all(
    Array.from(byExchange.entries()).map(async ([exchange, entries]) => {
      const tokens = entries.map((e) => e.token);
      const quotes = await provider.getQuote(CM_SEGMENT[exchange], tokens, 'FULL');
      const quoteByToken = new Map(quotes.map((q) => [q.token, q]));

      for (const entry of entries) {
        const q = quoteByToken.get(entry.token);
        if (!q) continue;

        const change = q.netChange ?? q.ltp - q.close;
        const changePercent = q.percentChange ?? (q.close > 0 ? (change / q.close) * 100 : 0);

        results.push({
          token: entry.token,
          symbol: entry.symbol,
          exchange,
          ltp: q.ltp,
          change,
          changePercent,
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
          timestamp: now,
        });
      }
    })
  );

  return results;
}
