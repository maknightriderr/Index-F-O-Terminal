// ============================================================
// FUTURES INTELLIGENCE SERVICE
// ============================================================
// Resolves current/next/far futures contracts for an underlying,
// computes basis/premium-discount against spot, and classifies
// OI buildup (spec §22).
// ============================================================

import { calculateDTE, FO_SEGMENT, isExpiryActive } from '@fno/shared';
import type { Exchange, FuturesData, FuturesChainResponse } from '@fno/shared';
import { classifyFuturesOI } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOi } from '../lib/oi-baseline.js';
import { cached } from '../lib/cache.js';
import { getSpotQuote } from './option-chain.js';

const EXPIRY_LABELS: Array<'current' | 'next' | 'far'> = ['current', 'next', 'far'];
const FUTURES_CACHE_TTL_SECONDS = 10;

export async function buildFuturesData(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<FuturesChainResponse> {
  const cacheKey = `futures:${exchange}:${underlying}`;
  return cached(cacheKey, FUTURES_CACHE_TTL_SECONDS, () => buildFuturesDataUncached(provider, underlying, exchange));
}

async function buildFuturesDataUncached(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<FuturesChainResponse> {
  // Shares option-chain.ts's cached spot quote rather than fetching its
  // own — found live that two independent fetches for the same
  // underlying (on separate cache keys) could show the header price and
  // the "Current Month" futures price a few seconds apart on a moving
  // contract, visibly disagreeing on screen for no real reason.
  const { token: spotToken, ltp: spotPrice } = await getSpotQuote(provider, underlying, exchange);

  if (spotPrice <= 0) {
    throw new Error(`Unable to resolve a live spot price for ${underlying}`);
  }

  const instruments = await provider.getInstrumentMaster();
  // Underlying match (case-insensitive) and sort comparison (string, not
  // Date) deliberately mirror resolveNearestFuturesContract in
  // option-chain.ts exactly — found live that this file's own
  // case-sensitive match / Date-based sort could pick a DIFFERENT
  // "nearest" contract than resolveSpotToken resolves to for MCX, so the
  // Futures panel's "Current Month" price and the header's spot price
  // (same instrument, by MCX having no separate cash contract) came from
  // two genuinely different contracts rather than just two stale quotes
  // of the same one. Matching the exact selection logic here — not just
  // comparing tokens after independently picking — is what guarantees
  // they can't diverge.
  const futInstruments = instruments
    .filter(
      (i) =>
        i.underlying?.toUpperCase() === underlying.toUpperCase() &&
        i.exchange === exchange &&
        (i.instrumentType === 'FUTIDX' || i.instrumentType === 'FUTSTK' || i.instrumentType === 'FUTCOM') &&
        isExpiryActive(i.expiry)
    )
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : 0))
    .slice(0, 3);

  if (futInstruments.length === 0) {
    throw new Error(`No futures contracts found for ${underlying} on ${exchange}`);
  }

  const tokens = futInstruments.map((i) => i.token);
  const quotes = await provider.getQuote(FO_SEGMENT[exchange], tokens, 'FULL');
  const quoteByToken = new Map(quotes.map((q) => [q.token, q]));

  const changeOiByToken = new Map<string, number>();
  await Promise.all(
    futInstruments.map(async (inst) => {
      const oi = quoteByToken.get(inst.token)?.oi;
      if (oi !== undefined) changeOiByToken.set(inst.token, await computeChangeOi(inst.token, oi));
    })
  );

  const now = Date.now();

  const contracts: FuturesData[] = futInstruments.map((inst, idx) => {
    const quote = quoteByToken.get(inst.token);
    // MCX has no separate cash instrument — resolveSpotToken resolves to
    // this exact nearest-future contract, so its "own" quote and the
    // shared spot quote are the identical instrument. Use the shared
    // value directly here rather than the batch quote fetched moments
    // apart above, so the Futures panel can't show a different tick for
    // the same contract than the header does.
    const futuresPrice = inst.token === spotToken ? spotPrice : quote?.ltp ?? 0;
    const basis = Math.round((futuresPrice - spotPrice) * 100) / 100;
    const premiumDiscountPct = spotPrice > 0 ? Math.round((basis / spotPrice) * 10000) / 100 : 0;
    const changeOi = changeOiByToken.get(inst.token) ?? 0;

    return {
      token: inst.token,
      symbol: inst.symbol,
      expiryLabel: EXPIRY_LABELS[idx] ?? 'far',
      spotPrice,
      futuresPrice,
      basis,
      premiumDiscount: Math.abs(premiumDiscountPct),
      premiumDiscountType: basis >= 0 ? 'PREMIUM' : 'DISCOUNT',
      volume: quote?.volume ?? 0,
      oi: quote?.oi ?? 0,
      changeOi,
      interpretation: classifyFuturesOI({ priceChange: quote?.percentChange ?? 0, oiChange: changeOi }),
      expiry: inst.expiry!,
      dte: calculateDTE(inst.expiry!),
      timestamp: now,
    };
  });

  return { underlying, exchange, spotPrice, contracts, timestamp: now };
}
