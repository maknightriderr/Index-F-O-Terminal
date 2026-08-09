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

export async function getLiveIndexQuotes(provider: MarketDataProvider): Promise<MarketQuote[]> {
  const byExchange = new Map<Exchange, Array<{ symbol: string; token: string }>>();

  for (const idx of INDEX_LIST) {
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
