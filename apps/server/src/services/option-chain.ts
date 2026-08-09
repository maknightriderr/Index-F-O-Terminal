// ============================================================
// OPTION CHAIN ASSEMBLY SERVICE
// ============================================================
// Auto-discovers strikes for an underlying + expiry from the
// instrument master, fetches live quotes and broker Greeks,
// falls back to the internal Black-Scholes engine when broker
// Greeks are missing, and layers on PCR / Max Pain / Expected
// Move from @fno/analytics. This is the core of spec §4/§11.
// ============================================================

import {
  DEFAULT_STRIKE_RANGE,
  KNOWN_INDEX_TOKENS,
  RISK_FREE_RATE,
  CM_SEGMENT,
  FO_SEGMENT,
  getATMStrike,
  classifyStrike,
  calculateDTE,
  yearsToExpiry,
} from '@fno/shared';
import type { Exchange, Instrument, OptionChain, OptionChainStrike, OptionChainLeg, OptionType } from '@fno/shared';
import {
  calculatePCR,
  calculateMaxPain,
  calculateExpectedMove,
  classifyOptionOI,
  calculateGreeksFromPrice,
  analyzePositionMomentum,
  analyzeOiTrap,
  analyzeTimeDecay,
} from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOi } from '../lib/oi-baseline.js';
import { logger } from '../lib/logger.js';

export interface BuildOptionChainOptions {
  strikeRange?: number; // strikes above/below ATM to include
}

export async function buildOptionChain(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  requestedExpiry?: string,
  options: BuildOptionChainOptions = {}
): Promise<OptionChain> {
  const strikeRange = options.strikeRange ?? DEFAULT_STRIKE_RANGE;

  const availableExpiries = await provider.getExpiries(underlying, exchange);
  if (availableExpiries.length === 0) {
    throw new Error(`No option expiries found for ${underlying} on ${exchange}`);
  }

  const expiry =
    requestedExpiry && availableExpiries.includes(requestedExpiry)
      ? requestedExpiry
      : availableExpiries[0];

  const spotToken = await resolveSpotToken(provider, underlying, exchange);
  const spotQuotes = await provider.getQuote(CM_SEGMENT[exchange], [spotToken], 'OHLC');
  const spotPrice = spotQuotes[0]?.ltp ?? 0;
  const spotClose = spotQuotes[0]?.close ?? 0;
  // Compute the % change ourselves rather than trust the provider's
  // percentChange field — OHLC-mode payloads don't always populate it,
  // and close/ltp are always present, so this is more reliable.
  const underlyingChangePercent = spotClose > 0 ? ((spotPrice - spotClose) / spotClose) * 100 : 0;

  if (spotPrice <= 0) {
    throw new Error(`Unable to resolve a live spot price for ${underlying}`);
  }

  const instruments = await provider.getInstrumentMaster();
  const optionInstruments = instruments.filter(
    (i) =>
      i.underlying === underlying &&
      i.exchange === exchange &&
      (i.instrumentType === 'OPTIDX' || i.instrumentType === 'OPTSTK' || i.instrumentType === 'OPTFUT') &&
      i.expiry === expiry &&
      i.strike !== undefined
  );

  if (optionInstruments.length === 0) {
    throw new Error(`No option contracts found for ${underlying} expiry ${expiry}`);
  }

  const allStrikes = Array.from(new Set(optionInstruments.map((i) => i.strike!))).sort((a, b) => a - b);
  const strikeInterval = inferStrikeInterval(allStrikes);
  const atmStrike = getATMStrike(spotPrice, strikeInterval);

  const atmIndex = allStrikes.reduce(
    (closest, s, idx) => (Math.abs(s - atmStrike) < Math.abs(allStrikes[closest] - atmStrike) ? idx : closest),
    0
  );
  const selectedStrikes = allStrikes.slice(
    Math.max(0, atmIndex - strikeRange),
    atmIndex + strikeRange + 1
  );
  const selectedSet = new Set(selectedStrikes);

  const byStrike = new Map<number, { call?: Instrument; put?: Instrument }>();
  for (const inst of optionInstruments) {
    if (!selectedSet.has(inst.strike!)) continue;
    const entry = byStrike.get(inst.strike!) || {};
    if (inst.optionType === 'CE') entry.call = inst;
    else if (inst.optionType === 'PE') entry.put = inst;
    byStrike.set(inst.strike!, entry);
  }

  const allTokens = Array.from(byStrike.values()).flatMap((e) =>
    [e.call?.token, e.put?.token].filter((t): t is string => !!t)
  );

  const [quotes, greeksData] = await Promise.all([
    provider.getQuote(FO_SEGMENT[exchange], allTokens, 'FULL'),
    provider.getOptionGreeks(underlying, expiry).catch((err) => {
      logger.warn({ error: err.message, underlying, expiry }, 'Broker Greeks unavailable, using internal engine only');
      return [];
    }),
  ]);

  const quoteByToken = new Map(quotes.map((q) => [q.token, q]));
  const greeksByKey = new Map(greeksData.map((g) => [`${g.strikePrice}:${g.optionType}`, g]));

  // Batch-resolve daily OI baselines for every leg with OI up front (avoids N sequential round-trips).
  const changeOiByToken = new Map<string, number>();
  await Promise.all(
    allTokens.map(async (token) => {
      const oi = quoteByToken.get(token)?.oi;
      if (oi !== undefined) changeOiByToken.set(token, await computeChangeOi(token, oi));
    })
  );

  const dte = calculateDTE(expiry);
  const tte = yearsToExpiry(expiry);
  const now = Date.now();

  const buildLeg = (inst: Instrument, strike: number, optionType: OptionType): OptionChainLeg => {
    const quote = quoteByToken.get(inst.token);
    const broker = greeksByKey.get(`${strike}:${optionType}`);
    const changeOi = changeOiByToken.get(inst.token) ?? 0;

    const brokerIv = broker ? Number(broker.iv) : 0;
    const hasBrokerGreeks = !!broker && brokerIv > 0;

    // calculateGreeksFromPrice returns iv as a decimal (0.17 for 17%), matching
    // the analytics package's internal convention — but broker Greeks and every
    // consumer of OptionChainLeg.iv (frontend display, ATM-IV -> Expected Move
    // below) expect a percentage (17.1), matching Angel One's own convention.
    // Normalize here so both paths agree on the same unit.
    const greeks = hasBrokerGreeks
      ? { delta: Number(broker!.delta), gamma: Number(broker!.gamma), theta: Number(broker!.theta), vega: Number(broker!.vega), iv: brokerIv }
      : (() => {
          const calculated = calculateGreeksFromPrice(quote?.ltp ?? 0, spotPrice, strike, tte, optionType, RISK_FREE_RATE);
          return { ...calculated, iv: calculated.iv * 100 };
        })();

    return {
      token: inst.token,
      ltp: quote?.ltp ?? 0,
      bid: quote?.bid ?? 0,
      ask: quote?.ask ?? 0,
      volume: quote?.volume ?? 0,
      oi: quote?.oi ?? 0,
      changeOi,
      iv: greeks.iv,
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      oiInterpretation: classifyOptionOI({ priceChange: 0, oiChange: changeOi }, optionType),
      greeksSource: hasBrokerGreeks ? 'BROKER' : 'CALCULATED',
      timestamp: now,
    };
  };

  const strikes: OptionChainStrike[] = selectedStrikes.map((strike) => {
    const entry = byStrike.get(strike);
    const call = entry?.call ? buildLeg(entry.call, strike, 'CE') : null;
    const put = entry?.put ? buildLeg(entry.put, strike, 'PE') : null;

    return {
      strike,
      distanceFromSpot: Math.round((strike - spotPrice) * 100) / 100,
      classification: classifyStrike(strike, spotPrice, 'CE', strikeInterval),
      call,
      put,
    };
  });

  const pcrDetail = calculatePCR(strikes, spotPrice);
  const maxPainDetail = calculateMaxPain(strikes, spotPrice, underlying, expiry);

  const atmEntry = strikes.find((s) => s.strike === atmStrike) ?? strikes[Math.floor(strikes.length / 2)];
  const atmIvSamples = [atmEntry?.call?.iv, atmEntry?.put?.iv].filter((v): v is number => !!v && v > 0);
  const atmIv = atmIvSamples.length > 0 ? atmIvSamples.reduce((a, b) => a + b, 0) / atmIvSamples.length / 100 : 0.15;

  const expectedMoveDetail = calculateExpectedMove(spotPrice, atmIv, dte, underlying);

  const positionMomentum = analyzePositionMomentum(strikes, underlyingChangePercent);
  const oiTrap = analyzeOiTrap(strikes, spotPrice);
  const decay = analyzeTimeDecay(strikes, atmStrike, dte);

  return {
    symbol: underlying,
    underlying,
    exchange,
    spotPrice,
    expiry,
    availableExpiries,
    dte,
    strikeInterval,
    atmStrike,
    strikes,
    pcr: pcrDetail.oiPCR,
    pcrDetail: {
      oiPCR: pcrDetail.oiPCR,
      volumePCR: pcrDetail.volumePCR,
      changeOiPCR: pcrDetail.changeOiPCR,
      nearAtmPCR: pcrDetail.nearAtmPCR,
    },
    maxPain: maxPainDetail.maxPain,
    maxPainDistance: maxPainDetail.distanceFromSpot,
    expectedMove: {
      points: expectedMoveDetail.expectedMove,
      upperBound: expectedMoveDetail.upperBound,
      lowerBound: expectedMoveDetail.lowerBound,
    },
    positionMomentum,
    oiTrap,
    decay,
    timestamp: now,
  };
}

// --- Helpers ---

export async function resolveSpotToken(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<string> {
  const candidates = await provider.searchInstruments(underlying, exchange, 'CM');
  const exact = candidates.find(
    (i) =>
      (i.instrumentType === 'EQ' || i.instrumentType === 'INDEX') &&
      (i.symbol.toUpperCase() === underlying.toUpperCase() ||
        i.underlying?.toUpperCase() === underlying.toUpperCase())
  );
  if (exact) return exact.token;

  const known = KNOWN_INDEX_TOKENS[underlying.toUpperCase()];
  if (known) return known;

  // MCX commodities (CRUDEOIL, GOLD, etc.) have no cash/spot instrument at
  // all — trading is futures/options only. The standard reference price for
  // their options is the nearest-expiry futures contract, not a spot index.
  if (exchange === 'MCX') {
    const nearestFuture = await resolveNearestFuturesContract(provider, underlying, exchange);
    if (nearestFuture) return nearestFuture.token;
  }

  if (candidates[0]) return candidates[0].token;

  throw new Error(`Unable to resolve spot instrument for ${underlying}`);
}

async function resolveNearestFuturesContract(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<Instrument | undefined> {
  const instruments = await provider.getInstrumentMaster();
  const futures = instruments
    .filter(
      (i) =>
        i.exchange === exchange &&
        i.instrumentType === 'FUTCOM' &&
        i.underlying?.toUpperCase() === underlying.toUpperCase() &&
        i.expiry
    )
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : 0));
  return futures[0];
}

function inferStrikeInterval(sortedStrikes: number[]): number {
  if (sortedStrikes.length < 2) return 50;

  const gapCounts = new Map<number, number>();
  for (let i = 1; i < sortedStrikes.length; i++) {
    const gap = Math.round((sortedStrikes[i] - sortedStrikes[i - 1]) * 100) / 100;
    if (gap <= 0) continue;
    gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1);
  }

  let bestGap = 50;
  let bestCount = 0;
  for (const [gap, count] of gapCounts) {
    if (count > bestCount) {
      bestGap = gap;
      bestCount = count;
    }
  }
  return bestGap;
}
