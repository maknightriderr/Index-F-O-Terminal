import { alignFootprintsToReference, FLOW_ALIGNMENT_VERSION, type FootprintBar, type Of1Bar } from '@fno/analytics';
import type { Exchange, OHLCV } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { tapedInput } from '../lib/io-tape.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { footprintsFor } from './order-flow-store.js';
import { orderFlowFeedStatus } from './dhan-feed.js';
import { resolveNearestFuturesContract } from './option-chain.js';
import { decisionNow } from './decision-clock.js';

const M15 = 15 * 60_000;
const status = new Map<string, { barTime: number; alignment: FootprintBar['priceAlignment'] }>();
export const orderFlowAlignmentStatus = () => Object.fromEntries(status);

function brokerDate(t: number): string {
  return new Date(t + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** One taped input: replay never substitutes today's contract or basis. */
export function alignedFootprintsFor(provider: MarketDataProvider, symbol: string, exchange: Exchange, bars: readonly Of1Bar[]): Promise<Map<number, FootprintBar>> {
  const at = decisionNow();
  const recent = bars.filter(b => b.time + M15 <= at).slice(-60);
  return tapedInput('orderFlowAlignedFootprints', [FLOW_ALIGNMENT_VERSION, symbol, exchange, recent[0]?.time ?? null, recent[recent.length - 1]?.time ?? null, recent.length], async () => {
    if (!recent.length) return new Map();
    const last = recent[recent.length - 1];
    try {
      const raw = await footprintsFor(symbol, recent.map(b => b.time));
      if (!raw.get(last.time) || raw.get(last.time)?.deltaMode === 'UNAVAILABLE') {
        status.set(symbol, { barTime: last.time, alignment: { status: 'UNAVAILABLE', reason: 'FLOW_UNAVAILABLE' } });
        return new Map();
      }
      const feed = orderFlowFeedStatus().instruments[symbol];
      const future = await resolveNearestFuturesContract(provider, symbol, exchange);
      // Broker tokens/display symbols differ. Join exchange + underlying +
      // expiry, then require the exact Dhan contract on each raw footprint.
      const verified = feed && future && feed.exchange === exchange && future.exchange === exchange
        && future.underlying?.toUpperCase() === symbol.toUpperCase() && future.expiry === feed.expiry;
      const contract = verified ? { instrument: feed.tradingSymbol, expiry: feed.expiry } : null;
      let futuresBars: Of1Bar[] = [];
      if (contract && exchange !== 'MCX' && raw.size > 0) {
        // Dedicated key: cannot truncate the longer history of other engines.
        // Paper/shadow share completed-bar history; no per-tick broker calls.
        const candles = await cached<OHLCV[]>(
          `of1:alignment:${exchange}:${future!.token}:${recent[0].time}:${last.time}`, 300,
          () => provider.getHistoricalData({ exchange, segment: 'FO', token: future!.token, interval: 'FIFTEEN_MINUTE',
            fromDate: brokerDate(recent[0].time), toDate: brokerDate(last.time + M15) }),
          c => c.length > 0
        );
        futuresBars = candles.map(c => ({ time: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
          .filter(b => b.time + M15 <= at && b.time <= last.time);
      }
      const aligned = alignFootprintsToReference(recent, raw, futuresBars, contract, exchange === 'MCX' ? 'FUTURES' : 'SPOT', at);
      status.set(symbol, { barTime: last.time, alignment: aligned.get(last.time)?.priceAlignment ?? { status: 'UNAVAILABLE', reason: 'FLOW_UNAVAILABLE' } });
      return aligned;
    } catch (err: any) {
      status.set(symbol, { barTime: last.time, alignment: { status: 'UNAVAILABLE', reason: 'ALIGNMENT_INPUT_FAILED' } });
      logger.warn({ symbol, exchange, error: err.message }, 'OF1 alignment unavailable; no candidate');
      return new Map();
    }
  });
}
