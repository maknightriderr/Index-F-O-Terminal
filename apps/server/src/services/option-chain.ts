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
  isExpiryActive,
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
  calculateGammaExposure,
} from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOi } from '../lib/oi-baseline.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

export interface BuildOptionChainOptions {
  strikeRange?: number; // strikes above/below ATM to include
}

const CHAIN_CACHE_TTL_SECONDS = 10;
// Angel One's optionGreek endpoint rate-limits far more strictly than the
// 10s whole-chain cache above accounts for — that cache is PER SYMBOL, so
// it doesn't bound the AGGREGATE call rate across however many symbols
// are being tracked at once (every open browser tab polling every 15s,
// plus the trade-setup monitor's own 90s sweep across every locked
// position, each independently able to miss the 10s window and re-fetch
// Greeks for its own symbol). Confirmed live: every single call was
// coming back "Access denied because of exceeding access rate". Greeks
// don't swing on a sub-minute basis the way LTP does, so a much longer,
// endpoint-specific cache directly cuts the aggregate call rate rather
// than just each symbol's own rate.
const GREEKS_CACHE_TTL_SECONDS = 90;

export async function buildOptionChain(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  requestedExpiry?: string,
  options: BuildOptionChainOptions = {}
): Promise<OptionChain> {
  const strikeRange = options.strikeRange ?? DEFAULT_STRIKE_RANGE;
  const cacheKey = `chain:${exchange}:${underlying}:${requestedExpiry ?? 'nearest'}:${strikeRange}`;

  return cached(cacheKey, CHAIN_CACHE_TTL_SECONDS, () =>
    buildOptionChainUncached(provider, underlying, exchange, requestedExpiry, strikeRange)
  );
}

async function buildOptionChainUncached(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange,
  requestedExpiry: string | undefined,
  strikeRange: number
): Promise<OptionChain> {
  const availableExpiries = await provider.getExpiries(underlying, exchange);
  if (availableExpiries.length === 0) {
    throw new Error(`No option expiries found for ${underlying} on ${exchange}`);
  }

  const expiry =
    requestedExpiry && availableExpiries.includes(requestedExpiry)
      ? requestedExpiry
      : availableExpiries[0];

  const { ltp: spotPrice, close: spotClose } = await getSpotQuote(provider, underlying, exchange);
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
    // Deliberately using cached()'s default shouldCache (always cache,
    // empty result included) rather than the nonEmpty-style guard other
    // callers use for a swallowed-error empty array (see cached()'s own
    // doc comment). That guard exists so a rare transient failure doesn't
    // lock out a legitimate retry — the right call when the failure is
    // random. This one isn't: the confirmed cause is "Access denied
    // because of exceeding access rate," so retrying on every uncached
    // poll is exactly what KEEPS it rate-limited. Caching the empty
    // result too is a deliberate backoff, giving the limit window time to
    // actually clear instead of re-tripping it every poll.
    cached(`option-greeks:${exchange}:${underlying}:${expiry}`, GREEKS_CACHE_TTL_SECONDS, () =>
      provider.getOptionGreeks(underlying, expiry).catch((err) => {
        logger.warn({ error: err.message, underlying, expiry }, 'Broker Greeks unavailable, using internal engine only');
        return [];
      })
    ),
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
    // Same self-computed % change as underlyingChangePercent above (not
    // the provider's own percentChange field, which OHLC-mode payloads
    // don't always populate) — this leg's OWN premium move, feeding
    // classifyOptionOI's real buying-vs-writing / covering-vs-unwinding
    // read below instead of the OI-direction-only guess it used to fall
    // back to when this was hardcoded to 0.
    const legChangePercent =
      quote && quote.close > 0 ? ((quote.ltp - quote.close) / quote.close) * 100 : 0;

    const brokerIv = broker ? Number(broker.iv) : 0;
    // Broker Greeks must pass a plausibility check before we trust them —
    // Angel One's optionGreek endpoint can return garbage (delta >> 1,
    // extreme IV, NaN) for illiquid options, near-zero-DTE, or when their
    // own solver glitches. sanitizeBrokerGreeks() returns null when the
    // data is too far off to clamp, and we fall back to the internal BS
    // engine which has its own clamping built in.
    const sanitized = !!broker && brokerIv > 0
      ? sanitizeBrokerGreeks(
          { delta: Number(broker.delta), gamma: Number(broker.gamma), theta: Number(broker.theta), vega: Number(broker.vega), iv: brokerIv },
          optionType
        )
      : null;

    // calculateGreeksFromPrice returns iv as a decimal (0.17 for 17%), matching
    // the analytics package's internal convention — but broker Greeks and every
    // consumer of OptionChainLeg.iv (frontend display, ATM-IV -> Expected Move
    // below) expect a percentage (17.1), matching Angel One's own convention.
    // Normalize here so both paths agree on the same unit.
    const greeks = sanitized
      ?? (() => {
          const calculated = calculateGreeksFromPrice(quote?.ltp ?? 0, spotPrice, strike, tte, optionType, RISK_FREE_RATE);
          return { delta: calculated.delta, gamma: calculated.gamma, theta: calculated.theta, vega: calculated.vega, iv: calculated.iv * 100 };
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
      oiInterpretation: classifyOptionOI({ priceChange: legChangePercent, oiChange: changeOi }, optionType),
      // Calls and puts at the same strike are moneyness-opposite (a strike
      // below spot is ITM for a call but OTM for the put at that same
      // strike) — must be classified per-leg with its own optionType, not
      // once per strike row.
      moneyness: classifyStrike(strike, spotPrice, optionType, strikeInterval),
      greeksSource: sanitized ? 'BROKER' : 'CALCULATED',
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
  const gammaExposure = calculateGammaExposure(strikes, spotPrice);

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
    gammaExposure,
    timestamp: now,
  };
}

// --- Helpers ---

// option-chain.ts and futures.ts each independently resolved + fetched the
// spot quote for the same underlying, under separate cache keys — found
// live on MCX CRUDEOIL, where the Asset Workspace header (from the option
// chain response) and the Futures panel's "Current Month" price could
// visibly disagree by ~20 points, since each was serving whatever it had
// cached up to CHAIN_CACHE_TTL_SECONDS/FUTURES_CACHE_TTL_SECONDS (10s)
// apart on a moving contract. Sharing one cached quote here — read by
// both — means the two nearly-simultaneous requests the frontend fires
// (Promise.allSettled in fetchAll) almost always land on the exact same
// cached value instead of two independently-fetched ticks.
const SPOT_QUOTE_CACHE_TTL_SECONDS = 5;

export async function getSpotQuote(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<{ token: string; ltp: number; close: number }> {
  const cacheKey = `spot-quote:${exchange}:${underlying}`;
  return cached(cacheKey, SPOT_QUOTE_CACHE_TTL_SECONDS, async () => {
    const spotToken = await resolveSpotToken(provider, underlying, exchange);
    const [quote] = await provider.getQuote(CM_SEGMENT[exchange], [spotToken], 'OHLC');
    return { token: spotToken, ltp: quote?.ltp ?? 0, close: quote?.close ?? 0 };
  });
}

export async function resolveSpotToken(
  provider: MarketDataProvider,
  underlying: string,
  exchange: Exchange
): Promise<string> {
  // MCX commodities (CRUDEOIL, GOLD, etc.) have no cash/spot instrument at
  // all — trading is futures/options only. The standard reference price for
  // their options is the nearest-expiry futures contract, not a spot index.
  // MUST be checked before the EQ/INDEX search below: Angel One's
  // instrument master carries a phantom "CRUDEOILCOM"-style reference
  // instrument for MCX commodities classified as instrumentType 'EQ' even
  // though it isn't a real tradeable spot — confirmed live, its quote
  // doesn't track the actual futures market (a persistent ~25pt gap from
  // the real nearest-future's price on CRUDEOIL). The EQ/INDEX match below
  // was matching that phantom instrument and returning it immediately,
  // never reaching this MCX branch at all.
  if (exchange === 'MCX') {
    const nearestFuture = await resolveNearestFuturesContract(provider, underlying, exchange);
    if (nearestFuture) return nearestFuture.token;
  }

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

  if (candidates[0]) return candidates[0].token;

  throw new Error(`Unable to resolve spot instrument for ${underlying}`);
}

export async function resolveNearestFuturesContract(
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
        isExpiryActive(i.expiry)
    )
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : 0));
  return futures[0];
}

export function inferStrikeInterval(sortedStrikes: number[]): number {
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

// --- Broker Greeks Validation ---
// Angel One's optionGreek endpoint can return out-of-range values (delta > 1,
// NaN, extreme IV) for illiquid options, near-zero-DTE strikes, or when their
// own solver glitches. The internal BS engine (calculateGreeksFromPrice)
// already clamps everything, but broker values bypass that. This function
// validates and clamps, returning null if the data is too broken to salvage
// — the caller then falls back to the internal engine.

interface BrokerGreeksInput {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number; // percentage, e.g. 17.1 for 17.1%
}

const MIN_BROKER_IV_PCT = 0.5;   // 0.5% — anything below is almost certainly noise
const MAX_BROKER_IV_PCT = 500;   // 500% — even the most volatile meme stock shouldn't exceed this

function sanitizeBrokerGreeks(
  raw: BrokerGreeksInput,
  optionType: OptionType
): BrokerGreeksInput | null {
  // If any value is NaN or Infinity, the entire set is unreliable
  const vals = [raw.delta, raw.gamma, raw.theta, raw.vega, raw.iv];
  if (vals.some((v) => !isFinite(v) || isNaN(v))) return null;

  // IV must be in a sane percentage range — if not, the rest of the
  // Greeks derived from it are equally suspect
  if (raw.iv < MIN_BROKER_IV_PCT || raw.iv > MAX_BROKER_IV_PCT) return null;

  // Clamp delta per option type:
  // CE delta ∈ [0, 1], PE delta ∈ [-1, 0]
  const delta = optionType === 'CE'
    ? Math.max(0, Math.min(1, raw.delta))
    : Math.max(-1, Math.min(0, raw.delta));

  // Gamma is always non-negative (same for both CE and PE)
  const gamma = Math.max(0, raw.gamma);

  // Theta is always non-positive for long options
  const theta = Math.min(0, raw.theta);

  // Vega is always non-negative
  const vega = Math.max(0, raw.vega);

  return { delta, gamma, theta, vega, iv: raw.iv };
}
